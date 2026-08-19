// CI Panel 扩展：由观测算出归属，再塌缩成 UI 读的那个运行态。
//
// 两个函数都是纯的、且**不认识任何具体后端** —— 加一种托管方式时它们一个字都不用改，而
// 「同一时刻只有一个托管方」的全部不变量都建立在它们的输出上。单独一个叶子文件，只依赖类型：
// 后端要用它算控制结果里的 runtime，而后端是被注册表加载的，放进 resolve.ts 就会绕出一条
// 「谁先被 require 决定注册表里那一格是不是 undefined」的加载环。
import type {
  RunnerOwnership,
  RunnerRunState,
  RunnerRuntimeState,
  SupervisorKind
} from "mcsmanager-common";

import type { Observation, ObservedInstance } from "./types";

/**
 * **只数实例个数、不读 state**，这是刻意的：systemd 单元 failed/inactive 但 listener 还活着
 * 是真实存在的状态，按 state 过滤掉它们会让归属退化成 idle 并放行 start，正好制造要防的那种
 * 双托管。要保证的东西在输入侧 —— observe 的「只报活体」契约（types.ts）。
 */
export function ownershipOf(
  declared: SupervisorKind,
  instances: ObservedInstance[],
  complete = true
): RunnerOwnership {
  // 「答不出」与「确实没有」必须分开，fail closed：unknown 不放行 start
  if (!complete && instances.length === 0) return "unknown";
  if (instances.length === 0) return "idle";
  if (instances.length > 1) return "conflict"; // 同一目录跑起两个 listener，一定要告警
  if (instances[0].disputed) return "conflict"; // 两个后端同时认领同一个实例
  const by = instances[0].by;
  if (!by) return "foreign";
  // 被声明之外的后端管着：意图与实际不符（典型来源就是特权助手坏掉那个场景），同样危险
  return by === declared ? "self" : "conflict";
}

// 一个目录可能有 N 个实例，而 UI 要的是一行。最活跃的那个状态胜出：一个正在起、一个已在跑
// 的时候，说「在跑」比说「正在启动」更接近用户要做的判断（能不能停它）。
const STATE_RANK: RunnerRunState[] = ["running", "starting", "stopping", "failed", "stopped"];

/**
 * 观测 → 面板读的运行态。**同步**，且只吃 Observation：不许在这里读任何后端的私有存储，
 * 否则后端知识就顺着这个「后端无关」的函数散播出去了。0 实例时的解释来自 Observation.detail，
 * 由后端在 observe 里填好。
 */
export function toRuntimeState(
  supervisor: SupervisorKind,
  obs: Observation,
  complete: boolean
): RunnerRuntimeState {
  const ownership = ownershipOf(supervisor, obs.instances, complete);
  return {
    supervisor,
    ownership,
    // 有活体就算在线，与谁在管无关：foreign 也是「它确实在跑」
    running: ownership === "self" || ownership === "foreign",
    state:
      obs.instances.length === 0
        ? complete
          ? "stopped" // 确实停着 —— 最常见的那一格
          : "unknown" // 答不出
        : (STATE_RANK.find((r) => obs.instances.some((i) => i.state === r)) ?? "unknown"),
    // 有实例就用实例的，没实例就用目录级的（那正是「起不来」的场景）
    detail: obs.instances.find((i) => i.detail)?.detail || obs.detail || "",
    since: obs.instances.find((i) => i.since)?.since || "",
    busy: obs.instances.some((i) => i.busy),
    raw: obs.instances[0]?.raw
  };
}
