import { removeTrail } from "mcsmanager-common";
import { ManagerOptions, SocketOptions } from "socket.io-client";

export interface IPacket {
  uuid: string;
  status: number;
  event: string;
  data: any;
}

export interface IRequestPacket {
  uuid: string;
  data: any;
}

export interface IUser {
  uuid?: string;
  userName?: string;
  passWord?: string;
  salt?: string;
  permission?: number;
  registerTime?: string;
  loginTime?: string;
  instances?: Array<any>;
  isInit?: boolean;
  passWordType?: number;
  secret?: string;
  open2FA?: boolean;
  ssoSub?: string;
  ssoBound?: boolean;
}

export interface ICompleteUser {
  uuid: string;
  userName: string;
  permission: number;
  instances: Array<any>;
  registerTime: string;
  loginTime: string;
}

type RemoteMappingEntry = {
  from: {
    ip: string;
    port: number;
    prefix: string;
  };
  to: {
    ip: string;
    port: number;
    prefix: string;
  };
};

export interface IRemoteService {
  uuid?: string;
  ip?: string;
  port?: number;
  prefix?: string;
  remarks?: string;
  apiKey?: string;
  remoteMappings?: RemoteMappingEntry[];
}

// @Entity
export class RemoteServiceConfig {
  public ip = "";
  public port = 24444;
  public prefix = "";
  public remarks = "";
  public apiKey = "";
  public remoteMappings: RemoteMappingEntry[] = [];

  connectOpts: Partial<SocketOptions & ManagerOptions> = {
    multiplex: false,
    reconnectionDelayMax: 1000 * 5,
    timeout: 1000 * 10,
    reconnection: true,
    // 实际等于不设上限。原值 10：重连十次还不成，socket.io 就**彻底放弃**，此后这条连接
    // 再也不会自己回来，只能等 RemoteServiceSubsystem 的巡检把它整个重建。高负载节点上连接
    // 抖动本来就多，十次很容易在一次故障窗口里用光，结果是机器早就恢复了、面板还显示不可用。
    // 退避上限是 reconnectionDelayMax（5 秒），所以无限重试的代价只是每 5 秒一次握手。
    //
    // 用 MAX_SAFE_INTEGER 而不是 Infinity：这个对象会被 JSON 序列化落盘，而 Infinity 会变成
    // null。虽然 initialize() 现在一律丢掉盘上那份、以代码为准，但别在磁盘上留一个看不懂的
    // null 当陷阱。
    reconnectionAttempts: Number.MAX_SAFE_INTEGER,
    // 直接用 WebSocket，不走「先 HTTP 长轮询再升级」的默认路径。
    //
    // 默认的 ["polling", "websocket"] 对本项目是纯亏：面板与节点之间是一条长期连接，而长轮询
    // 把它拆成一串各自带超时的 HTTP 请求，每一轮都要重新过一遍 Koa 中间件——节点一忙，掉的
    // 就是这些请求，表现成连接反复重建。升级过程本身也是一次额外的探测握手。
    //
    // 代价：中间若有不支持 WebSocket 的反向代理（daemon 的 prefix 就是为这类部署准备的），
    // 连接会直接失败而不是退回长轮询。但 socket.io 本来就会升级到 WebSocket，那种代理在升级
    // 这一步同样会出问题，只是失败得更晚、更难查。
    transports: ["websocket"],
    rejectUnauthorized: false
  };

  /**
   * To keep the remote mapping inside response consistent with other parts,
   * a simple conversion needs to be made.
   *
   * This is intentionally a method instead of a getter member, as the
   * conversion involves list operation.
   *
   * @returns converted remote mappings
   */
  public getConvertedRemoteMappings() {
    return this.remoteMappings.map((remote) => ({
      from: {
        addr: `${remote.from.ip}:${remote.from.port}`,
        prefix: remote.from.prefix
      },
      to: {
        addr: `${remote.to.ip}:${remote.to.port}`,
        prefix: remote.to.prefix
      }
    }));
  }

  /**
   * IP concatenated with port.
   */
  public get addr() {
    return `${this.ip}:${this.port}`;
  }

  /**
   * The prefix trimmed and removed trailing slash.
   */
  public get canonicalPrefix() {
    return removeTrail(this.prefix.trim(), "/");
  }

  /**
   * Full address containing IP, port and prefix.
   */
  public get fullAddr() {
    return this.addr + this.canonicalPrefix;
  }
}
