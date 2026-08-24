import fs from "fs-extra";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanListenerProcs } from "../../src/service/supervisor/local_procs";
import { SCAN_ROOT } from "../setup";

// Every gate in the supervisor framework rests on this one scan: which listeners are alive, in
// which directory, in which process group, and whether a job is running. It is also the only part
// that reads /proc, so it takes an injectable root — otherwise none of the parsing below could be
// exercised without a real runner on the machine.

const procRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ci-panel-proc-"));
const dirA = path.join(SCAN_ROOT, "org-repo", "runner-1");
const dirB = path.join(SCAN_ROOT, "org-repo", "runner-2");

// /proc/<pid>/stat is "pid (comm) state ppid pgrp ...", and comm can itself contain spaces and
// parentheses — hence the parser slicing after the LAST ')'.
const writeProc = (
  pid: number,
  opts: { comm: string; cmdline?: string; ppid?: number; pgid?: number; cgroup?: string }
) => {
  const dir = path.join(procRoot, String(pid));
  fs.mkdirsSync(dir);
  fs.writeFileSync(path.join(dir, "comm"), `${opts.comm}\n`);
  fs.writeFileSync(
    path.join(dir, "stat"),
    `${pid} (${opts.comm}) S ${opts.ppid ?? 1} ${opts.pgid ?? pid} 0 0 -1 4194560\n`
  );
  if (opts.cmdline !== undefined)
    fs.writeFileSync(path.join(dir, "cmdline"), opts.cmdline.replace(/ /g, "\0"));
  if (opts.cgroup !== undefined) fs.writeFileSync(path.join(dir, "cgroup"), opts.cgroup);
};

beforeAll(() => {
  fs.mkdirsSync(dirA);
  fs.mkdirsSync(dirB);

  // A healthy idle listener, in its unit's cgroup.
  writeProc(1001, {
    comm: "Runner.Listener",
    cmdline: `${dirA}/bin/Runner.Listener run`,
    pgid: 1001,
    cgroup: "0::/system.slice/actions.runner.org-repo.runner-1.service\n"
  });

  // A second runner, busy: its Worker is a child of the listener. The worker itself never becomes
  // an entry — it only marks its parent.
  writeProc(2001, {
    comm: "Runner.Listener",
    cmdline: `${dirB}/bin/Runner.Listener run`,
    pgid: 2001
  });
  writeProc(2002, {
    comm: "Runner.Worker",
    cmdline: `${dirB}/bin/Runner.Worker spawnclient 1 2`,
    ppid: 2001,
    pgid: 2001
  });

  // Not a runner at all.
  writeProc(3001, { comm: "sshd", cmdline: "/usr/sbin/sshd -D" });

  // Exited between readdir and the reads — every file is missing.
  fs.mkdirsSync(path.join(procRoot, "4001"));

  // Not a pid at all: /proc holds plenty of these.
  fs.mkdirsSync(path.join(procRoot, "self"));
});

afterAll(() => fs.removeSync(procRoot));

