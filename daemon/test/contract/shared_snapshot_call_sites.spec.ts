import fs from "fs-extra";
import path from "path";
import { describe, expect, it } from "vitest";
import { DAEMON_ROOT } from "../setup";

// 共享 /proc 快照是纯性能改动，它唯一的风险面是被用错地方：动作路径（start / stop / detach 与
// controlRunner 在锁内重算的那次闸门）必须看「此时此刻」，拿一份最多 1 秒前的快照去判，等于把
// 判定与执行之间那个不许存在的窗口又开了回来——而 idle 是唯一放行 start 的取值，代价是双托管。
//
// 这条边界靠两件事守住，二者缺一不可，所以都钉在这里：
//   1. observeAll 的 procSource 缺省是 fresh —— 新调用方忘了选，拿到的是保守的那个；
//   2. opt-in 的调用点只能是只读展示路径。
//
// 用源码级断言而不是行为断言：真正的行为（systemd 后端 observe）要 fork systemctl，本套件
// 刻意不碰宿主机的真单元（见 test/setup.ts 里 CIP_RUNNER_SVC_HELPER 的说明）。

const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    return e.isFile() && e.name.endsWith(".ts") ? [full] : [];
  });

const SRC = path.join(DAEMON_ROOT, "src");
const rel = (f: string) => path.relative(DAEMON_ROOT, f).split(path.sep).join("/");
const files = walk(SRC).map((f) => ({ path: rel(f), text: fs.readFileSync(f, "utf8") }));

describe("共享 /proc 快照的使用边界", () => {
  it("只有 local_procs（定义处）与 resolve（观测入口）认识 sharedListenerProcs", () => {
    // 别的地方要用它，就意味着绕开了 observeAll 的 procSource 开关——那个开关是这条边界的
    // 唯一落点。真有新的只读调用方，应当走 observeAll(dirs, "shared")，而不是自己去拿快照。
    const ALLOWED = ["src/service/supervisor/local_procs.ts", "src/service/supervisor/resolve.ts"];
    const users = files.filter((f) => f.text.includes("sharedListenerProcs")).map((f) => f.path);

    expect(users.sort()).toEqual([...ALLOWED].sort());
  });

  it("observeAll 的缺省是 fresh", () => {
    // 缺省值写反了，所有既有调用方（含 controlRunner 的闸门）会一起静默切到共享快照上。
    const resolve = files.find((f) => f.path === "src/service/supervisor/resolve.ts");
    expect(resolve, "resolve.ts 被挪走了，这条守卫要跟着改").toBeDefined();
    expect(resolve?.text).toMatch(/procSource:\s*ProcSource\s*=\s*"fresh"/);
  });

  it("只有只读展示路径显式要 shared", () => {
    // runner_scan.buildRunners 是列表 / 计数 / 详情页三条只读链的共同底座，也是唯一该 opt-in
    // 的地方。controlRunner 那次 observeAll 不传第二个参数，因此走 fresh。
    const OPT_IN = ["src/service/runner_scan.ts"];
    const optedIn = files
      .filter((f) => /observeAll\([^)]*,\s*"shared"\s*\)/.test(f.text))
      .map((f) => f.path);

    expect(optedIn.sort()).toEqual([...OPT_IN].sort());
  });

  it("动作路径仍然直接现扫 /proc", () => {
    // 守住正则不会在某次重命名之后静默地什么都匹配不到：scanListenerProcs 必须还有真实调用方
    // （resolve 的 fresh 分支、reconcile 的每一拍、systemd 的 detach 复核）。
    const rawCallers = files
      .filter((f) => f.path !== "src/service/supervisor/local_procs.ts")
      .filter((f) => /\bscanListenerProcs\(/.test(f.text))
      .map((f) => f.path);

    expect(rawCallers.length).toBeGreaterThanOrEqual(3);
    expect(rawCallers).toContain("src/service/supervisor/reconcile.ts");
  });
});
