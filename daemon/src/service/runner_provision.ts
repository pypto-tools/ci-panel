// CI Panel 扩展：一键 provision 一个 GitHub Actions self-hosted runner。
// 流程：解压安装包 → 落纳管关系（.cipanel + 句柄实例）→ config.sh 注册到 GitHub →
// 交给托管后端拉起。纳管关系刻意排在最前：此后任何一步失败，这个 runner 在面板里仍然
// 看得见、点得动删除，而不是只存在于 GitHub 上。
//
// 托管方式由后端决定（systemd 单元 / daemon 自己 fork），见 service/supervisor/。
// 面板这边的实例只是「句柄」——给文件管理/配置/详情页当抓手（那些接口都按 instanceUuid
// 授权、根在实例 cwd），它不带启动命令、永远不跑 runner，以免和 systemd 双跑抢同一个
// GitHub 身份。（早期版本是 daemon 把 run.sh 当子进程托管，已废弃。）
import fs from "fs-extra";
import path from "path";
import { spawn, execFile, execFileSync } from "child_process";
import { promisify } from "util";
import axios from "axios";

// 异步版 execFile：凡是会碰 systemd 的助手调用都用它。同步跑会冻住 daemon 的单线程事件
// 循环，systemctl 慢多久就冻多久，心跳一丢面板就把整个节点判成掉线（见 runner_scan 顶部）。
const execFileAsync = promisify(execFile);
import InstanceSubsystem from "./system_instance";
import logger from "./log";
import { $t } from "../i18n";
import { writeMarker, readMarker } from "./runner_marker";
// runner_scan 也引本模块，这里构成一个环。安全：module 是 commonjs，命名导入编译成
// 调用点属性访问（tsc 与 webpack 打包皆然），而两侧都只在函数体里运行时相互调用、
// 不在模块作用域求值，所以不会踩到上面第 22 行说的那类初始化顺序问题。
import { assertUnderRoots, readServiceName } from "./runner_scan";
import { backendFor, nodeDefaultSupervisor } from "./supervisor/registry";
import { resolveSupervisor } from "./supervisor/resolve";
import { dirKey, withRunnerLock } from "./runner_lock";
import {
  formatEnvLines,
  MAX_VALUE_LEN,
  sanitizeEnvVars,
  writeDotEnvFile,
  type RunnerEnvVar
} from "./runner_env_vars";
import { envTemplateIndexOf, expandEnvTemplate } from "./runner_env_template";

// 实例类型常量，等于 Instance.TYPE_UNIVERSAL。刻意用字面量而不 import Instance 类：
// instance.ts 处在 instance↔system_instance 的循环里，本模块被 runner_scan 提前引入后，
// 访问 Instance 的静态成员会踩到初始化顺序(TDZ)——「Cannot access 'TYPE_UNIVERSAL' before initialization」。
// createInstance 的 type 只需这个字符串，不必依赖那个类。
const INSTANCE_TYPE_UNIVERSAL = "universal";

// runner 安装包路径（可用环境变量 CIP_RUNNER_PKG 覆盖）
const RUNNER_PKG =
  process.env.CIP_RUNNER_PKG ||
  path.join(process.cwd(), "data/runner-pkg/actions-runner-linux-arm64-2.331.0.tar.gz");

// 下载目录（放新拉取的安装包）
const RUNNER_PKG_DIR = path.dirname(RUNNER_PKG);

// 代理兜底：前端没传就用 daemon 环境变量 CIP_RUNNER_PROXY
function resolveProxy(proxy?: string): string {
  return (proxy || "").trim() || (process.env.CIP_RUNNER_PROXY || "").trim();
}

// 代理在 <dir>/.env 里的那几条。作为默认值写在用户填的初始变量之前（同名以用户的为准）。
function proxyDotEnvVars(proxy: string): RunnerEnvVar[] {
  if (!proxy) return [];
  return [
    { key: "HTTP_PROXY", value: proxy },
    { key: "HTTPS_PROXY", value: proxy },
    { key: "ALL_PROXY", value: proxy },
    { key: "NO_PROXY", value: "localhost,127.0.0.1,::1" }
  ];
}

// actions-runner 自己会往 .env 里塞东西：config.sh 末尾 `source ./env.sh`，而 env.sh 把下面这份
// 清单里「当前进程环境中非空」的变量追加进 <dir>/.env（已有同名的跳过，所以面板先写的那份不会
// 被顶掉）。那个「当前进程」就是 daemon —— 于是 daemon 启动时继承的 LD_LIBRARY_PATH 这类会一路
// 落到每个新建 runner 的 .env 里，用户没填却凭空出现。
//
// 清单抄自安装包 bin/env.sh 的 varCheckList，它属于 runner 版本的一部分：换安装包时回来核对。
// 抄漏一个的后果只是预览少显示一条（写入照旧由 runner 自己做），不影响正确性。
export const RUNNER_ENV_SH_KEYS = [
  "LANG",
  "JAVA_HOME",
  "ANT_HOME",
  "M2_HOME",
  "ANDROID_HOME",
  "ANDROID_SDK_ROOT",
  "GRADLE_HOME",
  "NVM_BIN",
  "NVM_PATH",
  "LD_LIBRARY_PATH",
  "PERL5LIB"
];

// 「不填也会进 .env 的东西」，供面板在创建前如实展示。两个来源分开报，因为它们的覆盖规则不同：
//   panel  —— 面板按代理字段写的，用户在表单里填同名变量即可覆盖
//   runner —— runner 注册时从 daemon 进程环境快照的，用户填了同名变量它就不会再写
export interface DefaultDotEnvPreview {
  proxy: string; // 实际生效的代理（前端没填时是 daemon 的 CIP_RUNNER_PROXY 兜底）
  panel: RunnerEnvVar[];
  runner: RunnerEnvVar[];
}

// 代理参数的长度上限。与 panel 的 utils/proxy 同值、同规则，但两边各查一次是有意的：
// 直连 daemon 的客户端根本不经过 panel，daemon 才是这条链路上真正的边界。
export const MAX_PROXY_ARG_LEN = 512;

export function previewDefaultDotEnv(proxy?: string): DefaultDotEnvPreview {
  // 这个值会被回显进环境变量预览，所以长度和空白都要在用它之前查掉：几 MB 的字符串会顺着
  // socket 走一圈，而带换行的值在环境变量语境里从来就不是「一个值」。
  const raw = String(proxy ?? "").trim();
  if (raw.length > MAX_PROXY_ARG_LEN)
    throw new Error(`代理地址过长(上限 ${MAX_PROXY_ARG_LEN})`);
  if (/\s/.test(raw)) throw new Error("代理地址不能包含空白字符");
  const resolved = resolveProxy(raw);
  const panel = proxyDotEnvVars(resolved);
  const taken = new Set(panel.map((v) => v.key));
  const runner = RUNNER_ENV_SH_KEYS.filter((key) => !taken.has(key))
    .map((key) => ({ key, value: String(process.env[key] ?? "") }))
    .filter((v) => v.value !== "");
  return { proxy: resolved, panel, runner };
}

// 把 http://host:port 代理写进 axios 配置
function applyProxy(cfg: any, proxy?: string) {
  const pxy = resolveProxy(proxy);
  if (!pxy) return;
  const m = pxy.match(/^https?:\/\/([^:/]+):(\d+)/);
  if (m) cfg.proxy = { host: m[1], port: Number(m[2]), protocol: "http" };
}

// runner 架构：arm64 / x64
function runnerArch(): string {
  return process.arch === "arm64" ? "arm64" : "x64";
}

// 从仓库地址提取 owner/repo，作为实例标签（按仓库分组用）
function repoSlug(repoUrl: string): string {
  try {
    const u = new URL(repoUrl);
    const parts = u.pathname
      .replace(/\.git$/i, "")
      .split("/")
      .filter(Boolean);
    if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
    return parts.join("/") || u.hostname;
  } catch {
    return repoUrl;
  }
}

// 在 runner-pkg 目录里挑版本最高的安装包（拉取新版后自动生效）；找不到就用内置默认路径
function resolveLocalPackage(): { path: string; version: string } {
  const arch = runnerArch();
  let best = { path: RUNNER_PKG, version: parseRunnerVersion(RUNNER_PKG) };
  try {
    const re = new RegExp(`^actions-runner-linux-${arch}-\\d+\\.\\d+\\.\\d+\\.tar\\.gz$`);
    for (const f of fs.readdirSync(RUNNER_PKG_DIR)) {
      if (!re.test(f)) continue;
      const v = parseRunnerVersion(f);
      if (v && (!best.version || cmpVersion(v, best.version) > 0)) {
        best = { path: path.join(RUNNER_PKG_DIR, f), version: v };
      }
    }
  } catch {
    // 目录不存在等，忽略
  }
  return best;
}

