// CI Panel 扩展：systemd 托管后端。
//
// 这一整块是从 runner_scan.ts 搬过来的，行为逐条保留（异步 execFile、助手 --no-block + 自己
// 轮询、isSettled 比对 since、helperErrorMessage 的三分类）。验收标准只有一句：systemd 老节点
// 看不出区别。
//
// 与搬迁前唯一的结构差别：单元名不再由每个方法各读一次 .service，而是 prepare() 读一次、
// 经 SupervisorTarget.ctx 往下传。那个文件 runner 属主自己就能改写，两次读之间被换掉的话，
// 我们会去停一个「没锁住的」单元，而锁住的那个还活着，紧接着目录就被删了。
// 所以本文件的**动作路径**（start / stop / restart / detach）里不许再出现 readServiceName，
// 只有 prepare（那唯一一次读）与 observe（观测依据，过期最多少报一个实例）可以读。
//
// 本文件里的一切都是 lock-free 的：加锁只发生在框架的五个入口（controlRunner、deleteRunner、
// provisionRunner、writeRunnerEnv、reconcile tick），后端方法互调因此不会撞上 withRunnerLock
// 的不可重入。
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs-extra";
import path from "path";

const execFileAsync = promisify(execFile);

import { $t } from "../../i18n";
import { canonicalPath } from "../../tools/path_link_check";
import logger from "../log";
import { serviceKey } from "../runner_lock";
import {
  errText,
  HELPER_TIMEOUT_MS,
  helperErrorMessage,
  installSystemdService,
  queryHelperPreflight,
  RUNNER_SVC_HELPER,
  setServiceEnv,
  uninstallSystemdService
} from "../runner_provision";
import { readSection } from "../runner_env_vars";
import { readServiceName } from "../runner_scan";
import { detachHint } from "./hints";
import { scanListenerProcs, type ListenerProc } from "./local_procs";
import { toRuntimeState } from "./ownership";
import type {
  Observation,
  ObservedInstance,
  RunnerSupervisor,
  RunnerSupervisorFactory,
  SupervisorTarget
} from "./types";
import type {
  ControlOutcome,
  RunnerEnvSection,
  RunnerEnvVar,
  RunnerRunState,
  SupervisorAction
} from "mcsmanager-common";

const SYSTEMCTL = "/usr/bin/systemctl";

// 单元名的唯一合法形状。与 runner_scan / runner_env / 助手脚本的三份保持一致，
// 一致性由 daemon/test/security/service_name_boundary.spec.ts 盯住。
const SERVICE_RE = /^actions\.runner\.[A-Za-z0-9._@-]+\.service$/;

// 助手已经把 job 交给 systemd 之后，最多再等多久确认它跑到位。等不到不算失败——如实回
// settled:false，让调用方去看状态轮询，绝不把请求挂在这里。
const SETTLE_TIMEOUT_MS = 8000;
const SETTLE_POLL_MS = 500;

// 删除前那次停止用更长的期限。8 秒是给「面板上点启停要立刻有反馈」选的，等不到就交给状态轮询
// 慢慢收敛；而删除等不到就只能整个中止，让人回头再来一遍，所以这里值得多等。上限仍远小于单元
// 的 TimeoutStopSec=5min —— 目的是拿到一个确定的结论，不是陪它耗到底。
export const DELETE_SETTLE_MS = 60000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// 单元状态。比原来的 SystemdState 多一个 mainPid：cgroup 读不到时用它做退化的认领判定。
export interface SystemdUnit {
  service: string;
  loaded: boolean; // systemd 认不认识它（false = 服务文件已被删）
  activeState: string; // active / inactive / failed
  subState: string; // running / dead / ...
  enabled: string; // enabled / disabled / static
  since: string; // 主进程启动时间
  mainPid: number;
}

