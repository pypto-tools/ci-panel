import fs from "fs-extra";
import path from "path";
import Storage from "../common/storage/sys_storage";
import { IRemoteService, RemoteServiceConfig } from "../entity/entity_interface";
import RemoteService from "../entity/remote_service";
import { $t } from "../i18n";
import { UniversalRemoteSubsystem } from "./base/urs";
import { logger } from "./log";

// The RemoteServiceSubsystem will be one of the most important systems
// main function is to store remote services everywhere
// Scan local services, unified management, remote calls and proxies, etc.
class RemoteServiceSubsystem extends UniversalRemoteSubsystem<RemoteService> {
  // 密钥被拒的节点多久重连一次。巡检是 20 秒一拍，但重连改变不了「密钥不对」这件事 ——
  // 按拍重连只会把握手和日志放大三倍（改之前巡检是 60 秒一拍，这里保持原来的节奏）。
  // 不能干脆不重连：密钥可能是在节点那头改回来的，面板这边没有任何事件能得知。
  private static readonly REJECTED_RETRY_INTERVAL = 60 * 1000;
  private readonly lastRejectedRetryAt = new Map<string, number>();

  async initialize() {
    // If it is the first startup, it will automatically try to connect to "LocalHost",
    // otherwise it will automatically read from the configuration file and connect to all remote services.
    for (const uuid of await Storage.getStorage().list("RemoteServiceConfig")) {
      const config = (await Storage.getStorage().load(
        "RemoteServiceConfig",
        RemoteServiceConfig,
        uuid
      )) as RemoteServiceConfig;
      // connectOpts 是代码里的连接调优参数，不是用户数据：面板没有任何接口能改它，edit() 也
      // 不碰它。但它跟着 config 一起落了盘，而 StorageSubsystem.defineAttr 会用盘上那份逐键
      // 覆盖类里的默认值 —— 于是盘上存的是**节点注册当时**的快照，此后任何一次参数调整都只
      // 对新注册的节点生效，存量节点静默沿用老值。两套行为并存是最难查的一类问题，所以这里
      // 显式丢掉盘上那份，一律以代码为准。
      config.connectOpts = new RemoteServiceConfig().connectOpts;
      const newService = new RemoteService(uuid, config);
      this.setInstance(uuid, newService);
      newService.connect();
    }

    // If there is no daemon process, check whether there is a daemon process locally
    if (this.services.size === 0) {
      await this.initConnectLocalhost("");
    }

    logger.info($t("TXT_CODE_systemRemoteService.nodeCount", { n: this.services.size }));

    // Register for periodic connection status checks
    //
    // 60 秒 → 20 秒：socket.io 自己的重连现在是无限次（见 RemoteServiceConfig.connectOpts），
    // 所以这个巡检不再是断线恢复的主力，只兜一种它管不到的情况——连接还在、但鉴权没过
    // （auth 超时）。那种状态下节点对面板完全不可用，60 秒的盲区太长了。
    setInterval(() => this.connectionStatusCheckTask(), 1000 * 20);
  }

  // Register a NEW remote service to system and connect it.
  // Like: this.registerRemoteService({
  // ip: "127.0.0.1",
  // apiKey: "test_key",
  // port: 24444
  // });
  async registerRemoteService(config: IRemoteService) {
    const instance = await this.newInstance(config);
    if (!instance) throw new Error($t("TXT_CODE_3bfb9e04"));
    await Storage.getStorage().store("RemoteServiceConfig", instance.uuid, instance.config);
    instance.connect();
    return instance;
  }

  // Delete the specified remote service based on UUID
  async deleteRemoteService(uuid: string) {
    if (this.getInstance(uuid)) {
      this.getInstance(uuid)?.disconnect();
      this.deleteInstance(uuid);
      await Storage.getStorage().delete("RemoteServiceConfig", uuid);
    }
  }

  // According to the IRemoteService, New a RemoteService object
  // Used to initialize objects.
  async newInstance(config: IRemoteService) {
    const instance = new RemoteService(
      config.uuid || this.randdomUuid(),
      new RemoteServiceConfig()
    );
    this.setInstance(instance.uuid, instance);
    await this.edit(instance.uuid, config);
    return instance;
  }

