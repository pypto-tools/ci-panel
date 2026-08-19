// CI Panel 扩展：托管后端注册表与节点能力自报。
//
// ★ 新增一种托管方式时，daemon 侧唯一需要改的地方：FACTORIES 加一行。
//
// **FACTORIES 必须是 Record 而不是数组。** 「union 加成员 → 表驱动映射编译失败」是整套框架
// 唯一的强制机制，而 readonly RunnerSupervisorFactory[] 加成员时一行都不红——那样「加后端只动
// 三处」就从编译器强制降级成作者自觉。漏注册的后果还不是运行时报错（nodeCapabilities 与
// resolveSupervisor 都产不出未注册的 kind），而是新后端静默变成死代码、节点悄悄退回默认，
// 比崩溃难发现得多。
//
// 能力检测也不能是硬编码的 if-else（「有 systemd 就 systemd，否则 process」那种）：每个后端
// 自报可用性、原因与优先级，节点默认取「可用者里优先级最高的那个」。
import { $t } from "../../i18n";
import logger from "../log";
import { noneFactory } from "./none";
import { processFactory } from "./process";
import { systemdFactory } from "./systemd";
import type { RunnerSupervisor, RunnerSupervisorFactory } from "./types";
import type { SupervisorKind } from "mcsmanager-common";

const FACTORIES = {
  systemd: systemdFactory, // priority 30
  process: processFactory, // priority 20，恒可用（能跑 daemon 就能 fork）
  none: noneFactory // priority 0，恒可用，兜底
} satisfies Record<SupervisorKind, RunnerSupervisorFactory>;

// 遍历顺序直接由 priority 决定，不另立一张顺序表（两张表就会漂移）
const REGISTRY: readonly RunnerSupervisorFactory[] = Object.values(FACTORIES).sort(
  (a, b) => b.priority - a.priority
);

// 已注册的托管方式。Record 只保证形状对得上，不保证有人真去遍历它 —— 覆盖性由
// daemon/test/pure-logic/registry_detect.spec.ts 盯着，漏注册的后果是新后端静默变成死代码。
export function registeredKinds(): SupervisorKind[] {
  return Object.keys(FACTORIES) as SupervisorKind[];
}

export function isSupervisorKind(v: unknown): v is SupervisorKind {
  return typeof v === "string" && v in FACTORIES;
}

export interface SupervisorCapability {
  kind: SupervisorKind;
  available: boolean;
  reason: string;
  isDefault: boolean;
}

let capabilities: SupervisorCapability[] | null = null;

/**
 * 节点能力，进程内算一次。结果随节点信息上报：前端据此给节点打标签、在创建弹窗里默认选对，
 * 并且在监听进程环境变量不可写时说得清原因。
 *
 * CIP_RUNNER_SUPERVISOR 只从 daemon 进程环境读，面板与任何 API 都不接受它——能设它的人
 * 本来就有该节点的 shell。填了但该后端在本节点不可用时会被忽略并退回自动探测。
 */
export function nodeCapabilities(): SupervisorCapability[] {
  if (capabilities) return capabilities;
  const detected = REGISTRY.map((f) => ({ f, a: f.detect() }));
  const forced = process.env.CIP_RUNNER_SUPERVISOR;
  // REGISTRY 已按 priority 降序，且 none 恒可用，所以兜底一定取得到 —— 但不去索引 [0]：
  // 哪天 none 变成有条件可用，无守卫的写法会在首次能力探测（daemon 启动早期）抛一个
  // 「Cannot read properties of undefined」，而真正的病因是注册表少了兜底项。
  const fallback = detected.find((d) => d.a.available);
  if (!fallback) throw new Error("[supervisor] 没有任何可用的托管后端：注册表缺少恒可用的 none");
  const chosen =
    detected.find((d) => d.f.kind === forced && d.a.available)?.f.kind ?? fallback.f.kind;
  if (forced && forced !== chosen)
    logger.warn(
      `[supervisor] CIP_RUNNER_SUPERVISOR=${forced} 在本节点不可用，退回自动探测的 ${chosen}`
    );
  capabilities = detected.map(({ f, a }) => ({
    kind: f.kind,
    available: a.available,
    reason: a.reason || "",
    isDefault: f.kind === chosen
  }));
  for (const c of capabilities)
    logger.info(
      `[supervisor] ${c.kind}: ${c.available ? "可用" : `不可用（${c.reason}）`}` +
        `${c.isDefault ? " ← 节点默认" : ""}`
    );
  return capabilities;
}

// 仅供测试：能力是进程内 memo 的，而覆盖性与 CIP_RUNNER_SUPERVISOR 的用例必须能换一组 env
// 重新探测。生产代码不许调它 —— 探测结果在一次运行内必须是稳定的（意图落盘就是为了这件事）。
export function __resetNodeCapabilitiesForTest(): void {
  capabilities = null;
  instances.clear();
}

export function nodeDefaultSupervisor(): SupervisorKind {
  return nodeCapabilities().find((c) => c.isDefault)!.kind;
}

// 后端实例按 kind 复用：带状态的后端（进程表、退避计时）每次 create 一个新的就等于没有状态。
const instances = new Map<SupervisorKind, RunnerSupervisor>();

/**
 * 取某种托管方式的后端。**未注册的 kind 抛错而不是回 null**：调用方都不做 null 检查，
 * 而 resolveSupervisor 与 nodeCapabilities 都产不出未注册的 kind——真出现了就是注册表漏了一行，
 * 静默降级比抛错难查得多。
 */
export function backendFor(kind: SupervisorKind): RunnerSupervisor {
  const cached = instances.get(kind);
  if (cached) return cached;
  // kind 可能来自磁盘上的 .cipanel，未必是本版本注册过的取值，所以这里显式收一次 undefined
  const factory: RunnerSupervisorFactory | undefined = FACTORIES[kind];
  if (!factory) throw new Error($t("TXT_CODE_RUNNER_SUPERVISOR_UNKNOWN", { kind }));
  const backend = factory.create();
  instances.set(kind, backend);
  return backend;
}

// detect().available 的那些，按 priority 降序。跨后端观测求并集时遍历它
export function availableBackends(): RunnerSupervisor[] {
  return nodeCapabilities()
    .filter((c) => c.available)
    .map((c) => backendFor(c.kind));
}