export interface ProvisionRunnerParams {
  repoUrl: string; // https://github.com/owner/repo
  token: string; // GitHub runner registration token
  name: string; // runner 名称
  labels?: string; // 逗号分隔标签
  targetDir: string; // 绝对路径，runner 安装目录
  proxy?: string; // 可选 http://host:port
  packagePath?: string; // 可选，指定 tar.gz 安装包（导入模式）；不填用内置包
  group?: string; // 可选，所属组（批量时为基础名），写进 .cipanel marker
  // 初始环境变量。两个目标、两套语义，与面板上「环境变量」页写的是同两个文件：
  //   envOverride —— systemd drop-in 的 Environment=，进监听进程（代理这类必须放这里）
  //   envDotenv   —— <dir>/.env，只注入 job/step 执行环境（设备号、库路径这类）
  // 进来时应已展开占位符并经 sanitizeEnvVars 校验（批量入口在 expandBatchSpecs 里做，
  // 好让非法值在整批开跑之前就失败）；这里仍会再 sanitize 一次，因为本函数也被单个置备调用。
  envOverride?: RunnerEnvVar[];
  envDotenv?: RunnerEnvVar[];
  onStep?: (step: string) => void; // 可选，进度回调：每进入一个阶段回报一次
}

// 把 config.sh 的参数表里紧跟 --token 的那一项替换成 ***。
//
// 这是注册 token（GitHub 凭据）不进日志的唯一一道防线：下面 ProvisionError 的 fullLog 会
// 经 BatchItemState.log 一路送到浏览器。刻意导出成独立函数而不内联，是为了能直接对它断言——
// 内联的话测试只能把这行抄一遍，而抄一遍的测试查不出这行自己的错。
//
// 按位置匹配而非按内容：token 本身是随机串，没有可识别的特征。所以参数表的构造方式一旦改动
// （比如 --token 改名），这里会静默失配 —— 那正是需要测试盯住的回归。
export function redactTokenArgs(args: string[]): string[] {
  return args.map((a, i) => (args[i - 1] === "--token" ? "***" : a));
}

// 带完整日志的错误：message 用于展示（截断），fullLog 保留全量输出供前端复制/下载
export class ProvisionError extends Error {
  fullLog: string;
  constructor(message: string, fullLog: string) {
    super(message);
    this.name = "ProvisionError";
    this.fullLog = fullLog;
  }
}

// SIGTERM 之后再等多久上 SIGKILL。给的是「体面退出」的窗口，不是等它慢慢跑完。
const KILL_ESCALATE_MS = 10000;

function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number }
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    // 只有要求超时的调用才 detached。detached 把子进程放进独立进程组，超时时才能连它派生的
    // 孙子进程一起收掉——config.sh 只是个 bash 壳，SIGTERM 发给它不会自动传给底下的
    // Runner.Listener，只杀直接子进程的话 stdio 仍被孙子占着，close 永远不来。
    // 不带超时的调用（tar、curl -sIL）保持原样，免得顺手改掉既有路径的进程语义。
    const detached = Boolean(opts.timeout);
    const p = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, shell: false, detached });

    let softTimer: NodeJS.Timeout | undefined;
    let hardTimer: NodeJS.Timeout | undefined;
    const done = (code: number, extra = "") => {
      if (settled) return; // error / close / 硬超时三条路都可能先到，只认第一个
      settled = true;
      if (softTimer) clearTimeout(softTimer);
      if (hardTimer) clearTimeout(hardTimer);
      // 硬超时那条路是在 close 之前就落定的：管道可能还开着（SIGKILL 打不到已被重新挂靠的
      // 孙子进程时就会这样）。不摘监听器，output 会在 promise 落定后继续无上限地涨；
      // 不 unref，这个 ChildProcess 还会一直吊着事件循环。
      p.stdout?.removeAllListeners("data");
      p.stderr?.removeAllListeners("data");
      p.unref();
      resolve({ code, output: output + extra });
    };

    // 整组发信号。进程组 id 就是组长(直接子进程)的 pid，取负号即可。组可能已经没了——
    // 这时 ESRCH 是正常的，忽略。
    const killGroup = (signal: NodeJS.Signals) => {
      if (!detached || p.pid === undefined) return;
      try {
        process.kill(-p.pid, signal);
      } catch {
        /* 组已退出 */
      }
    };

    if (opts.timeout) {
      softTimer = setTimeout(() => {
        killGroup("SIGTERM");
        // SIGTERM 可能被忽略。到点仍没 close 就 SIGKILL，并且无论如何都把 promise 落定：
        // 这个函数跑在 runner 锁里，挂着不返回等于把该 runner 的所有操作锁到 daemon 重启。
        hardTimer = setTimeout(() => {
          killGroup("SIGKILL");
          done(-1, `\n超时 ${opts.timeout}ms 未结束，已 SIGTERM→SIGKILL 终止整个进程组`);
        }, KILL_ESCALATE_MS);
      }, opts.timeout);
    }

    p.stdout.on("data", (d) => (output += d.toString()));
    p.stderr.on("data", (d) => (output += d.toString()));
    p.on("error", (e) => done(-1, `\n${e.message}`));
    p.on("close", (code, signal) => {
      // 被信号杀掉时退出码是 null，不点破的话调用方只看到一个没有任何解释的失败
      done(code ?? -1, signal ? `\n进程被信号 ${signal} 终止` : "");
    });
  });
}

// config.sh 的超时。它要连 GitHub，走的又常是不稳的代理——代理黑洞掉连接时进程可以永远挂着，
// 而 config.sh 跑在 runner 锁内（注册在置备里、remove 在删除里），一个挂死的子进程会把该
// runner 的删除/置备/启停/改环境变量全部锁到 daemon 重启为止。宁可给一个宽到正常绝不会碰到
// 的上限（正常几秒到几十秒），也不能让锁永远放不掉。
const CONFIG_SH_TIMEOUT_MS = 5 * 60 * 1000;

export async function provisionRunner(params: ProvisionRunnerParams) {
  const targetDir = path.normalize(params.targetDir || "");
  if (!path.isAbsolute(targetDir) || targetDir === "/")
    throw new Error("目标目录必须是绝对路径且不能为根目录 /");
  // 与 deleteRunner 互斥：删除正在等 systemd 停下来的那几十秒里若放行置备，单元会被重新装上
  // 并拉起，而删除随后就把目录删了——留下一个工作目录已不存在的孤儿单元（见 runner_lock）。
  return withRunnerLock([dirKey(targetDir)], "provision", () => runProvision(params, targetDir));
}

