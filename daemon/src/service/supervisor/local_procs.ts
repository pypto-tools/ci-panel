// CI Panel 扩展：本机 /proc 里的 runner 监听进程快照。
//
// systemd 与 process 两个后端都要回答「这个目录里有没有活着的 listener」，而且都在本机 PID
// namespace 里，所以这段逻辑抽在这里给它们共用——**但它不是框架层的统一原语**：容器后端在
// 另一个 namespace，远端后端根本没有 /proc，它们的 observe 会用完全不同的手段。放在后端这边
// 而不是框架里，就是为了不把「本地进程」这个假设写进框架。
//
// 一轮观测只调一次它，结果由 observeAll 作为形参传给每个后端（见 types.ts 的 observe）。
// 动作路径（start / stop / detach）刻意不受这条约束：它们要的是「此时此刻」的事实，
// 拉起 listener 与发 SIGKILL 都不可逆，不能拿一份几百毫秒前的快照去做这种决定。
import fs from "fs-extra";

import { canonicalPath } from "../../tools/path_link_check";

export interface ListenerProc {
  pid: number;
  pgid: number; // 进程组：spawn 出来的 listener 靠它认领
  dir: string; // 来自 cmdline 的 runner 目录，已归一化
  cgroup: string; // /proc/<pid>/cgroup 原文，systemd 后端据此认领
  busy: boolean; // 有 Runner.Worker 子进程 = 正在跑 job，停它会中断 CI
}

// 分批并发读：机器上可能有几千个进程，同步逐个读会卡住事件循环几十毫秒、负载高时更久；
// 一次全开又会同时占几千个 fd。沿用 runner_scan.busyRunnerDirs 原有的做法。
const CHUNK = 256;

/**
 * 扫出本机所有 runner 监听进程。procRoot 可注入，否则这段逻辑没法测。
 *
 * **读不到 procRoot 必须抛，不能回空数组。** 空数组与「确实没有 listener」在类型上无法区分，
 * 而 observeAll 正是靠这次抛错把 complete 拉掉的：吞掉它，观测失败就会静默变成 ownership:idle
 * ——而 idle 是唯一放行 start 的取值，于是一次读不动 /proc 就成了双托管的入口。
 * 可能的失败：容器里挂了 hidepid、procRoot 被 bind mount 掉、fixture 路径写错。
 */
export async function scanListenerProcs(procRoot = "/proc"): Promise<ListenerProc[]> {
  const pids = (await fs.promises.readdir(procRoot)).filter((n) => /^\d+$/.test(n));

  const listeners = new Map<number, Omit<ListenerProc, "pid" | "busy">>();
  const workerParents = new Set<number>();

  for (let i = 0; i < pids.length; i += CHUNK) {
    await Promise.all(
      pids.slice(i, i + CHUNK).map(async (pid) => {
        try {
          // comm 只有 15 个可用字符（TASK_COMM_LEN-1），"Runner.Listener" 正好 15——刚够，
          // 但官方把名字改长一点就会被截断，而存活判定现在是启停的前置条件，静默失配代价太大。
          // 所以只用 "Runner." 前缀粗筛（截断也留得住），精确分类交给下面的 cmdline，
          // 它带完整路径，本来就是我们要的那个信息。
          const comm = (await fs.promises.readFile(`${procRoot}/${pid}/comm`, "utf8")).trim();
          if (!comm.startsWith("Runner.")) return;

          // /proc/<pid>/stat 的 comm 字段可能含空格和括号，必须从最后一个 ')' 之后再切字段；
          // 之后依次是 state、ppid、pgrp。
          const stat = await fs.promises.readFile(`${procRoot}/${pid}/stat`, "utf8");
          const fields = stat
            .slice(stat.lastIndexOf(")") + 1)
            .trim()
            .split(/\s+/);

          const cmdline = (
            await fs.promises.readFile(`${procRoot}/${pid}/cmdline`, "utf8")
          ).replace(/\0/g, " ");
          const m = cmdline.match(/^(\S+)\/bin\/Runner\.(Listener|Worker)\b/);
          if (!m) return;

          if (m[2] === "Worker") {
            // 沿用既有做法：Worker 的归属由它的父 Listener 决定，不自己解析目录
            workerParents.add(Number(fields[1]));
            return;
          }

          // cgroup 读不到不致命（内核配置差异），systemd 后端会退回 MainPID 交叉验证
          const cgroup = await fs.promises
            .readFile(`${procRoot}/${pid}/cgroup`, "utf8")
            .catch(() => "");

          listeners.set(Number(pid), {
            pgid: Number(fields[2]),
            // canonicalPath 而不是 normalize：这个值要和调用方给的 dir 做字符串全等比较。
            // cmdline 里本来就是物理路径，但两侧必须走**同一个**归一化函数，否则「哪一侧碰巧
            // 已经是 realpath」就成了闸门灵不灵的隐式前提。
            dir: canonicalPath(m[1]),
            cgroup
          });
        } catch {
          /* 进程可能刚好退出了，跳过 */
        }
      })
    );
  }

  return Array.from(listeners, ([pid, v]) => ({ pid, ...v, busy: workerParents.has(pid) }));
}
