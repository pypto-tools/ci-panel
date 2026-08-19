// CI Panel 扩展：以文件系统为真相源，扫描机器上真实存在的 GitHub Actions runner。
//
// 为什么需要它：runner 的归属和状态，权威记录都在磁盘上，而不在面板的数据库里。
//   <runner 目录>/.runner   —— GitHub 官方 runner 注册时写的，含 gitHubUrl（属于哪个仓库）和 agentName
//   <runner 目录>/.service  —— 单元安装时写的，内容是 systemd 单元名
//   <runner 目录>/.cipanel  —— 面板纳管标记（membership 的唯一真相源，见 runner_marker）
//
// 托管方式只认 systemd：面板实例一律只是「句柄」（不带启动命令、不跑 runner），
// 所以 managedBy 只会是 systemd 或 none。日常展示只列带 .cipanel 的（scanManagedRunners），
// 全盘发现（scanRunners）只给「导入」用。
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs-extra";
import path from "path";

// 异步版 execFile：本模块调 systemctl 一律用它，避免同步调用卡住 daemon 单线程事件循环——
// systemctl 走 dbus、机器一忙偶发能卡几秒，同步跑就会丢 WebSocket 心跳→面板判定掉线→刷新卡。
const execFileAsync = promisify(execFile);
import InstanceSubsystem from "./system_instance";
import logger from "./log";
import {
  hasMarker,
  metaFilePath,
  readMarker,
  removeMarker,
  writeMarker,
  type RunnerSource
} from "./runner_marker";
import {
  ensureHandleInstance,
  errText,
  HELPER_TIMEOUT_MS,
  helperErrorMessage,
  queryHelperPreflight,
  removeGithubRegistration,
  RUNNER_SVC_HELPER,
  uninstallSystemdService
} from "./runner_provision";
import { dirKey, serviceKey, withRunnerLock } from "./runner_lock";
import { $t } from "../i18n";
import { canonicalPath } from "../tools/path_link_check";
import { legacyManagedBy, legacySystemdState } from "./supervisor/legacy";
import { scanListenerProcs } from "./supervisor/local_procs";
import { toRuntimeState } from "./supervisor/ownership";
import { isSupervisorAction, observeAll, resolveSupervisor } from "./supervisor/resolve";
import { runUnitAction, stopBeforeUninstall } from "./supervisor/systemd";
import type {
  RegisterRunnerItem,
  RegisterRunnerResult,
  ScannedRunner,
  SupervisorAction
} from "mcsmanager-common";
// 三方共用的声明只在 common 里写一份；这里转出去，免得已有的 import 全要改路径
export type { ScannedRunner };

// 单元名的唯一合法形状。与助手脚本的 SERVICE_RE 保持一致。
const SERVICE_RE = /^actions\.runner\.[A-Za-z0-9._@-]+\.service$/;

// ---- 扫描根 ----
// 唯一真相源是特权助手的 ALLOWED_ROOT：那是 root 侧真正的边界，daemon 这边声明得再宽也没用，
// 只会把失败推迟到「runner 已经注册到 GitHub」之后（provision 的第 4 步才调助手）。所以启动时
// 向助手要一次(initRunnerRoots)，拿不到才退回环境变量——开发机没装助手/没配免密属正常。
const FALLBACK_ROOTS = "/data/ci-runner";

function parseRoots(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => path.normalize(s.trim()))
    .filter(Boolean);
}

let runnerRoots: string[] = parseRoots(process.env.CIP_SCAN_ROOTS || FALLBACK_ROOTS);

// daemon 启动时调一次。同步执行：assertUnderRoots 是同步的、且会被 HTTP 请求调用，
// 必须在开始服务之前就定下来，不能让前几个请求用着回退值。
export function initRunnerRoots(): void {
  const pre = queryHelperPreflight();
  if (!pre) {
    logger.warn(
      `[runner-scan] 取不到特权助手的 ALLOWED_ROOT，暂用 ${runnerRoots.join(", ")}。` +
        `创建 runner 时若被助手拒绝，请跑 prod-scripts/install-runner-privileges.sh`
    );
    return;
  }
  // 助手的 ALLOWED_ROOT 是「一个路径」，不是列表 —— 绝不能按逗号切分：目录名里的逗号
  // (/srv/ci,prod 是合法路径)会被拆成两个根，其中 /srv/ci 并非助手的真实根，却会让
  // assertUnderRoots 放行它下面的一切，而 deleteRunner 是直接 fs.remove、不经助手复核的。
  // 拿不到合法的单个绝对路径就 fail closed：退回原有的回退值，不要半信半疑地放宽。
  const helperRoot = path.normalize(pre.allowedRoot.trim());
  if (!path.isAbsolute(helperRoot) || helperRoot === path.sep) {
    logger.error(
      `[runner-scan] 助手返回的 ALLOWED_ROOT 非法(${pre.allowedRoot})，继续使用 ${runnerRoots.join(", ")}`
    );
    return;
  }
  const helperRoots = [helperRoot];
  // CIP_SCAN_ROOTS 是列表而助手只有一个根。历史上多写的根从来就装不上服务(助手会拒)，
  // 所以这里以助手为准同时也修掉了那个不一致，但要说清楚是哪些根被丢掉了。
  const envRaw = process.env.CIP_SCAN_ROOTS;
  if (envRaw && parseRoots(envRaw).join(",") !== helperRoots.join(",")) {
    logger.warn(
      `[runner-scan] CIP_SCAN_ROOTS(${parseRoots(envRaw).join(", ")}) 与助手的 ` +
        `ALLOWED_ROOT(${helperRoots.join(", ")}) 不一致，以助手为准。` +
        `要改扫描根请跑 prod-scripts/install-runner-privileges.sh --root <路径>`
    );
  }
  runnerRoots = helperRoots;
  logger.info(`[runner-scan] 扫描根取自特权助手(v${pre.version}): ${runnerRoots.join(", ")}`);
}

