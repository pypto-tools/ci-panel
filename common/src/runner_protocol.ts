// runner 纳管协议：daemon 实现、panel 转发、frontend 调用，三方共用同一份声明。
//
// 之前 daemon 与 frontend 各手写一份、panel 再声明一次自己用到的字段，给结果加一个
// 字段要改三处，漏一处只会在运行时才发现。
//
// 除文件末尾那个纯函数外只放类型，且**不引任何运行时依赖**：前端用 `import type` 引它，
// 编译期就被擦除，不会把 common 里的 fs / child_process 代码带进浏览器 bundle。
export type RunnerSource = "provision" | "import";

// 纳管一个 runner 目录的入参
export interface RegisterRunnerItem {
  dir: string;
  repo?: string; // 仅作兜底：daemon 以目录里的 .runner 为准
  group?: string;
}

// 单个 runner 的纳管结果
export interface RegisterRunnerResult {
  dir: string;
  ok: boolean;
  markerId?: string;
  instanceUuid?: string; // 句柄实例 uuid（文件管理/配置/详情页要用）
  repo?: string; // daemon 从 .runner 解析出的仓库 slug，校验通过才有值
  error?: string;
}

// panel 在 daemon 的结果上追加 registeredRepos：本次顺带纳管进仓库注册表的仓库
export interface RegisterRunnersResponse {
  results: RegisterRunnerResult[];
  registeredRepos?: string[];
}

// ---- 托管框架：意图与观测是两个正交的轴 ----
//
// 别把两件事塞进一个 union（"systemd" | "process" | "both" | "none" 这种）：前两个说的是托管
// 方式，后两个说的是归属关系。混在一起时加第三种托管方式会让 "both" 当场歧义（是哪两个 both？），
// 取值组合还随后端数量爆炸，所有 switch 都得重访。拆开之后，ownership 这一轴与后端数量无关 ——
// 新增一种托管方式时它一个字都不用改。

// 意图轴：这个 runner 该由谁托管。置备时定下，落盘在 .cipanel，不随节点能力探测漂移。
//
// 新增一种托管方式时**这里加一个成员**，两张表驱动的映射（daemon 的后端注册表、frontend 的
// 标签表）会当场编译失败 —— 被强制补全的是表里的一条，而不是散落各处的 if 分支。所以成员与
// 后端实现同一次落地，不提前占位：占位的那一格既没有实现也没有标签，编译器反而不再提醒任何人。
export type SupervisorKind = "systemd" | "process" | "none";

// 面板能下的托管动作。取值与线上的 SystemdAction 一致，只是名字不再绑 systemd。
export type SupervisorAction = "start" | "stop" | "restart";

// 观测轴：现在实际被谁管着。每次扫描现算，从不落盘。
export type RunnerOwnership =
  | "self" // 声明的那个后端确实在管它
  | "foreign" // 有进程在跑，但没有任何后端认领（多半是有人手动起的）
  | "conflict" // 不止一个托管方，或被声明之外的后端管着
  | "idle" // 没有任何东西在跑
  // 观测不完整，答不出。**不是 idle** —— idle 是唯一放行 start 的取值，把"观测失败"折叠进去
  // 就等于让一次 systemctl 超时变成双托管的入口。
  | "unknown";

// 归一化的运行态。闭集而不是自由字符串 —— 否则每个消费方都会按后端各自 string-match。
export type RunnerRunState = "running" | "starting" | "stopping" | "stopped" | "failed" | "unknown";

export interface RunnerRuntimeState {
  supervisor: SupervisorKind; // 意图
  ownership: RunnerOwnership; // 观测
  // 面板所有「在线」展示与计数只读这个字段。派生自 state，但显式给出，避免各处再解析一遍。
  running: boolean;
  state: RunnerRunState;
  // 已 i18n 的人类可读补充（systemd 的 subState、process 的停止阶梯进度、spawn 失败原因）
  detail: string;
  since: string;
  busy: boolean; // 正在跑 job —— 停它会中断 CI
  // 后端特有的原始字段，**只供展示与排障**。任何判断逻辑都不许读它：读了就等于把后端知识
  // 散播到消费方，下一个后端来的时候这些地方全要改。
  // systemd: { service, activeState, subState, unitFileState };process: { pid, pgid }
  raw?: Record<string, string>;
}

// 启停结果。寻址与结果都以目录为准 —— 单元名只有 systemd 后端才有，拿它当主键的话，
// 协议里就说不出「停止这个目录里的 runner」这句话（其余 runner 接口本来就按 dir 寻址）。
//
// settled 的语义不变：false = 托管方已受理但等待窗口内还没跑到位，**不是失败**，状态由页面
// 自己的轮询继续收敛。这个契约对任何异步后端都成立，所以加后端不需要改前端的轮询逻辑。
export interface ControlOutcome {
  dir: string;
  action: SupervisorAction;
  settled: boolean;
  runtime: RunnerRuntimeState | null;
}

/**
 * @deprecated 升级窗口里的兼容形状：新 daemon 回填它，好让还没升级的 panel 照常显示单元名与
 * 在线状态。不回填的话，一台正常跑着 job 的节点在老面板上会表现为「全部 runner 已停止 /
 * 无人托管 / 启停入口消失 / 冲突告警归零」，而且全程没有任何报错。新代码一律读
 * RunnerRuntimeState.raw。1.2 移除。
 */
