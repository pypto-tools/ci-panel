// runner 托管方式与归属的展示与守卫。
//
// 这里的 canControl 与 daemon 的 assertActionAllowed 是同一套规则的两份实现：那边是边界
// （不可信的调用方都要过它），这边是体验（按钮该不该灰、灰了要说清为什么）。两边都得有——
// 只有 daemon 那份的话，用户点下去才知道不行；只有这份的话，规则形同虚设。
// 契约由 common 的两个 union 钉住：任何一边漏掉一个取值都会编译失败。
import { t } from "@/lang/i18n";
import type {
  RunnerOwnership,
  ScannedRunner,
  SupervisorAction,
  SupervisorKind
} from "mcsmanager-common";

// 入参写成结构类型而不是 ScannedRunner：仓库视图拿到的是 RepoRunner（panel 聚合出来的形状），
// 两处共用同一个判定函数，就不能挑其中一个具体类型当形参。
export type RunnerControlSubject = Pick<
  ScannedRunner,
  "dir" | "managed" | "supervisor" | "runtime" | "systemd"
>;

export interface ControlCheck {
  ok: boolean;
  reason?: string; // 已 i18n：禁用提示与 tooltip 共用
}

export function canControl(r: RunnerControlSubject, action: SupervisorAction): ControlCheck {
  // 未纳管的目录不给启停：runner/state 会放行扫描根内未纳管的目录（只读详情页要用），
  // 于是手输一个详情页 URL 就能对一个面板没纳管的 runner 下启停命令。
  if (!r.managed) return { ok: false, reason: t("TXT_CODE_RUNNER_NOT_MANAGED") };
  if (r.supervisor === "none") return { ok: false, reason: t("TXT_CODE_RUNNER_SUPERVISOR_NONE") };

  // 兜底取 unknown 而不是 idle：runtime 缺失（节点还没升级）时我们**并不知道**它在不在跑，
  // 而 idle 是唯一放行 start 的取值。与 daemon 侧的 fail closed 一致。
  const ownership: RunnerOwnership = r.runtime?.ownership ?? "unknown";
  if (ownership === "conflict") return { ok: false, reason: t("TXT_CODE_RUNNER_CONFLICT_REFUSE") };
  if (ownership === "foreign")
    return {
      ok: false,
      reason:
        action === "start"
          ? t("TXT_CODE_RUNNER_ALREADY_SUPERVISED")
          : t("TXT_CODE_RUNNER_FOREIGN_REFUSE")
    };
  // 观测不完整时只放行 stop：start 会去 GitHub 抢身份，restart 内含一次 start
  if (ownership === "unknown" && action !== "stop")
    return { ok: false, reason: t("TXT_CODE_RUNNER_OBSERVE_INCOMPLETE") };
  if (ownership === "self" && action === "start")
    return { ok: false, reason: t("TXT_CODE_RUNNER_ALREADY_RUNNING") };
  return { ok: true };
}

// 表驱动而不是 v-if 链：SupervisorKind 加成员时这张 Record 编译失败，正是我们要的提醒。
const KIND_LABEL: Record<SupervisorKind, string> = {
  systemd: "TXT_CODE_RUNNER_SUPERVISOR_SYSTEMD",
  process: "TXT_CODE_RUNNER_SUPERVISOR_PROCESS",
  none: "TXT_CODE_RUNNER_SUPERVISOR_NONE_LABEL"
};

const OWNERSHIP_TAG: Record<RunnerOwnership, { key: string; color: string }> = {
  self: { key: "TXT_CODE_RUNNER_OWNERSHIP_SELF", color: "blue" },
  idle: { key: "TXT_CODE_RUNNER_OWNERSHIP_IDLE", color: "default" },
  foreign: { key: "TXT_CODE_RUNNER_OWNERSHIP_FOREIGN", color: "orange" },
  conflict: { key: "TXT_CODE_RUNNER_OWNERSHIP_CONFLICT", color: "error" },
  unknown: { key: "TXT_CODE_RUNNER_OWNERSHIP_UNKNOWN", color: "warning" }
};

export function kindLabel(kind: SupervisorKind | undefined): string {
  // 老节点的载荷里没有 supervisor：显示成「外部」比显示一个空标签诚实
  return t(KIND_LABEL[kind ?? "none"]);
}

export function ownershipTag(r: RunnerControlSubject): { label: string; color: string } {
  const tag = OWNERSHIP_TAG[r.runtime?.ownership ?? "unknown"];
  return { label: t(tag.key), color: tag.color };
}

/**
 * 冲突横幅的谓词。
 *
 * foreign 在 none 节点上是**预期状态**（那种节点本来就由外部托管），不该出警告；
 * 在别的节点上它意味着「有个没人认领的 listener 在跑」，要提醒。
 */
export function shouldWarnConflict(r: RunnerControlSubject): boolean {
  const ownership = r.runtime?.ownership;
  return ownership === "conflict" || (ownership === "foreign" && r.supervisor !== "none");
}

// tooltip：冲突与无人认领给处置方向，其余回后端给的 detail（systemd 的 subState、
// process 的 spawn 失败原因……），没有就回空串让 tooltip 不显示。
export function ownershipHint(r: RunnerControlSubject): string {
  const ownership = r.runtime?.ownership;
  if (ownership === "conflict") return t("TXT_CODE_RUNNER_CONFLICT_REFUSE");
  if (ownership === "foreign" && r.supervisor !== "none")
    return t("TXT_CODE_RUNNER_ALREADY_SUPERVISED");
  if (ownership === "unknown") return t("TXT_CODE_RUNNER_OBSERVE_INCOMPLETE");
  return r.runtime?.detail || "";
}

// 单元名只有 systemd 托管才有，且只供展示与过渡期的请求载荷。判断逻辑一律不许读它。
//
// 回退到老字段是必需的，不是保险：还没升级的节点不回 runtime，而那种 daemon 只认单元名。
// 少了这一层，升级窗口里对老节点的每次启停都会带着一个空单元名过去，然后整批失败。
export function serviceOf(r: RunnerControlSubject): string {
  return r.runtime?.raw?.service ?? r.systemd?.service ?? "";
}