// 一次 systemctl show 查完所有单元，省得 30 个 runner 调 30 次。异步执行，不阻塞事件循环。
// 失败一律抛：要不要把它降级成「查不到」，由两个包装函数各自决定。
async function showUnits(services: string[]): Promise<Map<string, SystemdUnit>> {
  const result = new Map<string, SystemdUnit>();
  // 单元名来自各 runner 目录下的 .service，而那个文件 runner 属主自己就能改写。不校验就直接
  // 展开进 argv 的话，一份写着 `--property=…` 的 .service 就能改掉这次查询——下面那个
  // --property 排在它们后面，而 systemctl 的选项不认位置。execFile 是数组传参、不起 shell，
  // 所以够不成命令注入，但该拦的还是要拦：形状不合法的一律不查（照旧回 null 状态）。
  const wanted = services.filter((s) => SERVICE_RE.test(s));
  // 丢掉的要说出来。对 .service 的一贯态度是「查不到状态必须让人知道」，静默过滤会让一个
  // .service 写坏的 runner 悄悄显示成「没装服务」。
  if (wanted.length !== services.length)
    logger.warn(
      `[supervisor-systemd] 忽略 ${services.length - wanted.length} 个形状非法的单元名，` +
        `对应 runner 的 systemd 状态将显示为未知`
    );
  if (wanted.length === 0) return result;

  const r = await execFileAsync(
    SYSTEMCTL,
    [
      "show",
      ...wanted,
      "--property=Id,LoadState,ActiveState,SubState,UnitFileState,ExecMainStartTimestamp,MainPID"
    ],
    { encoding: "utf8", timeout: 15000, maxBuffer: 8 * 1024 * 1024 }
  );

  // 多个单元的输出以空行分隔
  for (const block of String(r.stdout).split(/\n\s*\n/)) {
    const kv: Record<string, string> = {};
    for (const line of block.split("\n")) {
      const i = line.indexOf("=");
      if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1);
    }
    if (!kv.Id) continue;
    result.set(kv.Id, {
      service: kv.Id,
      loaded: kv.LoadState === "loaded",
      activeState: kv.ActiveState || "",
      subState: kv.SubState || "",
      enabled: kv.UnitFileState || "",
      since: kv.ExecMainStartTimestamp || "",
      mainPid: Number(kv.MainPID) || 0
    });
  }
  return result;
}

/**
 * 宽容版：查不到就当「状态未知」，回空 map。
 *
 * isSettled 与 stopBeforeUninstall 都明确依赖这个语义（before=null → 回 settled:false，
 * 「没到位，再等」而不是「整个操作失败」）。systemctl 抖一下就让一次删除失败，就违反了
 * 「老节点看不出区别」。
 */
export async function querySystemd(services: string[]): Promise<Map<string, SystemdUnit>> {
  try {
    return await showUnits(services);
  } catch (err: unknown) {
    logger.error(`[supervisor-systemd] systemctl show 失败: ${errText(err)}`);
    return new Map();
  }
}

/**
 * 严格版：**观测路径专用**，失败必须抛。
 *
 * 抛出去才会被 observeAll 接住并把 complete 拉掉，归属随之判成 unknown；吞掉它，整台节点的
 * 归属会静默塌成 idle —— 而 idle 是唯一放行 start 的取值。
 */
async function querySystemdStrict(services: string[]): Promise<Map<string, SystemdUnit>> {
  return showUnits(services);
}

// 这一轮 systemctl 的效果是否已经体现出来了。
// restart/start 光看 activeState=active 不够：restart 一个本来就在跑的单元，头几百毫秒查到的
// 还是「旧的 active」，会把没发生的事判成已完成。所以额外比对主进程启动时间(since)变没变。
export function isSettled(
  action: SupervisorAction,
  before: SystemdUnit | null,
  now: SystemdUnit
): boolean {
  if (action === "stop") return now.activeState === "inactive" || now.activeState === "failed";
  // 没有操作前的基准就没法区分「新起来的」和「本来就是这样的」——querySystemd 出错时会返回
  // 空 map，before 就是 null。这种时候一律按未落定处理：宁可回 settled:false 让页面轮询去
  // 收敛，也不能凭一个旧状态报「成功」或「失败」。
  if (!before) return false;
  // failed 是终态，但必须是这一轮打出来的：单元本来就 failed 时，systemd 还没把 job 出队，
  // 头几百毫秒查到的仍是那个旧 failed，会把一个随后就成功的 restart 当场判成失败。
  if (now.activeState === "failed")
    return before.activeState !== "failed" || now.since !== before.since;
  if (now.activeState !== "active") return false;
  return action === "start" || now.since !== before.since;
}

