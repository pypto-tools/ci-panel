import { v4 } from "uuid";
import { IPacket, IRequestPacket } from "../entity/entity_interface";
import RemoteService from "../entity/remote_service";
import { $t } from "../i18n";

class RemoteError extends Error {
  constructor(msg: string) {
    super(msg);
  }
}

export class RemoteRequestTimeoutError extends RemoteError {
  constructor(msg: string) {
    super(msg);
  }
}

// Use RemoteRequest to send Socket.io events and data to remote services,
// and support synchronous response data (such as HTTP).
export default class RemoteRequest {
  constructor(public readonly rService?: RemoteService) {
    if (!this.rService || !this.rService.socket) throw new Error($t("TXT_CODE_ca8072bd"));
  }

  // request to remote daemon
  public async request<T = any>(
    event: string,
    data?: any,
    timeout = 6000,
    force = false
  ): Promise<T> {
    if (!this.rService || !this.rService.socket) throw new Error($t("TXT_CODE_3d94ea16"));

    if (!this.rService.available && !force) {
      // 一次几秒的重连不该变成一屏报错：连接刚断、socket.io 正在重连时，先等它回来。
      // waitForReady 自己判断值不值得等（密钥被拒、已经不再重连、掉线太久都会立刻返回），
      // 所以这里不需要再抄一遍那些条件。
      // 等待上限不超过调用方自己的超时：它愿意为一次往返等多久，就最多为「等连接回来」等
      // 多久。timeout 为 0 表示调用方不设超时，那就用 waitForReady 的默认上限。
      await this.rService.waitForReady(
        timeout > 0 ? Math.min(timeout, RemoteService.READY_WAIT) : undefined
      );

      if (!this.rService.available) {
        // 密钥被节点拒了是个完全不同的故障：说清楚，别让人照着「检查远程节点状态」去查一台
        // 好端端的机器。真实原因原本只写在面板日志里，界面上一个字都看不到。
        if (this.rService.authRejected)
          throw new Error($t("TXT_CODE_NODE_AUTH_REJECTED") + ` IP: ${this.rService.config.ip}`);
        throw new Error($t("TXT_CODE_b7d38e78") + ` IP: ${this.rService.config.ip}`);
      }
    }

    if (!this.rService.socket.connected && !force)
      throw new Error($t("TXT_CODE_7c650d80") + ` IP: ${this.rService.config.ip}`);

    return new Promise((resolve, reject) => {
      let countdownTask: NodeJS.Timeout;
      const uuid = [v4(), new Date().getTime()].join("");
      const protocolData: IRequestPacket = { uuid, data };

      const fn = (msg: IPacket) => {
        if (msg.uuid === uuid) {
          if (countdownTask) clearTimeout(countdownTask);
          this.rService?.socket?.removeListener(event, fn);
          if (msg.status == RemoteService.STATUS_OK) resolve(msg.data);
          else if (msg.data.err) {
            reject(new RemoteError(msg.data.err));
          } else {
            reject(new RemoteError(msg.data));
          }
        }
      };

      if (timeout) {
        countdownTask = setTimeout(() => {
          this.rService?.socket?.removeListener(event, fn);
          reject(
            new RemoteRequestTimeoutError(
              [$t("TXT_CODE_bd99b64e"), this.rService?.config.ip].join(" ")
            )
          );
        }, timeout);
      }

      this.rService?.socket?.on(event, fn);
      // send command
      this.rService?.emit(event, protocolData);
    });
  }
}
