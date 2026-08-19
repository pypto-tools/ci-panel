// CI Panel 扩展：none —— 只读后端。
//
// 用途：runner 由本 daemon 之外的东西托管（外部编排；或改造完成前的过渡期）。它 detect 恒可用，
// 所以每个节点、每个目录、每一轮都有它这一个本机 /proc 观测者在跑——面板因此能看见「它其实在跑，
// 只是不归自己管」，而所有控制动作都被 assertActionAllowed 当场拒掉。
import { $t } from "../../i18n";
import { canonicalPath } from "../../tools/path_link_check";
import { detachHint } from "./hints";
import { scanListenerProcs, type ListenerProc } from "./local_procs";
import type { Observation, RunnerSupervisorFactory } from "./types";

/**
 * 把一份 /proc 快照按目录归拢成「没有任何后端认领」的实例。
 * 认领信息一律留空（by 不设）：谁认领谁自己在 observe 里说，这里只负责如实上报存在。
 */
export async function observeLocalUnclaimed(
  dirs: string[],
  procs: readonly ListenerProc[]
): Promise<Map<string, Observation>> {
  const wanted = new Set(dirs);
  const byDir = new Map<string, Observation>();
  for (const p of procs) {
    if (!wanted.has(p.dir)) continue;
    const obs = byDir.get(p.dir) ?? { instances: [] };
    obs.instances.push({
      // id 取 listener pid：跨后端去重的唯一可比标识（见 types.ts 的 ObservedInstance.id）
      id: String(p.pid),
      state: "running",
      since: "",
      busy: p.busy,
      raw: { pid: String(p.pid), pgid: String(p.pgid) }
    });
    byDir.set(p.dir, obs);
  }
  return byDir;
}

export const noneFactory: RunnerSupervisorFactory = {
  kind: "none",
  // 兜底：永远可用，所以 nodeCapabilities 按优先级排序后一定有结果
  priority: 0,
  detect: () => ({ available: true }),
  create: () => ({
    kind: "none",
    // 形参 procs 必须收下：none 恒可用，它就是那个「永远在线的本机 /proc 观测者」，
    // 自己再扫一遍等于每轮多扫一次 /proc，而且两份快照新鲜度不同。
    observe: (dirs, procs) => observeLocalUnclaimed(dirs, procs),

    attach: async () => {
      throw new Error($t("TXT_CODE_RUNNER_SUPERVISOR_NONE"));
    },

    // 幂等回 ok，别挡住删除——「本后端没托管过」是成功，不是失败。
    // 但**必须先复核有没有活 listener**：none 管的目录恰恰是最可能有外部进程在跑的那一批，
    // 回错了，删除那侧的 fail closed 会被绕过，目录被从活进程底下删掉。
    // 这里现扫一次而不用观测快照：detach 之后紧接着就是删目录，要的是此时此刻的事实。
    detach: async (dir) => {
      const target = canonicalPath(dir);
      const live = (await scanListenerProcs()).filter((p) => p.dir === target);
      return live.length
        ? {
            ok: false,
            error: $t("TXT_CODE_RUNNER_FOREIGN_RUNNING", { dir: target }),
            hint: detachHint("none")
          }
        : { ok: true };
    },

    start: async () => {
      throw new Error($t("TXT_CODE_RUNNER_SUPERVISOR_NONE"));
    },
    stop: async () => {
      throw new Error($t("TXT_CODE_RUNNER_SUPERVISOR_NONE"));
    },
    restart: async () => {
      throw new Error($t("TXT_CODE_RUNNER_SUPERVISOR_NONE"));
    },

    readListenerEnv: async () => ({ present: false, vars: [] }),
    writeListenerEnv: async () => {
      throw new Error($t("TXT_CODE_RUNNER_LISTENER_ENV_UNAVAILABLE"));
    }
  })
};