// 置备本体。进来时已在锁内，targetDir 已规范化并校验过。
// 刻意用 Omit 去掉 params.targetDir：那是调用方原样传进来、还没规范化的值，而它决定了
// assertBaseDirRepo 的基目录与解压落点——留在类型里迟早有人顺手用错一个。
async function runProvision(
  params: Omit<ProvisionRunnerParams, "targetDir">,
  targetDir: string
) {
  const { repoUrl, token, name } = params;
  const labels = (params.labels || "").trim();
  const proxy = resolveProxy(params.proxy);

  // ---- 校验 ----
  if (!repoUrl || !/^https?:\/\/.+/.test(repoUrl)) throw new Error("仓库地址无效（需 http/https URL）");
  if (!token) throw new Error("注册 token 不能为空");
  if (!name) throw new Error("runner 名称不能为空");
  assertBaseDirRepo(path.dirname(targetDir), repoUrl); // 一个基目录只归一个仓库

  const step = params.onStep || (() => {});

  // 安装包：导入模式用指定 tar.gz，否则用内置包
  const pkg = (params.packagePath || "").trim() || resolveLocalPackage().path;
  if (!fs.existsSync(pkg)) throw new Error(`runner 安装包不存在: ${pkg}`);
  if (!/\.tar\.gz$|\.tgz$/i.test(pkg)) throw new Error(`安装包需为 tar.gz 文件: ${pkg}`);

  // ---- 1) 解压安装包 ----
  await fs.ensureDir(targetDir);
  if (!fs.existsSync(path.join(targetDir, "config.sh"))) {
    step("解压安装包");
    logger.info(`[runner-provision] 解压安装包 ${pkg} 到 ${targetDir}`);
    const r = await run("tar", ["xzf", pkg, "-C", targetDir], {});
    if (r.code !== 0)
      throw new ProvisionError(`解压失败: ${r.output.slice(-500)}`, r.output);
  } else {
    step("安装包已就绪");
  }

  // ---- 1.5) 先把纳管关系落下来，再去碰 GitHub ----
  // 面板要看得见一个 runner，需要两样东西同时存在：.cipanel（纳管关系的真相源）与句柄实例
  // （已纳管目录是遍历实例 cwd 再用 .cipanel 过滤出来的）。此前两者都排在装服务之后，于是装
  // 服务那一步一抛，GitHub 上已经有了身份、本地却两样都没有 —— 这个 runner 在面板里根本不
  // 存在，只能从导入弹窗里捡回来再删。
  //
  // 前移之后，此后任何一步失败都留下一个「面板里看得见、点得动删除」的条目：它的 exists 为
  // false（缺 .runner），列表已有的 exists / broken 字段就能表达这个状态，不需要给 marker 加
  // 什么「置备中」的标记。两个函数本来就幂等（writeMarker 保留已有的 id/source/managedSince，
  // ensureHandleInstance 已有就复用），所以重跑一次置备没有副作用。
  const marker = writeMarker(targetDir, {
    source: "provision",
    repo: repoSlug(repoUrl),
    group: (params.group || "").trim(),
    labels: (params.labels || "").trim(),
    // 托管意图此刻定死并落盘。不能每次从节点能力现推：特权助手哪天坏了，推断结果就会翻成另一
    // 个后端，daemon 会在一个单元还活着的目录里再拉起一个 listener，两个进程抢同一个身份。
    supervisor: nodeDefaultSupervisor()
  });
  step("创建句柄实例");
  const instanceUuid = ensureHandleInstance(targetDir, repoSlug(repoUrl), name);

  // ---- 2) 代理 + 用户填的初始变量写入 <dir>/.env（actions-runner 运行时读取；供 run.sh 上线用）----
  // 在 config.sh 之前写完，所以第一个 job 就带着这些变量跑，不需要先建好再改一遍。
  // 同名以用户填的为准（sanitizeEnvVars 里后者覆盖前者）：代理那四条只是默认值。
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  const dotenvVars = sanitizeEnvVars([...proxyDotEnvVars(proxy), ...(params.envDotenv || [])]);
  if (dotenvVars.length) writeDotEnvFile(targetDir, dotenvVars);
  if (proxy) {
    childEnv.HTTP_PROXY = childEnv.HTTPS_PROXY = childEnv.ALL_PROXY = proxy;
    childEnv.NO_PROXY = "localhost,127.0.0.1,::1";
  }

  // ---- 3) config.sh 注册（已注册则跳过；必须以非 root 运行，daemon 本身即 ci-runner）----
  const alreadyConfigured = fs.existsSync(path.join(targetDir, ".runner"));
  if (!alreadyConfigured) {
    step("注册到 GitHub");
    logger.info(`[runner-provision] 注册 runner ${name} → ${repoUrl}`);
    const args = ["--url", repoUrl, "--token", token, "--name", name, "--work", "_work", "--unattended", "--replace"];
    if (labels) args.push("--labels", labels);

    // 代理连 GitHub CDN 常被中途重置（response ended / reset / TLS 等）。这类是暂时性错误，
    // 而 --replace 让注册幂等（重试会替换掉上次可能残留在 GitHub 的半成品 agent），故多次重试自愈。
    const MAX_ATTEMPTS = 5;
    let r = { code: -1, output: "" };
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      r = await run(path.join(targetDir, "config.sh"), args, {
        cwd: targetDir,
        env: childEnv,
        timeout: CONFIG_SH_TIMEOUT_MS
      });
      if (r.code === 0) break;
      const transient =
        /ended prematurely|ResponseEnded|reset by peer|ECONNRESET|EPIPE|timed?\s*out|timeout|EOF|SSL|TLS handshake|connection|502|503|504|Bad Gateway|Gateway Time-?out/i.test(
          r.output
        );
      if (attempt < MAX_ATTEMPTS && transient) {
        logger.warn(
          `[runner-provision] ${name} 注册第 ${attempt}/${MAX_ATTEMPTS} 次疑似网络中断，重试…（${r.output.slice(-160)}）`
        );
        step(`注册重试 ${attempt}/${MAX_ATTEMPTS - 1}`);
        // 重试前清掉上次半成品，避免 config.sh 因残留文件报"已配置"之类
        for (const leftover of [".credentials", ".credentials_rsaparams", ".runner"]) {
          await fs.remove(path.join(targetDir, leftover)).catch(() => {});
        }
        await sleep(1500 * attempt); // 递增退避 1.5s / 3s / 4.5s / 6s
        continue;
      }
      break;
    }
    if (r.code !== 0) {
      // 最终仍失败：清掉半成品本地文件，便于之后重跑（GitHub 侧若已建 agent，重跑 --replace 会覆盖）
      for (const leftover of [".credentials", ".credentials_rsaparams", ".runner"]) {
        await fs.remove(path.join(targetDir, leftover)).catch(() => {});
      }
      const safeArgs = redactTokenArgs(args);
      throw new ProvisionError(
        `config.sh 注册失败 (code=${r.code}): ${r.output.slice(-800)}`,
        `$ config.sh ${safeArgs.join(" ")}\n(cwd: ${targetDir})\nexit code: ${r.code}\n\n${r.output}`
      );
    }
  } else {
    step("已注册（跳过）");
  }

  // ---- 4) 交给托管后端 ----
  // systemd 节点装单元并 enable --now；无 systemd 的节点记下期望态并把 run.sh 拉起来。
  // 面板这边只留一个句柄实例，给文件管理/配置/详情页用，它不带启动命令、永远不跑 runner。
  //
  // attach 的契约是「成功即在跑」，所以这里不需要再补一次 start；它也**不走 controlRunner**，
  // 那道归属闸门管不到它，防重复拉起由各后端 attach 内部自己保证（systemd 靠助手对已存在单元
  // 的拒绝，process 靠 spawn 前那次 /proc 复核）。
  step($t("TXT_CODE_RUNNER_PROVISION_STEP_SUPERVISOR"));
  const backend = backendFor(resolveSupervisor(targetDir, marker));
  await backend.attach(targetDir);
  // attach 之后才解析动作依据：systemd 下单元名要等助手把 .service 写完才定得下来
  const target = backend.prepare?.(targetDir);

  // ---- 4.5) 初始的监听进程环境变量（代理必须进这里，.env 只进 job/step）----
  // 必须排在 attach 之后：systemd 下单元名要等助手写下 <dir>/.service 才定得下来，而 attach
  // 用的是 enable --now，监听进程在这些变量落盘之前就已经起来了，所以写完要重启一次才生效。
  // 失败按整项失败处理——一个装好却连不上 GitHub（代理没进监听进程）的 runner，比一个明确
  // 失败、可以点「重试失败项」重跑的更难收拾。
  const listenerVars = sanitizeEnvVars(params.envOverride || []);
  if (listenerVars.length) {
    step("写入监听进程环境变量");
    await backend.writeListenerEnv(targetDir, listenerVars, target);
    step("重启使环境变量生效");
    await backend.restart(targetDir, target);
  }

  logger.info(`[runner-provision] 完成: ${backend.kind} 托管 + 句柄实例 ${instanceUuid} (${name})`);
  return {
    instanceUuid,
    nickname: name,
    alreadyConfigured,
    markerId: marker.id
  };
}

// 特权小助手路径（root 所有、ci-runner 不可写；见 prod-scripts/ci-panel-runner-svc）。可用环境变量覆盖。
export const RUNNER_SVC_HELPER =
  process.env.CIP_RUNNER_SVC_HELPER || "/usr/local/sbin/ci-panel-runner-svc";

// catch 到的值类型是 unknown，取「可读文本」这件事在本模块和 runner_scan 里重复出现，
// 统一收在这里narrow一次，避免各处退回 err: any。
export function errText(err: unknown): string {
  if (err instanceof Error) {
    // execFile 的错误对象上挂着 stderr，比 message 更有信息量（同步/异步版都有）
    const stderr = (err as Error & { stderr?: unknown }).stderr;
    const detail = typeof stderr === "string" ? stderr.trim() : "";
    return detail || err.message;
  }
  return String(err);
}

// 调用特权助手的等待上限。systemd 健康时一次 install 约 6 秒，60 秒是余量而不是预期耗时。
export const HELPER_TIMEOUT_MS = 60000;

// execFile 的 timeout 到期时，Node 把子进程 SIGTERM 掉，错误对象上留下的是 killed=true /
// signal="SIGTERM"，而 stderr 基本是空的。于是它和「sudo 拒绝执行」在文本上无法区分——两者
// 都只剩一句 `Command failed: sudo -n …`。按 stderr 正则分类的话，超时会被报成「免密没配」，
// 把排查引向 sudoers（实际发生过：宿主机 D-Bus 卡死导致的超时被当成权限问题查了很久）。
// 所以文本分类之前必须先按信号判一次：只有真跑起来并自己报错的助手，stderr 才有话说。
// 只认 killed=true：那代表「Node 自己动手杀的」，在本模块的用法里只可能是 timeout 到期。
// 不能顺带认 signal==="SIGTERM"——被外面 kill 掉的子进程也是 SIGTERM，但 killed 是 false，
// 认了就会凭空报出一个「等了 60 秒」的超时。
export function isExecTimeout(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { killed?: unknown; code?: unknown };
  return e.killed === true || e.code === "ETIMEDOUT";
}

// 助手调用失败时对外的统一说法。三类必须分开，因为处置完全不同：
//   超时   —— systemd 可能还在处理，该去查状态、稍后重试，绝不是权限问题
//   被拒   —— 免密没配好，该去跑 install-runner-privileges.sh
//   其他   —— 助手自己报的错，原文透出
// 收在这里是因为 install / uninstall / set-env / 启停 四处都要做同一件事，而它们此前各写
// 一份正则，还写出了两种不同的宽严（`sudo:` 与 `^sudo:`）。这里统一取严的那版：`^sudo:` 只
// 认行首，不会被别处出现的 "sudo:" 字样带偏。
export function helperErrorMessage(what: string, err: unknown, timeoutMs: number): string {
  if (isExecTimeout(err))
    return (
      `${what}超时（等了 ${Math.round(timeoutMs / 1000)} 秒）：systemd 未在期限内回应。` +
      `操作可能仍在后台进行，请用 systemctl 确认实际状态后再重试——这不是权限问题。`
    );
  const detail = errText(err);
  if (/password is required|not allowed to execute|^sudo:/im.test(detail))
    return (
      `${what}需要免密 sudo，但未配置。请先安装特权助手与 sudoers 规则` +
      `（见 prod-scripts/ci-panel-runner-svc 与 ci-panel-runner-install.sudoers）。`
    );
  return `${what}失败: ${detail}`;
}