// 布局是 <root>/<仓库目录>/<runner 目录>，两层足够；再深就是 runner 自己的 bin/_work 了
const MAX_DEPTH = 2;

export interface ScanResult {
  roots: string[];
  runners: ScannedRunner[];
  errors: Array<{ dir: string; error: string }>;
}

function isRunnerDir(dir: string) {
  return fs.existsSync(path.join(dir, ".runner"));
}

// 读 <dir>/.service 拿 systemd 单元名。文件不存在（ENOENT）= 没装服务，返回空串；
// 其余失败（权限、EIO 等）一律抛出——绝不能把「读不到」也当成「没装」：deleteRunner 正是
// 靠这个返回值决定要不要占单元名那把锁，静默返回空串会让它在毫无保护的情况下往下删，
// 而这恰恰是本模块要防的那个竞态。不先 existsSync 再读，也顺手去掉了那对 TOCTOU。
// .service 是「目录 → 单元」的权威映射，目录名不可信：simpler-ci/npu-runner-1 这个目录，
// runner 在 GitHub 上其实叫 runner-dev4-7，服务名也是按后者拼的。
// 导出给 deleteRunner（取锁要用）与 runner_env（它在这之上再加一道单元名合法性校验）复用。
export function readServiceName(dir: string): string {
  try {
    // metaFilePath 顺带挡住「.service 是指向别处的符号链接」——目录在根内不代表文件也在。
    return fs.readFileSync(metaFilePath(dir, ".service"), "utf8").trim();
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return "";
    throw err;
  }
}

// 收集所有含 .runner 的目录；命中即停，不再往里挖
function collectRunnerDirs(
  dir: string,
  depth: number,
  out: string[],
  errors: ScanResult["errors"]
) {
  if (depth > MAX_DEPTH) return;
  // 每一层都要复核，不能只在根上校验一次：下面的 statSync/readdirSync 与 isRunnerDir 都跟随
  // 符号链接，所以扫描根里的一个 <root>/仓库/x → /根外目录 就足以让这次扫描去回读根外的
  // .runner，并把它当成一个正常 runner 报给前端。assertUnderRoots 比的是 realpath，能挡住。
  // 记进 errors 而不是静默跳过：本模块对「扫到一半跳过了什么」一贯要求可见（见下面 readdirSync
  // 失败的那一支），静默会让人以为那个目录压根不存在。
  try {
    assertUnderRoots(dir);
  } catch (err: unknown) {
    errors.push({ dir, error: errText(err) });
    return;
  }
  try {
    if (!fs.statSync(dir).isDirectory()) return;
  } catch {
    return;
  }
  if (isRunnerDir(dir)) {
    out.push(dir);
    return;
  }
  if (depth === MAX_DEPTH) return;
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch (err: any) {
    errors.push({ dir, error: err.message });
    return;
  }
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    collectRunnerDirs(path.join(dir, name), depth + 1, out, errors);
  }
}

// 找出正在跑 job 的 runner 目录。
// runner 空闲时只有 Runner.Listener 一个进程；接到 job 后会 fork 出 Runner.Worker 子进程。
// 停一个 busy 的 runner 会当场中断 CI 任务，所以必须在 UI 上标出来、拦一道。
//
// 现在从 supervisor/local_procs 的那一份 /proc 扫描派生 —— 同一个「哪些目录里有活 listener」
// 的问题在托管框架里也要回答，两份实现只会漂移。签名与调用方（删除前的 busy 拦截）都不变。
//
// **这道删除闸门因此仍然硬钉在本机 /proc 上**，与后端 observe 报的 busy 无关：对任何看不见
// Runner.Worker 的托管方式（容器、远端），它会静默退化成「永不 busy」。本方案落地的后端都从
// 同一份扫描派生，两者恒等；第一个打破这个等式的后端必须同时把这道闸改成读 runtime.busy。
async function busyRunnerDirs(): Promise<Set<string>> {
  try {
    const procs = await scanListenerProcs();
    return new Set(procs.filter((p) => p.busy).map((p) => p.dir));
  } catch (err: unknown) {
    // 扫不动 /proc 时回空集合：这里的语义是「拦不拦这次删除」，而删除本身另有 fail closed
    // （detach 会复核活体）。观测路径要的是相反的语义，那条路走 observeAll，它会判 unknown。
    logger.warn(`[runner-scan] /proc 扫描失败，busy 判定按「无」处理: ${errText(err)}`);
    return new Set();
  }
}

// 从仓库地址提取 owner/repo。与 runner_provision.ts 的 repoSlug 同语义
function repoSlug(repoUrl: string): string {
  try {
    const u = new URL(repoUrl);
    const parts = u.pathname
      .replace(/\.git$/i, "")
      .split("/")
      .filter(Boolean);
    if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
    return parts.join("/") || u.hostname;
  } catch {
    return repoUrl;
  }
}

