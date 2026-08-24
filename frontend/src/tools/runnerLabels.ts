// 新建 runner 时预填的默认标签。
//
// 标签是 workflow 选机器的唯一依据（runs-on），而「x86_64 的节点上默认填着 arm64」这种错在
// 界面上看不出任何异常：runner 建得出来、也能上线，只是从此再没有一个 job 派得对。所以默认值
// 必须来自所选节点自报的架构，不能写死。
//
// 平台部分固定 linux：置备走的是 systemd + actions-runner-linux-* 安装包，本项目没有别的分支。

// 节点没报架构时沿用的值（daemon 比面板旧，info/overview 里还没有 arch 字段）。
// 取 arm64 是为了与升级前的行为一致；这只是预填值，用户仍可改。
export const FALLBACK_ARCH_LABEL = "arm64";

// os.arch() 之外的常见写法（uname -m / docker 的叫法）也一并归一，免得换个来源就少认一种。
const ARCH_ALIASES: Record<string, string> = {
  x86_64: "x64",
  amd64: "x64",
  aarch64: "arm64"
};

// 架构 → 标签。GitHub 自带标签用 X64/ARM64，本项目一律小写。
// 认不出的取值原样透出（小写）：显示节点自报的架构比替用户猜一个更可能错的值要好。
export function archLabel(arch?: string): string {
  const a = (arch || "").trim().toLowerCase();
  if (!a) return FALLBACK_ARCH_LABEL;
  return ARCH_ALIASES[a] || a;
}

export function defaultRunnerLabels(arch?: string): string {
  return `linux,${archLabel(arch)}`;
}