export interface HelperPreflight {
  version: string;
  allowedRoot: string; // 助手允许操作的根目录 —— root 侧真正的边界
}

// 向特权助手要一次自检信息。preflight 无副作用（不碰 systemd、不碰任何 runner 目录），
// 所以可以在 daemon 启动时安全地调。拿不到就返回 null：开发机没装助手、没配免密都属正常，
// 此时调用方退回环境变量即可。
// 这里保留同步调用：它只在启动时被 initRunnerRoots 调一次（扫描根必须在开始服务前定下来），
// 此刻还没有 WebSocket 连接可丢，且 preflight 不碰 systemd，不存在卡几分钟的风险。
export function queryHelperPreflight(): HelperPreflight | null {
  let out = "";
  try {
    out = String(
      execFileSync("sudo", ["-n", RUNNER_SVC_HELPER, "preflight"], {
        encoding: "utf8",
        timeout: 10000
      })
    );
  } catch (err: unknown) {
    // 免密未配、助手没装、助手是不认识 preflight 的旧版 —— 都归到「拿不到」
    logger.warn(`[runner-provision] 助手 preflight 失败: ${errText(err)}`);
    return null;
  }
  if (!/^ok$/m.test(out)) return null;
  const allowedRoot = out.match(/^allowed_root=(.+)$/m)?.[1]?.trim() ?? "";
  const version = out.match(/^version=(.+)$/m)?.[1]?.trim() ?? "";
  return allowedRoot ? { version, allowedRoot } : null;
}

// 把 runner 装成 systemd 服务并 enable+start。daemon 非 root，走 sudo -n 调用只放行了 helper 的白名单。
// 失败(尤其是未配免密 sudo)时抛 ProvisionError，带清晰指引。
// 异步调用：助手里的 systemctl enable --now 会一直等到单元起来，同步跑会冻住 daemon 的事件
// 循环、丢掉 WebSocket 心跳，面板就把整个节点判成掉线。
export async function installSystemdService(dir: string): Promise<void> {
  try {
    const { stdout: out } = await execFileAsync("sudo", ["-n", RUNNER_SVC_HELPER, "install", dir], {
      encoding: "utf8",
      timeout: HELPER_TIMEOUT_MS
    });
    logger.info(`[runner-provision] systemd 安装: ${String(out).trim()}`);
  } catch (err: unknown) {
    // 分类收在 helperErrorMessage 里：超时和「免密没配」在这里长得一模一样，各写一份正则
    // 迟早写歪（此前确实写歪过，见那个函数的注释）。
    throw new ProvisionError(
      helperErrorMessage("装 systemd 服务", err, HELPER_TIMEOUT_MS),
      errText(err)
    );
  }
}

// 写 runner 的 systemd drop-in（override.conf 的 Environment=）+ daemon-reload，不重启。
// 两个调用方：面板改已有 runner 的环境变量（runner_env.writeRunnerEnv），与置备时写初始变量。
// 住在本模块而不是 runner_env，是因为 runner_env 已经引本模块拿助手常量，反向再引就成环。
//
// 异步执行：daemon 是单线程的，而批量接口会连续扇出 N 次，同步跑会在每次 sudo +
// daemon-reload 期间冻结整个事件循环（日志推流、扫描、心跳全停）。
export async function setServiceEnv(dir: string, desired: RunnerEnvVar[]): Promise<void> {
  // 载荷：每行 KEY=VALUE，base64 走 argv（sudo 可审计、无 shell 元字符问题）
  const b64 = Buffer.from(formatEnvLines(desired), "utf8").toString("base64");
  try {
    const r = await execFileAsync("sudo", ["-n", RUNNER_SVC_HELPER, "set-env", dir, b64], {
      encoding: "utf8",
      timeout: HELPER_TIMEOUT_MS
    });
    logger.info(`[runner-env] override: ${String(r.stdout).trim()}（${desired.length} 个变量）`);
  } catch (err: unknown) {
    // 分类统一走 helperErrorMessage：超时与「免密没配」在错误对象上长得一样，各写一份正则
    // 会让超时被报成权限问题（见该函数的注释）。
    throw new Error(helperErrorMessage("设置 systemd 环境变量", err, HELPER_TIMEOUT_MS));
  }
}

// 卸载 runner 的 systemd 服务（停 + 删单元）。走特权助手；幂等——没装服务也不报错。
// 异步调用，理由同 installSystemdService：同步跑会把 daemon 的单线程事件循环整个冻住。
//
// 助手里用的仍是阻塞的 disable --now，「必须等 runner 真停了才能删目录」这个要求不变。但等待
// 已经由调用方(runDelete)在这之前用 --no-block + 轮询完成了：进到这里时服务通常已经 inactive，
// 那条 disable --now 就是空操作、立即返回。留着它是兜底，不再是主要的等待点——单靠它等的话，
// 单元的 TimeoutStopSec 是 5min 而这里只给 HELPER_TIMEOUT_MS，超时是必然而非意外。
export async function uninstallSystemdService(
  dir: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const { stdout: out, stderr: errOut } = await execFileAsync(
      "sudo",
      ["-n", RUNNER_SVC_HELPER, "uninstall", dir],
      { encoding: "utf8", timeout: HELPER_TIMEOUT_MS }
    );
    logger.info(`[runner] systemd 卸载: ${String(out).trim()}`);
    // 助手卸载成功也可能有话要说——比如 drop-in 目录里留着非它写入的配置，删不得。退出码是 0，
    // 不在这里转达的话这条提示就丢了：调用方只看 ok，而 execFile 的 stderr 没有别的去处。
    const warn = String(errOut || "").trim();
    if (warn) logger.warn(`[runner] systemd 卸载提示: ${warn}`);
    return { ok: true };
  } catch (err: unknown) {
    return { ok: false, error: helperErrorMessage("卸载 systemd 服务", err, HELPER_TIMEOUT_MS) };
  }
}

// 从 GitHub 注销 runner：config.sh remove --token <删除token>。以 ci-runner 身份跑，走代理。
// 需要先停掉 runner（否则 GitHub 会拒绝移除在线 runner）——由调用方保证卸载 systemd 在前。
export async function removeGithubRegistration(
  dir: string,
  token: string,
  proxy?: string
): Promise<{ ok: boolean; error?: string }> {
  const configSh = path.join(dir, "config.sh");
  if (!fs.existsSync(configSh)) return { ok: false, error: "config.sh 不存在，无法注销" };
  const pxy = resolveProxy(proxy);
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  if (pxy) {
    childEnv.HTTP_PROXY = childEnv.HTTPS_PROXY = childEnv.ALL_PROXY = pxy;
    childEnv.NO_PROXY = "localhost,127.0.0.1,::1";
  }
  const r = await run(configSh, ["remove", "--token", token], {
    cwd: dir,
    env: childEnv,
    timeout: CONFIG_SH_TIMEOUT_MS
  });
  if (r.code !== 0) return { ok: false, error: r.output.slice(-300) };
  return { ok: true };
}

// 确保某 runner 目录有一个面板实例作为「管理句柄」：文件管理/配置/详情页要复用 MCSManager
// 的实例能力（那些接口都按 instanceUuid 授权、根在实例 cwd 上），所以纳管的 runner 也得有个实例。
// 已有就返回其 uuid，不重复建。句柄实例本身能跑 run.sh，但对 systemd 托管的 runner 前端不暴露它的
// 启停（启停走 systemctl），且 managedBy 的 both 判定按 marker.source 排除 import，故不会误判/双跑。
export function ensureHandleInstance(dir: string, repo: string, agentName: string): string {
  const norm = path.normalize(dir);
  for (const inst of InstanceSubsystem.instances.values()) {
    if (inst?.config?.cwd && path.normalize(inst.config.cwd) === norm) {
      // 自愈：早期句柄实例是按「面板托管」建的，启动命令还留着 bash run.sh。
      // systemd 已是唯一启动路径，这条命令就是个雷——谁从原生实例页点"启动"，
      // 就会和 systemd 同时拉起两个 Runner.Listener 抢同一个 GitHub 身份。收掉它。
      if (inst.config.startCommand) {
        try {
          inst.parameters({ startCommand: "", stopCommand: "" }, true);
          logger.info(`[runner] 收掉句柄实例的启动命令 ${inst.instanceUuid} (${dir})`);
        } catch (err: any) {
          logger.warn(`[runner] 收启动命令失败 ${dir}: ${err?.message || err}`);
        }
      }
      // 仓库标签只在新建实例时设过，复用这条路径从不更新。于是重新纳管、改分组，
      // 或者当初建实例时 .runner 还读不出仓库的那些，标签会一直停在旧值/空值。
      // repo 为空时不动（读不出来不代表原来的就是错的）。
      if (repo && inst.config.tag?.[0] !== repo) {
        try {
          inst.parameters({ tag: [repo] }, true);
          logger.info(`[runner] 对齐句柄实例的仓库标签 ${inst.instanceUuid} → ${repo}`);
        } catch (err: unknown) {
          // 刻意不往上抛：此刻 .cipanel 已经写好，runner 确实被纳管了，为一个标签把整条
          // 纳管报成失败反而更误导。标签只用于实例列表的分组显示，仓库注册表认的是
          // RegisterResult.repo、归堆认的是 .runner，都不读它。记 error 便于事后发现。
          logger.error(`[runner] 对齐仓库标签失败（标签仍是旧值）${dir}: ${errText(err)}`);
        }
      }
      return inst.instanceUuid;
    }
  }
  const instance = InstanceSubsystem.createInstance({
    nickname: agentName || path.basename(dir),
    // 刻意不给启动命令：句柄实例只是文件管理/配置的抓手，runner 由 systemd 跑。
    // 留空后即使误点"启动"也起不来，从根上堵死双跑。
    startCommand: "",
    stopCommand: "",
    cwd: dir,
    type: INSTANCE_TYPE_UNIVERSAL,
    tag: repo ? [repo] : []
  });
  logger.info(`[runner] 建句柄实例 ${instance.instanceUuid} → ${dir}`);
  return instance.instanceUuid;
}

