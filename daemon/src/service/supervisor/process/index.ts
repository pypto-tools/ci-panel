// CI Panel 扩展：process 托管后端 —— 由 daemon 自己把 runner 拉起来。
//
// 用在没有 systemd（或没有特权助手）的节点上：容器、hi launch 起的机器、手工跑的 daemon。
// 子进程刻意脱离 daemon 的生命周期（detached，新进程组 + 新会话）：否则升级一次 daemon 就会
// 打断正在跑的 job（可能几小时）。代价是「在不在跑」只能靠观测 /proc 回答，而那本来就是这套
// 框架的做法——不需要「持有句柄 vs 认领孤儿」两套逻辑。
//
// 这台状态机只有三个转移，缺一个就会出现「停不住」或「起不来」：
//   attach / start → desired = "running"、清停止阶梯
//   stop           → desired = "stopped"、记 stopRequestedAt
//   reconcile      → 推进停止阶梯；或在 desired 仍是 "running" 且没有活体时按退避重拉
import { spawn as nodeSpawn, type ChildProcess } from "child_process";
import fs from "fs-extra";

import { $t } from "../../../i18n";
import { canonicalPath } from "../../../tools/path_link_check";
import logger from "../../log";
import { errText } from "../../runner_provision";
import { detachHint } from "../hints";
import { scanListenerProcs, type ListenerProc } from "../local_procs";
import { ownershipOf, toRuntimeState } from "../ownership";
import type {
  Observation,
  RunnerSupervisor,
  RunnerSupervisorFactory,
  SupervisorTarget
} from "../types";
import { observationFor, owns } from "./observe";
import {
  listenerEnvFor,
  markerIdOf,
  mutateRuntime,
  readListenerEnvFile,
  readRuntime,
  removeRuntime,
  rotateAndOpenRunLog,
  writeListenerEnvFile,
  writeRuntime,
  type RunnerRuntime
} from "./store";
import type {
  ControlOutcome,
  RunnerEnvSection,
  RunnerEnvVar,
  SupervisorAction
} from "mcsmanager-common";

// 面板点一次按钮最多等多久确认到位。与 systemd 后端同一个契约：等不到回 settled:false，
// 不是失败，剩下的交给页面自己的状态轮询。
const SETTLE_TIMEOUT_MS = 8000;
const SETTLE_POLL_MS = 500;

// 与 prod-scripts/ci-panel-runner-svc 生成的单元对齐：KillSignal=SIGTERM、TimeoutStopSec=5min。
// 第一级是 SIGINT 而不是 SIGTERM：官方 runsvc.sh 自己就把 TERM 转成 INT（见其 trap），而
// Runner.Listener 认 SIGINT 为优雅停止。直接对齐它要的那个信号，少一层转换。
const STOP_LADDER = [
  { after: 0, signal: "SIGINT" as const },
  { after: 30_000, signal: "SIGTERM" as const },
  { after: 300_000, signal: "SIGKILL" as const }
];

const BACKOFF_BASE_MS = 10_000; // 对齐单元的 RestartSec=10
const BACKOFF_MAX_MS = 300_000;
// 活过这么久才算「这次启动真的成功」，这时才清零 failures。取 60s：官方 runner 连不上 GitHub
// 时通常几秒内就退出，而正常 listener 一旦连上就长期在跑，60s 足以把两者分开。
const HEALTHY_MS = 60_000;

// 删除路径那次停止要的耐心比面板点按钮长得多，与 systemd 后端的 DELETE_SETTLE_MS 同一个理由
const DETACH_SETTLE_MS = 60000;

const DEFAULT_START_ARGV = ["./run.sh"];

/**
 * 启动命令。**只从 daemon 进程环境读**：`.cipanel` 与任何 API 都不接受它——威胁模型是
 * 「面板登录态 → 节点任意执行」，而能设这个变量的人已经有该节点的 shell，拿不到新权限。
 *
 * 格式非法时回退默认而不是拒绝启动 daemon（那等于整节点下线），但要吼出来。
 */