/**
 * 启停本体：调助手（--no-block）后自己轮询到位。**不加锁**，调用方已在锁内。
 * settleMs 可覆盖：删除路径要的耐心比面板点按钮那条路长得多（见 DELETE_SETTLE_MS）。
 */
export async function runUnitAction(
  service: string,
  action: SupervisorAction,
  settleMs: number = SETTLE_TIMEOUT_MS
): Promise<{ settled: boolean; unit: SystemdUnit | null }> {
  // 重启前的状态：下面判断「restart 是否真的发生了」要拿它的 since 做对比
  const before = (await querySystemd([service])).get(service) || null;

  try {
    // 必须是异步 execFile。同步版会把 daemon 的单线程事件循环整个冻住，systemctl 慢多久就
    // 冻多久，WebSocket 心跳(pingInterval 20s/pingTimeout 10s)一丢，面板就判这个节点掉线——
    // 批量重启时每个 runner 冻一次，整台机器会不可达好几分钟。
    await execFileAsync("sudo", ["-n", RUNNER_SVC_HELPER, action, service], {
      encoding: "utf8",
      timeout: HELPER_TIMEOUT_MS
    });
  } catch (err: unknown) {
    // 分类统一走 helperErrorMessage —— 超时和「免密没配」在错误对象上长得一模一样，
    // 各处自己写正则此前就写歪过。
    throw new Error(helperErrorMessage(`${action} ${service}`, err, HELPER_TIMEOUT_MS));
  }

  // 助手用的是 systemctl --no-block：systemd 收下 job 就返回，不等它跑完。所以上面的成功
  // 只代表「已受理」，真正的结果要自己轮询。为什么不让 systemctl 等：runner 单元是
  // KillMode=process + TimeoutStopSec=5min，遇上不响应 SIGTERM 的 Listener 一等就是 5 分钟，
  // 面板请求(90s)必然超时，批量重启更是逐个叠加。
  const deadline = Date.now() + settleMs;
  let unit: SystemdUnit | null = null;
  for (;;) {
    await sleep(SETTLE_POLL_MS);
    unit = (await querySystemd([service])).get(service) || null;
    if (unit && isSettled(action, before, unit)) {
      // --no-block 之后 systemctl 的退出码只代表「job 已入队」，起不来是查状态才知道的。
      // 阻塞版当年会在这里非零退出并报错，别把这个信号丢了——照旧抛，调用方的错误路径不变。
      // stop 落到 failed 是正常终态（单元非零退出后就停在 failed），不算失败。
      if (action !== "stop" && unit.activeState === "failed")
        throw new Error(
          `${action} ${service} 失败: 单元进入 failed（${unit.subState}）。` +
            `详见 journalctl -u ${service} -n 50`
        );
      logger.info(`[supervisor-systemd] ${action} ${service} 完成（${unit.activeState}）`);
      return { settled: true, unit };
    }
    if (Date.now() >= deadline) break;
  }
  logger.warn(
    `[supervisor-systemd] ${action} ${service} 已提交，但 ${settleMs}ms 内未落定` +
      `（当前 ${unit?.activeState || "未知"}/${unit?.subState || "未知"}）`
  );
  return { settled: false, unit };
}

/**
 * 卸载之前先把服务停稳，并且是由我们自己来等。
 *
 * 助手的 uninstall 用的是阻塞的 `disable --now`，而 runner 单元 TimeoutStopSec=5min：碰上不
 * 响应 SIGTERM 的 Runner.Listener，那条命令能坐满 5 分钟，而我们只给 HELPER_TIMEOUT_MS——超时
 * 是必然的，且 execFile 超时杀出来的错误 stderr 为空，和「免密没配」长得一模一样。走
 * runUnitAction（助手侧是 --no-block，这边自己轮询）之后，「等多久」由 DELETE_SETTLE_MS 说
 * 了算，等不到拿到的是明确的 settled:false。
 *
 * service 由调用方传入 —— 就是加锁时读到并校验过的那一份（systemd 后端里来自
 * SupervisorTarget.ctx），本函数不再自己读 .service。
 */