export interface SystemdStateCompat {
  service: string;
  loaded: boolean;
  activeState: string;
  subState: string;
  enabled: string;
  since: string;
}

/** @deprecated 名称保留一版给未同步升级的 panel / frontend,1.2 移除 */
export type SystemdAction = SupervisorAction;
/** @deprecated 同上。新代码一律用 ControlOutcome */
export type ServiceControlResult = ControlOutcome;

// ---- 扫描结果 ----
// daemon 吐出、panel 转发、frontend 渲染的同一份声明：之前三个包各写一份，各自演化。
export interface ScannedRunner {
  dir: string;
  dirName: string;
  repo: string; // owner/repo，来自 .runner 的 gitHubUrl
  agentName: string; // runner 在 GitHub 上的名字，来自 .runner
  // 这两个字段过渡期声明为可选：老 daemon 的载荷里它们根本不存在，而 panel 的 toRunnerRef 与
  // frontend 的启停守卫都要按「可能 undefined」写。1.2 与下面两个兼容字段一起收紧成必填。
  supervisor?: SupervisorKind; // 意图
  runtime?: RunnerRuntimeState | null; // 观测（含 ownership / running / busy / raw）
  instanceUuid: string; // 句柄实例（按 cwd 匹配），文件管理与详情页按它授权
  instanceStatus: number; // 句柄实例状态，-1 = 无实例
  managed: boolean; // 有合法 .cipanel。日常展示只看这类
  markerId: string; // marker 里的管理标识，空 = 未纳管
  source: RunnerSource | ""; // provision / import，空 = 未纳管
  group: string; // marker 里的所属组
  exists: boolean; // 目录还在且含 .runner（按已知路径探测时用得上）
  broken?: string; // 目录有问题时的说明（.runner 解析失败等）
  /** @deprecated 仅供未同步升级的 panel 读，新代码一律用 runtime.raw。1.2 移除 */
  systemd?: SystemdStateCompat | null;
  /** @deprecated 同上，由 supervisor + ownership 派生。1.2 移除 */
  managedBy?: "systemd" | "both" | "none";
}

// ---- 环境变量的两个作用域 ----
// 线上取值刻意不改名（"override" / "dotenv"）：老 daemon 的路由层把认不出的值一律归一成
// "override"，于是新 frontend 发一个新名字过去，只该进 job 的变量会被静默写进 root 拥有的
// systemd drop-in，还泄进监听进程自己的环境。内部概念叫 listener / job，在路由边界做一次映射。
export type EnvTarget = "override" | "dotenv";

export interface RunnerEnvVar {
  key: string;
  value: string;
}

// 单个目标文件的一节：文件在不在 + 其中的变量
export interface RunnerEnvSection {
  present: boolean;
  vars: RunnerEnvVar[];
  // 读取失败的原因（权限、EIO 等）。有值时 vars 不可信：merge 写入必须中止，否则会把读不到的
  // 既有变量当成「本来就没有」而整份覆盖掉。
  error?: string;
}

export interface RunnerEnvResult {
  dir: string;
  supervisor: SupervisorKind;
  // 能不能写 listener 作用域由后端说了算，不再由「有没有 systemd 单元」说了算
  canWriteListenerEnv: boolean;
  /** @deprecated 老 frontend 用它决定要不要禁用输入框。1.2 移除，届时只留 canWriteListenerEnv */
  hasSystemd: boolean;
  override: RunnerEnvSection; // listener 作用域：进监听进程（代理必须放这里）
  dotenv: RunnerEnvSection; // job 作用域：只进 job / step
}

// panel 转发 daemon 的 runner/register 回复时，要从中挑出「本次纳管成功、且 daemon 解析出
// 仓库」的那些 slug，用来顺带登记仓库注册表。
//
// 提取成函数，是因为 panel 原先在路由里直接写 `(result as { results?: RegisterRunnerResult[] })`
// —— RemoteRequest 的返回是 unknown，那个断言不受任何检查。daemon 改个字段名编译期毫无动静，
// 运行时 results 变 undefined，循环一次都不进，registeredRepos 恒为空数组：仓库列表里
// 一直显示「未纳管」，而没有任何一处报错。
//
// 放在协议文件里而不是 panel 里，是为了让它和它依赖的字段名同生共死：改了 RegisterRunnerResult
// 就必须改这里，而这里有测试盯着。运行时只做窄化，不信任入参的任何形状。
export function collectRegisteredRepoSlugs(payload: unknown): string[] {
  const results = (payload as { results?: unknown } | null | undefined)?.results;
  if (!Array.isArray(results)) return [];
  const slugs = new Set<string>();
  for (const r of results) {
    if (!r || typeof r !== "object") continue;
    const item = r as Partial<RegisterRunnerResult>;
    // 只收成功项：失败项的 repo 可能是请求体里的兜底值，与 daemon 从 .runner 读出的
    // 不同源，登记进去会让注册表的 key 对不上。
    if (item.ok === true && typeof item.repo === "string" && item.repo) slugs.add(item.repo);
  }
  return Array.from(slugs);
}
