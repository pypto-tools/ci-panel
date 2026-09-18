import { io, Socket, SocketOptions, ManagerOptions } from "socket.io-client";
import { RemoteServiceConfig } from "./entity_interface";
import { logger } from "../service/log";
import RemoteRequest from "../service/remote_command";
import { InstanceStreamListener, removeTrail } from "mcsmanager-common";
import { systemConfig } from "../setting";
import { $t, i18next } from "../i18n";

/** shouldWaitForReady 要看的全部状态。抽成形参，这条判断才测得了。 */
export interface ReadyWaitState {
  /** 已经可用：没什么好等的。 */
  available: boolean;
  /** 上一次鉴权被节点明确拒绝（密钥/白名单）。 */
  authRejected: boolean;
  /** socket.io 是否还在自动重连。false = 没有人会让它恢复。 */
  socketActive: boolean;
  /** 距离上一次可用过去了多久；从未可用过时为 null。 */
  msSinceAvailable: number | null;
}

/**
 * 请求发不出去时，值不值得等一等。
 *
 * 只有一种情况值得等：**连接刚断、而且 socket.io 正在把它拉回来**。其余情况必须立刻失败——
 * 面板的 /api/overview 是扇出到所有节点的，在一个已经宕掉的节点上每个请求白等几秒，代价是
 * 整页跟着慢，而那正是这一串改动要消除的症状本身。
 *
 * 尤其注意 `socketActive` 单独不足以做判断：重连次数已经抬到实际无限，一台宕了一小时的节点
 * 同样是 active。必须配上「刚刚才不可用」这个时间窗。
 */
export function shouldWaitForReady(s: ReadyWaitState, blipWindowMs: number): boolean {
  if (s.available) return false;
  if (s.authRejected) return false;
  if (!s.socketActive) return false;
  if (s.msSinceAvailable === null) return false; // 从未连上过：不是抖动，是压根没通
  return s.msSinceAvailable < blipWindowMs;
}

export default class RemoteService {
  public static readonly STATUS_OK = 200;
  public static readonly STATUS_ERR = 500;

  /**
   * 等节点回应鉴权的时长。
   *
   * 原值 5 秒。高负载节点（CPU 被 runner 打满）上这一个往返就可能超时，而超时的后果远不止
   * 「这次没连上」：auth 失败 → available 保持 false → 面板对该节点的**每一个**请求在发出
   * 前就被拒掉，直到下一轮巡检。机器好好的，界面上却是「远程节点不可用」。
   *
   * **必须小于 daemon 的 AUTH_TIMEOUT**（daemon/src/routers/auth_router.ts）：那边一到点就
   * 断开连接，比它还长就是在等一个不会到来的响应。两者的关系由
   * panel/test/contract/auth_timeout_layering.spec.ts 盯着。
   */
  public static readonly AUTH_TIMEOUT = 15000;

  /**
   * 掉线之后多久之内还当作「抖动」。
   *
   * 超过这个窗口就按「故障」处理：请求立刻失败，不再等。必须卡得住——重连次数已经抬到实际
   * 无限，`socket.active` 对一台宕了一小时的节点同样是 true，只靠它做判断会让每个请求都白等
   * 一遍，而 /api/overview 是扇出到所有节点的，那就是整页跟着慢。
   */
  private static readonly BLIP_WINDOW = 15000;

  /** 抖动窗口内最多等多久。socket.io 的重连退避上限是 5 秒，等满一轮就够。 */
  public static readonly READY_WAIT = 5000;

  public uuid: string = "";
  public available: boolean = false;
  public socket?: Socket;
  public readonly instanceStream = new InstanceStreamListener();
  public config: RemoteServiceConfig;
  public realUrl: string = "";

  /**
   * 上一次鉴权是被节点**明确拒绝**的（密钥不符，或没过 IP 白名单），而不是超时/断线。
   *
   * 两种「不可用」的代价完全不同：被拒的等下去毫无意义，重连中的等几秒就好。原先它们共用
   * 一条路径、报同一句「远程节点不可用，请检查远程节点状态」——而真实原因写在面板日志里，
   * 界面上一个字都看不到。
   */
  public authRejected = false;

  /** 最后一次鉴权通过的时刻。0 表示从未连上过。 */
  private lastAvailableAt = 0;

  /** 在等这个节点恢复的请求。恢复时一次性放行，超时的自己摘掉。 */
  private readonly readyWaiters = new Set<() => void>();

  constructor(uuid: string, config: RemoteServiceConfig) {
    this.uuid = uuid;
    this.config = config;
  }

  /**
   * 状态迁移走这两个方法，不要直接赋值 available：等待中的请求要靠 markAvailable 唤醒，
   * 而 lastAvailableAt 是「这次不可用算抖动还是算故障」的唯一依据。
   */
  public markAvailable() {
    this.available = true;
    this.authRejected = false;
    this.lastAvailableAt = Date.now();
    this.wakeReadyWaiters();
  }

  /**
   * 节点明确拒绝了密钥：这是终局，等下去不会有别的结果。
   *
   * 必须唤醒正在等的请求。它们是在「连接刚断、正在重连」时开始等的，那时判断值得等；
   * 现在答案出来了，不叫醒的话每个请求都要熬满等待上限，才能报出这条早就确定的错误。
   */
  public markAuthRejected() {
    this.authRejected = true;
    this.markUnavailable();
    this.wakeReadyWaiters();
  }

  private wakeReadyWaiters() {
    // 复制一份再遍历：唤醒回调会把自己从集合里摘掉。
    for (const wake of [...this.readyWaiters]) wake();
  }

  public markUnavailable() {
    this.available = false;
    // lastAvailableAt 刻意不清：它正是用来判断「这次不可用是刚开始的抖动，还是已经持续很久」。
  }