export async function stopBeforeUninstall(
  service: string
): Promise<{ ok: boolean; error?: string }> {
  // 空串 = 没装服务，或 .service 内容不合法（调用方因此没占那把锁）。两种都不发 stop：
  // 后者留给助手去拒——它同样从 .service 派生单元名，会当场 die，删除随之中止，是 fail closed。
  if (!service) return { ok: true };

  // 查不到状态就不发 stop：对不存在的单元 `systemctl stop` 会非零退出，而删除一个没装服务的
  // runner 是完全正常的操作，不该因此失败。这种情况留给幂等的 uninstall 收尾。
  const before = (await querySystemd([service])).get(service) || null;
  if (!before || !before.loaded) return { ok: true };
  if (before.activeState === "inactive" || before.activeState === "failed") return { ok: true };

  try {
    const r = await runUnitAction(service, "stop", DELETE_SETTLE_MS);
    if (r.settled) return { ok: true };
    return {
      ok: false,
      error:
        `服务未能在 ${Math.round(DELETE_SETTLE_MS / 1000)} 秒内停止` +
        `（当前 ${r.unit?.activeState || "状态未知"}）。停止请求已提交给 systemd，可能仍在进行——` +
        `用 systemctl status ${service} 确认已停止后再重试删除。`
    };
  } catch (err: unknown) {
    return { ok: false, error: errText(err) };
  }
}

// ---- 认领与状态映射 ----

// 这个 listener 是不是该单元跑起来的。
// 单元的 ExecStart 是 runsvc.sh，listener 是它的子进程，所以 MainPID 与 listener 的 pid 并不
// 相等——不能靠 pid 比对。精确的证据是 cgroup：systemd 把单元的所有进程放进以单元名命名的
// cgroup 里。比「单元 active 且目录里有 listener」严格得多，后者在「单元 active + 有人手动又
// 跑了一个」时会把两个都认领成自己的，于是 conflict 退化成 self、start 被放行。
function unitOwns(unit: SystemdUnit | null, service: string, p: ListenerProc): boolean {
  if (!unit?.loaded) return false;
  if (p.cgroup) return p.cgroup.includes(`/${service}`);
  // cgroup 读不到（内核配置差异）时的退化判定：单元有主进程就认。记 WARN，因为这一支比上面
  // 那条宽——它认不出「单元在跑 + 另有人手动又起了一个」里的第二个。
  logger.warn(
    `[supervisor-systemd] 读不到 pid ${p.pid} 的 cgroup，${service} 的认领退回 MainPID 判定`
  );
  return unit.mainPid > 0;
}

// 活体的运行态。observe 只报活体，所以这里不会出现 stopped/failed —— 进程还在跑却报 failed
// 会让 UI 说一件与事实相反的话；单元层面的 failed 由 Observation.detail 解释。
function runStateOf(unit: SystemdUnit | null): RunnerRunState {
  if (unit?.activeState === "activating") return "starting";
  if (unit?.activeState === "deactivating") return "stopping";
  return "running";
}

// ---- 后端 ----

function unitOf(t: SupervisorTarget | undefined): string {
  return (t?.ctx as { service?: string } | undefined)?.service || "";
}

// 动作路径要的单元名只能来自 prepare()。缺了就是调用方没走 controlRunner，属于编程错误——
// 与其在这里补读一次 .service（那正是要消除的 TOCTOU），不如当场抛。
function requireUnit(t: SupervisorTarget | undefined, what: string): string {
  const service = unitOf(t);
  if (!service) throw new Error(`${what}: 缺少已解析的 systemd 单元名`);
  return service;
}

export function overrideConfPath(service: string): string {
  return path.join("/etc/systemd/system", `${service}.d`, "override.conf");
}

