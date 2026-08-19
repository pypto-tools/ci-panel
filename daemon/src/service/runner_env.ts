// CI Panel 扩展：管理 runner 的环境变量。两个**作用域**、两套语义（这批机器的 runsvc.sh
// 不 source .env）：
//
//   listener —— 进「监听进程」自己的环境。代理这类要让 Runner.Listener 连上 GitHub 的变量
//               必须放这里。**存在哪儿由托管后端说了算**：systemd 后端写 root 拥有的 drop-in
//               （经特权助手），process 后端写 daemon 私有目录里的一份 env 文件。
//   job      —— runner 目录下的 .env。runsvc 不 source 它，故不进监听进程，只被 runner 程序
//               读取、注入到每个 job/step 的执行环境（设备号、库路径这类）。文件属主即 daemon
//               运行用户，读写都直接走 fs。
//
// 线上字段名仍叫 override / dotenv（见 common 的 EnvTarget）：改名会让新前端发给老 daemon 的
// 值落到它那条宽松归一上，把只该进 job 的变量静默写进 root 拥有的 drop-in。映射只在路由边界
// 做一次，本模块内部一律用作用域说话。
//
// 两个作用域都是「面板整表托管」：读回显 → 用户编辑 → 覆盖写回。变量名白名单、值禁换行，防注入。
import fs from "fs-extra";
import path from "path";
import { $t } from "../i18n";
import { canonicalPath } from "../tools/path_link_check";
import { assertUnderRoots } from "./runner_scan";
import { readMarker } from "./runner_marker";
import { backendFor } from "./supervisor/registry";
import { resolveSupervisor } from "./supervisor/resolve";
import { dirKey, withRunnerLock } from "./runner_lock";
import {
  dotenvPath,
  readSection,
  sanitizeEnvVars,
  writeDotEnvFile,
  type RunnerEnvVar
} from "./runner_env_vars";
import type { EnvTarget, RunnerEnvResult, RunnerEnvSection } from "mcsmanager-common";

// 内部作用域。与线上取值的映射只在路由边界做一次（见 scopeOfTarget）
export type EnvScope = "listener" | "job";

// 线上取值 → 内部作用域。表驱动：协议加一个作用域时这张 Record 会编译失败。
const SCOPE_BY_TARGET: Record<EnvTarget, EnvScope> = {
  override: "listener",
  dotenv: "job"
};

/**
 * 映射不到就**抛**，不许照抄老 daemon 路由层那句 `target === "dotenv" ? "dotenv" : "override"`
 * 的宽松归一：那句话会把任何认不出的值归成 override，于是只该进 job 的变量（设备号、库路径）
 * 被写进 root 拥有的 drop-in，还泄进监听进程自己的环境。宁可让请求失败。
 */
export function scopeOfTarget(target: unknown): EnvScope {
  // hasOwnProperty 而不是直接索引：target 来自请求体，`"toString"` 会从原型链上取到一个函数，
  // 真值判断放它过去，随后被当成作用域用 —— 与 controlRunner 校验动作名时同一条理由。
  if (typeof target !== "string" || !Object.prototype.hasOwnProperty.call(SCOPE_BY_TARGET, target))
    throw new Error($t("TXT_CODE_RUNNER_ENV_TARGET_UNKNOWN", { target: String(target) }));
  return SCOPE_BY_TARGET[target as EnvTarget];
}

export type { EnvTarget, RunnerEnvResult, RunnerEnvSection, RunnerEnvVar };

// set 的补丁：replace=true 时整表覆盖(upsert 即完整清单)；否则合并(upsert 增改、remove 删)。
export interface RunnerEnvPatch {
  upsert?: RunnerEnvVar[];
  remove?: string[];
  replace?: boolean;
}

// 校验并规范化 runner 目录：绝对路径、在扫描根内、含 .runner。
// canonicalPath 而不是 normalize：同一个 runner 在这条路上必须算出与归属判定完全相同的字符串，
// 否则软链节点上这里锁的 key 与那边比对的 key 不是同一个。
function normalizeRunnerDir(dirRaw: string): string {
  const dir = canonicalPath(String(dirRaw || ""));
  assertUnderRoots(dir);
  if (!fs.existsSync(path.join(dir, ".runner")))
    throw new Error(`不是 runner 目录(缺 .runner): ${dir}`);
  return dir;
}

// 这个目录归哪个后端管。读它的 marker 意图，marker 缺失/老版本时按「装过单元的算 systemd，
// 其余交给节点默认」推断（见 resolveSupervisor）。
function backendOf(dir: string) {
  return backendFor(resolveSupervisor(dir, readMarker(dir)));
}