// 校验扫描根并收集其下所有 .runner 目录（全盘发现，不看纳管状态）
function collectFromRoots(roots?: string[]): {
  scanRoots: string[];
  dirs: string[];
  errors: ScanResult["errors"];
} {
  const scanRoots = (roots?.length ? roots : runnerRoots).map((r) => path.normalize(r.trim()));
  const errors: ScanResult["errors"] = [];
  const dirs: string[] = [];
  for (const root of scanRoots) {
    if (!path.isAbsolute(root) || root === "/") {
      errors.push({ dir: root, error: "扫描根必须是绝对路径且不能是 /" });
      continue;
    }
    // 调用方（最终是前端）可以指定更窄的根，但绝不能指定扫描根之外的——否则这个接口
    // 就成了「让 daemon 枚举任意目录下的 .runner 并回读其内容」的通道。只许收窄，不许放宽。
    try {
      assertUnderRoots(root);
    } catch (err: unknown) {
      errors.push({ dir: root, error: errText(err) });
      continue;
    }
    if (!fs.existsSync(root)) {
      errors.push({ dir: root, error: "目录不存在" });
      continue;
    }
    collectRunnerDirs(root, 0, dirs, errors);
  }
  return { scanRoots, dirs, errors };
}

// 从一组已知的 runner 目录构建结果：读 .runner / .service / .cipanel，统一查 systemd 与 busy。
// scanRunners（全盘发现）与 scanManagedRunners（只看已纳管）都复用它，区别只在传进来的 dirs。
async function buildRunners(dirsRaw: string[]): Promise<ScannedRunner[]> {
  // 面板实例按工作目录索引，用来判断这个 runner 面板有没有在托管
  const instanceByCwd = new Map<string, { uuid: string; status: number }>();
  for (const inst of InstanceSubsystem.instances.values()) {
    const cwd = inst?.config?.cwd;
    if (cwd) {
      // key 也走 canonicalPath：句柄实例的 cwd 与扫描来的目录必须算出同一个字符串，
      // 否则软链路径下 instanceUuid 会空掉，文件管理与详情页的授权跟着断
      instanceByCwd.set(canonicalPath(cwd), {
        uuid: inst.instanceUuid,
        status: inst.status()
      });
    }
  }

  // canonicalPath 而不是 normalize：这批 dir 要拿去和 /proc 里的物理路径做字符串全等比较，
  // 两侧必须走同一个归一化函数，否则软链节点上观测恒为空、归属恒判 idle，闸门静默失效。
  // 这是 10 秒一轮的轮询热路径，所以算一次就存进 draft，别对同一个目录算两遍。
  const dirs = dirsRaw.map(canonicalPath);

  // 先把每个目录的 .runner / .service / .cipanel 读出来，再统一观测
  const drafts = dirs.map((dir) => {
    const marker = readMarker(dir);
    const draft = {
      dir,
      dirName: path.basename(dir),
      repo: marker?.repo || "", // 目录坏了读不到 .runner 时，靠 marker 里的 repo 兜底
      agentName: path.basename(dir),
      service: "",
      marker,
      exists: fs.existsSync(path.join(dir, ".runner")),
      broken: undefined as string | undefined
    };
    try {
      // .runner 带 BOM，直接 JSON.parse 会炸。
      // 走 metaFilePath：目录逐层校验过了，但 .runner 本身仍可能是指向根外的符号链接，
      // 而它的内容（repo / agentName）会直接进列表送到浏览器。
      const raw = fs.readFileSync(metaFilePath(dir, ".runner"), "utf8").replace(/^﻿/, "");
      const j = JSON.parse(raw);
      if (j.gitHubUrl) draft.repo = repoSlug(String(j.gitHubUrl));
      if (j.agentName) draft.agentName = String(j.agentName);
    } catch (err: any) {
      draft.broken = `.runner 解析失败: ${err.message}`;
    }
    // readServiceName 现在对非 ENOENT 的失败会抛（删除路径必须 fail closed），但扫描是列表
    // 视图：一个 runner 的 .service 读不动，不该让整份列表都拿不到。记在这一条的 broken 上，
    // 其余照常列出。service 留空意味着查不到 systemd 状态，所以必须说出来，不能静默。
    try {
      draft.service = readServiceName(dir);
    } catch (err: unknown) {
      const msg = `.service 读取失败: ${errText(err)}`;
      draft.broken = draft.broken ? `${draft.broken}；${msg}` : msg;
    }
    return draft;
  });

  // 「谁在托管它、有没有在跑」全部退到托管后端里：这里对所有可用后端求一次并集，
  // 本函数不再认识 systemctl 与 /proc。observeAll 内部一轮只扫一次 /proc。
  const { byDir, complete } = await observeAll(dirs);

  const runners: ScannedRunner[] = drafts.map((d) => {
    // 意图（该由谁管）与观测（现在被谁管着）是两个正交的轴，都由框架给出，这里只是组装
    const supervisor = resolveSupervisor(d.dir, d.marker);
    const runtime = toRuntimeState(supervisor, byDir.get(d.dir) ?? { instances: [] }, complete);
    const instance = instanceByCwd.get(d.dir);

    return {
      dir: d.dir,
      dirName: d.dirName,
      repo: d.repo,
      agentName: d.agentName,
      supervisor,
      runtime, // ownership / running / state / busy / raw
      // ---- 兼容回填：给还没升级的 panel 读（见 supervisor/legacy.ts），1.2 一起删 ----
      systemd: legacySystemdState(runtime),
      managedBy: legacyManagedBy(runtime),
      // ------------------------------------------------------------------------
      // 句柄实例只作文件管理/详情页的抓手（那些接口按 uuid 授权），不参与任何托管判断
      instanceUuid: instance?.uuid || "",
      instanceStatus: instance ? instance.status : -1,
      managed: Boolean(d.marker),
      markerId: d.marker?.id || "",
      source: d.marker?.source || "",
      group: d.marker?.group || "",
      exists: d.exists,
      broken: d.broken
    };
  });

  runners.sort((a, b) => (a.repo + a.agentName >= b.repo + b.agentName ? 1 : -1));
  return runners;
}

