// CI Panel 扩展：process 后端的认领判据与观测。
import type { ListenerProc } from "../local_procs";
import type { Observation, ObservedInstance } from "../types";
import type { RunnerRuntime } from "./store";

/**
 * 这个 listener 是不是我们拉起的。
 *
 * 判据是 pgid 而不是 pid：我们 spawn 的是 run.sh（bash），Runner.Listener 是它的孙子。只记 pid
 * 会有个尴尬情况——run.sh 挂了而 listener 还活着，记录的 pid 已死、目录里有活 listener，认领
 * 失败、被判成 foreign，看起来像误报。detached 让 run.sh 成为新进程组的组长，它派生的 listener
 * 继承同一个 pgid。
 *
 * 两个条件都要：单看 pgid，回卷之后可能命中一个毫无关系的进程组；单看 dir，分不出是不是我们
 * 拉起的。
 */
export function owns(rt: RunnerRuntime | null, p: ListenerProc): boolean {
  if (!rt?.pgid) return false;
  return p.dir === rt.dir && p.pgid === rt.pgid;
}

/**
 * 从一份 /proc 快照造出这个目录的实例列表。
 * observe 与 reconcile 的闸门共用它 —— 各写一份的话，自动路径与 UI 会给出两个结论。
 */
export function instancesFrom(
  dir: string,
  procs: readonly ListenerProc[],
  rt: RunnerRuntime | null
): ObservedInstance[] {
  return procs
    .filter((p) => p.dir === dir)
    .map((p) => ({
      id: String(p.pid), // 跨后端去重的硬契约：本机可见的实例一律用 listener pid
      by: rt && owns(rt, p) ? ("process" as const) : undefined,
      state: "running" as const, // 只报活体，所以恒 running
      since: rt?.startedAt ? new Date(rt.startedAt).toISOString() : "",
      busy: p.busy,
      detail: rt?.lastError || "", // 让「spawn 失败原因看得见」真的有来源
      raw: { pid: String(p.pid), pgid: String(p.pgid) }
    }));
}

// 目录级观测。0 实例时 detail 是唯一的解释来源：一个反复起不来的 runner 恰好没有任何实例，
// 而「为什么起不来」正是这时最需要说的话。
export function observationFor(
  dir: string,
  procs: readonly ListenerProc[],
  rt: RunnerRuntime | null
): Observation {
  return { instances: instancesFrom(dir, procs, rt), detail: rt?.lastError || "" };
}
