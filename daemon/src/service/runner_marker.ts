// CI Panel 扩展：runner 目录下的 .cipanel 标记文件。
//
// 它是「这个 runner 归面板纳管」的磁盘凭据，也是纳管关系的唯一真相源——面板不再另存一份
// 注册表去和磁盘对账，避免两份数据漂移。日常展示时 daemon 只返回带 .cipanel 的目录，
// 于是「面板管哪些 runner」由 marker 决定，而不是「机器上存在哪些 .runner」。
//
// 与同目录下另外两个文件各记一件事、互不覆盖：
//   .runner   —— GitHub 官方写的，记归属（gitHubUrl / agentName）
//   .service  —— svc.sh 写的，记 systemd 单元名（托管方式之一）
//   .cipanel  —— 本文件，记面板纳管来源（provision 创建 / import 导入）
//
// 全程只读/只写这一个文件，不碰 runner 本身。
import fs from "fs-extra";
import path from "path";
import { v4 } from "uuid";
import type { RunnerSource } from "mcsmanager-common";

export const MARKER_FILE = ".cipanel";
// v2：新增 labels 字段。v1 老 marker 无 labels，读出为 ""（标签未知），安全降级。
const MARKER_VERSION = 2;

// source 刻意只记「来源」（创建还是导入）这个不变量，不记「现在实际被谁管着」这种会漂移的
// 观测结果——后者每次探测现算，存进静态文件只会过期误导。
//
// 后来新增的 supervisor 字段不与这条冲突：它记的是**意图**（置备时定下「该由谁管」），
// 与观测正交，而且必须落盘——若每次从节点能力现推，特权助手哪天坏掉就会让一个 systemd 在管的
// runner 翻成别的后端，daemon 于是在活着的单元旁边再拉起一个 listener。
//
// 定义在 common/src/runner_protocol.ts，三方共用。这里只转出去，免得已有的
// `from "./runner_marker"` 全要改路径——之前这里是第二份手写声明，两边各自演化。
export type { RunnerSource };

export interface RunnerMarker {
  v: number;
  id: string; // 面板管理标识（与 GitHub agentName、面板实例 uuid 都无关）
  group: string; // 命名前缀（baseName），是同标签组「往后累加」的锚；单个导入可空
  repo: string; // owner/repo
  labels: string; // 注册时的原始 labels（逗号分隔，原样保留）；v1 老 marker / import 无此值时为 ""
  source: RunnerSource;
  managedSince: number; // 纳管时间（ms 时间戳）
  // 置备时定下的托管意图（systemd / none / …）。v1、v2 老 marker 没有这个字段，读出为
  // undefined，由 supervisor/resolve.ts 按「装过单元的算 systemd，其余交给节点默认」推断。
  //
  // 刻意声明成 string 而不是 SupervisorKind：它是磁盘上的原始值，合法性由 resolveSupervisor
  // 那边的 isSupervisorKind 判一次（注册表在那边）。本文件是最底层、不引任何其他 service，
  // 把它拉进后端的依赖环不值得。
  supervisor?: string;
}

export function markerPath(dir: string) {
  return path.join(dir, MARKER_FILE);
}

// runner 的元数据文件（.runner / .service / .cipanel）必须真的落在那个 runner 目录里。
// 三个文件 runner 属主自己都能写，把其中任一换成指向别处的符号链接，读取方就会跟过去 ——
// 目录在扫描根内，不代表它里面的文件也在。少了这道检查，一个 <runner>/.runner → /任意文件
// 就能让扫描把该文件的内容当作 runner 元数据读回并送到浏览器（JSON 解析失败时，Node 的错误
// 信息里还带着内容前缀）。
//
// 比的是「文件的 realpath 是否就在该目录的 realpath 下」，而不是再调一次 assertUnderRoots：
// 被管理的 runner 允许落在扫描根之外（见 runner_scan 的 managedRunnerDirs），所以对这三个
// 文件而言正确的约束是「不许逃出自己的目录」—— 那对根内根外都成立。
// 导出给 runner_scan 复用（它读 .runner 和 .service）。放在本文件是因为这里最底层、
// 不 import 任何其他 service，不会绕出循环依赖。
export function metaFilePath(dir: string, name: string): string {
  const file = path.join(dir, name);
  // 文件不存在时抛 ENOENT，与直接 readFileSync 的行为一致，调用方照旧按「没有这个文件」处理。
  const realFile = fs.realpathSync(file);
  if (path.dirname(realFile) !== fs.realpathSync(dir))
    throw new Error(`${name} 逃出了 runner 目录（疑似符号链接）: ${dir}`);
  return realFile;
}

// 逃逸的 marker 一律当作「没有 marker」。这里必须 fail closed：registerRunners 与 scanOneRunner
// 正是靠 hasMarker/readMarker 为真来跳过 assertUnderRoots 的，返回 true 等于把边界让开。
export function hasMarker(dir: string): boolean {
  try {
    metaFilePath(dir, MARKER_FILE);
    return true;
  } catch {
    return false;
  }
}

export function readMarker(dir: string): RunnerMarker | null {
  try {
    const raw = fs.readFileSync(metaFilePath(dir, MARKER_FILE), "utf8").replace(/^\uFEFF/, "");
    const j = JSON.parse(raw);
    if (!j || typeof j.id !== "string" || !j.id) return null;
    return {
      v: Number(j.v) || MARKER_VERSION,
      id: String(j.id),
      group: String(j.group || ""),
      repo: String(j.repo || ""),
      labels: String(j.labels || ""),
      source: j.source === "import" ? "import" : "provision",
      managedSince: Number(j.managedSince) || 0,
      // 不是字符串就当没写过：取值本身是否为已注册的后端，由 resolveSupervisor 再判一次
      supervisor: typeof j.supervisor === "string" && j.supervisor ? j.supervisor : undefined
    };
  } catch {
    return null;
  }
}

// 写 marker，幂等：目录已有 marker 时保留原 id / source / managedSince，只补齐 repo、group、labels。
// 这样重复纳管既不会换掉管理标识，也不会把「创建」误改成「导入」。
export function writeMarker(
  dir: string,
  data: { source: RunnerSource; repo?: string; group?: string; labels?: string; id?: string }
): RunnerMarker {
  const existing = readMarker(dir);
  const marker: RunnerMarker = existing
    ? {
        ...existing,
        v: MARKER_VERSION, // 顺带把 v1 老 marker 升到当前版本
        // 用 || 而非 ??：调用方常传空串（如 provisionRunner 的 (params.labels||"").trim()），
        // 空串同样应回退到既有值，否则重复 provision 会把已存的 group/labels 抹掉，runner 掉出标签组。
        repo: data.repo || existing.repo,
        group: data.group || existing.group,
        labels: data.labels || existing.labels
      }
    : {
        v: MARKER_VERSION,
        id: data.id || v4().replace(/-/gim, ""),
        group: data.group || "",
        repo: data.repo || "",
        labels: data.labels || "",
        source: data.source,
        managedSince: Date.now()
      };
  fs.writeFileSync(markerPath(dir), JSON.stringify(marker, null, 2) + "\n", "utf8");
  return marker;
}

export function removeMarker(dir: string) {
  fs.removeSync(markerPath(dir));
}
