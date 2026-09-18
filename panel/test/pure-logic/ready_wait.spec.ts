import { describe, expect, it } from "vitest";
import RemoteService, {
  shouldWaitForReady,
  type ReadyWaitState
} from "../../src/app/entity/remote_service";
import { RemoteServiceConfig } from "../../src/app/entity/entity_interface";

// 节点连接一断，available 就翻 false，而面板对该节点的每个请求都在**发出前**被拒。于是一次
// 三秒的重连，在界面上就是一屏「远程节点不可用」。waitForReady 给这种抖动一个短暂的等待窗口。
//
// 这条判断的危险不在于「该等的没等」，而在于「不该等的等了」：重连次数已经抬到实际无限，
// 一台宕了一小时的节点同样处在 active 状态。判断写松一点，/api/overview 这种扇出到所有节点
// 的接口就会在每个节点上白等一轮 —— 那正是这一串改动要消除的症状本身。

const BLIP = 15000;

const state = (over: Partial<ReadyWaitState> = {}): ReadyWaitState => ({
  available: false,
  authRejected: false,
  socketActive: true,
  msSinceAvailable: 1000,
  ...over
});

describe("shouldWaitForReady", () => {
  it("刚断线、socket.io 正在重连：等", () => {
    expect(shouldWaitForReady(state(), BLIP)).toBe(true);
  });

  it("已经可用：不等", () => {
    expect(shouldWaitForReady(state({ available: true }), BLIP)).toBe(false);
  });

  it("密钥被节点拒绝：不等", () => {
    // 等多久结果都一样。这种节点被 daemon 踢掉后 socket.io 不会自己重连（服务端主动断开），
    // 但面板的巡检会把它重新连上、再被拒一次 —— 只要有一拍恰好处在重连中，不看 authRejected
    // 的话，那一拍到达的每个请求都会白等满一个窗口。
    expect(shouldWaitForReady(state({ authRejected: true }), BLIP)).toBe(false);
  });

  it("socket.io 已经不再重连：不等", () => {
    // 没有人会让它恢复，等待只是把失败推迟。
    expect(shouldWaitForReady(state({ socketActive: false }), BLIP)).toBe(false);
  });

  it("从未连上过：不等", () => {
    // 新加的节点地址写错、或者节点还没装起来。这不是抖动，是压根没通。
    expect(shouldWaitForReady(state({ msSinceAvailable: null }), BLIP)).toBe(false);
  });

  it("掉线已久：不等", () => {
    // 这条是整个判断的重点。少了它，一台宕掉的节点会让每个请求都等满窗口。
    expect(shouldWaitForReady(state({ msSinceAvailable: BLIP }), BLIP)).toBe(false);
    expect(shouldWaitForReady(state({ msSinceAvailable: BLIP + 1 }), BLIP)).toBe(false);
    expect(shouldWaitForReady(state({ msSinceAvailable: BLIP - 1 }), BLIP)).toBe(true);
  });
});

describe("RemoteService.waitForReady", () => {
  const makeService = () => new RemoteService("uuid-1", new RemoteServiceConfig());

  it("节点恢复时立刻放行，不用等满超时", async () => {
    const svc = makeService();
    svc.markAvailable(); // 先连上过一次，才谈得上「抖动」
    svc.markUnavailable();
    // socket.active：socket.io 正在重连
    svc.socket = { active: true } as never;

    const t0 = Date.now();
    const waiting = svc.waitForReady(5000);
    svc.markAvailable();
    await waiting;

    // 关键不是「快」，是它被**唤醒**了而不是熬到超时
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(svc.available).toBe(true);
  });

  it("节点没回来就等满上限，然后交回调用方去报错", async () => {
    const svc = makeService();
    svc.markAvailable();
    svc.markUnavailable();
    svc.socket = { active: true } as never;

    const t0 = Date.now();
    await svc.waitForReady(120);

    expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
    expect(svc.available).toBe(false); // 等待不改变结论，只是给了它一次机会
  });

  it("不值得等的情况立即返回", async () => {
    const svc = makeService();
    svc.markAvailable();
    svc.markUnavailable();
    svc.authRejected = true;
    svc.socket = { active: true } as never;

    const t0 = Date.now();
    await svc.waitForReady(5000);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("markAvailable 会清掉 authRejected", async () => {
    // 换过密钥之后节点重新通过鉴权，那条「密钥被拒」的结论必须跟着作废，
    // 否则这个节点会一直快速失败，直到面板重启。
    const svc = makeService();
    svc.authRejected = true;
    svc.markAvailable();
    expect(svc.authRejected).toBe(false);
  });
});