// 全盘发现：返回 roots 下所有 .runner 目录（无论有没有纳管），每个带 managed 标记。
// 只给「导入」列表用——让用户看见机器上全部 runner，已纳管的置灰。
export async function scanRunners(roots?: string[]): Promise<ScanResult> {
  const { scanRoots, dirs, errors } = collectFromRoots(roots);
  const runners = await buildRunners(dirs);
  logger.info(`[runner-scan] 扫描 ${scanRoots.join(", ")}：发现 ${runners.length} 个 runner`);
  return { roots: scanRoots, runners, errors };
}

// 自愈：已纳管(有 marker)但缺句柄实例的 runner，补建一个。
// 覆盖历史数据——本次改动之前导入的 runner 只写了 marker、没建实例，文件管理/详情页会缺 instanceUuid；
// 靠这个在列表/详情读取时自动补上，用户无需重新导入(导入弹窗里它们已置灰、也没法再导)。
// ensureHandleInstance 幂等：已有实例直接返回，不重复建。
// 不能加 `!r.instanceUuid` 前置条件：ensureHandleInstance 本身幂等（已有就复用），
// 而且它还负责把早期句柄实例遗留的启动命令(bash run.sh)收掉——那些恰恰是「已有句柄」的，
// 加了前置条件就永远轮不到修。
function reconcileHandle(r: ScannedRunner) {
  if (r.managed && r.exists) {
    try {
      r.instanceUuid = ensureHandleInstance(r.dir, r.repo, r.agentName);
    } catch (err: any) {
      logger.warn(`[runner-scan] 补建/修复句柄实例失败 ${r.dir}: ${err?.message || err}`);
    }
  }
}

// 发现全部「被管理的 runner」目录：遍历面板的句柄实例——每个被管理 runner 纳管时都建了一个
// 句柄实例，其 cwd 就是 runner 目录（实例配置持久化、重启不丢）。所以直接从实例 cwd 拿到全部
// 被管理 runner，不再遍历 CIP_SCAN_ROOTS——runner 放在任意位置都能被列出，不受扫描根限制。
// 仍以 .cipanel 过滤，排除 global 等非 runner 实例（它们目录里没有 .cipanel）。
function managedRunnerDirs(): string[] {
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const inst of InstanceSubsystem.instances.values()) {
    const cwd = inst?.config?.cwd;
    if (!cwd) continue;
    const norm = canonicalPath(cwd);
    if (seen.has(norm)) continue;
    seen.add(norm);
    if (hasMarker(norm)) dirs.push(norm);
  }
  return dirs;
}

// 列出已纳管的 runner，供日常展示用。
export async function scanManagedRunners(): Promise<ScanResult> {
  const runners = await buildRunners(managedRunnerDirs());
  runners.forEach(reconcileHandle); // 幂等：顺手修早期句柄实例遗留的启动命令
  logger.info(`[runner-scan] 已纳管（经句柄实例发现）：${runners.length} 个`);
  return { roots: [], runners, errors: [] };
}

// 已纳管 runner 的运行计数，供 info/overview 上报「实例状态」。
//
// 句柄实例从不启动，所以按「面板启动了几个实例」统计恒为 0、毫无意义；这里按观测出来的真实
// 运行态统计，节点页看到的才是 runner 的实际运行情况。「在线」全项目只有 runtime.running 一处
// 定义，不在这里重新解析一遍 activeState。
//
// info/overview 会被面板高频轮询，故加 TTL 缓存，避免每次都走目录遍历 + systemctl。
// 刻意不做 reconcile（不像 scanManagedRunners 那样补建句柄实例）——这是只读的热路径，不该有副作用。
export interface ManagedRunnerCounts {
  total: number;
  running: number;
  busy: number;
}

const COUNTS_TTL_MS = 5000;
let countsCache: { at: number; value: ManagedRunnerCounts } | null = null;

export async function getManagedRunnerCounts(): Promise<ManagedRunnerCounts> {
  const now = Date.now();
  if (countsCache && now - countsCache.at < COUNTS_TTL_MS) return countsCache.value;

  const runners = await buildRunners(managedRunnerDirs());
  const value: ManagedRunnerCounts = { total: 0, running: 0, busy: 0 };
  for (const r of runners) {
    value.total++;
    if (r.runtime?.running) value.running++;
    if (r.runtime?.busy) value.busy++;
  }
  countsCache = { at: now, value };
  return value;
}

// 探单个 runner 目录的实时状态（详情页拿基本信息 + 定时刷新用）。免全盘遍历。
export async function scanOneRunner(dirRaw: string): Promise<ScannedRunner | null> {
  const dir = path.normalize(String(dirRaw || ""));
  if (!path.isAbsolute(dir) || dir === "/") throw new Error("目录必须是绝对路径且不能是 /");
  // 边界校验：dir 来自前端（runner_router 的 runner/state 原样透传）。少了这一句，任意绝对
  // 路径都能拿来读 <dir>/.runner、.service、.cipanel。
  // 放行已纳管的目录，与 registerRunners 同一套判断：被管理的 runner 允许落在扫描根之外
  // （见 managedRunnerDirs 的说明），一刀切会让那些 runner 的详情页直接打不开。
  // 用 readMarker 而不是 hasMarker：后者只看文件在不在，一个空的 .cipanel 就能把闸放开；
  // 前者要求 marker 真能解析出 id，与 buildRunners 判定 managed 用的是同一个来源。
  // 说清这道闸的边界：它挡的是「没有合法 .cipanel 的任意路径」。已经被植入合法 .cipanel 的
  // 路径仍会走到下面的 reconcileHandle → ensureHandleInstance（句柄实例的 cwd 就是文件管理
  // 的根），那一层由本路由的 ROLE.ADMIN、以及植入 marker 本就需要目标目录写权限来兜底。
  if (!readMarker(dir)) assertUnderRoots(dir);
  const runner = (await buildRunners([dir]))[0] || null;
  if (runner) reconcileHandle(runner); // 详情页直接进来时也补齐，保证文件管理可用
  return runner;
}