// ---- 批量：多组标签，每组 <基础名>-1..-N ----
// 一组的初始环境变量。值里可写 {{index}} 这类占位符，按每个 runner 各展开一次
// （见 runner_env_template）。
export interface RunnerGroupEnv {
  override?: RunnerEnvVar[]; // systemd drop-in，进监听进程
  dotenv?: RunnerEnvVar[]; // <dir>/.env，只进 job/step
}

export interface RunnerGroup {
  baseName: string; // 基础名，实际名会拼上 -1 -2 ...
  labels?: string; // 该组标签（逗号分隔）
  count: number; // 数量
  env?: RunnerGroupEnv; // 可选，该组每个 runner 的初始环境变量
}

export interface ProvisionBatchParams {
  repoUrl: string;
  token: string;
  proxy?: string;
  baseDir: string; // 基目录，每个 runner 目录 = baseDir/<name>
  groups: RunnerGroup[];
  packagePath?: string; // 可选，指定 tar.gz 安装包（导入模式）
  concurrency?: number; // 同时创建几个（1..10，默认 3）；代理脆时别调太高
}

// 并发度：限制在 1..10。默认 3——既加速又不至于把代理/磁盘打爆（并行注册挤同一个脆代理易触发重试风暴）
const DEFAULT_CONCURRENCY = 3;
const MAX_CONCURRENCY = 10;
function clampConcurrency(n?: number): number {
  const v = Math.floor(Number(n) || 0);
  if (v < 1) return DEFAULT_CONCURRENCY;
  return Math.min(v, MAX_CONCURRENCY);
}

export interface BatchItemResult {
  name: string;
  ok: boolean;
  instanceUuid?: string;
  error?: string;
}

interface BatchSpec {
  name: string;
  labels: string;
  targetDir: string;
  group: string; // 基础名，作为 .cipanel marker 的组
  // 该 runner 的初始环境变量：占位符已按它自己的名字/编号展开、已校验。存在 spec 上而不是组上，
  // 是为了让「重试失败项」原样复用同一份值（重试走的就是 st.specs）。
  envOverride: RunnerEnvVar[];
  envDotenv: RunnerEnvVar[];
}

// 转义正则特殊字符，供按 baseName 前缀匹配用
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 收集「已占用的 runner 名字」，用于采番与防覆盖。两个来源、两种范围：
//   1. 基目录下的既有子目录名 —— 防目录物理覆盖，按 baseDir 天然隔离，照收。
//   2. 已看护句柄实例的昵称 —— 让同一 repo 换基目录也不撞名（GitHub runner 名按 repo 唯一）。
//      关键：只计入 tag 命中「同一 repo」的实例，否则别的 repo 的同名 runner 会污染本 repo
//      的采番，把编号顶高（例：repo A 有 npu-10，会害 repo B 从 npu-11 起）。
// 未传 repoUrl 时退化为收集全部昵称（保持无 repo 上下文的调用兼容）。
// 纯只读；基目录尚不存在时视为无已存在 runner。
function collectUsedNames(baseDir: string, repoUrl?: string): Set<string> {
  const used = new Set<string>();
  try {
    for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
      if (entry.isDirectory()) used.add(entry.name);
    }
  } catch {
    // 基目录首次创建时不存在：忽略
  }
  const wanted = repoUrl ? repoSlug(repoUrl) : "";
  for (const inst of InstanceSubsystem.instances.values()) {
    const nickname = inst?.config?.nickname;
    if (!nickname) continue;
    if (wanted) {
      const tags = inst.config.tag;
      if (!Array.isArray(tags) || !tags.includes(wanted)) continue;
    }
    used.add(String(nickname));
  }
  return used;
}

// 在已占用名字里挑出形如 `${base}-<N>` 的全部 N。0 与负数不收：采番从 1 起，`cpu-0` 只可能
// 是人手建的目录，把它当锚点会算出一个谁都不认识的空缺。
function takenIndexesFor(base: string, used: Set<string>): Set<number> {
  const re = new RegExp(`^${escapeRegExp(base)}-(\\d+)$`);
  const taken = new Set<number>();
  for (const n of used) {
    const m = re.exec(n);
    if (!m) continue;
    const v = Number(m[1]);
    if (Number.isInteger(v) && v > 0) taken.add(v);
  }
  return taken;
}

// 在已占用名字里找形如 `${base}-<N>` 的最大 N（无则 0）
function maxIndexFor(base: string, used: Set<string>): number {
  let max = 0;
  for (const v of takenIndexesFor(base, used)) if (v > max) max = v;
  return max;
}

// 1..max 之间没被占用的编号，升序。删除留下的空缺就是它——采番优先填这些，填完再往后接，
// 免得删掉中间几个之后编号一路飙高、面板上看着全是洞。
function freeIndexesFor(base: string, used: Set<string>): number[] {
  const taken = takenIndexesFor(base, used);
  const free: number[] = [];
  let max = 0;
  for (const v of taken) if (v > max) max = v;
  for (let i = 1; i < max; i++) if (!taken.has(i)) free.push(i);
  return free;
}

// 给一个前缀分配 count 个可用名字：先填删除留下的空缺（升序），填完再接在最大编号之后。
// 会就地把分配出的名字加进 used —— 调用方靠这一点让同一批里的多个组不互相撞名。
//
// 为什么补空缺：删掉中间几个之后编号只会一路往上飙，面板上剩一串洞，而 GitHub 侧的名字
// 已经随注销一起消失了，那些编号本来就是空的。前端预览走同一条规则（AddRunnerDialog 的
// groupNames），两边必须一致，否则用户看到的名字不是最终建出来的名字。
//
// 导出仅为可测：这段没有任何 I/O 副作用，却是整套命名里最容易悄悄回归的一处。
export function allocateRunnerNames(
  prefix: string,
  count: number,
  used: Set<string>,
  baseDir: string
): string[] {
  const free = freeIndexesFor(prefix, used);
  let next = maxIndexFor(prefix, used);
  const names: string[] = [];
  for (let k = 0; k < count; k++) {
    let name = "";
    // used 是 collectUsedNames 的一次快照，之后可能有并发置备落地新目录。逐个验到空的为止，
    // 而不是撞上就报错——补空缺天然要试多个候选，把「候选被占」当异常会让正常路径动不动就失败。
    // next 单调递增，循环必然终止。
    for (;;) {
      const i = free.shift() ?? ++next;
      name = `${prefix}-${i}`;
      if (!used.has(name) && !fs.existsSync(path.join(baseDir, name))) break;
      logger.warn(`[runner-provision] ${name} 已被占用，跳过该编号`);
    }
    used.add(name);
    names.push(name);
  }
  return names;
}

