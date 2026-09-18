import fs from "fs-extra";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { scanListenerProcs, sharedListenerProcs } from "../../src/service/supervisor/local_procs";
import { SCAN_ROOT } from "../setup";

// 只读路径（runner 列表、info/overview 的计数、详情页）此前各扫各的 /proc：机器上有几千个
// pid 时一次扫描就要半秒多，而前端三路轮询叠起来，一分钟能打出几十次全量扫描——并发越多越慢，
// 慢到浏览器 30 秒超时，界面上就是"加载失败"。共享快照把同一拍里的这些调用合成一次。
//
// 与之对立的那条约束同样要钉住：**动作路径不许用它**。start / detach 是去 GitHub 抢身份的
// 不可逆副作用，拿一份几百毫秒前的快照去判闸门，就是双托管的入口。所以 scanListenerProcs
// 必须保持"每次都现扫"。

const procRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ci-panel-proc-shared-"));
const dirA = path.join(SCAN_ROOT, "org-repo", "shared-1");
const dirB = path.join(SCAN_ROOT, "org-repo", "shared-2");

const writeProc = (pid: number, dir: string) => {
  const d = path.join(procRoot, String(pid));
  fs.mkdirsSync(d);
  fs.writeFileSync(path.join(d, "comm"), "Runner.Listener\n");
  fs.writeFileSync(path.join(d, "stat"), `${pid} (Runner.Listener) S 1 ${pid} 0 0 -1 4194560\n`);
  fs.writeFileSync(path.join(d, "cmdline"), `${dir}/bin/Runner.Listener run`.replace(/ /g, "\0"));
};

beforeAll(() => {
  fs.mkdirsSync(dirA);
  fs.mkdirsSync(dirB);
  writeProc(1001, dirA);
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => fs.removeSync(procRoot));

describe("sharedListenerProcs", () => {
  it("并发调用共享同一轮扫描", async () => {
    // 同一个数组实例 = 只扫了一遍。这正是「6 个并发各等 3.4 秒」变回「各等 0.66 秒」的原因。
    const [a, b, c] = await Promise.all([
      sharedListenerProcs(procRoot),
      sharedListenerProcs(procRoot),
      sharedListenerProcs(procRoot)
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a.map((p) => p.pid)).toEqual([1001]);
  });

  it("TTL 窗口内复用上一轮结果，过期后重新扫", async () => {
    // 用自己的 procRoot：本用例要把系统时钟拨来拨去，共用 key 会把一个"未来时刻"的缓存留给
    // 后面的用例，时钟一恢复就成了永不过期的条目。
    const ttlRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ci-panel-proc-ttl-"));
    const write = (pid: number, dir: string) => {
      const d = path.join(ttlRoot, String(pid));
      fs.mkdirsSync(d);
      fs.writeFileSync(path.join(d, "comm"), "Runner.Listener\n");
      fs.writeFileSync(path.join(d, "stat"), `${pid} (Runner.Listener) S 1 ${pid} 0 0 -1 419456\n`);
      fs.writeFileSync(
        path.join(d, "cmdline"),
        `${dir}/bin/Runner.Listener run`.replace(/ /g, "\0")
      );
    };
    write(2001, dirA);

    const base = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(base);

    expect((await sharedListenerProcs(ttlRoot)).map((p) => p.pid)).toEqual([2001]);

    // 窗口内新起的 listener 这一拍看不到——这就是 1 秒快照的代价，明确写下来
    write(2002, dirB);
    vi.setSystemTime(base + 900);
    expect((await sharedListenerProcs(ttlRoot)).map((p) => p.pid)).toEqual([2001]);

    // 过期之后必须看得到。看不到就不是"快照"而是"卡住"了，界面上的运行状态会永远停在旧值。
    vi.setSystemTime(base + 1_100);
    expect((await sharedListenerProcs(ttlRoot)).map((p) => p.pid).sort()).toEqual([2001, 2002]);

    fs.removeSync(ttlRoot);
  });

  it("读不动 /proc 时照旧抛，且不会被缓存住", async () => {
    // observeAll 靠这次抛错把 complete 拉掉 → ownership:unknown。若共享层把失败缓存下来，
    // 一次抖动会让整台节点在接下来的窗口里全部判 unknown、启停全被拒。
    const missing = path.join(procRoot, "does-not-exist");
    await expect(sharedListenerProcs(missing)).rejects.toThrow();
    await expect(sharedListenerProcs(missing)).rejects.toThrow();
    // 换回好的根立刻就能扫出来，说明失败没有污染缓存
    expect((await sharedListenerProcs(procRoot)).map((p) => p.pid)).toEqual([1001]);
  });

  it("不同的 procRoot 互不串用", async () => {
    // key 就是 procRoot。串了的话夹具之间会互相污染，而生产上只有一个根，问题会一直潜伏到
    // 有人给容器后端传别的根为止。
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "ci-panel-proc-other-"));
    expect(await sharedListenerProcs(other)).toEqual([]);
    expect((await sharedListenerProcs(procRoot)).map((p) => p.pid)).toContain(1001);
    fs.removeSync(other);
  });
});

describe("scanListenerProcs（动作路径用）", () => {
  it("每次都现扫，不受共享快照影响", async () => {
    // 动作路径的语义是"此时此刻"。这条用例是那条约束的守门人：谁把 scanListenerProcs 也包上
    // 缓存，它会立刻红。
    await sharedListenerProcs(procRoot); // 先把共享快照焐热
    writeProc(1003, dirB);
    expect((await scanListenerProcs(procRoot)).map((p) => p.pid).sort()).toEqual([1001, 1003]);
    fs.removeSync(path.join(procRoot, "1003"));
  });
});
