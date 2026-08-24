// 一键添加 Runner 接口（自研补充，对应 panel 的 /api/runner 路由）
import { useDefineApi } from "@/stores/useDefineApi";
import type { RegisterRunnerItem, RegisterRunnersResponse, RunnerSource } from "mcsmanager-common";

export interface ProvisionRunnerResult {
  instanceUuid: string;
  nickname: string;
  alreadyConfigured: boolean;
}

export const provisionRunner = useDefineApi<
  {
    params: { daemonId: string };
    data: {
      repoUrl: string;
      token: string;
      name: string;
      labels?: string;
      targetDir: string;
      proxy?: string;
    };
  },
  ProvisionRunnerResult
>({
  url: "/api/runner/provision",
  method: "POST"
});

// ---- 批量：多组标签，每组 <基础名>-1..-N ----
export interface RunnerBatchGroup {
  baseName: string;
  labels?: string;
  count: number;
  // 该组每个 runner 的初始环境变量。两个目标与「环境变量」页写的是同两个文件：
  // override → systemd drop-in（进监听进程，代理放这里）；dotenv → <dir>/.env（只进 job/step）。
  // 值里可写 {{index}} 这类占位符，由 daemon 按每个 runner 展开（见 tools/envTemplate.ts）。
  env?: {
    override?: RunnerEnvVar[];
    dotenv?: RunnerEnvVar[];
  };
}

export interface RunnerBatchItemResult {
  name: string;
  ok: boolean;
  instanceUuid?: string;
  error?: string;
}

// 某组标签命中该 repo 已有 label 组，后端强制沿用既有命名前缀时的提示项
export interface RunnerBatchAligned {
  baseName: string; // 用户填的基础名
  labels: string; // 命中的标签
  prefix: string; // 实际沿用的既有前缀
}

// 某仓库在基目录下已有的一个 label 组
export interface RepoLabelGroup {
  key: string; // 归一化标签 key（组身份）
  labels: string; // 展示用原始标签
  prefix: string; // 命名前缀（采番锚点）
  count: number; // 现有数量
  maxIndex: number; // 现有 `${prefix}-N` 的最大 N
  freeIndexes: number[]; // 1..maxIndex 之间的空缺（升序），新建时优先填这些
}

// 只读：列出某仓库在基目录下已有的 label 组
export const runnerRepoGroups = useDefineApi<
  { params: { daemonId: string }; data: { baseDir: string; repoUrl: string } },
  { groups: RepoLabelGroup[] }
>({
  url: "/api/runner/repo_groups",
  method: "POST"
});

export const startRunnerDownload = useDefineApi<
  { params: { daemonId: string }; data: { version?: string; proxy?: string; force?: boolean } },
  { downloadId: string; version: string; url: string; skipped: boolean }
>({
  url: "/api/runner/download_start",
  method: "POST"
});

export interface RunnerDownloadProgress {
  total: number;
  received: number;
  percent: number;
  speed: number; // bytes/s
  done: boolean;
  error?: string;
  version: string;
  path: string;
}

export const runnerDownloadProgress = useDefineApi<
  { params: { daemonId: string }; data: { downloadId: string } },
  RunnerDownloadProgress
>({
  url: "/api/runner/download_progress",
  method: "POST"
});

export interface RunnerCheckResult {
  mode: "direct" | "import";
  path: string;
  exists: boolean;
  localVersion?: string;
  latestVersion?: string;
  updateAvailable?: boolean;
  checkError?: string;
  isTarGz?: boolean;
  sizeMB?: number;
  version?: string;
}

export const checkRunnerPackage = useDefineApi<
  {
    params: { daemonId: string };
    data: { mode: string; packagePath?: string; proxy?: string };
  },
  RunnerCheckResult
>({
  url: "/api/runner/check",
  method: "POST"
});

export interface ProxyCheckTargetResult {
  name: string;
  url: string;
  ok: boolean;
  status?: number;
  ms: number;
  error?: string;
}

export interface ProxyCheckResult {
  proxy: string;
  results: ProxyCheckTargetResult[];
}

export const checkRunnerProxy = useDefineApi<
  {
    params: { daemonId: string };
    data: { proxy?: string };
  },
  ProxyCheckResult
>({
  url: "/api/runner/proxy_check",
  method: "POST"
});