// ---- 纳管 / 取消纳管：写、删 .cipanel 标记 ----

// 协议类型来自 common，daemon / panel / frontend 共用一份，见 common/src/runner_protocol.ts
export type RegisterItem = RegisterRunnerItem;
export type RegisterResult = RegisterRunnerResult;

// owner/repo 的形状校验，与面板 entity/repo.ts 的 SLUG_REGEX 对齐。
// 必须校验：repoSlug() 解析不出 URL 时会把输入原样返回（见其实现），那种垃圾值非空，
// 会让下面的兜底判断失效，还会以一个不可能被注册表接受的 slug 进到 RegisterResult.repo。
const SLUG_SHAPE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
function isRepoSlug(s: string): boolean {
  return SLUG_SHAPE.test(s) && !s.includes("..");
}

// 纳管：给指定目录写 .cipanel（默认来源 import——手动导入既有 runner），并确保有个「句柄实例」，
// 让文件管理/配置/详情页能复用 MCSManager 的实例能力。句柄实例不改变实际托管方式：
// systemd runner 仍由 systemd 跑，前端不暴露句柄实例的启停，both 判定也按 source 排除 import。
export function registerRunners(
  items: RegisterItem[],
  source: RunnerSource = "import"
): RegisterResult[] {
  if (!Array.isArray(items) || items.length === 0) throw new Error("没有要纳管的 runner");
  return items.map((it) => {
    const dir = path.normalize(String(it?.dir || ""));
    try {
      if (!path.isAbsolute(dir) || dir === "/") throw new Error("目录必须是绝对路径且不能是 /");
      // 边界校验：dir 来自前端。新纳管一律限制在扫描根之下，和 scan 保持一致。
      // 已经带 .cipanel 的目录放行——被管理的 runner 允许落在扫描根之外（见 managedRunnerDirs
      // 的说明），而改分组标签走的也是这个入口，一刀切会把它们挡在门外。
      if (!hasMarker(dir)) assertUnderRoots(dir);
      if (!fs.existsSync(path.join(dir, ".runner")))
        throw new Error("不是 runner 目录（缺 .runner）");
      const marker = writeMarker(dir, { source, repo: it.repo, group: it.group });
      // 从 .runner 读 agentName / repo，作句柄实例的昵称与分组标签。
      // repo 以 .runner 为准、调用方传的只作兜底：面板拿这个返回值去纳管仓库，而
      // 之后 managed_list 归堆用的也是 .runner 里的 slug（见 buildRunners）。两边同源
      // 才能保证注册表的 key 对得上，否则仓库列表里照样显示"未纳管"。
      let agentName = path.basename(dir);
      let repo = "";
      try {
        const raw = fs.readFileSync(path.join(dir, ".runner"), "utf8").replace(/^﻿/, "");
        const j = JSON.parse(raw) as { agentName?: unknown; gitHubUrl?: unknown };
        if (typeof j.agentName === "string" && j.agentName) agentName = j.agentName;
        if (typeof j.gitHubUrl === "string" && j.gitHubUrl) {
          const slug = repoSlug(j.gitHubUrl);
          if (isRepoSlug(slug)) repo = slug;
        }
      } catch {
        /* .runner 解析失败也不挡纳管，用目录名兜底 */
      }
      // 兜底同样要过校验，否则等于把一个无效 slug 塞进句柄实例标签和返回值
      if (!repo) {
        const fallback = String(it.repo || marker.repo || "");
        if (isRepoSlug(fallback)) repo = fallback;
      }
      const instanceUuid = ensureHandleInstance(dir, repo, agentName);
      logger.info(
        `[runner-register] 纳管 ${dir} (id=${marker.id}, source=${marker.source}, 实例=${instanceUuid})`
      );
      return { dir, ok: true, markerId: marker.id, instanceUuid, repo };
    } catch (err: any) {
      return { dir, ok: false, error: err?.message || String(err) };
    }
  });
}

export interface UnregisterResult {
  dir: string;
  ok: boolean;
  hadInstance: boolean; // 该目录是否有面板实例
  removedInstance: boolean; // 是否回收了句柄实例
}

// 取消纳管：删 .cipanel（不动 runner 本身的文件）。
// 若是 import 来源的「句柄实例」，一并回收（deleteFile=false，只删实例记录、保留 runner 文件）；
// provision 的托管实例不动——那是真在跑 run.sh 的运行单元，不该被"取消纳管"顺手删掉。
export function unregisterRunner(dirRaw: string): UnregisterResult {
  const dir = path.normalize(String(dirRaw || ""));
  if (!path.isAbsolute(dir) || dir === "/") throw new Error("目录必须是绝对路径且不能是 /");
  const marker = readMarker(dir);
  let instanceUuid = "";
  for (const inst of InstanceSubsystem.instances.values()) {
    if (inst?.config?.cwd && path.normalize(inst.config.cwd) === dir) {
      instanceUuid = inst.instanceUuid;
      break;
    }
  }
  removeMarker(dir);
  let removedInstance = false;
  if (instanceUuid && marker?.source === "import") {
    InstanceSubsystem.removeInstance(instanceUuid, false); // deleteFile=false：保留 runner 目录
    removedInstance = true;
  }
  logger.info(`[runner-register] 取消纳管 ${dir}（回收句柄实例: ${removedInstance}）`);
  return { dir, ok: true, hadInstance: Boolean(instanceUuid), removedInstance };
}

