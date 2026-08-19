// 共享夹具：给 process 后端的用例造一个「像样的 runner 目录」，外加一套可注入的依赖。
//
// 后端真正会做的三件危险事——spawn、kill、等时钟——全部经 ProcessDeps 注入，用例因此能在毫秒内
// 断言「发了哪几个信号、发给谁」，而不用真起进程、真等 5 分钟。
import fs from "fs-extra";
import path from "path";

import { canonicalPath } from "../../src/tools/path_link_check";
import { writeMarker } from "../../src/service/runner_marker";
import type { ListenerProc } from "../../src/service/supervisor/local_procs";
import type { ProcessDeps } from "../../src/service/supervisor/process";
import { SCAN_ROOT } from "../setup";

export interface Fixture {
  dir: string;
  markerId: string;
}

// 造一个含 .runner 与合法 .cipanel 的目录。markerId 是后端一切私有状态的文件名，
// 所以必须来自真实的 writeMarker，而不是随手编一个字符串。
export function makeRunner(name: string): Fixture {
  const dir = canonicalPath(path.join(SCAN_ROOT, "org-repo", name));
  fs.mkdirsSync(dir);
  fs.writeFileSync(path.join(dir, ".runner"), JSON.stringify({ gitHubUrl: "", agentName: name }));
  const marker = writeMarker(dir, { source: "import", repo: "org/repo" });
  return { dir, markerId: marker.id };
}

export function listenerProc(over: Partial<ListenerProc> & { dir: string }): ListenerProc {
  return { pid: 1000, pgid: 1000, cgroup: "", busy: false, ...over };
}

export interface FakeDeps extends ProcessDeps {
  // 当前这一轮 scan 会看到什么。用例直接改它来模拟「进程起来了 / 退出了」
  procs: ListenerProc[];
  // 收到的信号，按顺序。负数 pid 表示整个进程组——这一点也要被断言到
  signals: Array<{ pid: number; signal: NodeJS.Signals }>;
  // spawn 的调用记录（命令、参数、cwd、env）
  spawns: Array<{ cmd: string; args: string[]; opts: any }>;
  advance(ms: number): void;
}

/**
 * 一套假依赖。默认 spawn 返回一个「起成功了」的假子进程；用例可以覆盖 spawn 来模拟失败。
 * 时钟从一个固定时刻起步并只在 advance() 时前进，停止阶梯那三级才测得了。
 */
export function fakeDeps(over: Partial<ProcessDeps> = {}): FakeDeps {
  let clock = 1_700_000_000_000;
  const deps: FakeDeps = {
    procs: [],
    signals: [],
    spawns: [],
    advance: (ms: number) => {
      clock += ms;
    },
    scan: async () => deps.procs,
    kill: (pid, signal) => {
      deps.signals.push({ pid, signal });
    },
    now: () => clock,
    settlePollMs: 1,
    settleTimeoutMs: 0, // 用例要么现场就到位，要么立刻拿到 settled:false —— 别让假时钟空转
    spawn: ((cmd: string, args: string[], opts: any) => {
      deps.spawns.push({ cmd, args, opts });
      return fakeChild(4242);
    }) as unknown as ProcessDeps["spawn"],
    ...over
  };
  return deps;
}

// 够用的 ChildProcess 替身：后端只用到 pid、on('error'|'exit') 与 unref()
export function fakeChild(pid: number | undefined): any {
  const handlers = new Map<string, (...a: any[]) => void>();
  return {
    pid,
    on(event: string, fn: (...a: any[]) => void) {
      handlers.set(event, fn);
      return this;
    },
    unref() {
      return this;
    },
    // 用例用它触发 'error' / 'exit'，模拟 spawn 失败与 run.sh 早退
    emit(event: string, ...args: any[]) {
      handlers.get(event)?.(...args);
    }
  };
}