export function resolveStartArgv(raw = process.env.CIP_RUNNER_START): {
  argv: string[];
  warning?: string;
} {
  const text = (raw || "").trim();
  if (!text) return { argv: DEFAULT_START_ARGV };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { argv: DEFAULT_START_ARGV, warning: "CIP_RUNNER_START 不是合法 JSON，已回退默认" };
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every((s) => typeof s === "string" && s)
  )
    return {
      argv: DEFAULT_START_ARGV,
      warning: "CIP_RUNNER_START 必须是非空字符串数组，已回退默认"
    };
  return { argv: parsed as string[] };
}

/**
 * 交给 listener 的基础环境：**白名单，不是 process.env**。
 *
 * systemd 路径上这条泄漏面根本不存在——助手生成的单元里既没有 Environment= 也没有
 * EnvironmentFile=，listener 的环境完全由 root 写的 drop-in 决定。而 daemon 自己的环境里有
 * CIP_RUNNER_PROXY（代理串可能带凭据）、CIP_SCAN_ROOTS、CIP_RUNNER_SVC_HELPER，单元还通过
 * EnvironmentFile 注入了含 CIP_GITHUB_TOKEN（全局 PAT）的那份 .env。整份传下去，PAT 会顺着
 * listener → Runner.Worker → 每个 step 进到不可信的 job 环境里。
 *
 * 白名单而不是黑名单：以后 daemon 新增任何 CIP_* 变量都不会悄悄漏出去。
 * 代理不受影响——它本来就该由 listener 作用域显式配置，systemd 节点上也从没继承过 daemon 的。
 */
const LISTENER_ENV_BASE = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TZ"
] as const;

export function listenerBaseEnv(): Record<string, string> {
  const base: Record<string, string> = {};
  for (const k of LISTENER_ENV_BASE) if (process.env[k]) base[k] = process.env[k]!;
  return base;
}

// 指数退避：failures=0 回 0（第一次尝试不等）
export function backoffFor(failures: number): number {
  if (failures <= 0) return 0;
  return Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
}

// 可注入的外部依赖。停止阶梯跨越 5 分钟、启动要等 8 秒，不注入就只能用真实时钟测，
// 而这几条恰恰是最需要用例盯住的（发错信号不可逆）。
export interface ProcessDeps {
  scan: () => Promise<ListenerProc[]>;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  now: () => number;
  spawn: typeof nodeSpawn;
  settlePollMs: number;
  // 面板点一次按钮的等待窗口。restart 内部那次 stop 用的也是它，所以它必须可注入 ——
  // 否则那条路只能用真实的 8 秒去测。
  settleTimeoutMs: number;
}

const DEFAULT_DEPS: ProcessDeps = {
  scan: () => scanListenerProcs(),
  kill: (pid, signal) => void process.kill(pid, signal),
  now: () => Date.now(),
  spawn: nodeSpawn,
  settlePollMs: SETTLE_POLL_MS,
  settleTimeoutMs: SETTLE_TIMEOUT_MS
};

export interface ProcessSupervisor extends RunnerSupervisor {
  // 只拉起、不等到位。reconcile 用它：start() 结尾要 settle 8 秒，而 tick 是串行且防重入的，
  // N 个起不来的 runner 会把有效周期拉到 8N 秒 —— 自动重拉反过来把自动停止饿死。
  spawnOnce(dir: string, t?: SupervisorTarget): Promise<void>;
}