// ---- 基目录选择器：浏览 / 新建目录（供前端创建 runner 时挑基目录）----
// 严格限制在扫描根之下，绝不让前端浏览/创建到整个文件系统。扫描根见文件顶部的 runnerRoots：
// 正常部署下它等于助手的 ALLOWED_ROOT，所以这里放行的目录助手一定也放行。

const scanRoots = () => [...runnerRoots];

export function assertUnderRoots(target: string) {
  if (!path.isAbsolute(target)) throw new Error("路径必须是绝对路径");
  // 比较真实路径：只做字符串前缀判断的话，扫描根下的一个符号链接（<root>/x → /etc）
  // 就能把这道边界绕过去。
  //
  // 路径还不存在时（listDirs/makeDir 会传新建目录）realpathSync 直接失败，此时不能退回按字面
  // 路径比较：<root>/x → /根外 的链接下面，一个尚未创建的 <root>/x/新目录 字面上仍以 <root>
  // 开头，就那么放过去了。改成上溯到最深的那个「存在的祖先」，解析它，再把剩下的字面段拼回来。
  // 于是不存在的路径按其真实落点判定，而合法的新建路径（祖先在根内）照旧放行。
  const real = (p: string) => {
    const rest: string[] = [];
    let cur = path.normalize(p);
    for (;;) {
      try {
        return path.join(fs.realpathSync(cur), ...rest);
      } catch {
        const parent = path.dirname(cur);
        // 一路上溯到文件系统根都不存在（或没权限 lstat）：没有可信的落点可推，
        // 退回字面路径。这一支只在整条路径都不存在时才会走到。
        if (parent === cur) return path.normalize(p);
        rest.unshift(path.basename(cur));
        cur = parent;
      }
    }
  };
  const resolved = real(target);
  const roots = scanRoots();
  const realRoots = roots.map(real);
  if (!realRoots.some((r) => resolved === r || resolved.startsWith(r + path.sep)))
    throw new Error(`只允许在扫描根下操作：${roots.join(", ")}`);
}

export interface DirListing {
  path: string;
  parent: string; // 空 = 已在扫描根，不能再往上
  roots: string[];
  dirs: string[]; // 子目录名（不含隐藏目录）
}

export function listDirs(pathRaw?: string): DirListing {
  const roots = scanRoots();
  const target = pathRaw ? path.normalize(String(pathRaw)) : roots[0] || "/";
  assertUnderRoots(target);
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory())
    throw new Error(`目录不存在: ${target}`);
  const dirs: string[] = [];
  for (const name of fs.readdirSync(target)) {
    if (name.startsWith(".")) continue; // 隐藏目录不列
    try {
      if (fs.statSync(path.join(target, name)).isDirectory()) dirs.push(name);
    } catch {
      /* 权限/竞态，跳过 */
    }
  }
  dirs.sort((a, b) => a.localeCompare(b));
  const parent = roots.some((r) => target === r) ? "" : path.dirname(target);
  return { path: target, parent, roots, dirs };
}

export function makeDir(pathRaw: string, name: string): { path: string } {
  const base = path.normalize(String(pathRaw || ""));
  const folder = String(name || "").trim();
  if (!folder || /[/\\]/.test(folder) || folder === "." || folder === "..")
    throw new Error("目录名不能为空、且不能含 / \\ 或 . ..");
  assertUnderRoots(base);
  if (!fs.existsSync(base)) throw new Error(`父目录不存在: ${base}`);
  const full = path.join(base, folder);
  fs.ensureDirSync(full);
  logger.info(`[runner] 新建目录 ${full}`);
  return { path: full };
}

// ---- 彻底删除一个 runner：停+卸 systemd、从 GitHub 注销、清面板侧、删目录 ----

export type DeleteStepStatus = "ok" | "failed" | "skipped";
export interface DeleteStep {
  key: "systemd" | "github" | "panel" | "dir";
  label: string;
  status: DeleteStepStatus;
  detail?: string; // 失败 / 跳过的原因
  hint?: string; // 失败时可手动执行的命令 / 做法，供用户接着做
}
export interface DeleteResult {
  dir: string;
  ok: boolean; // 目录是否删掉（核心结果）
  steps: DeleteStep[]; // 每一步的执行结果，供前端展示"卡在哪一步"
  warnings: string[]; // 由非 ok 步骤派生，兼容旧用法
}

export interface DeleteRunnerOptions {
  removeToken?: string; // GitHub 删除 token，没有就跳过注销那一步
  proxy?: string;
  force?: boolean; // 正在跑 job 也删（会中断 CI）
}