// 解析 .env：每行 KEY=VALUE，按首个 = 切分，值原样（不去引号）。跳过空行与 # 注释。
function parseDotEnv(text: string): RunnerEnvVar[] {
  const vars: RunnerEnvVar[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    vars.push({ key: line.slice(0, eq).trim(), value: line.slice(eq + 1) });
  }
  return vars;
}

/**
 * 读某 runner 两个作用域当前托管的环境变量（面板回显用，均只读、免 sudo）。
 *
 * listener 那一节由后端给：**「能不能写监听进程的环境变量」从此由后端回答，不再由「有没有
 * systemd 单元」回答** —— 那正是这条修复的要点，无 systemd 的节点此前在面板上根本没有配代理
 * 的入口。
 *
 * 因为后端的 readListenerEnv 返回 Promise（容器后端要 docker inspect、远端要一次 RPC），
 * 本函数跟着变成 async；三个后端的实现体照样是同步文件读，包一层的成本是零。
 */
export async function readRunnerEnv(dirRaw: string): Promise<RunnerEnvResult> {
  const dir = normalizeRunnerDir(dirRaw);
  const backend = backendOf(dir);
  return {
    dir,
    supervisor: backend.kind,
    canWriteListenerEnv: backend.kind !== "none",
    hasSystemd: backend.kind === "systemd", // @deprecated，1.2 移除，届时只留 canWriteListenerEnv
    // 线上字段名不改（见文件头）：override 装的就是 listener 作用域那一节
    override: await backend.readListenerEnv(dir, backend.prepare?.(dir)),
    dotenv: readSection(dotenvPath(dir), parseDotEnv)
  };
}

// 计算「目标全量」：replace 直接用 upsert；merge 用 current 打底、应用 upsert/remove。
// merge 保留各 runner 自己已有的变量（如每台不同的 DEVICE_ID），只增改指定项、删除 remove。
function resolveDesired(current: RunnerEnvVar[], patch: RunnerEnvPatch): RunnerEnvVar[] {
  const upsert = sanitizeEnvVars(Array.isArray(patch.upsert) ? patch.upsert : []);
  if (patch.replace) return upsert;
  const removeSet = new Set((Array.isArray(patch.remove) ? patch.remove : []).map(String));
  const map = new Map<string, string>();
  for (const v of current) map.set(v.key, v.value); // 当前值打底
  for (const v of upsert) map.set(v.key, v.value); // upsert 覆盖
  for (const k of removeSet) map.delete(k); // remove 删除
  return sanitizeEnvVars(Array.from(map, ([key, value]) => ({ key, value })));
}

/**
 * 设置某 runner 某作用域的环境变量。listener 交给后端（systemd 走特权助手写 drop-in，
 * process 写 daemon 私有的 env 文件），job 直接写 <dir>/.env。
 * 两者都不重启：生效由面板另走 restart（带 busy 拦截）。
 */
export async function writeRunnerEnv(
  dirRaw: string,
  scope: EnvScope,
  patch: RunnerEnvPatch
): Promise<RunnerEnvResult> {
  const dir = normalizeRunnerDir(dirRaw);
  const backend = backendOf(dir);
  // 动作依据一次解析：读 .service 只发生在 prepare 里，写入与占锁用的是同一份
  const target = backend.prepare?.(dir);
  // 与删除互斥：listener 作用域在 systemd 下是往 /etc/systemd/system/<svc>.d/ 写 drop-in，
  // 删除窗口里放行它，就会给一个正被卸掉的单元留下 drop-in 目录（助手的 uninstall 不清它）。
  // job 作用域只写 <dir>/.env，与单元无关，所以不占后端那把 key：占了反而会和一次慢重启
  // （助手 60 秒超时）互相挡，而「存 .env → 另点重启生效」正是页面上的常规操作顺序。
  const keys = [dirKey(dir)];
  if (scope === "listener") keys.push(...(target?.lockKeys ?? []));
  return withRunnerLock(keys, "env", async () => {
    const current = await readRunnerEnv(dir);
    const section = scope === "listener" ? current.override : current.dotenv;
    // merge 以当前值打底，读不出来就不能写：否则会把既有变量当成「没有」而整份抹掉。
    // replace 是整表覆盖、不依赖当前值，读失败不影响。
    if (section.error && !patch?.replace)
      throw new Error(`读取现有环境变量失败，已中止写入以免误删：${section.error}`);
    const desired = resolveDesired(section.vars, patch || {});
    if (scope === "listener") await backend.writeListenerEnv(dir, desired, target);
    else writeDotEnvFile(dir, desired);
    return readRunnerEnv(dir);
  });
}
