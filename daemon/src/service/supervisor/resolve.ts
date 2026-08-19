// CI Panel 扩展：意图解析、跨后端观测、以及唯一的控制入口。
//
// 这个文件里的函数**都不认识任何具体后端**：加第四种托管方式时它们一个字都不用改，而「同一时刻
// 只有一个托管方」的全部不变量都建立在它们的输出上。
import path from "path";

import { $t } from "../../i18n";
import { canonicalPath } from "../../tools/path_link_check";
import logger from "../log";
import { dirKey, withRunnerLock } from "../runner_lock";
import { metaFilePath, readMarker, type RunnerMarker } from "../runner_marker";
import { errText } from "../runner_provision";
import { scanListenerProcs, type ListenerProc } from "./local_procs";
import { ownershipOf } from "./ownership";
import { availableBackends, backendFor, isSupervisorKind, nodeDefaultSupervisor } from "./registry";
import type { Observation, ObservedInstance } from "./types";
import type {
  ControlOutcome,
  RunnerOwnership,
  SupervisorAction,
  SupervisorKind
} from "mcsmanager-common";

// ---- 意图 ----

// 装过单元的目录里有 .service。只有「文件不存在」才算没装过——读不动或疑似符号链接一律保守
// 当成装过：猜错成 false 会把意图翻成节点默认，daemon 就可能在一个还活着的单元旁边再拉起一个
// listener，两个进程抢同一个 GitHub 身份。
function hasSystemdUnitFile(dir: string): boolean {
  try {
    metaFilePath(dir, ".service");
    return true;
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException)?.code !== "ENOENT";
  }
}

/**
 * 「这个 runner 该由谁托管」。
 *
 * 意图**必须**落盘（.cipanel 的 supervisor），不能每次从节点能力现推：特权助手哪天坏了
 * （sudoers 被覆盖、助手被升级脚本删掉），nodeDefaultSupervisor() 就会翻成另一个后端，
 * daemon 会在一个单元还活着的目录里再拉起一个 listener——正是上游当年废弃子进程托管的那个原因。
 *
 * 老 marker（v1/v2）没有这个字段：装过单元的一定是 systemd 时代创建的；没装过的（导入的、
 * 或装单元失败的）交给节点默认。这条推断让存量数据不需要迁移脚本。
 */
export function resolveSupervisor(dir: string, marker: RunnerMarker | null): SupervisorKind {
  if (marker?.supervisor && isSupervisorKind(marker.supervisor)) return marker.supervisor;
  if (hasSystemdUnitFile(dir)) return "systemd";
  return nodeDefaultSupervisor();
}

// 某个目录声明的后端。合并观测里的 detail 时要用：别的后端对这个目录为什么起不来一无所知
export function declaredFor(dir: string): SupervisorKind {
  return resolveSupervisor(dir, readMarker(dir));
}

// ---- 观测 ----

// 观测结果 + 这一轮到底可不可信。complete=false 时「0 个实例」只说明「不知道」，不说明「没有」
export interface ObserveResult {
  byDir: Map<string, Observation>;
  complete: boolean;
}

/**
 * 对**所有可用后端**求并集，而不是只问声明的那一个——这是冲突检测能成立的唯一方式。
 * dirs 会先归一化，返回的 map 以归一化后的路径为 key。
 */
export async function observeAll(dirs: string[]): Promise<ObserveResult> {
  const keys = dirs.map(canonicalPath);
  const merged = new Map<string, Map<string, ObservedInstance>>();
  const details = new Map<string, string>();
  let complete = true;

  // /proc 一轮只扫一次，快照传给每个后端。扫不动本身也是一次观测失败
  let procs: ListenerProc[] = [];
  try {
    procs = await scanListenerProcs();
  } catch (err: unknown) {
    complete = false;
    logger.error(`[supervisor] /proc 扫描失败，本轮观测不完整: ${errText(err)}`);
  }

  // 每个目录的声明只解析一次。declaredFor 走 readMarker，那是一次同步 readFileSync +
  // realpathSync；放在后端循环里就是 N*B 次阻塞读，而这条路每 10 秒跑一轮。
  const declared = new Map(keys.map((k) => [k, declaredFor(k)]));

  for (const backend of availableBackends()) {
    let seen: Map<string, Observation>;
    try {
      seen = await backend.observe(keys, procs);
    } catch (err: unknown) {
      // 一个后端观测失败不能让整份列表拿不到——但也绝不能当成「它那边没有东西在跑」：
      // 直接跳过就会落到 idle，而 idle 是唯一放行 start 的取值，观测失败于是成了双托管的入口。
      // 所以把 complete 拉掉，由 ownershipOf 判 unknown。
      complete = false;
      logger.error(`[supervisor] ${backend.kind} observe 失败，本轮按未知处理: ${errText(err)}`);
      continue;
    }
    for (const [dir, obs] of seen) {
      const byId = merged.get(dir) ?? new Map<string, ObservedInstance>();
      for (const inst of obs.instances) {
        const prev = byId.get(inst.id);
        // 同一个进程会被多个后端看到（systemd 后端与 none 后端都要读 /proc）。按 id 去重，
        // 认领信息取「有认领的那一份」：否则一个 systemd 在管的 runner 会因为别的后端也看见了
        // 它而被算成两个实例、误判成冲突。
        //
        // 两个后端**都**认领同一个 id 是另一回事：那是真冲突（意图漂移 + 双托管），不许被去重
        // 吞掉——合成一条、by 保留先到者，但打上 disputed，由 ownershipOf 判 conflict。
        if (prev?.by && inst.by && prev.by !== inst.by)
          byId.set(inst.id, { ...prev, disputed: true });
        else byId.set(inst.id, prev?.by ? prev : inst);
      }
      merged.set(dir, byId);
      if (obs.detail && backend.kind === declared.get(dir)) details.set(dir, obs.detail);
    }
  }

  return {
    byDir: new Map(
      Array.from(merged, ([dir, byId]) => [
        dir,
        { instances: Array.from(byId.values()), detail: details.get(dir) || "" }
      ])
    ),
    complete
  };
}

