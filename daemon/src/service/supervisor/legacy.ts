// CI Panel 扩展：给还没升级的 panel 回填的两个老字段。
//
// 部署没有跨机编排，也没有版本握手（deploy/install.sh 是 --role daemon|web|all、按机分批），
// 所以「节点先升、面板机后升」必然发生。不回填的话，老 panel 读到的 systemd 字段是 undefined，
// 于是它落进「按句柄实例判在线」的分支 —— 而句柄实例永远不 running，一台正常跑着 job 的节点
// 会表现为「全部 runner 已停止 / 无人托管 / 启停入口消失 / 冲突告警归零」，且全程没有报错。
//
// 只救得了 systemd 节点（条件是 raw 里有 service）。这是可以接受的：别的托管方式是这次才有的
// 新能力，老面板本来也不认识；而 systemd 节点是存量，不能在升级窗口里集体掉线。
// 1.2 与 SystemdAction 别名、hasSystemd 一起删。
import type { RunnerRuntimeState, ScannedRunner, SystemdStateCompat } from "mcsmanager-common";

export function legacySystemdState(runtime: RunnerRuntimeState | null): SystemdStateCompat | null {
  const raw = runtime?.raw;
  if (!raw?.service) return null;
  return {
    service: raw.service,
    loaded: true,
    activeState: raw.activeState ?? "",
    subState: raw.subState ?? "",
    enabled: raw.unitFileState ?? "",
    since: runtime?.since ?? ""
  };
}

export function legacyManagedBy(runtime: RunnerRuntimeState | null): ScannedRunner["managedBy"] {
  if (runtime?.ownership === "conflict") return "both";
  // 老 panel 的 "systemd" 只表示「有人在托管它」，它认得的也只有这一种托管方式
  return runtime?.ownership === "self" ? "systemd" : "none";
}