// 删除是不可逆的破坏性操作。分步 best-effort：单步失败记 warning 但继续，尽量把 runner 清干净。
export async function deleteRunner(
  dirRaw: string,
  opts: DeleteRunnerOptions = {}
): Promise<DeleteResult> {
  // 严格校验：绝对路径、非根、必须在扫描根下、且看起来确实是 runner 目录——绝不误删别处。
  //
  // canonicalPath 而不是 normalize：这个值往下要当锁的 key（dirKey）、要和实例的 cwd 比、
  // 要和 busyRunnerDirs 的键比，而那三处都已经归一化过了。只 normalize 的话，一个符号链接
  // 别名就能占到与 controlRunner 不同的 dirKey（删除与启停的互斥静默失效）、绕开 busy 拦截、
  // 并把句柄实例留在面板里指着一个已经删掉的目录。
  //
  // 绝对性判在**原串**上、归一化之前：canonicalPath 内含 path.resolve，空串会被补成 daemon
  // 的 cwd 并一路通过这道检查（顺序沿用 controlRunner）。
  const raw = String(dirRaw || "");
  if (!path.isAbsolute(raw)) throw new Error("目录必须是绝对路径且不能是 /");
  const dir = canonicalPath(raw);
  if (dir === "/") throw new Error("目录必须是绝对路径且不能是 /");
  // 走共享的 assertUnderRoots，别再从环境变量重推一份：扫描根的真相源是助手的 ALLOWED_ROOT，
  // 各自推各自的会让这条删除路径和其余路径的边界不一致。
  try {
    assertUnderRoots(dir);
  } catch (err: unknown) {
    throw new Error(`拒绝删除扫描根之外的目录: ${dir}（${errText(err)}）`);
  }
  if (!fs.existsSync(path.join(dir, ".runner")) && !fs.existsSync(path.join(dir, ".cipanel")))
    throw new Error("不是 runner 目录（无 .runner / .cipanel），拒绝删除");

  // 单元名必须在动手之前读：uninstall 成功后助手会把 <dir>/.service 一并删掉，之后就取不到了。
  // 内容不合法就不占这个 key —— controlService 本来也会拒掉这种单元名，占了只是白占。
  // 读不出来（权限、EIO）就拒绝删除：拿不到单元名就占不上那把锁，等于在毫无保护的情况下开删。
  // 和上面几道守卫一样，把原始 fs 错误包一层，说清楚是「因为这个」才不删的。
  let service: string;
  try {
    service = readServiceName(dir);
  } catch (err: unknown) {
    throw new Error(`读取 .service 失败，无法确定 systemd 单元名，拒绝删除: ${errText(err)}`);
  }
  const keys = [dirKey(dir)];
  const lockedService = SERVICE_RE.test(service) ? service : "";
  if (lockedService) keys.push(serviceKey(lockedService));
  // 删除期间挡住同一个 runner 的置备与启停（原因见 runner_lock 顶部）。目录与单元名两个 key
  // 都占：provision 只按目录进来，service_control 只按单元名进来，各挡一条路。
  //
  // 单元名往下传，不让 runDelete 再读一次 .service：那个文件 runner 属主自己就能改写，两次读
  // 之间被换掉的话，我们会去停一个「没锁住的」单元，而锁住的那个还活着，紧接着目录就被删了。
  // 这里读到的这一份既是锁的依据，也必须是后续动作的依据。
  return withRunnerLock(keys, "delete", () => runDelete(dir, opts, lockedService));
}

