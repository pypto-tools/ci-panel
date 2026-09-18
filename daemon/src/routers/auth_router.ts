import { timingSafeEqual } from "node:crypto";
import { IGNORE } from "../const";
import { globalConfiguration } from "../entity/config";
import RouterContext from "../entity/ctx";
import { $t } from "../i18n";
import logger from "../service/log";
import { LOGIN_BY_TOP_LEVEL, loginSuccessful } from "../service/mission_passport";
import * as protocol from "../service/protocol";
import { routerApp } from "../service/router";

// 连上之后多久还没通过鉴权就踢掉。
//
// **必须大于面板那侧 auth 请求的超时**（panel/src/app/entity/remote_service.ts）：面板在等一个
// 响应，而这个定时器一到就把连接断了，等于让面板必然等到自己超时。两个值的关系由
// panel/test/contract/auth_timeout_layering.spec.ts 盯着。
//
// 从 6 秒放宽到 20 秒，是为了高负载节点：daemon 的事件循环被 runner 饿住时，鉴权往返本身就
// 可能要好几秒，而鉴权一失败，面板对该节点的一切请求都会被 available=false 挡在门外。
// 代价是未鉴权的连接能多挂一会儿——它拦的是端口已经暴露之后的资源占用，不是授权本身。
const AUTH_TIMEOUT = 20000;

function checkLogin(ctx: RouterContext) {
  return (
    ctx.session.key === globalConfiguration.config.key &&
    ctx.session.type === LOGIN_BY_TOP_LEVEL &&
    ctx.session.login &&
    ctx.session.id
  );
}

// Top-level authority authentication middleware (this is the first place for any authority authentication middleware)
routerApp.use(async (routePath, ctx, _, next) => {
  const socket = ctx.socket;

  // release all data flow controllers
  if (routePath.startsWith("stream")) return next();

  // Except for the auth controller, which is publicly accessible, other business controllers must be authorized before they can be accessed
  if (routePath === "auth") return await next();
  if (!ctx.session) throw new Error("Session does not exist in authentication middleware.");
  if (checkLogin(ctx)) return await next();

  logger.warn(
    $t("TXT_CODE_auth_router.notAccess", {
      id: socket.id,
      address: socket.handshake.address,
      event: routePath
    })
  );
  return protocol.error(ctx, "error", IGNORE, {
    disablePrint: true
  });
});

// authentication controller
routerApp.on("auth", (ctx, data) => {
  try {
    let ip = ctx.socket.handshake.address;
    // extract IPv4 address from IPv6 format
    if (ip.startsWith("::ffff:")) ip = ip.substring(7);

    if (
      (!globalConfiguration.config.whiteListPanelIp ||
        globalConfiguration.config.whiteListPanelIps.includes(ip)) &&
      timingSafeEqual(
        Buffer.from(String(data ?? "")),
        Buffer.from(String(globalConfiguration.config.key ?? ""))
      )
    ) {
      // The authentication is passed, and the registered session is a trusted session
      logger.info(
        $t("TXT_CODE_auth_router.access", {
          id: ctx.socket.id,
          address: ctx.socket.handshake.address
        })
      );

      // Log the authentication success
      loginSuccessful(ctx, data);

      protocol.msg(ctx, "auth", true);
    } else {
      protocol.msg(ctx, "auth", false);
    }
  } catch (e) {
    protocol.msg(ctx, "auth", false);
  }
});

// Connected event for timeout authentication close
routerApp.on("connection", (ctx) => {
  const session = ctx.session;
  setTimeout(() => {
    if (!session.login) {
      ctx.socket.disconnect();
      logger.info(
        $t("TXT_CODE_auth_router.disconnect", {
          id: ctx.socket.id,
          address: ctx.socket.handshake.address
        })
      );
    }
  }, AUTH_TIMEOUT);
});
