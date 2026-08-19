// CI Panel 扩展：process 后端的私有状态存储。
//
// 落点是 daemon 自己的数据目录（daemon/data/RunnerRuntime/），**不是 runner 目录**。
// runner 目录对 daemon 用户可写，把 pgid 放在那里就等于让面板变成一条「任意 kill」通道；
// 与 .service 的符号链接检查是同一条边界。
//
// 状态文件丢了也不致命：/proc 是终极真相源，这个文件只回答「这个 listener 是不是我们拉起的」。
// 丢了之后一个我们拉起的进程会被判成 foreign —— 保守但安全，用户看得见告警、可以处置。
import fs from "fs-extra";
import path from "path";

import logger from "../../log";
import { readMarker } from "../../runner_marker";
import { formatEnvLines, readSection, sanitizeEnvVars } from "../../runner_env_vars";
import type { RunnerEnvSection, RunnerEnvVar } from "mcsmanager-common";

export interface RunnerRuntime {
  v: 1;
  dir: string; // canonicalPath 归一过
  pgid: number;
  // 最近一次**成功**拉起的时刻。只在 spawn 拿到 pid 后更新
  startedAt: number;
  // 最近一次**尝试**拉起的时刻（成功与否都更新）。退避判据用它，不用 startedAt——
  // 一个从来没起来过的 runner 永远没有 startedAt，拿它算退避等于不退避。
  lastAttemptAt: number;
  // 期望态。reconcile 用它决定要不要把进程拉回来
  desired: "running" | "stopped";
  // 0 = 没在停。落盘是为了让停止阶梯跨 daemon 重启也能继续升级信号
  stopRequestedAt: number;
  // 停止阶梯已经发到第几级（STOP_LADDER 的下标 + 1，0 = 一级都没发）。单调推进，发过的不重发：
  // 没有这个字段就只能按 elapsed 反查级别，而 reconcile 是 15 秒一拍，30s~300s 之间每拍都会
  // 重发同一级信号（约 18 次），对 Runner.Listener 反复发中断有「二次中断即强杀」的语义风险。
  stopStage: number;
  failures: number; // 连续启动失败次数，退避用
  lastError: string; // 最后一次失败原因，填进 RunnerRuntimeState.detail 让用户看得见
}

const RUNTIME_DIR = path.join(process.cwd(), "data", "RunnerRuntime");
const RUN_LOG_DIR = path.join(RUNTIME_DIR, "logs");

// markerId 会被拼进文件路径，必须校验形状。marker 的 id 是去掉横杠的 uuid（见 runner_marker
// 的 v4().replace），所以 32 位十六进制是它唯一的合法形状。不校验就等于让 marker 的内容
// （runner 属主可写）决定 daemon 往哪写文件。
const MARKER_ID_RE = /^[0-9a-f]{32}$/;

function assertMarkerId(markerId: string): string {
  if (!MARKER_ID_RE.test(markerId)) throw new Error(`非法的 markerId: ${markerId}`);
  return markerId;
}

export function runtimePath(markerId: string): string {
  return path.join(RUNTIME_DIR, `${assertMarkerId(markerId)}.json`);
}

// 监听进程作用域的环境变量文件（代理必须放这里）。spawn 时注入。
// 由 daemon 独占、不在 runner 目录里，所以**不需要** systemd drop-in 那套 % → %% 说明符转义，
// 读回时也不还原 —— 照抄 parseOverrideConf 会把值里的 %% 错误地折半。
export function listenerEnvPath(markerId: string): string {
  return path.join(RUNTIME_DIR, `${assertMarkerId(markerId)}.env`);
}

export function runLogPath(markerId: string): string {
  return path.join(RUN_LOG_DIR, `${assertMarkerId(markerId)}.log`);
}

// 目录 → markerId。没有合法 .cipanel 的目录在这里就断掉：本后端的一切私有状态都以它命名。
export function markerIdOf(dir: string): string {
  const marker = readMarker(dir);
  if (!marker?.id) throw new Error(`该目录没有合法的 .cipanel，无法定位运行时状态: ${dir}`);
  return assertMarkerId(marker.id);
}