export function createProcessSupervisor(overrides: Partial<ProcessDeps> = {}): ProcessSupervisor {
  const deps: ProcessDeps = { ...DEFAULT_DEPS, ...overrides };

  // 每次发信号前重新证明归属。pgid 会被回收，而 SIGKILL 打错对象不可逆 —— 这道复核不能只在
  // stop 入口做一次：阶梯要跨几分钟，中间进程组可能已经退出并被别人复用。
  const signalOwned = (
    rt: RunnerRuntime,
    procs: readonly ListenerProc[],
    signal: NodeJS.Signals
  ): void => {
    if (!procs.some((p) => owns(rt, p))) return;
    try {
      deps.kill(-rt.pgid, signal); // 负号 = 整个进程组，连 run.sh 派生的孙子一起
    } catch {
      /* 组已退出，ESRCH 正常 */
    }
  };

  // 按 stopStage 单调推进，发过的级别不重发。第一级由 stop() 发，30s / 5min 两级由 reconcile 接手。
  const advanceStopLadder = async (
    rt: RunnerRuntime,
    procs: readonly ListenerProc[]
  ): Promise<void> => {
    const id = markerIdOf(rt.dir);
    if (!procs.some((p) => owns(rt, p))) {
      // 进程已经没了：收工，清掉停止态但**保留 desired:"stopped"**，否则下一拍又拉起来
      await mutateRuntime(id, (cur) =>
        cur ? { ...cur, stopRequestedAt: 0, stopStage: 0, pgid: 0 } : cur
      );
      return;
    }
    const elapsed = deps.now() - rt.stopRequestedAt;
    let stage = rt.stopStage;
    while (stage < STOP_LADDER.length && elapsed >= STOP_LADDER[stage].after) {
      signalOwned(rt, procs, STOP_LADDER[stage].signal);
      stage += 1;
    }
    if (stage !== rt.stopStage)
      await mutateRuntime(id, (cur) => (cur ? { ...cur, stopStage: stage } : cur));
  };

  // 失败也要落盘，否则退避没有输入。lastAttemptAt 无论成败都推进。
  // clearPgid 区分两种失败：spawn 没起来（进程组不存在，清）vs run.sh 退出（listener 可能还
  // 活着，不清 —— 清掉会让一个活着的 listener 当场退化成 foreign，三条路全拒）。
  const recordFailure = async (
    markerId: string,
    err: unknown,
    clearPgid: boolean
  ): Promise<void> => {
    await mutateRuntime(markerId, (rt) =>
      rt
        ? {
            ...rt,
            ...(clearPgid ? { pgid: 0 } : {}),
            lastAttemptAt: deps.now(),
            failures: rt.failures + 1,
            lastError: errText(err).slice(0, 500)
          }
        : rt
    );
    logger.error(`[supervisor-process] 启动失败 ${markerId}: ${errText(err)}`);
  };

  // 轮询到位。面板契约与 systemd 后端一致：到点仍未达成就回 settled:false。
  const settle = async (
    dir: string,
    action: SupervisorAction,
    settleMs = deps.settleTimeoutMs
  ): Promise<ControlOutcome> => {
    const key = canonicalPath(dir);
    const deadline = deps.now() + settleMs;
    for (;;) {
      const procs = await deps.scan();
      const rt = await readRuntime(markerIdOf(key));
      const obs = observationFor(key, procs, rt);
      const reached =
        action === "stop" ? obs.instances.length === 0 : obs.instances.some((i) => i.by);
      if (reached || deps.now() >= deadline)
        return {
          dir: key,
          action,
          settled: reached,
          runtime: toRuntimeState("process", obs, true)
        };
      await new Promise((r) => setTimeout(r, deps.settlePollMs));
    }
  };

  const spawnOnce = async (dir: string): Promise<void> => {
    const key = canonicalPath(dir);
    // ownership 闸门已经在 controlRunner 里过了。这里再查一次 /proc 不是重复：那一次到这一次
    // 之间有 await，而且 attach 是绕过 controlRunner 直接进来的。拉起 listener 会去 GitHub 抢
    // 身份，不可逆，值得在最后一刻再证明一次。
    const live = (await deps.scan()).filter((p) => p.dir === key);
    if (live.length) throw new Error($t("TXT_CODE_RUNNER_ALREADY_SUPERVISED"));

    const { argv, warning } = resolveStartArgv();
    if (warning) logger.error(`[supervisor-process] ${warning}`);

    const markerId = markerIdOf(key);

    // **意图先落盘，再 spawn。** 反过来会留一个死角：stop 之后再 start，若 spawn 失败，
    // desired 仍是 "stopped"，reconcile 第一句就 return —— 退避重拉永远够不着这个 runner，
    // 而用户明明点了启动。这一句也顺带保证 recordFailure 有文件可写（导入的 runner 之前没有）。
    await mutateRuntime(markerId, (prev) => ({
      v: 1,
      dir: key,
      pgid: prev?.pgid ?? 0,
      startedAt: prev?.startedAt ?? 0,
      lastAttemptAt: deps.now(),
      desired: "running",
      stopRequestedAt: 0,
      stopStage: 0,
      failures: prev?.failures ?? 0,
      lastError: prev?.lastError ?? ""
    }));

    const logFd = await rotateAndOpenRunLog(markerId);
    try {
      const child: ChildProcess = deps.spawn(argv[0], argv.slice(1), {
        cwd: key,
        env: { ...listenerBaseEnv(), ...listenerEnvFor(markerId) },
        detached: true, // 新进程组（pgid == child.pid），且活过 daemon 重启
        stdio: ["ignore", logFd, logFd],
        shell: false // argv 数组传参，不起 shell —— 逃生口的值也走这条路
      });

      // spawn 失败在 Node 里**不抛**：命令不存在时它照样返回一个 ChildProcess，child.pid 是
      // undefined，错误在下一个 tick 以 'error' 事件出现；没有监听器时会变成 uncaughtException，
      // 被 app.ts 那个兜底 handler 吞成一行日志。本仓其余每一处 spawn 都挂了 'error'。
      //
      // 一次 start 只许记一次失败：'error' 与下面的 pid 兜底会同时命中（命令不存在时两者都真），
      // 各记一次会让 failures +2，退避曲线整体错位。哨兵保证只走一次。
      let failed = false;
      const fail = (e: unknown, clearPgid: boolean): void => {
        if (failed) return;
        failed = true;
        void recordFailure(markerId, e, clearPgid);
      };
      child.on("error", (e) => fail(e, true)); // spawn 本身失败 → 进程组不存在，pgid 该清
      child.on("exit", (code, sig) => {
        void (async () => {
          const rt = await readRuntime(markerId);
          // 用户主动停的不算启动失败 —— lastError 是给人看的，别把正常停止写成故障
          if (rt?.desired === "stopped" || rt?.stopRequestedAt) return;
          // **判据是「有没有活够 HEALTHY_MS」，不是退出码。** 官方 run.sh 有好几条正常退出 0
          // 的路（listener 被从 GitHub 移除、误配 --once、"exit 0, no retry" 分支）。只看 code
          // 的话这些情形下 failures 恒 0、退避形同虚设，reconcile 每拍重 spawn 一次，
          // 而 detail 一片空白，用户看不出它为什么一直在重启。
          if (rt?.startedAt && deps.now() - rt.startedAt >= HEALTHY_MS) return;
          fail(new Error(`run.sh 过早退出 code=${code} sig=${sig}`), false);
        })();
      });
      child.unref(); // 不让这个 ChildProcess 一直吊着事件循环

      // 绝不写半个 runtime 文件：pgid 写成 undefined 时 JSON.stringify 会把这个键整个丢掉，
      // 于是 owns() 首句恒假 —— UI 恒 idle、stop 一个信号都不发、reconcile 每 15 秒重拉一次，
      // 而 failures 永远是 0，退避形同虚设。
      if (typeof child.pid !== "number") {
        fail(new Error("spawn 未返回 pid"), true);
        throw new Error($t("TXT_CODE_RUNNER_SPAWN_FAILED", { dir: key }));
      }
      // 只更新「这次拉起」相关的两个字段。**failures 不在这里清零**：spawn 返回了 pid 只说明
      // fork 成功，run.sh 可能下一秒就退出；在这里清零会让崩溃循环的计数在 0/1 之间摆动，
      // 退避永远爬不到上限。清零挪到 reconcile —— 活过 HEALTHY_MS 才算这次启动成功。
      const pid = child.pid;
      await mutateRuntime(markerId, (cur) =>
        cur ? { ...cur, pgid: pid, startedAt: deps.now() } : cur
      );
    } finally {
      await fs.close(logFd); // 已交给子进程，父进程这边必须关，否则每次 start 泄一个 fd
    }
  };

  const self: ProcessSupervisor = {
    kind: "process",

    spawnOnce,

    async observe(dirs: string[], procs: readonly ListenerProc[]) {
      const out = new Map<string, Observation>();
      for (const dir of dirs) {
        // 没有合法 .cipanel 的目录也要如实上报「有东西在跑」，只是认领不了 —— 扫描列表里
        // 未纳管的目录同样会走到这里（导入弹窗）。
        let rt: RunnerRuntime | null = null;
        try {
          rt = await readRuntime(markerIdOf(dir));
        } catch {
          rt = null;
        }
        out.set(dir, observationFor(dir, procs, rt));
      }
      return out;
    },

    // 契约：attach 成功即在跑。本后端天然满足 —— 它就是「记期望态 + 拉起」。
    // 防重复拉起由 spawnOnce 首句那次 /proc 复核承担。
    async attach(dir: string) {
      const key = canonicalPath(dir);
      await writeRuntime(markerIdOf(key), {
        v: 1,
        dir: key,
        pgid: 0,
        startedAt: 0,
        lastAttemptAt: 0,
        desired: "running",
        stopRequestedAt: 0,
        stopStage: 0,
        failures: 0,
        lastError: ""
      });
      await self.start(key); // 失败会抛，置备那一步因此不会报成功而实际没起来
    },

    async detach(dir: string, t?: SupervisorTarget) {
      const key = canonicalPath(dir);
      const markerId = markerIdOf(key);
      const rt = await readRuntime(markerId);
      const live = (await deps.scan()).filter((p) => p.dir === key);

      if (!rt) {
        // **「没有运行时记录」≠「没有东西在跑」。** 它只说明「我不知道怎么安全地停它」。
        // 两条导入纳管路径都不写 runtime 文件，所以「手动 ./run.sh 跑着 + 被面板导入」这个
        // 组合恒满足 rt === null —— 而那正是这次要解决的那台机器的状态。回 ok 会让删除一路
        // 走完：GitHub 注销（在线 runner 不让移除，留下幽灵身份）→ 把 _work/_diag 从活进程
        // 底下抽走。上游唯一的拦截只认 Runner.Worker，空闲但在线的 listener 不算 busy。
        if (live.length)
          return {
            ok: false,
            error: $t("TXT_CODE_RUNNER_FOREIGN_RUNNING", { dir: key }),
            hint: detachHint("process")
          };
        // 真的什么都没有：这才是「纳管后永远删不掉」的修法
        return { ok: true };
      }

      // rt 存在但 pgid 已陈旧（daemon 重启过、进程组被回收、pgid 被别人复用）时，owns() 全假、
      // stop 一个信号都不发，然后空等 60 秒回一条没有指引的超时。与上面那一支对称地先判一次。
      if (live.length && !live.some((p) => owns(rt, p)))
        return {
          ok: false,
          error: $t("TXT_CODE_RUNNER_FOREIGN_RUNNING", { dir: key }),
          hint: detachHint("process")
        };

      const r = await self.stop(key, DETACH_SETTLE_MS, t);
      if (!r.settled)
        return { ok: false, error: $t("TXT_CODE_RUNNER_STOP_NOT_SETTLED", { dir: key }) };
      await removeRuntime(markerId);
      return { ok: true };
    },

    async start(dir: string) {
      await spawnOnce(dir);
      return settle(dir, "start");
    },

    /**
     * 停止是一次**期望态的翻转**，不只是发一个信号：systemd 下 `systemctl stop` 会取消
     * Restart=always，停止是持久的。把重启策略搬进用户态之后，「别再拉起」必须显式落盘，
     * 否则 reconcile 会在 15 秒内把用户刚停掉的 runner 拉回来。
     */
    async stop(dir: string, settleMs = deps.settleTimeoutMs) {
      const key = canonicalPath(dir);
      const id = markerIdOf(key);
      const rt = await readRuntime(id);
      if (!rt) return settle(key, "stop", settleMs); // 幂等：没托管过，直接看现状落定

      if (!rt.stopRequestedAt) {
        // 重试一次 stop 不重置阶梯，否则 stage 永远回到 0、SIGKILL 那一级到不了
        await mutateRuntime(id, (cur) =>
          cur
            ? { ...cur, desired: "stopped" as const, stopRequestedAt: deps.now(), stopStage: 0 }
            : cur
        );
      }
      const cur = await readRuntime(id);
      if (cur) await advanceStopLadder(cur, await deps.scan());
      return settle(key, "stop", settleMs);
    },

    /**
     * **不能简单地 stop 再 start**：stop() 会把 desired 翻成 "stopped"，中间那一瞬若 daemon 被
     * 杀，重启后 reconcile 读到 "stopped" 就再也不会把它拉回来——用户点的是「重启」，得到的是
     * 「永久停止」。所以走一条不碰期望态的内部路径。
     */
    async restart(dir: string, t?: SupervisorTarget) {
      const key = canonicalPath(dir);
      const id = markerIdOf(key);
      const rt = await readRuntime(id);
      if (rt) {
        // 只推信号阶梯，不写 desired —— 期望态自始至终是 "running"。
        // 已经在停的话不重置 stopRequestedAt/stopStage，否则重复 restart 会把阶梯钉在第一级。
        if (!rt.stopRequestedAt)
          await mutateRuntime(id, (c) =>
            c ? { ...c, stopRequestedAt: deps.now(), stopStage: 0 } : c
          );
        const cur = await readRuntime(id);
        if (cur) await advanceStopLadder(cur, await deps.scan());
        const stopped = await settle(key, "stop");
        // 没停下来就别接着起：那正好是「两个 listener 抢同一个身份」的造法
        if (!stopped.settled) return stopped;
        await mutateRuntime(id, (c) => (c ? { ...c, stopRequestedAt: 0, stopStage: 0 } : c));
      }
      return self.start(key);
    },

    async readListenerEnv(dir: string): Promise<RunnerEnvSection> {
      // 没有合法 .cipanel 的目录（未纳管，但详情页仍可只读打开）没有本后端存过的任何东西 ——
      // 回空节，而不是把「查不到纳管标记」抬成一个读取错误。写入那一侧仍然要求纳管：
      // 没有 markerId 就没有文件名可用。
      let markerId: string;
      try {
        markerId = markerIdOf(canonicalPath(dir));
      } catch {
        return { present: false, vars: [] };
      }
      return readListenerEnvFile(markerId);
    },

    async writeListenerEnv(dir: string, vars: RunnerEnvVar[]): Promise<void> {
      await writeListenerEnvFile(markerIdOf(canonicalPath(dir)), vars);
    },

    /**
     * 每 15 秒一拍，已经在该目录的锁内，一次一个目录。两件事：把停止阶梯往下推（跨 daemon
     * 重启也能继续），以及在 desired=running 却没有活体时按退避重拉。
     *
     * procs 由通用循环扫一次后传入；它扫不动时压根不会调到这里——「不知道有没有在跑」的时候
     * 什么都不做，是这条无人值守路径唯一安全的选择。
     */
    async reconcileOne(dir: string, procs: readonly ListenerProc[]) {
      const key = canonicalPath(dir);
      // 锁内重新读：等锁期间 rt 可能已经被 detach 删掉了
      const id = markerIdOf(key);
      const rt = await readRuntime(id);
      if (!rt) return;

      if (rt.stopRequestedAt) {
        await advanceStopLadder(rt, procs);
        return;
      }
      if (rt.desired !== "running") return; // 用户停过它，别再自作主张拉起来

      const instances = observationFor(key, procs, rt).instances;

      // 活过 HEALTHY_MS 才算上一次启动真的成功，这时才清零 failures。这是 startedAt 唯一的
      // 读点，也是崩溃循环下退避能爬到上限的前提（spawn 之后刻意不清零）。
      if (
        rt.failures &&
        rt.startedAt &&
        deps.now() - rt.startedAt > HEALTHY_MS &&
        ownershipOf("process", instances) === "self"
      ) {
        await mutateRuntime(id, (c) => (c ? { ...c, failures: 0, lastError: "" } : c));
        return;
      }

      // 只在「没有任何东西在跑」时才重拉。foreign / conflict 下硬拉就是双托管，而这个判定用的
      // 是与 UI 完全相同的那个函数——不重写一套。
      if (ownershipOf("process", instances) !== "idle") return;

      // 退避判据用 lastAttemptAt，不用 startedAt：一个从来没起来过的 runner 根本没有 startedAt。
      if (deps.now() - rt.lastAttemptAt < backoffFor(rt.failures)) return;

      // **走 spawnOnce，不走 start()**：start() 结尾要 settle 8 秒，而 tick 是串行 + 防重入的，
      // N 个起不来的 runner 会把有效周期拉到 8N 秒，而停止阶梯的 30s / 5min 两级正靠这个周期
      // 推进——自动重拉反过来会把自动停止饿死。到没到位下一拍自然看得到。
      await spawnOnce(key).catch((err) =>
        logger.error(`[supervisor-process] ${key} 重拉失败: ${errText(err)}`)
      );
    }
  };

  return self;
}

export const processFactory: RunnerSupervisorFactory = {
  kind: "process",
  priority: 20,
  // 恒可用：只要 daemon 跑得起来，它就能 fork 一个子进程。真正决定用不用它的是优先级——
  // systemd 可用时它排在后面。
  detect: () => ({ available: true }),
  create: () => createProcessSupervisor()
};
