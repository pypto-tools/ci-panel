// CI Panel 扩展：托管方式相关的处置指引。
//
// 单独一个叶子文件，只依赖 i18n：detach 失败时 none 后端要给指引，而后端是被注册表加载的，
// 指引若和注册表放在同一条依赖链上（none → resolve → registry → none），谁先被 require 就
// 决定了注册表里那一格是不是 undefined。放在这里，那条环根本不成立。
import { $t } from "../../i18n";
import type { SupervisorKind } from "mcsmanager-common";

// 表驱动：新增一种托管方式时这张 Record 会编译失败，提醒补一条指引
const DETACH_HINT: Record<SupervisorKind, string> = {
  systemd: "TXT_CODE_RUNNER_DETACH_HINT_SYSTEMD",
  none: "TXT_CODE_RUNNER_DETACH_HINT_NONE"
};

// 已 i18n 的处置指引：目录里还有活 listener、面板停不掉它时，告诉用户该去做什么
export function detachHint(kind: SupervisorKind): string {
  return $t(DETACH_HINT[kind]);
}