// 标签集合归一化：拆分、去空、小写、去重、排序 → 规范 key。
// "gpu, A100" 与 "a100,GPU" 都 → "a100,gpu"，作为一个 label 组的唯一身份（与顺序/大小写/重复无关）。
export function labelKey(labels: string): string {
  return (labels || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort()
    .join(",");
}

// 一个仓库下、按 label 组聚合的既有 runner 概况。前端据此展示可复用的标签组。
export interface RepoLabelGroup {
  key: string; // labelKey，组身份
  labels: string; // 展示用原始标签（取组内首个 marker 的原样值）
  prefix: string; // 命名前缀（marker.group），采番的锚点
  count: number; // 现有数量
  maxIndex: number; // 现有 `${prefix}-N` 的最大 N
  freeIndexes: number[]; // 1..maxIndex 之间的空缺（升序），新建时优先填这些
}

// 按 repo 聚合出该仓库已有的 label 组（只读）。数据源是「所有 tag 命中该 repo 的句柄实例」，
// 读各自 cwd 下的 .cipanel —— 因此跨基目录也能发现同一 repo 的既有组，与「采番按 repo」同范围。
// 无 labels 的 marker（v1 老 runner / import 导入）不计入——它们标签未知，不作为可复用组。
// baseDir 仍用于 collectUsedNames（把当前基目录的现存目录名纳入采番锚点、防覆盖）。
export function listRepoGroups(baseDir: string, repoUrl: string): RepoLabelGroup[] {
  const base = path.normalize((baseDir || "").trim());
  if (!path.isAbsolute(base) || base === "/")
    throw new Error("基目录必须是绝对路径且不能为根目录 /");
  const wanted = repoSlug(repoUrl);
  const used = collectUsedNames(base, repoUrl);
  const byKey = new Map<string, RepoLabelGroup>();
  const seenDirs = new Set<string>();
  for (const inst of InstanceSubsystem.instances.values()) {
    const cwd = inst?.config?.cwd;
    const tags = inst?.config?.tag;
    if (!cwd || !Array.isArray(tags) || !tags.includes(wanted)) continue;
    const dir = path.normalize(cwd);
    if (seenDirs.has(dir)) continue; // 每个目录只算一次
    seenDirs.add(dir);
    const m = readMarker(dir);
    if (!m || m.repo !== wanted || !m.labels) continue;
    const key = labelKey(m.labels);
    if (!key) continue;
    const prefix = m.group || path.basename(dir).replace(/-\d+$/, "");
    const g =
      byKey.get(key) ??
      {
        key,
        labels: m.labels,
        prefix,
        count: 0,
        maxIndex: maxIndexFor(prefix, used),
        freeIndexes: freeIndexesFor(prefix, used)
      };
    g.count += 1;
    byKey.set(key, g);
  }
  return [...byKey.values()];
}

// 护栏：一个基目录只归一个仓库。扫描 baseDir 下的 .cipanel，若发现属于「其他仓库」的
// runner 就拒绝创建。混放会让采番陷入死结——避让所有磁盘目录则本仓库编号被对方顶高（飙号），
// 只避让本仓库目录则会物理覆盖对方目录。从源头禁止混放，让「目录 = 仓库」的前提恒成立。
function assertBaseDirRepo(baseDir: string, repoUrl: string): void {
  const wanted = repoSlug(repoUrl);
  let names: string[] = [];
  try {
    names = fs.readdirSync(baseDir);
  } catch {
    return; // 目录尚不存在：无冲突
  }
  const conflicts = new Set<string>();
  for (const name of names) {
    const m = readMarker(path.join(baseDir, name));
    if (m && m.repo && m.repo !== wanted) conflicts.add(m.repo);
  }
  if (conflicts.size)
    throw new Error(
      `基目录 ${baseDir} 已被仓库 [${[...conflicts].join(", ")}] 使用，` +
        `请为 ${wanted} 换一个独立的基目录（一个目录只归一个仓库）`
    );
}

// 把一组的初始环境变量展开成某个 runner 的那一份：值里的 {{...}} 按它的名字/编号求值，
// 再走统一的校验。出错时把变量名与 runner 名带上——一整批里只有一条写错时，不点名等于没报错。
// 导出是为了能直接对它断言：批量的成功路径要真跑起来才看得到，而这一步的产物（每台各不相同
// 的那份变量）正是最需要盯住的地方。
export function expandGroupEnv(
  vars: RunnerEnvVar[] | undefined,
  name: string,
  seq: number
): RunnerEnvVar[] {
  if (!Array.isArray(vars) || vars.length === 0) return [];
  const ctx = { name, index: envTemplateIndexOf(name, seq), seq };
  return sanitizeEnvVars(
    vars.map((v) => {
      const key = String(v?.key ?? "");
      const raw = String(v?.value ?? "");
      // 长度在展开之前就查一次。sanitizeEnvVars 也查，但那是展开之后——而展开器是递归下降的，
      // 递归深度随输入长度走，先让它去嚼一个几 MB 的值没有任何意义。
      if (raw.length > MAX_VALUE_LEN)
        throw new Error(`${name} 的环境变量 ${key} 的值过长(上限 ${MAX_VALUE_LEN})`);
      try {
        return { key, value: expandEnvTemplate(raw, ctx) };
      } catch (err: unknown) {
        throw new Error(`${name} 的环境变量 ${key}: ${errText(err)}`);
      }
    })
  );
}

// 校验参数并把多组展开成完整 runner 列表（含名字去重与总数上限）。
// 若某组标签命中该 repo 已有 label 组，强制对齐到既有命名前缀，编号交给 allocateRunnerNames
// （先补空缺、再往后累加）；aligned 汇总被对齐的组，供上层提示「已并入既有组」。
function expandBatchSpecs(p: ProvisionBatchParams): {
  repoUrl: string;
  token: string;
  proxy: string;
  specs: BatchSpec[];
  aligned: { baseName: string; labels: string; prefix: string }[];
} {
  const repoUrl = p.repoUrl;
  const token = p.token;
  const proxy = (p.proxy || "").trim();
  const baseDir = path.normalize(p.baseDir || "");

  if (!repoUrl || !/^https?:\/\/.+/.test(repoUrl)) throw new Error("仓库地址无效（需 http/https URL）");
  if (!token) throw new Error("注册 token 不能为空");
  if (!path.isAbsolute(baseDir) || baseDir === "/")
    throw new Error("基目录必须是绝对路径且不能为根目录 /");
  if (!Array.isArray(p.groups) || p.groups.length === 0) throw new Error("至少需要一组 runner");
  assertBaseDirRepo(baseDir, repoUrl); // 一个基目录只归一个仓库

  const specs: BatchSpec[] = [];
  const aligned: { baseName: string; labels: string; prefix: string }[] = [];
  // 已占用名字：磁盘上的既有目录 + 同 repo 已看护实例名 + 本批已分配。采番在此基础上往后连续排。
  const used = collectUsedNames(baseDir, repoUrl);
  // 该 repo 下已有的 label 组，用于把相同标签的新组对齐到既有命名前缀。
  const repoGroups = listRepoGroups(baseDir, repoUrl);
  for (const g of p.groups) {
    const base = (g.baseName || "").trim();
    const labels = (g.labels || "").trim();
    const count = Number(g.count) || 0;
    if (!base) throw new Error("runner 基础名不能为空");
    if (count < 1 || count > 99) throw new Error(`每组数量需在 1..99，收到 ${g.count}`);
    // 标签命中既有组（集合完全相等）→ 强制沿用既有前缀；否则新组用用户填的 base。
    const existing = labels ? repoGroups.find((rg) => rg.key === labelKey(labels)) : undefined;
    const prefix = existing ? existing.prefix : base;
    if (existing && existing.prefix !== base) aligned.push({ baseName: base, labels, prefix });
    let seq = 0;
    for (const name of allocateRunnerNames(prefix, count, used, baseDir)) {
      seq++;
      specs.push({
        name,
        labels,
        targetDir: path.join(baseDir, name),
        group: prefix,
        // 占位符在这里展开、变量在这里校验：整批还没起就能因为一个写错的表达式失败，
        // 而不是跑到第 7 个 runner 才炸（前 6 个已经注册到 GitHub 了）。
        envOverride: expandGroupEnv(g.env?.override, name, seq),
        envDotenv: expandGroupEnv(g.env?.dotenv, name, seq)
      });
    }
  }
  if (specs.length > 99) throw new Error(`单批最多 99 个 runner，当前 ${specs.length} 个`);
  return { repoUrl, token, proxy, specs, aligned };
}

// 同步批量（保留：一次性阻塞返回全部结果）
export async function provisionRunnerBatch(
  p: ProvisionBatchParams
): Promise<{ results: BatchItemResult[]; aligned: { baseName: string; labels: string; prefix: string }[] }> {
  const { repoUrl, token, proxy, specs, aligned } = expandBatchSpecs(p);
  logger.info(`[runner-provision] 批量: 共 ${specs.length} 个 runner`);
  const results: BatchItemResult[] = [];
  for (const s of specs) {
    try {
      const r = await provisionRunner({
        repoUrl,
        token,
        name: s.name,
        labels: s.labels,
        targetDir: s.targetDir,
        proxy,
        packagePath: p.packagePath,
        group: s.group,
        envOverride: s.envOverride,
        envDotenv: s.envDotenv
      });
      results.push({ name: s.name, ok: true, instanceUuid: r.instanceUuid });
    } catch (err: any) {
      // 单个失败不中断整批
      logger.error(`[runner-provision] ${s.name} 失败: ${err?.message}`);
      results.push({ name: s.name, ok: false, error: err?.message || String(err) });
    }
  }
  return { results, aligned };
}

// ---- 异步批量：后台逐个跑，前端轮询进度（每个 runner 有 状态 + 当前步骤）----
type BatchItemStatus = "pending" | "running" | "done" | "failed";
interface BatchItemState {
  name: string;
  status: BatchItemStatus;
  step: string;
  instanceUuid?: string;
  error?: string; // 简短错误（展示用）
  log?: string; // 完整错误日志（复制/下载用）
}
interface BatchState {
  items: BatchItemState[];
  specs: BatchSpec[]; // 与 items 同序，供"重试失败项"重跑
  repoUrl: string;
  proxy: string;
  packagePath?: string;
  concurrency: number; // 同时创建几个
  done: boolean;
  startedAt: number;
}
const batches = new Map<string, BatchState>();
let batchSeq = 0;

// 跑指定下标的项（初次跑全部；重试只跑失败项）。token 每次现传，不落存。
async function runBatchItems(id: string, token: string, indices: number[]) {
  const st = batches.get(id)!;
  st.done = false;

  // 限并发工作池：起 K 个 worker，各自从共享游标领任务，领空即退出。
  // 每个 item 独立更新自己的 status/step，进度上报不受并发影响。
  const conc = Math.min(clampConcurrency(st.concurrency), indices.length || 1);

  async function runOne(i: number) {
    const s = st.specs[i];
    const item = st.items[i];
    item.status = "running";
    item.step = "开始";
    item.error = undefined;
    item.log = undefined;
    try {
      const r = await provisionRunner({
        repoUrl: st.repoUrl,
        token,
        name: s.name,
        labels: s.labels,
        targetDir: s.targetDir,
        proxy: st.proxy,
        packagePath: st.packagePath,
        group: s.group,
        envOverride: s.envOverride,
        envDotenv: s.envDotenv,
        onStep: (step) => {
          item.step = step;
        }
      });
      item.status = "done";
      item.step = r.alreadyConfigured ? "完成（已注册，跳过）" : "完成";
      item.instanceUuid = r.instanceUuid;
    } catch (err: any) {
      logger.error(`[runner-provision] ${s.name} 失败: ${err?.message}`);
      item.status = "failed";
      item.step = "失败";
      item.error = err?.message || String(err);
      item.log = err?.fullLog || err?.message || String(err);
    }
  }

  let cursor = 0;
  async function worker() {
    while (true) {
      const at = cursor++;
      if (at >= indices.length) return;
      await runOne(indices[at]);
    }
  }
  await Promise.all(Array.from({ length: conc }, () => worker()));

  st.done = true;
  logger.info(`[runner-provision] 批量任务 ${id} 本轮结束（并发 ${conc}）`);
}

// 启动后台批量，立刻返回 batchId + 初始清单
export function startRunnerBatch(
  p: ProvisionBatchParams
): { batchId: string; items: { name: string }[]; aligned: { baseName: string; labels: string; prefix: string }[] } {
  const { repoUrl, token, proxy, specs, aligned } = expandBatchSpecs(p);
  const id = `b${++batchSeq}`;
  const items: BatchItemState[] = specs.map((s) => ({
    name: s.name,
    status: "pending",
    step: ""
  }));
  const concurrency = clampConcurrency(p.concurrency);
  batches.set(id, {
    items,
    specs,
    repoUrl,
    proxy,
    packagePath: p.packagePath,
    concurrency,
    done: false,
    startedAt: Date.now()
  });
  logger.info(
    `[runner-provision] 批量任务 ${id} 启动，共 ${specs.length} 个 runner（并发 ${concurrency}）`
  );
  // 后台跑，不阻塞
  runBatchItems(
    id,
    token,
    specs.map((_, i) => i)
  );
  return { batchId: id, items: items.map((i) => ({ name: i.name })), aligned };
}

// 重试某批的失败项：用新传入的 token（旧的可能已过期），可选覆盖代理。--replace 幂等，会收编 GitHub 孤儿。
export function retryFailedBatch(
  batchId: string,
  token: string,
  proxy?: string
): { batchId: string; retrying: number } {
  const st = batches.get(batchId);
  if (!st) throw new Error("批量任务不存在（可能已过期），请重新创建");
  if (!token || !String(token).trim()) throw new Error("重试需要提供注册 token");
  if (proxy !== undefined) st.proxy = resolveProxy(proxy);
  const failedIdx = st.items.map((it, i) => (it.status === "failed" ? i : -1)).filter((i) => i >= 0);
  if (!failedIdx.length) throw new Error("没有失败项可重试");
  // 先把失败项置回 pending，前端轮询能立刻看到"排队中"
  for (const i of failedIdx) {
    st.items[i].status = "pending";
    st.items[i].step = "等待重试";
  }
  logger.info(`[runner-provision] 批量任务 ${batchId} 重试 ${failedIdx.length} 个失败项`);
  runBatchItems(batchId, String(token).trim(), failedIdx);
  return { batchId, retrying: failedIdx.length };
}

// 查询批量进度
export function getRunnerBatchProgress(id: string) {
  const st = batches.get(id);
  if (!st) throw new Error("批量任务不存在（可能已过期）");
  const total = st.items.length;
  const doneCount = st.items.filter((i) => i.status === "done").length;
  const failCount = st.items.filter((i) => i.status === "failed").length;
  return {
    done: st.done,
    total,
    doneCount,
    failCount,
    items: st.items.map((i) => ({
      name: i.name,
      status: i.status,
      step: i.step,
      instanceUuid: i.instanceUuid,
      error: i.error,
      log: i.log
    }))
  };
}

// ---- 收集：扫描基目录，把"已注册(有 .runner)但面板还没建实例"的 runner 纳入看护 ----
export interface CollectResult {
  baseDir: string;
  collected: { name: string; instanceUuid: string; repo: string }[];
  skipped: { name: string; reason: string }[];
}

export function collectRunners(baseDir: string): CollectResult {
  const base = path.normalize((baseDir || "").trim());
  if (!path.isAbsolute(base) || base === "/")
    throw new Error("基目录必须是绝对路径且不能为根目录 /");
  // baseDir 来自前端（runner_router.ts 原样透传 data.baseDir），必须落在扫描根之内。
  // 少了这一句，任意目录都能被纳管：下面对每个匹配的子目录会 ensureHandleInstance +
  // writeMarker，而句柄实例的 cwd 就是文件管理接口的根 —— 等于把任意路径变成可网页浏览。
  //
  // 必须排在所有 fs.* 之前：放到存在性检查之后的话，「不存在」和「越界」会给出两种不同的
  // 报错，等于把这个接口变成任意路径的存在性探针。readRunnerDiag 里也是同样的顺序。
  assertUnderRoots(base);
  if (!fs.existsSync(base) || !fs.statSync(base).isDirectory())
    throw new Error(`基目录不存在或不是目录: ${base}`);

  // 已看护的 cwd 集合（判重）
  const managed = new Set<string>();
  for (const inst of InstanceSubsystem.instances.values()) {
    const cwd = inst?.config?.cwd;
    if (cwd) managed.add(path.normalize(cwd));
  }

  const collected: CollectResult["collected"] = [];
  const skipped: CollectResult["skipped"] = [];

  for (const name of fs.readdirSync(base)) {
    const dir = path.join(base, name);
    // 逐个子项复核：base 在扫描根内不代表子项也在——子项可以是指向根外的符号链接，
    // 而下面的 statSync 会跟随它。这里跳过而不是整体抛错，免得一个坏链接
    // 让整次收集失败（下面 statSync 失败时也是同样的跳过语义）。
    try {
      assertUnderRoots(dir);
    } catch {
      skipped.push({ name, reason: "不在扫描根内（可能是符号链接）" });
      continue;
    }
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const hasRunner = fs.existsSync(path.join(dir, ".runner"));
    const hasRun = fs.existsSync(path.join(dir, "run.sh"));
    if (!hasRunner) {
      skipped.push({ name, reason: "未注册（无 .runner）" });
      continue;
    }
    if (!hasRun) {
      skipped.push({ name, reason: "缺 run.sh（安装包不完整）" });
      continue;
    }
    if (managed.has(path.normalize(dir))) {
      skipped.push({ name, reason: "已在看护" });
      continue;
    }
    // 从 .runner 读仓库地址与 agent 名（文件带 BOM，需去掉）
    let repo = "";
    let nickname = name;
    try {
      const raw = fs.readFileSync(path.join(dir, ".runner"), "utf8").replace(/^\uFEFF/, "");
      const j = JSON.parse(raw);
      if (j.gitHubUrl) repo = repoSlug(String(j.gitHubUrl));
      if (j.agentName) nickname = String(j.agentName);
    } catch {
      // .runner 解析失败：仍收集，只是没仓库标签
    }
    try {
      // 统一走 ensureHandleInstance：句柄实例只作抓手、不带启动命令（systemd 才跑 runner）
      const instanceUuid = ensureHandleInstance(dir, repo, nickname);
      // 纳入看护的同时写 .cipanel，让它进入日常展示；来源记为 import（既有 runner 被收编）
      writeMarker(dir, { source: "import", repo });
      managed.add(path.normalize(dir));
      collected.push({ name, instanceUuid, repo });
      logger.info(`[runner-collect] 纳入 ${name} → 实例 ${instanceUuid} (repo=${repo})`);
    } catch (err: any) {
      skipped.push({ name, reason: "建实例失败: " + (err?.message || String(err)) });
    }
  }
  logger.info(
    `[runner-collect] 扫描 ${base} 完成：纳入 ${collected.length}，跳过 ${skipped.length}`
  );
  return { baseDir: base, collected, skipped };
}

// ---- 检查：直接创建查版本/更新；导入压缩包查路径 ----
function parseRunnerVersion(p: string): string {
  const m = p.match(/(\d+\.\d+\.\d+)\.(?:tar\.gz|tgz)$/i);
  return m ? m[1] : "";
}

function cmpVersion(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

async function fetchLatestRunnerVersion(proxy?: string): Promise<string> {
  const cfg: any = { timeout: 10000, headers: { "User-Agent": "ci-panel" } };
  applyProxy(cfg, proxy);
  const res = await axios.get(
    "https://api.github.com/repos/actions/runner/releases/latest",
    cfg
  );
  const tag = res.data?.tag_name || ""; // 形如 v2.335.1
  return tag.replace(/^v/, "");
}

export interface CheckParams {
  mode: "direct" | "import";
  packagePath?: string;
  proxy?: string;
}

export async function checkRunnerPackage(params: CheckParams) {
  if (params.mode === "import") {
    const p = (params.packagePath || "").trim();
    if (!p) throw new Error("请先填写压缩包路径");
    const exists = fs.existsSync(p) && fs.statSync(p).isFile();
    const isTarGz = /\.tar\.gz$|\.tgz$/i.test(p);
    return {
      mode: "import",
      path: p,
      exists,
      isTarGz,
      sizeMB: exists ? Math.round((fs.statSync(p).size / 1e6) * 10) / 10 : 0,
      version: exists ? parseRunnerVersion(p) : ""
    };
  }

  // direct：取本地最高版本的包 + 尝试查 GitHub 最新版
  const local = resolveLocalPackage();
  const exists = fs.existsSync(local.path);
  const localVersion = local.version;
  let latestVersion = "";
  let updateAvailable = false;
  let checkError = "";
  try {
    latestVersion = await fetchLatestRunnerVersion(params.proxy);
    if (latestVersion && localVersion) {
      updateAvailable = cmpVersion(localVersion, latestVersion) < 0;
    }
  } catch (err: any) {
    checkError = err?.message || String(err);
  }
  return {
    mode: "direct",
    path: local.path,
    exists,
    localVersion,
    latestVersion,
    updateAvailable,
    checkError
  };
}

// ---- 代理连通性检测：用当前代理探测 GitHub / Google 等目标 ----
export interface ProxyCheckTargetResult {
  name: string;
  url: string;
  ok: boolean;
  status?: number;
  ms: number;
  error?: string;
}

// 探测目标：runner 注册/下载依赖 GitHub，Google 用来判断外网整体是否通
const PROXY_CHECK_TARGETS: { name: string; url: string }[] = [
  { name: "GitHub", url: "https://github.com" },
  { name: "GitHub API", url: "https://api.github.com" },
  { name: "Google", url: "https://www.google.com" }
];

// 用给定代理（前端不传则回退 CIP_RUNNER_PROXY）逐个探测目标；
// 只要拿到 HTTP 响应（即使 3xx/4xx）就算「通」——说明代理已把请求送达目标。
export async function checkProxyConnectivity(proxy?: string) {
  const usedProxy = resolveProxy(proxy);
  const results = await Promise.all(
    PROXY_CHECK_TARGETS.map(async (t): Promise<ProxyCheckTargetResult> => {
      const started = Date.now();
      const cfg: any = {
        timeout: 8000,
        headers: { "User-Agent": "ci-panel" },
        validateStatus: () => true,
        maxRedirects: 0
      };
      applyProxy(cfg, proxy);
      try {
        const res = await axios.get(t.url, cfg);
        return { name: t.name, url: t.url, ok: true, status: res.status, ms: Date.now() - started };
      } catch (err: any) {
        return {
          name: t.name,
          url: t.url,
          ok: false,
          ms: Date.now() - started,
          error: err?.message || String(err)
        };
      }
    })
  );
  return { proxy: usedProxy, results };
}

// ---- 下载：用 curl 从 GitHub 拉取（走代理 + 跟随重定向最稳；进度用轮询临时文件大小）----
interface DownloadState {
  total: number;
  received: number;
  done: boolean;
  error?: string;
  path: string;
  tmp: string;
  version: string;
  lastAt: number;
  lastReceived: number;
}
const downloads = new Map<string, DownloadState>();
let downloadSeq = 0;

// 通过 curl -sIL 拿最终 content-length（best-effort）
async function headContentLength(url: string, proxy: string): Promise<number> {
  // --http1.1 避开代理对 HTTP/2 的 framing 错误（curl code 92）
  const args = ["-sIL", "--http1.1", "--max-time", "25"];
  if (proxy) args.push("-x", proxy);
  args.push("-A", "ci-panel", url);
  const r = await run("curl", args, {});
  const matches = [...r.output.matchAll(/content-length:\s*(\d+)/gi)];
  return matches.length ? Number(matches[matches.length - 1][1]) : 0;
}

// 跑一次 curl（断点续传），返回退出码
function runCurlResume(url: string, tmp: string, proxy: string): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    // --http1.1 避开代理 HTTP/2 framing 错误(code 92)；-C - 断点续传；-L 跟随重定向
    const args = ["-sL", "--http1.1", "-C", "-", "--max-time", "0", "-A", "ci-panel", "-o", tmp];
    if (proxy) args.push("-x", proxy);
    args.push(url);
    const proc = spawn("curl", args, { shell: false });
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", (e) => resolve({ code: -1, stderr: e.message }));
    proc.on("close", (code) => resolve({ code: code ?? -1, stderr }));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function doDownload(id: string, url: string, dest: string, proxy: string) {
  const st = downloads.get(id)!;
  const tmp = st.tmp;
  try {
    await fs.ensureDir(path.dirname(dest));
    if (fs.existsSync(tmp)) await fs.remove(tmp); // 清掉旧的部分文件
    st.total = await headContentLength(url, proxy).catch(() => 0);

    // 代理不稳会中途断连，用断点续传 + 重试直到下完
    const MAX_ATTEMPTS = 40;
    let ok = false;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const { code, stderr } = await runCurlResume(url, tmp, proxy);
      const size = fs.existsSync(tmp) ? fs.statSync(tmp).size : 0;
      // 完成判据：curl 成功 或 已下到总大小
      if ((code === 0 || (st.total && size >= st.total)) && size > 0) {
        if (!st.total || size >= st.total) {
          ok = true;
          break;
        }
      }
      if (attempt === MAX_ATTEMPTS) {
        throw new Error(`下载多次中断未完成 (最后 code=${code}) ${stderr.slice(-160)}`);
      }
      logger.info(
        `[runner-download] 第 ${attempt} 次中断(code=${code})，已下 ${Math.round(size / 1e6)}MB，续传中…`
      );
      await sleep(1500);
    }

    await fs.move(tmp, dest, { overwrite: true });
    if (st.total) st.received = st.total;
    st.done = true;
    logger.info(`[runner-download] 完成: ${dest}`);
  } catch (err: any) {
    st.error = err?.message || String(err);
    st.done = true;
    try {
      if (fs.existsSync(tmp)) await fs.remove(tmp);
    } catch {
      // ignore
    }
    logger.error(`[runner-download] 失败: ${st.error}`);
  }
}

export async function startRunnerDownload(params: {
  version?: string;
  proxy?: string;
  force?: boolean; // 本地已有同版本包时是否强制重下（覆盖）；默认 false → 跳过
}): Promise<{ downloadId: string; version: string; url: string; skipped: boolean }> {
  const proxy = resolveProxy(params.proxy);
  logger.info(`[runner-download] 代理: ${proxy || "(直连)"}`);
  const version = (params.version || "").trim() || (await fetchLatestRunnerVersion(proxy));
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`无法确定要下载的版本: ${version}`);
  const arch = runnerArch();
  const file = `actions-runner-linux-${arch}-${version}.tar.gz`;
  const url = `https://github.com/actions/runner/releases/download/v${version}/${file}`;
  const dest = path.join(RUNNER_PKG_DIR, file);
  const id = `dl${++downloadSeq}`;

  // 本地已有同版本包：默认直接跳过下载，造一个"已完成"任务让前端进度轮询立刻拿到 done+path。
  // 需要覆盖重下时前端传 force:true。
  if (!params.force) {
    let existingSize = 0;
    try {
      if (fs.existsSync(dest)) existingSize = fs.statSync(dest).size;
    } catch {
      // ignore
    }
    if (existingSize > 0) {
      downloads.set(id, {
        total: existingSize,
        received: existingSize,
        done: true,
        path: dest,
        tmp: `${dest}.downloading`,
        version,
        lastAt: Date.now(),
        lastReceived: existingSize
      });
      logger.info(`[runner-download] 本地已有同版本，跳过下载: ${dest}`);
      return { downloadId: id, version, url, skipped: true };
    }
  }

  downloads.set(id, {
    total: 0,
    received: 0,
    done: false,
    path: dest,
    tmp: `${dest}.downloading`,
    version,
    lastAt: Date.now(),
    lastReceived: 0
  });
  logger.info(`[runner-download] 开始 ${version} (${arch}) → ${dest}`);
  // 后台下载，不阻塞
  doDownload(id, url, dest, proxy);
  return { downloadId: id, version, url, skipped: false };
}

export function getRunnerDownloadProgress(id: string) {
  const st = downloads.get(id);
  if (!st) throw new Error("下载任务不存在（可能已过期）");
  // curl 边下边写临时文件，进度 = 临时文件当前大小（完成后临时文件已 move 走，用 total）
  if (!st.done) {
    try {
      st.received = fs.existsSync(st.tmp) ? fs.statSync(st.tmp).size : 0;
    } catch {
      // ignore
    }
  }
  const now = Date.now();
  const dt = (now - st.lastAt) / 1000;
  const speed = dt > 0 ? Math.max(0, Math.round((st.received - st.lastReceived) / dt)) : 0;
  st.lastAt = now;
  st.lastReceived = st.received;
  return {
    total: st.total,
    received: st.received,
    percent: st.total ? Math.round((st.received / st.total) * 100) : 0,
    speed, // bytes/s
    done: st.done,
    error: st.error,
    version: st.version,
    // 只有成功完成才返回路径（供创建时用）
    path: st.done && !st.error ? st.path : ""
  };
}
