// runner 环境变量的校验、格式化与 .env 落盘。只碰纯数据和自己属主的文件，不碰 sudo/systemd。
//
// 为什么单独一个模块：这几样东西现在有两个使用方——runner_env（面板上改已有 runner 的变量）
// 与 runner_provision（创建时写入初始变量）。而 runner_env 本身要用 runner_provision 的特权
// 助手常量，所以校验逻辑放在这两者中的任何一边，另一边引过来都会成环。抽成叶子模块，两边各
// 引一次，顺带让这段纯逻辑可以直接单测（daemon/test/pure-logic/runner_env_vars.spec.ts）。
import fs from "fs-extra";
import path from "path";
import logger from "./log";
import type { RunnerEnvSection, RunnerEnvVar } from "mcsmanager-common";

// 声明在 common/src/runner_protocol.ts，三方共用。这里只转出去，免得已有的
// `from "./runner_env_vars"` 全要改路径 —— 之前这里是第二份手写声明。
export type { RunnerEnvVar, RunnerEnvSection };

// 环境变量名白名单，与助手脚本一致（允许小写，如既有 .env 里的 http_proxy/no_proxy）
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const MAX_VARS = 100;
export const MAX_VALUE_LEN = 4096;

// 校验并去重环境变量清单（同名后者覆盖前者），返回规范化后的数组
export function sanitizeEnvVars(vars: RunnerEnvVar[]): RunnerEnvVar[] {
  const map = new Map<string, string>();
  for (const v of vars) {
    const key = String(v?.key ?? "").trim();
    const value = String(v?.value ?? "");
    if (!key) continue;
    if (!ENV_KEY_RE.test(key)) throw new Error(`非法环境变量名: ${key}`);
    if (/[\r\n]/.test(value)) throw new Error(`环境变量 ${key} 的值不能含换行`);
    if (value.length > MAX_VALUE_LEN)
      throw new Error(`环境变量 ${key} 的值过长(上限 ${MAX_VALUE_LEN})`);
    map.set(key, value);
  }
  if (map.size > MAX_VARS) throw new Error(`环境变量条数过多(上限 ${MAX_VARS})`);
  return Array.from(map, ([key, value]) => ({ key, value }));
}

// 每行 KEY=VALUE。既是 .env 的内容，也是传给特权助手 set-env 的载荷（再 base64）。
export function formatEnvLines(vars: RunnerEnvVar[]): string {
  return vars.map((v) => `${v.key}=${v.value}`).join("\n");
}

export function dotenvPath(dir: string): string {
  return path.join(dir, ".env");
}

// 写 .env：整表覆盖，原子替换(temp→rename)。空清单则删除文件。属主即 daemon 用户，直接 fs。
export function writeDotEnvFile(dir: string, desired: RunnerEnvVar[]): void {
  const file = dotenvPath(dir);
  if (desired.length === 0) {
    try {
      fs.removeSync(file);
    } catch (err: any) {
      throw new Error(`清空 .env 失败: ${err?.message || err}`);
    }
    logger.info(`[runner-env] dotenv: 已清空 ${file}`);
    return;
  }
  const content = formatEnvLines(desired) + "\n";
  const tmp = `${file}.cip-tmp`;
  // 保留原文件权限位（不擅自放宽/收紧用户已有设置）；新建时用 0600——.env 可能装
  // 代理凭据这类敏感值，默认不给同组/其他用户可读。
  let mode = 0o600;
  try {
    if (fs.existsSync(file)) mode = fs.statSync(file).mode & 0o777;
  } catch {
    /* 拿不到就用默认 0600 */
  }
  try {
    // 上次崩溃可能残留临时文件；mode 只在创建时生效，先清掉免得沿用旧权限
    fs.removeSync(tmp);
    fs.writeFileSync(tmp, content, { mode });
    fs.renameSync(tmp, file);
  } catch (err: any) {
    try {
      fs.removeSync(tmp);
    } catch {
      /* 忽略临时文件清理失败 */
    }
    throw new Error(`写 .env 失败: ${err?.message || err}`);
  }
  logger.info(`[runner-env] dotenv: 写 ${file}（${desired.length} 个变量）`);
}

// 读某个目标文件并解析成一节。文件不存在 = present:false（正常空态）；读失败 = 带 error
// （与「空」区分开，写入路径据此中止，避免把读不到的既有变量当成「本来就没有」而整份抹掉）。
//
// 两个作用域共用它：job 作用域读 <dir>/.env，listener 作用域由各托管后端读自己的存储
// （systemd 读 drop-in override.conf）。所以它放在这个叶子模块，不放在任何一边。
export function readSection(file: string, parse: (t: string) => RunnerEnvVar[]): RunnerEnvSection {
  // 直接读、把 ENOENT 归到「不存在」，不先 existsSync：那是一对 check-then-use，两次调用之间
  // 文件被删掉的话会返回 present:true + error，于是 writeRunnerEnv 会为一个根本不存在的文件
  // 中止一次非 replace 写入，并给出一句说不清病因的提示。少一次 stat 只是顺带的好处。
  try {
    return { present: true, vars: parse(fs.readFileSync(file, "utf8")) };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { present: false, vars: [] };
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[runner-env] 读 ${file} 失败: ${msg}`);
    return { present: true, vars: [], error: msg };
  }
}