  // Edit the configuration file of the instance
  async edit(uuid: string, config: IRemoteService) {
    const instance = this.getInstance(uuid);
    if (!instance) return;
    if (config.remarks) instance.config.remarks = config.remarks;
    if (config.ip) instance.config.ip = config.ip;
    if (config.port) instance.config.port = config.port;
    if (config.prefix != null) instance.config.prefix = config.prefix;
    if (config.apiKey) instance.config.apiKey = config.apiKey;
    if (config.remoteMappings != null) instance.config.remoteMappings = config.remoteMappings;
    await Storage.getStorage().store("RemoteServiceConfig", instance.uuid, instance.config);
  }

  // Scannce localhost service
  // First use, need to scan the local host
  // Note: Every time you execute "initConnectLocalhost",
  // it will be managed by the subsystem (regardless of whether the target exists).
  async initConnectLocalhost(key?: string) {
    const ip = "localhost";
    const localKeyFilePath = path.normalize(
      path.join(process.cwd(), "../daemon/data/Config/global.json")
    );
    logger.info($t("TXT_CODE_systemRemoteService.loadDaemonTitle", { localKeyFilePath }));
    if (fs.existsSync(localKeyFilePath)) {
      logger.info($t("TXT_CODE_systemRemoteService.autoCheckDaemon"));
      const localDaemonConfig = JSON.parse(
        fs.readFileSync(localKeyFilePath, { encoding: "utf-8" })
      );
      const localKey = localDaemonConfig.key;
      const localPort = localDaemonConfig.port;
      return await this.registerRemoteService({ apiKey: localKey, port: localPort, ip });
    } else if (key) {
      const port = 24444;
      return await this.registerRemoteService({ apiKey: key, port, ip });
    }
    logger.warn($t("TXT_CODE_systemRemoteService.error"));

    // After 5 seconds, determine whether the daemon has been connected until a daemon is connected
    setTimeout(() => {
      if (this.services.size === 0) return this.initConnectLocalhost();
    }, 5 * 1000);
  }

  count() {
    let total = 0;
    let available = 0;
    this.services.forEach((v) => {
      total++;
      if (v.available) available++;
    });
    return { available, total };
  }

  // Periodic connection status check
  connectionStatusCheckTask() {
    this.services?.forEach((v) => {
      if (!v || v.available !== false) return;

      // 已经连上、只是没通过鉴权。高负载节点上这多半是上一次 auth 超时（daemon 的事件循环
      // 被 runner 饿住），连接本身好好的 —— 重试鉴权就够了。
      // 不走 connect()：那会把连接整个拆了重建，顺带清掉 socket.io 自己的重连退避状态，
      // 在一台本来就慢的机器上等于把恢复推得更远。
      if (v.socket?.connected) {
        logger.warn(
          `Daemon connected but not authenticated: ${v.config.remarks} ${v.config.ip}:${v.config.port}, retrying auth...`
        );
        // auth() 自己记录所有失败，正常不会 reject；这个 catch 兜的是将来的签名变化——
        // 未处理的 rejection 会让整个面板进程退出。记一行而不是吞掉，出了事查得到。
        void v.auth().catch((err: unknown) => logger.warn(err));
        return;
      }

      // socket.io 自己还在重连（active）。**绝对不能插手**：connect() 会把连接拆了重建，
      // 顺带清掉退避进度，等于每 20 秒把它的重试从头开始，本来几秒就能回来的连接反而更慢。
      // 重连次数上限抬到实际无限之后，掉线的节点几乎总是处在这个状态，所以这条分支才是常态。
      if (v.socket?.active) return;

      // 走到这里才是 socket.io 真的不管了：从没连过，或者被显式断开过。
      if (v.authRejected) {
        const last = this.lastRejectedRetryAt.get(v.uuid) ?? 0;
        if (Date.now() - last < RemoteServiceSubsystem.REJECTED_RETRY_INTERVAL) return;
        this.lastRejectedRetryAt.set(v.uuid, Date.now());
      }
      logger.warn(
        `Daemon exception detected: ${v.config.remarks} ${v.config.ip}:${v.config.port}, reconnecting...`
      );
      v.connect();
    });
  }

  changeDaemonLanguage(language: string) {
    for (const iterator of this.services.entries()) {
      iterator[1].setLanguage(language);
    }
  }
}

export default new RemoteServiceSubsystem();