// ---- 控制 ----

// 动作集合的完备性由这张记录型表钉住：协议新增一个动作时数组照样编译得过、这里就会静默不放行，
// 记录型会当场报错。不导出——对外只给下面那个收窄函数，表本身多一个消费方就多一处会漂移的判断。
const ALLOWED_ACTIONS = {
  start: true,
  stop: true,
  restart: true
} satisfies Record<SupervisorAction, true>;

/**
 * 请求体里那串字符是不是一个合法动作。**边界收窄只此一处** —— 每个入口各写一份 `as
 * SupervisorAction` 的话，类型系统会以为边界证明过了，而实际上一次都没有。
 *
 * hasOwnProperty 而不是 in：别让 "toString" 这类原型链上的键蒙混过关。
 */
export function isSupervisorAction(value: string): value is SupervisorAction {
  return Object.prototype.hasOwnProperty.call(ALLOWED_ACTIONS, value);
}

/**
 * 面板下发的启停都从这里走。
 *
 * 授权依据是 .cipanel 纳管凭据，不是「这串字符长得像单元名」：未纳管的目录不该能被面板拉起进程。
 * 不加 assertUnderRoots——纳管的 runner 允许落在扫描根之外（见 runner_scan 的 managedRunnerDirs）。
 */
export async function controlRunner(
  dirRaw: string,
  action: SupervisorAction
): Promise<ControlOutcome> {
  // 路由已经收窄过一次，这里再判一次：controlRunner 是公开导出的唯一控制入口，别让它的安全性
  // 取决于「所有调用方都记得先校验」。
  if (!isSupervisorAction(action))
    throw new Error($t("TXT_CODE_RUNNER_ACTION_UNSUPPORTED", { action }));
  // canonicalPath 而不是 normalize：等号另一侧是 /proc 里的物理路径，两侧必须同源，
  // 否则观测恒为空 → 归属恒为 idle → 下面那三道闸门全部静默失效。
  const raw = String(dirRaw || "");
  if (!path.isAbsolute(raw)) throw new Error($t("TXT_CODE_RUNNER_DIR_NOT_ABSOLUTE"));
  const dir = canonicalPath(raw);
  if (dir === "/") throw new Error($t("TXT_CODE_RUNNER_DIR_IS_ROOT"));

  // readMarker 而非 hasMarker：空文件不算凭据（沿用 scanOneRunner 的判断）
  const marker = readMarker(dir);
  if (!marker) throw new Error($t("TXT_CODE_RUNNER_NOT_MANAGED"));

  const kind = resolveSupervisor(dir, marker);
  const backend = backendFor(kind);

  // 一次性解析：读 .service 只发生在这里，锁的依据 == 动作的依据（见 types.ts 的 SupervisorTarget）
  const target = backend.prepare?.(dir);

  // 目录 key 永远占；其余 key 由 prepare 贡献（systemd 占单元名）。通用路径因此不认识单元名
  const keys = [dirKey(dir), ...(target?.lockKeys ?? [])];
  return withRunnerLock(keys, "service", async () => {
    // 闸门在**锁内**重算：判定与执行之间不许有别人插进来的窗口，而 start/attach 是去 GitHub
    // 抢身份的不可逆副作用。
    const { byDir, complete } = await observeAll([dir]);
    const obs = byDir.get(dir);
    assertActionAllowed(action, ownershipOf(kind, obs?.instances ?? [], complete), kind);
    // 显式分发而不是 backend[action](dir, target)：stop 的第二个形参是 settleMs，
    // 索引调用会把 target 塞到那个位置上。
    return action === "stop" ? backend.stop(dir, undefined, target) : backend[action](dir, target);
  });
}

/**
 * 「同一时刻只有一个托管方」的全部不变量，只写在这一处。新增后端不碰它。
 */
export function assertActionAllowed(
  action: SupervisorAction,
  ownership: RunnerOwnership,
  kind: SupervisorKind
): void {
  if (kind === "none") throw new Error($t("TXT_CODE_RUNNER_SUPERVISOR_NONE"));
  // 观测不完整：拒绝一切**不可逆**动作。start 会去 GitHub 抢身份，restart 内含一次 start；
  // 只有 stop 是纯收敛的（最坏情况是多发一次信号，造不出第二个托管方）。
  if (ownership === "unknown" && action !== "stop")
    throw new Error($t("TXT_CODE_RUNNER_OBSERVE_INCOMPLETE"));
  if (ownership === "conflict") throw new Error($t("TXT_CODE_RUNNER_CONFLICT_REFUSE"));
  if (ownership === "foreign")
    throw new Error(
      action === "start"
        ? $t("TXT_CODE_RUNNER_ALREADY_SUPERVISED")
        : // 不去杀一个不是我们拉起、也不知道怎么正确停的进程
          $t("TXT_CODE_RUNNER_FOREIGN_REFUSE")
    );
  if (action === "start" && ownership === "self")
    throw new Error($t("TXT_CODE_RUNNER_ALREADY_RUNNING"));
  // idle + stop：幂等，直接落定；idle + restart：等价于 start
}
