import fs from "fs-extra";
import path from "path";
import { describe, expect, it } from "vitest";
import RemoteService from "../../src/app/entity/remote_service";
import { PANEL_ROOT } from "../setup";

// 鉴权这一步有两个计时器，分属两个进程：
//   - 面板：等节点回应 auth 的超时（RemoteService.AUTH_TIMEOUT）
//   - 节点：连上之后还没鉴权就断开（daemon 的 AUTH_TIMEOUT）
// 谁先到点，决定了鉴权失败时面板看到的是「拒绝」还是「超时」，更决定了面板到底有没有机会
// 拿到答复。节点那侧先断，面板就必然等到自己超时——而 auth 一失败，available 保持 false，
// 面板对该节点的每个请求都在发出前被拒掉，直到下一轮巡检。
//
// 这两个值没有任何编译期关系，一边调了另一边不会红，所以只能在这里对着源码比。
// 也不适合搬进 common：它约束的是面板与节点两个进程的时序，不是共享协议。

const DAEMON_AUTH_ROUTER = path.join(PANEL_ROOT, "../daemon/src/routers/auth_router.ts");

// 面板必须留出余量：超时判定本身、以及那一跳网络往返，都发生在两个计时器之间。
const MARGIN_MS = 2_000;

describe("鉴权超时的分层", () => {
  const m = fs.readFileSync(DAEMON_AUTH_ROUTER, "utf8").match(/AUTH_TIMEOUT\s*=\s*(\d+)\s*;/);

  it("两个值都拿得到", () => {
    // 守住正则：daemon 那个常量被改名或挪走时，这条守卫要跟着改，而不是静默变成空断言。
    expect(m, "在 daemon/src/routers/auth_router.ts 里找不到 AUTH_TIMEOUT").not.toBeNull();
    expect(RemoteService.AUTH_TIMEOUT).toBeGreaterThan(0);
  });

  it("面板必须先于节点断开放弃", () => {
    expect(RemoteService.AUTH_TIMEOUT + MARGIN_MS).toBeLessThanOrEqual(Number(m![1]));
  });
});