// 创建时「不填也会被写下去」的两批变量，分开报是因为覆盖规则不同：
//   panel  —— 面板按代理字段写的，同时进 .env 与监听进程；表单里填同名变量即可覆盖
//   runner —— runner 注册末尾（config.sh → env.sh）从 daemon 进程环境快照的；
//             表单里填了同名变量它就不会再写（env.sh 只补 .env 里还没有的键）
export interface DefaultDotEnvPreview {
  proxy: string; // 实际生效的代理（前端没填时为 daemon 侧 CIP_RUNNER_PROXY 的兜底值）
  panel: RunnerEnvVar[];
  runner: RunnerEnvVar[];
}

export const runnerDefaultEnv = useDefineApi<
  { params: { daemonId: string }; data: { proxy?: string } },
  DefaultDotEnvPreview
>({
  url: "/api/runner/default_env",
  method: "POST"
});

export const provisionRunnerBatch = useDefineApi<
  {
    params: { daemonId: string };
    data: {
      repoUrl: string;
      token: string;
      proxy?: string;
      baseDir: string;
      groups: RunnerBatchGroup[];
      packagePath?: string;
    };
  },
  { results: RunnerBatchItemResult[]; aligned: RunnerBatchAligned[] }
>({
  url: "/api/runner/provision_batch",
  method: "POST"
});

// ---- 异步批量：启动后台任务 + 轮询进度 ----
interface RunnerBatchData {
  repoUrl: string;
  token: string;
  proxy?: string;
  baseDir: string;
  groups: RunnerBatchGroup[];
  packagePath?: string;
  concurrency?: number; // 同时创建几个（1..10，默认 3）
}

export const startRunnerBatch = useDefineApi<
  { params: { daemonId: string }; data: RunnerBatchData },
  { batchId: string; items: { name: string }[]; aligned: RunnerBatchAligned[] }
>({
  url: "/api/runner/batch_start",
  method: "POST"
});

export type RunnerBatchItemStatus = "pending" | "running" | "done" | "failed";

export interface RunnerBatchProgressItem {
  name: string;
  status: RunnerBatchItemStatus;
  step: string;
  instanceUuid?: string;
  error?: string; // 简短错误
  log?: string; // 完整错误日志（复制/下载用）
}

export interface RunnerBatchProgress {
  done: boolean;
  total: number;
  doneCount: number;
  failCount: number;
  items: RunnerBatchProgressItem[];
}

export const runnerBatchProgress = useDefineApi<
  { params: { daemonId: string }; data: { batchId: string } },
  RunnerBatchProgress
>({
  url: "/api/runner/batch_progress",
  method: "POST"
});

// 重试某批的失败项（新 token 重跑，复用同一 batchId 轮询）
export const retryRunnerBatch = useDefineApi<
  { params: { daemonId: string }; data: { batchId: string; token: string; proxy?: string } },
  { batchId: string; retrying: number }
>({
  url: "/api/runner/batch_retry",
  method: "POST"
});

// 收集：扫描基目录，纳入已注册但未建实例的 runner
export interface CollectRunnersResult {
  baseDir: string;
  collected: { name: string; instanceUuid: string; repo: string }[];
  skipped: { name: string; reason: string }[];
}

export const collectRunners = useDefineApi<
  { params: { daemonId: string }; data: { baseDir: string } },
  CollectRunnersResult
>({
  url: "/api/runner/collect",
  method: "POST"
});

// ---- 扫描：以磁盘为准列出节点上真实存在的 runner（只读，不建实例）----
// 形状来自 common，与 daemon / panel 同一份声明：这里原本是第三份手写镜像。
export type { ScannedRunner };

export const scanRunners = useDefineApi<
  { params: { daemonId: string }; data: { roots?: string[] } },
  { roots: string[]; runners: ScannedRunner[]; errors: Array<{ dir: string; error: string }> }
>({
  url: "/api/runner/scan",
  method: "POST"
});

// ---- 纳管 / 取消纳管：写、删 .cipanel 标记 ----
// 协议类型来自 common，与 daemon / panel 同一份声明（common/src/runner_protocol.ts）。
// 只用 import type：common 的入口还导出 fs / child_process 那些 node 侧代码，
// 类型导入在编译期就被擦除，不会进浏览器 bundle。
export type {
  RegisterRunnerItem,
  RegisterRunnerResult,
  RegisterRunnersResponse,
  RunnerSource
} from "mcsmanager-common";

// 纳管选中的 runner（只写标记，不建实例）。source 缺省为 import
// registeredRepos：本次顺带纳管进仓库注册表的仓库（此前不在表里的那些）
export const registerRunners = useDefineApi<
  {
    params: { daemonId: string };
    data: { items: RegisterRunnerItem[]; source?: RunnerSource };
  },
  RegisterRunnersResponse
>({
  url: "/api/runner/register",
  method: "POST"
});