// 删除本体。进来时已在锁内、目录也已校验过。
// service 是 deleteRunner 加锁时读到并校验过的单元名（空串 = 没装服务/名字不合法）。
async function runDelete(
  dir: string,
  opts: DeleteRunnerOptions,
  service: string
): Promise<DeleteResult> {
  const steps: DeleteStep[] = [];

  // busy 拦截：正在跑 job 的删除会当场中断 CI，必须显式 force
  const busy = await busyRunnerDirs();
  if (busy.has(dir) && !opts.force)
    throw new Error("该 runner 正在跑 job，删除会中断 CI；确认后加 force 重试");

  // 1) 停 + 卸 systemd。先自己把服务停稳，再调 uninstall——理由见 stopBeforeUninstall。
  //    停不下来就不进 uninstall：拿 stop 的失败原因直接走下面那条中止分支，语义一样（systemd
  //    没停下来），但错误文案说得出是「等了多久还没停」，而不是一句和权限问题撞车的超时。
  const stop = await stopBeforeUninstall(service);
  const uninstall = stop.ok ? await uninstallSystemdService(dir) : stop;
  steps.push(
    uninstall.ok
      ? { key: "systemd", label: "停止并卸载 systemd 服务", status: "ok" }
      : {
          key: "systemd",
          label: "停止并卸载 systemd 服务",
          status: "failed",
          detail: uninstall.error,
          hint: `sudo /usr/local/sbin/ci-panel-runner-svc uninstall ${dir}`
        }
  );

  // 停不掉就到此为止。等待期限是 DELETE_SETTLE_MS，远短于单元自己的 TimeoutStopSec=5min——
  // 也就是说到点了 Runner.Listener 很可能还活着，这时候接着往下删目录等于把文件从一个运行中的
  // 进程底下抽走：job 当场崩、_diag 里什么都留不下，而单元还在，systemd 会带着一个空目录反复
  // 重启它。宁可原样留着让人处置，也不留下这种半删状态。
  // 刻意不看 opts.force：那个标志的含义是「中断正在跑的 job」，批量删除时只要选中的 runner
  // 里有一个 busy 前端就会带上它，拿它给这里开口子等于在最该拦的场景下失效。
  if (!uninstall.ok) {
    for (const [key, label] of [
      ["github", "从 GitHub 注销"],
      ["panel", "清理面板句柄实例与纳管标记"],
      ["dir", "删除 runner 目录"]
    ] as const)
      steps.push({
        key,
        label,
        status: "skipped",
        detail: "systemd 服务没能停下来，后续步骤全部跳过，避免删掉一个还在运行的 runner",
        hint: `先手动停：sudo /usr/local/sbin/ci-panel-runner-svc uninstall ${dir}；确认 systemctl status 已停止后再重试删除`
      });
    const warnings = steps.filter((s) => s.status !== "ok").map((s) => `${s.label}：${s.detail}`);
    logger.warn(
      `[runner-delete] ${dir} 中止：systemd 未能停止（${uninstall.error || "未知原因"}）`
    );
    return { dir, ok: false, steps, warnings };
  }

  // 2) 从 GitHub 注销（需删除 token；停服务后才做）
  if (opts.removeToken) {
    const r = await removeGithubRegistration(dir, opts.removeToken, opts.proxy);
    steps.push(
      r.ok
        ? { key: "github", label: "从 GitHub 注销", status: "ok" }
        : {
            key: "github",
            label: "从 GitHub 注销",
            status: "failed",
            detail: r.error,
            hint: `在 runner 目录执行：cd ${dir} && ./config.sh remove --token <删除token>；或到 GitHub 仓库 Settings → Actions → Runners 手动移除`
          }
    );
  } else {
    steps.push({
      key: "github",
      label: "从 GitHub 注销",
      status: "skipped",
      detail: "未取得删除 token（该仓库可能没配 PAT）",
      hint: "到 GitHub 仓库 Settings → Actions → Runners 手动移除该 runner"
    });
  }

  // 3) 清面板侧：句柄实例 + marker（本地操作，基本不会失败）
  let instanceRemoved = false;
  try {
    for (const inst of InstanceSubsystem.instances.values()) {
      // 两侧同源：dir 已 canonicalPath，实例 cwd 也必须走同一个函数（managedRunnerDirs 同此）
      if (inst?.config?.cwd && canonicalPath(inst.config.cwd) === dir) {
        InstanceSubsystem.removeInstance(inst.instanceUuid, false); // 目录我们自己删，这里不删文件
        instanceRemoved = true;
        break;
      }
    }
    removeMarker(dir);
    steps.push({ key: "panel", label: "清理面板句柄实例与纳管标记", status: "ok" });
  } catch (err: any) {
    steps.push({
      key: "panel",
      label: "清理面板句柄实例与纳管标记",
      status: "failed",
      detail: err?.message || String(err)
    });
  }

  // 4) 删目录
  let dirRemoved = false;
  try {
    await fs.remove(dir);
    dirRemoved = true;
    steps.push({ key: "dir", label: "删除 runner 目录", status: "ok" });
  } catch (err: any) {
    steps.push({
      key: "dir",
      label: "删除 runner 目录",
      status: "failed",
      detail: err?.message || String(err),
      hint: `rm -rf ${dir}`
    });
  }

  const warnings = steps
    .filter((s) => s.status !== "ok")
    .map((s) => `${s.label}：${s.detail || s.status}`);
  logger.info(
    `[runner-delete] ${dir}（systemd=${uninstall.ok} 实例=${instanceRemoved} 目录=${dirRemoved}）`
  );
  return { dir, ok: dirRemoved, steps, warnings };
}

// ---- 过渡期的薄壳：按单元名启停 ----
//
// 启停本体已经搬进 supervisor/systemd.ts（连同 --no-block + 自己轮询、isSettled 比对 since、
// 助手错误三分类）。面板下发的启停一律走 supervisor/resolve.ts 的 controlRunner —— 它按目录
// 寻址、以 .cipanel 为授权依据、在锁内过一次归属闸门。
//
// 这里留下的只有一条按单元名进来的路：置备写完初始 drop-in 之后要重启一次单元使其生效，
// 那一刻 .cipanel 还没写，controlRunner 会（正确地）判它「未纳管」。第 5 步把置备改走后端的
// attach 之后，本函数与它的调用方一起删。
export async function controlService(
  service: string,
  action: SupervisorAction
): Promise<{ settled: boolean }> {
  // 复用 resolve.ts 的收窄函数，不再抄一份动作字面量：那边的表由
  // satisfies Record<SupervisorAction, true> 钉住完备性，协议新增一个动作时会当场编译失败，
  // 而抄在这里的字面量只会静默地不放行新动作。
  if (!isSupervisorAction(action))
    throw new Error($t("TXT_CODE_RUNNER_ACTION_UNSUPPORTED", { action }));
  // 助手会再校验一次（那次才是有效的边界）；这里挡住明显非法值，省一次 sudo 往返
  if (!SERVICE_RE.test(service))
    throw new Error($t("TXT_CODE_RUNNER_SERVICE_NAME_INVALID", { service }));
  // 与 deleteRunner 互斥：删除窗口里的 restart 会把刚被卸掉的单元重新拉起来，而目录随后就没了
  return withRunnerLock([serviceKey(service)], "service", () => runUnitAction(service, action));
}

// 老 panel 只发得出单元名（新的发 dir）。反查出目录，让两条路最终都汇到 controlRunner 那个
// 唯一入口，别在路由里留一条绕过 .cipanel 授权的旁路。
//
// 反查不到必须抛一条说得清病因的错：回空串的话会一路落到 controlRunner 的「目录必须是绝对
// 路径」，用户看到的错误与真实原因（这个单元不属于任何纳管目录）毫无关系。
export function dirOfSystemdUnit(service: string): string {
  if (!SERVICE_RE.test(service))
    throw new Error($t("TXT_CODE_RUNNER_SERVICE_NAME_INVALID", { service }));
  for (const dir of managedRunnerDirs()) {
    try {
      if (readServiceName(dir) === service) return dir;
    } catch {
      /* 这一个读不动就跳过，别让它挡住其余目录的反查 */
    }
  }
  throw new Error($t("TXT_CODE_RUNNER_UNIT_NOT_FOUND", { service }));
}
