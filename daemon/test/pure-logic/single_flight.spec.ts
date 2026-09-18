import { describe, expect, it, vi } from "vitest";
import { singleFlight, singleFlightBy } from "../../src/utils/single_flight";

// 面板的状态轮询会让同一件昂贵的只读活儿（全量 /proc 扫描、systemctl 查询）同时被好几路调用
// 打上来，而那件活儿此前每一路各做一遍。这个原语的全部价值就在下面这几条语义上，所以它们
// 必须被钉死——尤其是「失败不缓存」与「失败后让出在飞位置」：这两条错了，一次抖动会变成
// 接下来所有调用都拿到同一个旧错误，而症状（节点状态读不出来）和它要修的那个一模一样。

// 手动控制何时 resolve，才能在"还没回来"的那一刻发起第二次调用
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("singleFlight", () => {
  it("合并并发调用：N 个调用只跑一次 load，且都拿到同一个结果", async () => {
    const d = deferred<string>();
    const load = vi.fn(() => d.promise);
    const shared = singleFlight(load);

    const calls = [shared(), shared(), shared()];
    d.resolve("扫描结果");

    expect(await Promise.all(calls)).toEqual(["扫描结果", "扫描结果", "扫描结果"]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("缺省不缓存已完成的结果：上一次结束之后再调，会重新跑", async () => {
    // 这是最保守的取值，也是 scanManagedRunners 选它的原因：纳管 / 取消纳管之后前端立刻重拉
    // 列表，缓存住哪怕几秒的旧结果，都会让刚导入的 runner 在界面上"没出现"。
    const load = vi.fn(async () => "x");
    const shared = singleFlight(load);

    await shared();
    await shared();

    expect(load).toHaveBeenCalledTimes(2);
  });

  it("失败会传给所有被合并的调用方", async () => {
    const d = deferred<string>();
    const load = vi.fn(() => d.promise);
    const shared = singleFlight(load);

    const a = shared();
    const b = shared();
    d.reject(new Error("/proc 扫描失败"));

    await expect(a).rejects.toThrow("/proc 扫描失败");
    await expect(b).rejects.toThrow("/proc 扫描失败");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("失败之后让出在飞位置：下一次调用重新发起，而不是再收到那个旧错误", async () => {
    // 若 in-flight 项只在成功时清除，一次 rejection 会把这个 key 永久钉在一个已经 settle 的
    // promise 上——观测再也回不来，而这正是本次要修的症状本身。
    const load = vi
      .fn<[], Promise<string>>()
      .mockRejectedValueOnce(new Error("抖了一下"))
      .mockResolvedValueOnce("恢复了");
    const shared = singleFlight(load);

    await expect(shared()).rejects.toThrow("抖了一下");
    await expect(shared()).resolves.toBe("恢复了");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("失败不进 TTL 缓存", async () => {
    const load = vi
      .fn<[], Promise<string>>()
      .mockRejectedValueOnce(new Error("systemctl 超时"))
      .mockResolvedValueOnce("好了");
    const shared = singleFlight(load, { ttlMs: 60_000 });

    await expect(shared()).rejects.toThrow("systemctl 超时");
    // 缓存住失败，就等于「systemctl 抖了一下」→「接下来一分钟所有人都看不到状态」
    await expect(shared()).resolves.toBe("好了");
  });

  describe("ttlMs", () => {
    it("窗口内复用已完成的结果，过期后重新跑", async () => {
      let clock = 1_000;
      const load = vi.fn(async () => clock);
      const shared = singleFlight(load, { ttlMs: 5_000, now: () => clock });

      expect(await shared()).toBe(1_000);
      clock = 4_999;
      expect(await shared()).toBe(1_000); // 仍在窗口内：没有重新扫
      expect(load).toHaveBeenCalledTimes(1);

      clock = 6_001;
      expect(await shared()).toBe(6_001);
      expect(load).toHaveBeenCalledTimes(2);
    });
  });
});

describe("singleFlightBy", () => {
  it("按 key 分别合并：不同 key 各跑各的", async () => {
    const load = vi.fn(async (name: string) => `结果:${name}`);
    const shared = singleFlightBy((name: string) => name, load);

    const [a, b, a2] = await Promise.all([shared("甲"), shared("乙"), shared("甲")]);

    expect([a, b, a2]).toEqual(["结果:甲", "结果:乙", "结果:甲"]);
    // 甲的两次并发合成一次，乙自己一次
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("TTL 过期的条目会被清掉，key 可变时这张表不会无上限地长", async () => {
    let clock = 0;
    const load = vi.fn(async (name: string) => name);
    const shared = singleFlightBy((name: string) => name, load, { ttlMs: 10, now: () => clock });

    for (let i = 0; i < 50; i++) {
      await shared(`unit-${i}`);
      clock += 100; // 每一轮都让上一条过期
    }
    // 过期条目若留着，这里的断言测不出来——但同一个 key 再来时必须是重新跑的，
    // 这条能测：它同时证明了过期判断本身没被那张表短路。
    clock += 1_000;
    await shared("unit-0");
    expect(load).toHaveBeenCalledTimes(51);
  });
});