// 取消纳管（删 .cipanel）。removedInstance=true 说明顺带回收了句柄实例
export const unregisterRunner = useDefineApi<
  { params: { daemonId: string }; data: { dir: string } },
  { dir: string; ok: boolean; hadInstance: boolean; removedInstance: boolean }
>({
  url: "/api/runner/unregister",
  method: "POST"
});

// ---- 基目录选择器：浏览 / 新建目录（限扫描根内）----
export interface DirListing {
  path: string;
  parent: string; // 空 = 已在扫描根，不能再往上
  roots: string[];
  dirs: string[];
}
export const listRunnerDirs = useDefineApi<
  { params: { daemonId: string }; data: { path?: string } },
  DirListing
>({
  url: "/api/runner/list_dirs",
  method: "POST"
});
export const makeRunnerDir = useDefineApi<
  { params: { daemonId: string }; data: { path: string; name: string } },
  { path: string }
>({
  url: "/api/runner/mkdir",
  method: "POST"
});

// 探单个 runner 的实时状态（详情页基本信息 + 定时刷新）。返回 daemon 的 ScannedRunner 结构
export const runnerState = useDefineApi<
  { params: { daemonId: string }; data: { dir: string } },
  { runner: ScannedRunner | null }
>({
  url: "/api/runner/state",
  method: "POST"
});

// 彻底删除一个 runner：停+卸 systemd、GitHub 注销、清面板侧、删目录。不可逆。
export type DeleteStepStatus = "ok" | "failed" | "skipped";
export interface DeleteStep {
  key: "systemd" | "github" | "panel" | "dir";
  label: string;
  status: DeleteStepStatus;
  detail?: string; // 失败/跳过原因
  hint?: string; // 失败时可手动执行的命令
}
export interface DeleteRunnerResult {
  dir: string;
  ok: boolean;
  steps: DeleteStep[];
  warnings: string[];
}
export const deleteRunner = useDefineApi<
  {
    params: { daemonId: string };
    // removeToken：手输的 GitHub 删除 token（可选，留空则用仓库 PAT 自动获取）
    data: { dir: string; repo?: string; force?: boolean; removeToken?: string };
  },
  DeleteRunnerResult
>({
  url: "/api/runner/delete",
  method: "POST",
  // apiService 的默认超时是 30 秒，比 daemon 自己的等待期限还短——客户端先放弃，浏览器弹
  // "删除失败"，而服务端还在一步步往下做，用户看到的失败和实际结果对不上（重试才发现上一次
  // 其实成功了）。删除最慢的一步是等 systemd 停下来（DELETE_SETTLE_MS，60 秒），叠上 GitHub
  // 注销与 rm -rf 可以再多几十秒。10 分钟够用，同时保留一个终点。
  timeout: 1000 * 600
});

// 批量删除一个仓库（在某节点上）的全部 runner。整批共用一个 GitHub 删除 token。
export const deleteRunnerBatch = useDefineApi<
  {
    params: { daemonId: string };
    data: { repo: string; dirs: string[]; force?: boolean; removeToken?: string };
  },
  { results: Array<DeleteRunnerResult & { error?: string }> }
>({
  url: "/api/runner/delete_batch",
  method: "POST",
  // 理由同 deleteRunner，而且更紧迫：panel 侧并发扇出，单项耗时叠加，几个 runner 就能顶满
  // 默认的 30 秒。
  //
  // 注意这里做不到 deleteRunner 那种「客户端一定比服务端后放弃」：panel 是并发 5 的工作池，
  // 每项各有 600s 预算，所以 6 个目录在最坏情况下要 1200s，超过本次的 600s。真正的解法是照
  // provision_batch 改成异步任务流（batch_start + batch_progress），不是继续加大这个数字。
  // 在那之前，这里只是把「几个 runner 就必然超时」压回到「全都卡满才可能超时」。
  timeout: 1000 * 600
});

// ---- runner 的 _diag 运行日志（看控制台，只读，免 sudo）----
export interface DiagLogFile {
  name: string;
  size: number;
  mtime: number;
}

export interface DiagLogResult {
  dir: string;
  files: DiagLogFile[]; // _diag 下所有 *.log，最新在前
  file: string; // 实际返回内容的文件名
  content: string; // 初次=尾部；跟随=新增段
  size: number; // 该文件当前总字节数
  nextOffset: number; // 下次跟随从这里继续
  reset: boolean; // true = 文件被截断/轮转，客户端应清屏后用 content 重铺
  truncated: boolean;
}

export const runnerDiagLogs = useDefineApi<
  {
    params: { daemonId: string };
    data: { dir: string; file?: string; lines?: number; offset?: number };
  },
  DiagLogResult