// 解析一行 Environment= 后半段：支持 "K=V" 双引号(含 \" \\ 转义)与裸 token，空白分隔多条。
function parseEnvironmentLine(rest: string): RunnerEnvVar[] {
  const out: RunnerEnvVar[] = [];
  let i = 0;
  while (i < rest.length) {
    while (i < rest.length && /\s/.test(rest[i])) i++;
    if (i >= rest.length) break;
    let token = "";
    if (rest[i] === '"') {
      i++;
      while (i < rest.length && rest[i] !== '"') {
        if (rest[i] === "\\" && i + 1 < rest.length) {
          token += rest[i + 1];
          i += 2;
        } else {
          token += rest[i];
          i++;
        }
      }
      i++; // 跳过收尾引号
    } else {
      while (i < rest.length && !/\s/.test(rest[i])) {
        token += rest[i];
        i++;
      }
    }
    const eq = token.indexOf("=");
    // systemd 说明符还原：写入时字面 % 被转义成 %%（见助手脚本 set-env），读回时还原，
    // 否则「读→回显→保存」每过一轮就把 % 翻一倍。
    if (eq > 0)
      out.push({ key: token.slice(0, eq), value: token.slice(eq + 1).replace(/%%/g, "%") });
  }
  return out;
}

// 解析 override.conf 里的 Environment= 行。空 Environment=(重置标记)跳过。
export function parseOverrideConf(text: string): RunnerEnvVar[] {
  const vars: RunnerEnvVar[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("Environment=")) continue;
    const rest = line.slice("Environment=".length).trim();
    if (!rest) continue; // 空 Environment= 是重置标记，无值
    vars.push(...parseEnvironmentLine(rest));
  }
  return vars;
}

