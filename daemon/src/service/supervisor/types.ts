// CI Panel 扩展：runner 托管框架的后端接口。
//
// 框架本身不认识任何一种具体的托管方式。新增一种只动三处：一个实现 RunnerSupervisor 的新文件、
// registry.ts 的 FACTORIES 加一行、common 的 SupervisorKind 加一个成员——最后那一下会让两张
// 表驱动的 Record（这里的 FACTORIES、前端的标签表）编译失败，被强制补全的是表里的一条，
// 而不是散落各处的 if 分支。
//
// 意图（该由谁管，落盘在 .cipanel）与观测（现在实际被谁管着，每次现算）是两个正交的轴，
// 声明在 common/src/runner_protocol.ts。本文件只描述「后端怎么回答这两个问题」。
import type {
  ControlOutcome,
  RunnerEnvSection,
  RunnerEnvVar,
  RunnerRunState,
  SupervisorKind
} from "mcsmanager-common";

import type { ListenerProc } from "./local_procs";

/**
 * 一次性解析出「这个动作要作用在什么上」。**读 `.service` 这类 runner 属主自己可写的文件，
 * 全项目只许发生在这里一次。**
 *
 * 为什么不让每个方法自己去读：单元名往下传，才能保证「锁住的那个」与「动手的那个」是同一个。
 * 两次读之间被换掉的话，我们会去停一个没锁住的单元，而锁住的那个还活着，紧接着目录就被删了
 * （runner_scan.ts 的 deleteRunner 那段注释把这条不变量写死了）。
 */
export interface SupervisorTarget {
  // 传给 withRunnerLock 的额外 key（systemd → serviceKey(单元名)）
  lockKeys: string[];
  // 后端不透明的动作上下文。systemd 装已校验的单元名；框架只负责原样传递，不解释
  ctx?: unknown;
}

// 一个「正在跑」的托管实例。跨后端合并时按 id 去重，所以 id 必须是跨后端可比的
export interface ObservedInstance {
  /**
   * 跨后端去重用的稳定标识。**硬契约：凡是本机 `/proc` 里看得见的实例，一律取 listener pid**，
   * 后端原生标识（容器 id、单元名）进 `raw`。
   *
   * 理由是 none 后端恒可用（none.ts）：每个节点、每个目录、每一轮都有一个本机 /proc 观测者在跑，
   * 与声明的后端无关。某个后端若改用自己的标识，同一个 listener 会被记成两条实例，
   * 于是 ownership 恒为 conflict——该 runner 的一切启停被拒、列表常驻红横幅。
   */
  id: string;
  // 哪个后端认领它。undefined = 没有任何后端认领（多半是有人手动起的）
  by?: SupervisorKind;
  // 合并时置位：不止一个后端认领了这同一个实例——真冲突，不许被 id 去重吞掉
  disputed?: boolean;
  // 已 i18n 的人类可读补充，进 RunnerRuntimeState.detail。没有就留空
  detail?: string;
  state: RunnerRunState;
  since: string;
  busy: boolean;
  raw?: Record<string, string>;
}

export interface Observation {
  instances: ObservedInstance[];
  /**
   * 目录级的补充说明，与实例无关。**0 实例时它是唯一的解释来源**——一个反复起不来的 runner
   * 恰好没有任何实例，而「为什么起不来」正是这时最需要说的话。
   */
  detail?: string;
}

export interface RunnerSupervisor {
  readonly kind: SupervisorKind;

  /**
   * 观测：这些目录里现在有什么**活着**在跑——**包括不是本后端拉起的**。
   * 这是跨后端冲突检测的基础，也是本接口里唯一必须「多管闲事」的方法：只报自己拉起的东西，
   * 双托管就永远发现不了，而那正是最需要拦的场景。
   *
   * **硬契约，两条**（ownershipOf 只数个数、不读 state，全靠这两条成立）：
   *   1. **只报活体**。已退出的进程不许出现在 instances 里——多报一个，ownership 就从 idle
   *      翻成 self，start 被「已经在跑了」拒掉，用户永远起不动一个已停止的 runner。
   *   2. **id 与本机 /proc 同源**，见 ObservedInstance.id。
   *
   * procs 由 observeAll 一轮内扫一次后传入，后端不许自己再扫——同一份快照两个访问器、
   * 两种新鲜度，是测都测不了的。用不上本机 /proc 的后端忽略这个形参。
   */
  observe(dirs: string[], procs: readonly ListenerProc[]): Promise<Map<string, Observation>>;

  // 一次性解析锁依据与动作依据。不读外部可写文件的后端可以不实现
  prepare?(dir: string): SupervisorTarget;

  /**
   * 把一个已注册好的 runner 目录交给本后端托管（置备的第 4 步）。
   *
   * **契约一：attach 成功即 runner 已在跑**（systemd = 装单元 + enable --now）。做不到
   * 「创建即启动」的后端要在 attach 内部自己补一次 start，而不是让调用方去猜。
   *
   * **契约二：attach 自己负责防重复拉起。** 它不走 controlRunner，那道 ownership 闸门管不到它。
   * systemd 靠特权助手对已存在单元的拒绝，none 直接抛。新后端必须明确自己走哪条。
   */
  attach(dir: string, t?: SupervisorTarget): Promise<void>;

  /**
   * 收回托管。幂等：**没托管过**也要回 ok——「这台机器上根本没装过单元」不该让删除整条链失败。
   * 但「没托管过」≠「没东西在跑」：detach 必须先向观测复核该目录里还有没有活 listener，
   * 有就回 ok:false + hint。回错了，删除那侧的 fail closed 会被绕过，目录被从活进程底下删掉。
   */
  detach(
    dir: string,
    t?: SupervisorTarget
  ): Promise<{ ok: boolean; error?: string; hint?: string }>;

  start(dir: string, t?: SupervisorTarget): Promise<ControlOutcome>;
  // settleMs 可覆盖：删除路径要的耐心比面板点一次按钮那条路长得多
  stop(dir: string, settleMs?: number, t?: SupervisorTarget): Promise<ControlOutcome>;
  restart(dir: string, t?: SupervisorTarget): Promise<ControlOutcome>;

  /**
   * 监听进程的环境（代理必须放这里，.env 只进 job/step）。systemd → drop-in。
   * **返回 Promise，即使实现体是同步的**：容器后端要 docker inspect、远端后端要一次 RPC，
   * 同步签名让它们编译都过不了，而那时再改就是跨三个包的破坏性改动。
   */
  readListenerEnv(dir: string, t?: SupervisorTarget): Promise<RunnerEnvSection>;
  writeListenerEnv(dir: string, vars: RunnerEnvVar[], t?: SupervisorTarget): Promise<void>;

  /**
   * 周期性自我收敛，**一次一个目录**。只有带状态的后端才实现。
   * 粒度是单个 dir 而不是一批：通用循环要为每个 dir 单独占锁，一批一把锁既锁不住，
   * 也没法在拿不到锁时只跳过那一个。
   */
  reconcileOne?(dir: string, procs: readonly ListenerProc[], t?: SupervisorTarget): Promise<void>;
}

export interface SupervisorAvailability {
  available: boolean;
  // 不可用的原因。随节点能力上报，让面板能解释「为什么这个节点用不了 systemd」
  reason?: string;
}

export interface RunnerSupervisorFactory {
  readonly kind: SupervisorKind;
  // 越大越优先。多个可用时取最高者作为节点默认
  readonly priority: number;
  detect(): SupervisorAvailability;
  create(): RunnerSupervisor;
}