  /**
   * 断线重连期间，给请求一个短暂的等待窗口，而不是当场失败。
   *
   * 不具备等待条件时立即返回，由调用方按原样报错——判断见 shouldWaitForReady。
   */
  public async waitForReady(maxWait = RemoteService.READY_WAIT): Promise<void> {
    const wait = shouldWaitForReady(
      {
        available: this.available,
        authRejected: this.authRejected,
        socketActive: Boolean(this.socket?.active),
        msSinceAvailable: this.lastAvailableAt > 0 ? Date.now() - this.lastAvailableAt : null
      },
      RemoteService.BLIP_WINDOW
    );
    if (!wait) return;

    await new Promise<void>((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.readyWaiters.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, maxWait);
      this.readyWaiters.add(wake);
    });
  }

  private getDaemonInfo() {
    return `Name: ${this.config.remarks} | ID: ${this.uuid} | URL: ${this.realUrl}`;
  }

  public connect(connectOpts?: Partial<SocketOptions & ManagerOptions>) {
    if (connectOpts) this.config.connectOpts = connectOpts;
    // Start the formal connection to the remote Socket program
    let addr = `ws://${this.config.ip}:${this.config.port}`;
    if (this.config.ip.indexOf("wss://") === 0 || this.config.ip.indexOf("ws://") === 0) {
      addr = `${this.config.ip}:${this.config.port}`;
    }
    if (systemConfig?.ssl) {
      addr = addr.replace("ws://", "wss://");
    }
    this.realUrl = addr;

    const daemonInfo = this.getDaemonInfo();

    if (this.available) {
      logger.info(`${$t("TXT_CODE_daemonInfo.resetConnect")}:${daemonInfo}`);
      this.disconnect();
    }

    // prevent duplicate registration of events
    if (this.socket && this.socket.hasListeners("connect")) {
      logger.info(`${$t("TXT_CODE_daemonInfo.replaceConnect")}:${daemonInfo}`);
      return this.refreshReconnect();
    }

    logger.info(`${$t("TXT_CODE_daemonInfo.tryConnect")}:${daemonInfo}`);
    this.socket = io(this.realUrl, {
      ...this.config.connectOpts,
      path: removeTrail(this.config.prefix, "/") + "/socket.io"
    });

    // register built-in events
    this.socket.on("connect", async () => {
      logger.info($t("TXT_CODE_daemonInfo.connect", { v: daemonInfo }));
      await this.onConnect();
    });
    this.socket.on("disconnect", async () => {
      logger.info($t("TXT_CODE_daemonInfo.disconnect", { v: daemonInfo }));
      await this.onDisconnect();
    });
    this.socket.on("connect_error", async (error: Error) => {
      await this.onDisconnect();
    });
  }

  public async setLanguage(language?: string) {
    if (!language) language = i18next.language;
    logger.info(
      `${$t("TXT_CODE_daemonInfo.setLanguage")} (${this.config.ip}:${this.config.port}/${
        this.config.remarks
      }) language: ${language}`
    );
    return await new RemoteRequest(this).request("info/setting", {
      language
    });
  }

  // This function is used to verify the identity. It only needs to be verified once.
  // This function will be executed automatically after the connection event is triggered.
  // Generally, there is no need to execute it manually.
  public async auth(key?: string) {
    if (key) this.config.apiKey = key;
    const daemonInfo = this.getDaemonInfo();
    try {
      const res = await new RemoteRequest(this).request(
        "auth",
        this.config.apiKey,
        RemoteService.AUTH_TIMEOUT,
        true
      );
      if (res === true) {
        this.markAvailable();
        await this.setLanguage();
        logger.info($t("TXT_CODE_daemonInfo.authSuccess", { v: daemonInfo }));
        return true;
      }
      // 节点明确回了「不是」：密钥不符，或没过它的 IP 白名单。重试和等待都改变不了结果，
      // 记下来，让请求侧能报出真正的原因，而不是笼统的「节点不可用」。
      this.markAuthRejected();
      logger.warn($t("TXT_CODE_daemonInfo.authFailure", { v: daemonInfo }));
      return false;
    } catch (error: any) {
      // 超时或连接断了——这是**暂时**的失败，它对密钥什么也没说。所以不但不能置 authRejected，
      // 还要把上一次留下的清掉：留着就等于把一次高负载下的超时判成「密钥不对」——请求会快速
      // 失败、报错会说错原因、巡检还会按被拒节点的慢节奏去重连。
      //
      // 刻意在这里清而不是在 auth() 入口清：入口就清的话，一次仍会被拒的重试在飞的那十几秒里，
      // 节点看起来「没被拒」，报错会在两种文案之间来回闪。三条出口各自给出明确的结论：
      // 通过（markAvailable）、被拒（markAuthRejected）、说不清（这里）。
      this.authRejected = false;
      logger.warn($t("TXT_CODE_daemonInfo.authError", { v: daemonInfo }));
      logger.warn(error);
      return false;
    }
  }

  public emit(event: string, data?: any) {
    return this.socket?.emit(event, data);
  }

  private async onDisconnect() {
    this.markUnavailable();
  }

  private async onConnect() {
    // this.available = true; Note: Connected is not auth;
    return await this.auth(this.config.apiKey);
  }

  disconnect() {
    if (this.socket) {
      const daemonInfo = this.getDaemonInfo();
      logger.info($t("TXT_CODE_daemonInfo.closed", { v: daemonInfo }));
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket.close();
      delete this.socket;
    }
    this.socket = undefined;
    this.markUnavailable();
  }

  refreshReconnect() {
    this.disconnect();
    this.connect();
  }
}