function createSystemdSupervisor(): RunnerSupervisor {
  // 三个动作共用的一条路：单元名取自 prepare 的结果，落定后现算一次运行态回给面板。
  const act = async (
    dir: string,
    action: SupervisorAction,
    settleMs: number,
    t?: SupervisorTarget
  ): Promise<ControlOutcome> => {
    const service = requireUnit(t, action);
    const { settled } = await runUnitAction(service, action, settleMs);
    // 运行态由观测现算，而不是从 systemctl 的返回值拼：面板读到的「在线」全项目只有一处定义。
    // 这里只问本后端 —— 跨后端求并集是扫描那条路的事，而调用方此刻正持着这个 runner 的锁。
    const key = canonicalPath(dir);
    const obs = (await self.observe([key], await scanListenerProcs())).get(key) ?? {
      instances: []
    };
    return { dir: key, action, settled, runtime: toRuntimeState("systemd", obs, true) };
  };

  const self: RunnerSupervisor = {
    kind: "systemd",

    // 全项目唯一一次读 .service。锁的依据与动作的依据在这里一次给全，往下只传不再读。
    // 读不到（没装过单元）时 lockKeys 为空、ctx 留空 —— 「没装过单元」这件事在锁那一侧和
    // 动作这一侧因此是同一个判断，不会出现「锁按有单元占、动作按没单元走」的错位。
    prepare(dir: string): SupervisorTarget {
      const service = readServiceName(dir);
      if (service && !SERVICE_RE.test(service)) throw new Error(`非法的服务名: ${service}`);
      return { lockKeys: service ? [serviceKey(service)] : [], ctx: { service } };
    },

    async observe(
      dirs: string[],
      procs: readonly ListenerProc[]
    ): Promise<Map<string, Observation>> {
      const services = new Map<string, string>(); // dir → 单元名
      for (const dir of dirs) {
        // 这里读 .service 是**观测**，不是动作依据：读到过期的名字最多让这一轮少报一个实例，
        // 下一轮就纠正；动作用错名字则不可逆。
        const service = readServiceName(dir); // 非 ENOENT 的失败照旧抛，删除路径要 fail closed
        if (service && SERVICE_RE.test(service)) services.set(dir, service);
      }
      // 严格版：systemctl 失败必须冒泡到 observeAll，变成 complete=false → unknown
      const units = await querySystemdStrict([...services.values()]);

      const out = new Map<string, Observation>();
      for (const dir of dirs) {
        const service = services.get(dir) || "";
        const unit = service ? units.get(service) || null : null;
        // raw 只供展示与排障，判断逻辑一律不许读它（见 common 的 RunnerRuntimeState.raw）
        const raw: Record<string, string> = { service };
        if (unit) {
          raw.activeState = unit.activeState;
          raw.subState = unit.subState;
          raw.unitFileState = unit.enabled;
        }
        const instances: ObservedInstance[] = procs
          .filter((p) => p.dir === dir)
          .map((p) => ({
            id: String(p.pid), // 跨后端去重的硬契约：本机可见的实例一律用 listener pid
            by: unitOwns(unit, service, p) ? ("systemd" as const) : undefined,
            state: runStateOf(unit),
            since: unit?.since || "",
            busy: p.busy,
            raw: { ...raw }
          }));
        out.set(dir, {
          instances,
          // 0 实例时这是唯一的解释来源：单元 failed 而进程一个都没有，正是「为什么起不来」
          detail:
            unit && unit.activeState === "failed"
              ? $t("TXT_CODE_RUNNER_UNIT_FAILED", { subState: unit.subState || "unknown" })
              : ""
        });
      }
      return out;
    },

    // 助手的 install 用的是 enable --now，所以「attach 成功即 runner 已在跑」这条契约天然成立。
    // 防重复拉起也由助手兜底：它对已存在的单元直接拒绝。
    attach: (dir: string) => installSystemdService(dir),

    async detach(dir: string, t?: SupervisorTarget) {
      const service = unitOf(t);
      if (!service) {
        // 从没装过单元 —— 这一支就是「纳管后永远删不掉」的修法：没有需要拆的东西是成功，
        // 不是失败。但「没装过单元」不等于「没东西在跑」（有人手动 ./run.sh 过），所以先
        // 复核一次 /proc，否则删除那侧的 fail closed 会被绕过。
        const target = canonicalPath(dir);
        const live = (await scanListenerProcs()).filter((p) => p.dir === target);
        return live.length
          ? {
              ok: false,
              error: $t("TXT_CODE_RUNNER_FOREIGN_RUNNING", { dir: target }),
              hint: detachHint("systemd")
            }
          : { ok: true };
      }
      const stopped = await stopBeforeUninstall(service);
      if (!stopped.ok) return { ok: false, error: stopped.error, hint: detachHint("systemd") };
      return uninstallSystemdService(dir);
    },

    start: (dir, t) => act(dir, "start", SETTLE_TIMEOUT_MS, t),
    stop: (dir, settleMs, t) => act(dir, "stop", settleMs ?? SETTLE_TIMEOUT_MS, t),
    restart: (dir, t) => act(dir, "restart", SETTLE_TIMEOUT_MS, t),

    // 只读路径：t 缺省时才回退读一次 .service，风险等同 observe（读到过期的名字最多显示旧值）
    async readListenerEnv(dir: string, t?: SupervisorTarget): Promise<RunnerEnvSection> {
      const service = unitOf(t) || readServiceName(dir);
      if (!service) return { present: false, vars: [] };
      if (!SERVICE_RE.test(service)) throw new Error(`非法的服务名: ${service}`);
      return readSection(overrideConfPath(service), parseOverrideConf);
    },

    // 写路径：单元名必须来自 prepare()，缺了直接抛。写 drop-in 走特权助手（含 daemon-reload），
    // 不重启——生效由面板另点一次 restart，与搬迁前一致。
    async writeListenerEnv(dir: string, vars: RunnerEnvVar[], t?: SupervisorTarget): Promise<void> {
      requireUnit(t, "写入监听进程环境变量");
      await setServiceEnv(dir, vars);
    }
  };

  return self;
}

export const systemdFactory: RunnerSupervisorFactory = {
  kind: "systemd",
  priority: 30,
  detect() {
    // /run/systemd/system 是 sd_booted(3) 的标准判据：存在才说明这台是 systemd 起的。
    // 一次 existsSync，不起子进程 —— 容器里这个目录不存在。
    if (!fs.existsSync("/run/systemd/system"))
      return { available: false, reason: "该节点不是 systemd 启动的（无 /run/systemd/system）" };
    // 光有 systemd 还不够：本项目的 systemd 路径全部经特权助手（写单元、启停、drop-in），
    // 助手不可用时那条路一步都走不通。
    if (!queryHelperPreflight())
      return { available: false, reason: "特权助手不可用（未安装或未配免密 sudo）" };
    return { available: true };
  },
  create: createSystemdSupervisor
};