export async function readRuntime(markerId: string): Promise<RunnerRuntime | null> {
  let raw: string;
  try {
    raw = await fs.readFile(runtimePath(markerId), "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw err;
  }
  let j: Partial<RunnerRuntime> & { v?: unknown };
  try {
    j = JSON.parse(raw);
  } catch {
    logger.warn(`[supervisor-process] 运行时状态文件损坏，按「没托管过」处理: ${markerId}`);
    return null;
  }
  // 版本不匹配就整份丢弃：字段含义变了之后，按老字段推断出的 pgid 会指向一个我们其实不认识的
  // 进程组，而这个文件的唯一用途就是回答「这个进程是不是我们拉起的」。
  if (Number(j.v) !== 1) return null;
  if (typeof j.dir !== "string" || !j.dir) return null;
  return {
    v: 1,
    dir: j.dir,
    pgid: Number(j.pgid) || 0,
    startedAt: Number(j.startedAt) || 0,
    // 老文件没有 lastAttemptAt：拿 startedAt 顶上，退避至少有个基准
    lastAttemptAt: Number(j.lastAttemptAt) || Number(j.startedAt) || 0,
    desired: j.desired === "stopped" ? "stopped" : "running",
    stopRequestedAt: Number(j.stopRequestedAt) || 0,
    // 缺 stopStage 会让停止阶梯一级都发不出去（while 里的 undefined 比较恒假），必须补默认
    stopStage: Number(j.stopStage) || 0,
    failures: Number(j.failures) || 0,
    lastError: typeof j.lastError === "string" ? j.lastError : ""
  };
}

// 同一个 markerId 上的写入串行执行的队列。
//
// **所有写入都必须走 mutateRuntime，不许各自 read-modify-write。** spawn 的 'error' / 'exit'
// 两个回调在**锁外**触发（子进程随时可能退出），而 reconcile 的 failures 清零在锁内——两边
// 各自「读、改、写」会互相丢更新：刚记下的一次失败可能被一次清零抹掉，退避就此失效。
// dirKey 那把锁管不到这条路径（回调根本不经过 withRunnerLock），所以在这一层兜住。
const queues = new Map<string, Promise<void>>();

export async function mutateRuntime(
  markerId: string,
  fn: (rt: RunnerRuntime | null) => RunnerRuntime | null
): Promise<void> {
  const id = assertMarkerId(markerId);
  const prev = queues.get(id) ?? Promise.resolve();
  const next = prev.then(async () => {
    const current = await readRuntime(id);
    const desired = fn(current);
    if (!desired) {
      await fs.remove(runtimePath(id));
      return;
    }
    await fs.ensureDir(RUNTIME_DIR);
    await fs.writeFile(runtimePath(id), JSON.stringify(desired, null, 2) + "\n", "utf8");
  });
  // 队尾即使失败也要让后续写入继续排队，否则一次 EIO 会把这个 runner 的状态永久冻住
  const tail = next.catch(() => undefined);
  queues.set(id, tail);
  try {
    await next;
  } finally {
    // 队列空了就把这一格删掉，别让每个 markerId 永久留一条已完成的 promise
    if (queues.get(id) === tail) queues.delete(id);
  }
}

export async function writeRuntime(markerId: string, rt: RunnerRuntime): Promise<void> {
  await mutateRuntime(markerId, () => rt);
}

/**
 * 清掉这个 markerId 名下的**全部**私有文件，不只 .json。
 *
 * markerId 每次置备都换新，只清 .json 的话，每删一个 runner 就永久遗留一份**装着代理凭据**的
 * env 文件，而那些启动日志也绕开了轮转时「只留上一份」的上限。
 */
export async function removeRuntime(markerId: string): Promise<void> {
  const id = assertMarkerId(markerId);
  await mutateRuntime(id, () => null);
  for (const file of [listenerEnvPath(id), runLogPath(id), `${runLogPath(id)}.1`])
    await fs.remove(file);
}

// 启动时轮转，只留上一份。必须有上限：这个文件写在节点本地盘上，run.sh 是持续输出的，
// 涨爆了影响的不只是 ci-panel。它只用来抓 spawn 失败与早期输出——runner 自己的详细日志在
// <dir>/_diag/ 里，现有的 runner/diag_logs 接口已经能读，不需要新的日志通道。
export async function rotateAndOpenRunLog(markerId: string): Promise<number> {
  const file = runLogPath(markerId);
  await fs.ensureDir(RUN_LOG_DIR);
  await fs.move(file, `${file}.1`, { overwrite: true }).catch(() => undefined);
  return fs.open(file, "a");
}

// ---- 监听进程作用域的环境变量 ----
//
// 与 runner 目录的 .env（只进 job/step）是两个作用域：这一份进 Runner.Listener 自己的环境，
// 代理必须放在这里，否则 listener 连不上 GitHub。格式与 .env 一致（每行 KEY=VALUE），
// 但文件在 daemon 私有目录里、0600，因为它装的正是代理凭据这类东西。

function parseListenerEnv(text: string): RunnerEnvVar[] {
  const vars: RunnerEnvVar[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    // 值原样取回：本文件由 daemon 独占，没有 systemd 说明符那层转义，别在这里做还原
    vars.push({ key: line.slice(0, eq).trim(), value: line.slice(eq + 1) });
  }
  return vars;
}

export function readListenerEnvFile(markerId: string): RunnerEnvSection {
  return readSection(listenerEnvPath(markerId), parseListenerEnv);
}

export async function writeListenerEnvFile(markerId: string, vars: RunnerEnvVar[]): Promise<void> {
  const file = listenerEnvPath(markerId);
  const desired = sanitizeEnvVars(vars);
  if (desired.length === 0) {
    await fs.remove(file);
    return;
  }
  await fs.ensureDir(RUNTIME_DIR);
  // 0600：这份文件装代理凭据，同组/其他用户不该读得到
  await fs.writeFile(file, formatEnvLines(desired) + "\n", { encoding: "utf8", mode: 0o600 });
}

// spawn 时注入的那一份，已展平成 env 对象
export function listenerEnvFor(markerId: string): Record<string, string> {
  const section = readListenerEnvFile(markerId);
  // 读失败时宁可不注入也不半份注入：少了代理最多是连不上 GitHub 并在日志里说清楚，
  // 而半份环境会让 listener 以一组自相矛盾的配置跑起来。
  if (section.error) {
    logger.error(`[supervisor-process] 读监听进程环境变量失败，本次不注入: ${section.error}`);
    return {};
  }
  return Object.fromEntries(section.vars.map((v) => [v.key, v.value]));
}