describe("scanListenerProcs", () => {
  it("indexes listeners by directory, process group and cgroup", async () => {
    const procs = await scanListenerProcs(procRoot);
    const a = procs.find((p) => p.pid === 1001);
    expect(a).toMatchObject({ pid: 1001, pgid: 1001, dir: dirA, busy: false });
    expect(a?.cgroup).toContain("actions.runner.org-repo.runner-1.service");
  });

  it("marks a listener busy through its Worker child, and lists the worker separately never", async () => {
    const procs = await scanListenerProcs(procRoot);
    expect(procs.find((p) => p.pid === 2001)?.busy).toBe(true);
    // The worker's own pid must not appear: two entries for one runner would read as a conflict
    // and freeze every control on it.
    expect(procs.map((p) => p.pid)).not.toContain(2002);
  });

  it("skips processes that are not runners, and pids that vanished mid-scan", async () => {
    const procs = await scanListenerProcs(procRoot);
    expect(procs.map((p) => p.pid).sort()).toEqual([1001, 2001]);
  });

  it("tolerates a comm that was truncated by the kernel", async () => {
    // TASK_COMM_LEN caps comm at 15 characters and "Runner.Listener" is exactly 15 — one rename
    // upstream and the exact match would stop finding anything, silently. The prefix survives,
    // and the precise classification comes from cmdline anyway.
    writeProc(5001, {
      comm: "Runner.Listene",
      cmdline: `${dirA}/bin/Runner.Listener run`,
      pgid: 5001
    });
    const procs = await scanListenerProcs(procRoot);
    expect(procs.map((p) => p.pid)).toContain(5001);
    fs.removeSync(path.join(procRoot, "5001"));
  });

  it("parses stat when comm itself contains spaces and parentheses", async () => {
    writeProc(5002, {
      comm: "Runner.Listener (x)",
      cmdline: `${dirB}/bin/Runner.Listener run`,
      pgid: 777
    });
    const procs = await scanListenerProcs(procRoot);
    // pgid is the third field after the closing paren; a naive split would read it off by two.
    expect(procs.find((p) => p.pid === 5002)?.pgid).toBe(777);
    fs.removeSync(path.join(procRoot, "5002"));
  });

  // A self-updated runner is the common case, not an exotic one: the runner stages the new release
  // in bin.<version>/externals.<version> and spawns the new Worker from there immediately, while
  // its own listener keeps running out of bin/ until the unit restarts. Production hosts therefore
  // show `<dir>/bin/Runner.Listener` next to `<dir>/bin.2.336.0/Runner.Worker`.
  describe("a runner that has self-updated", () => {
    const dirC = path.join(SCAN_ROOT, "org-repo", "runner-3");

    beforeAll(() => {
      fs.mkdirsSync(dirC);
      writeProc(6001, {
        comm: "Runner.Listener",
        cmdline: `${dirC}/bin/Runner.Listener run --startuptype service`,
        pgid: 6001
      });
      writeProc(6002, {
        comm: "Runner.Worker",
        cmdline: `${dirC}/bin.2.336.0/Runner.Worker spawnclient 195 199`,
        ppid: 6001,
        pgid: 6001
      });
    });

    afterAll(() => {
      fs.removeSync(path.join(procRoot, "6001"));
      fs.removeSync(path.join(procRoot, "6002"));
    });

    it("still sees the job through a Worker living in bin.<version>", async () => {
      // The regression this pins: a /bin/-only pattern matched every listener and no worker, so
      // "running" stayed correct while every busy count silently read 0.
      const procs = await scanListenerProcs(procRoot);
      expect(procs.find((p) => p.pid === 6001)?.busy).toBe(true);
      expect(procs.map((p) => p.pid)).not.toContain(6002);
    });

    it("recognises a listener running out of bin.<version> too, with its directory intact", async () => {
      // After the restart the listener itself moves into the versioned directory. Failing to match
      // it there costs more than a wrong number: zero instances reads as ownership idle, the one
      // value that lets a start through, so a second listener could be launched over a live one.
      writeProc(6003, {
        comm: "Runner.Listener",
        cmdline: `${dirC}/bin.2.336.0/Runner.Listener run --startuptype service`,
        pgid: 6003
      });
      const procs = await scanListenerProcs(procRoot);
      expect(procs.find((p) => p.pid === 6003)).toMatchObject({ dir: dirC, busy: false });
      fs.removeSync(path.join(procRoot, "6003"));
    });

    it("does not treat a sibling directory as a runner bin", async () => {
      // Only a version suffix is accepted. `binaries/` or `bin-old/` are not the runner layout, and
      // matching them would invent instances for directories nothing is supervising.
      writeProc(6004, {
        comm: "Runner.Listener",
        cmdline: `${dirC}/binaries/Runner.Listener run`,
        pgid: 6004
      });
      const procs = await scanListenerProcs(procRoot);
      expect(procs.map((p) => p.pid)).not.toContain(6004);
      fs.removeSync(path.join(procRoot, "6004"));
    });
  });

  it("survives a missing cgroup file", async () => {
    // Kernel configuration differs; the systemd backend degrades to a MainPID check rather than
    // losing the process entirely.
    expect((await scanListenerProcs(procRoot)).find((p) => p.pid === 2001)?.cgroup).toBe("");
  });

  it("throws when the proc root cannot be read", async () => {
    // Returning an empty array here would be indistinguishable from "nothing is running", which
    // is the one reading that lets a start through. The framework turns this throw into
    // ownership: unknown.
    await expect(scanListenerProcs(path.join(procRoot, "does-not-exist"))).rejects.toThrow();
  });
});