>({
  url: "/api/runner/diag_logs",
  method: "POST"
});

// 启停结果同样来自 common（common/src/runner_protocol.ts），与 daemon 一份声明。
// SystemdState 已从协议里移除：单元的那几个字段现在进 RunnerRuntimeState.raw，只供展示。
// 升级窗口里 daemon 仍会回填一份同形状的 SystemdStateCompat 给还没升级的 panel。
export type { ControlOutcome, SupervisorAction, SystemdStateCompat } from "mcsmanager-common";
import type {
  ControlOutcome,
  EnvTarget,
  RunnerEnvResult,
  RunnerEnvSection,
  RunnerEnvVar,
  ScannedRunner,
  SupervisorAction
} from "mcsmanager-common";

// 启停 systemd 托管的 runner。依赖 daemon 侧的 sudoers 免密白名单
// 按**目录**寻址：单元名只有 systemd 托管才有。过渡期两个字段都发（service 留给还没升级的节点）
export const controlRunnerService = useDefineApi<
  {
    params: { daemonId: string };
    data: { dir: string; service?: string; action: SupervisorAction };
  },
  ControlOutcome
>({
  url: "/api/runner/service_control",
  method: "POST"
});

// ---- runner 环境变量：两个作用域 ----
//   override（线上取值）—— 进「监听进程」：systemd 写 drop-in，进程托管写 daemon 自己的 env
//                          文件。代理这类要让 runner 连上 GitHub 的变量必须放这里。
//   dotenv              —— runner 目录的 .env，只进 job/step（设备号、库路径放这里）
//
// 线上取值刻意没跟着内部命名改：还没升级的 daemon 会把认不出的值一律归一成 override，
// 于是只该进 job 的变量会被静默写进 root 拥有的 drop-in。
//
// 形状全部来自 common，与 daemon / panel 同一份声明。
export type { EnvTarget, RunnerEnvSection, RunnerEnvVar, RunnerEnvResult };

// 读某 runner 两个目标当前托管的环境变量（只读）
export const getRunnerEnv = useDefineApi<
  { params: { daemonId: string }; data: { dir: string } },
  RunnerEnvResult
>({
  url: "/api/runner/env_get",
  method: "POST"
});

// 设置某 runner 某目标的环境变量。replace=true 整表覆盖；否则合并（upsert 增改、remove 删除）。
// override 走特权助手写盘 + daemon-reload；dotenv 直接写文件。均不重启；生效需另调 restart。
export const setRunnerEnv = useDefineApi<
  {
    params: { daemonId: string };
    data: {
      dir: string;
      target: EnvTarget;
      upsert?: RunnerEnvVar[];
      remove?: string[];
      replace?: boolean;
    };
  },
  RunnerEnvResult
>({
  url: "/api/runner/env_set",
  method: "POST"
});

// 批量设置多个 runner 某目标的环境变量（panel 侧并行）。默认 merge，保留各自已有变量（如各台不同的 DEVICE_ID）。
export const setRunnerEnvBatch = useDefineApi<
  {
    params: { daemonId: string };
    data: {
      dirs: string[];
      target: EnvTarget;
      upsert?: RunnerEnvVar[];
      remove?: string[];
      replace?: boolean;
      concurrency?: number;
    };
  },
  { results: Array<{ dir: string; ok: boolean; error?: string } & Partial<RunnerEnvResult>> }
>({
  url: "/api/runner/env_set_batch",
  method: "POST"
});

// 批量启停/重启（panel 侧并行执行，没有目录的项会被跳过）
export const controlRunnerServiceBatch = useDefineApi<
  {
    params: { daemonId: string };
    data: {
      items: Array<{ dir: string; service?: string }>;
      action: SupervisorAction;
      concurrency?: number;
    };
  },
  {
    results: Array<
      { dir: string; service?: string; ok: boolean; error?: string } & Partial<ControlOutcome>
    >;
  }
>({
  url: "/api/runner/service_control_batch",
  method: "POST",
  // apiService 的默认超时是 30 秒，这里必须放宽：panel 侧以并发 5 扇出，每个 runner 最多花
  // 8 秒等 systemd 落定，所以整批耗时约 ceil(N/5) × 9 秒 —— 20 个 runner 就顶到 30 秒了。
  // 超时只会让浏览器这边报错，服务端该做的还在做，反而给人"失败了"的错觉。10 分钟够几十个
  // runner 用，同时保留一个终点，不像 Number.MAX_SAFE_INTEGER 那样可能永远挂着。
  timeout: 1000 * 600
});
