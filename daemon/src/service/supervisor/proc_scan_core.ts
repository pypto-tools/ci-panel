import fs from "node:fs";
import { canonicalPath } from "../../tools/path_link_check";
import type { ListenerProc, ProcScanResponse } from "./proc_scan_types";

// A runner update can leave Listener in bin/ and Worker in bin.<version>/.
const RUNNER_BIN_RE = /^(\S+)\/bin(?:\.[\d.]+)?\/Runner\.(Listener|Worker)\b/;

/** Synchronous by design: execute only inside the dedicated scan worker. */
export function scanProcTree(procRoot: string): Extract<ProcScanResponse, { ok: true }> {
  // A failed root read must throw; an empty result would incorrectly permit start.
  const pids = fs.readdirSync(procRoot).filter((name) => /^\d+$/.test(name));
  const listeners = new Map<number, Omit<ListenerProc, "pid" | "busy">>();
  const workerParents = new Set<number>();
  const warnings: string[] = [];
  let skipped = 0;
  for (const pid of pids) {
    try {
      // comm is truncated by the kernel; use it only as a coarse filter.
      const comm = fs.readFileSync(`${procRoot}/${pid}/comm`, "utf8").trim();
      if (!comm.startsWith("Runner.")) continue;
      const stat = fs.readFileSync(`${procRoot}/${pid}/stat`, "utf8");
      // comm may itself contain spaces and parentheses.
      const fields = stat
        .slice(stat.lastIndexOf(")") + 1)
        .trim()
        .split(/\s+/);
      const cmdline = fs.readFileSync(`${procRoot}/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
      const match = cmdline.match(RUNNER_BIN_RE);
      if (!match) continue;
      if (match[2] === "Worker") {
        workerParents.add(Number(fields[1]));
        continue;
      }
      let cgroup = "";
      try {
        cgroup = fs.readFileSync(`${procRoot}/${pid}/cgroup`, "utf8");
      } catch {
        // Some kernels do not expose cgroups; systemd also verifies MainPID.
      }
      listeners.set(Number(pid), {
        pgid: Number(fields[2]),
        dir: canonicalPath(match[1]),
        cgroup
      });
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT" && code !== "ESRCH") {
        // Preserve the existing per-PID error policy, but bound diagnostic traffic.
        skipped++;
        if (warnings.length < 10) warnings.push(`pid ${pid}: ${code || String(err)}`);
      }
    }
  }
  return {
    ok: true,
    procs: Array.from(listeners, ([pid, value]) => ({
      pid,
      ...value,
      busy: workerParents.has(pid)
    })),
    warnings,
    skipped
  };
}
