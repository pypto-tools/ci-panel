import fs from "fs-extra";
import path from "path";
import { spawn } from "child_process";
import { once } from "events";
import { describe, expect, it } from "vitest";
import { createProcessSupervisor } from "../../src/service/supervisor/process";
import {
  inspectProcessGroup,
  processGroupState,
  readLeaderIdentity
} from "../../src/service/supervisor/process/group";
import { readRuntime, runtimePath, writeRuntime } from "../../src/service/supervisor/process/store";
import { SCAN_ROOT } from "../setup";
import { fakeDeps, listenerProc, makeRunner } from "../helpers/process_fixture";

const fixture = makeRunner("group-probe");
const procRoot = path.join(SCAN_ROOT, "proc-fixture");
const PGID = 9150;
const bootId = "01234567-89ab-cdef-0123-456789abcdef";

function stat(over: { state?: string; group?: number; ticks?: string } = {}): string {
  const fields = Array<string>(20).fill("0");
  fields[0] = over.state ?? "S";
  fields[1] = "1";
  fields[2] = String(over.group ?? PGID);
  fields[19] = over.ticks ?? "777";
  return `${PGID} (wrapper (retry)) ${fields.join(" ")}`;
}

async function fakeProc(over: Parameters<typeof stat>[0] = {}) {
  await fs.remove(procRoot);
  await fs.ensureDir(path.join(procRoot, String(PGID)));
  await fs.outputFile(path.join(procRoot, "sys/kernel/random/boot_id"), bootId);
  await fs.writeFile(path.join(procRoot, String(PGID), "stat"), stat(over));
  await fs.symlink(fixture.dir, path.join(procRoot, String(PGID), "cwd"));
}

describe("group existence is conservative", () => {
  it("probes the entire group without delivering a signal", () => {
    const calls: Array<[number, number]> = [];
    expect(processGroupState(PGID, (pid, signal) => calls.push([pid, signal]))).toBe("present");
    expect(calls).toEqual([[-PGID, 0]]);
  });
  it("recognizes an absent group only on ESRCH", () => {
    expect(
      processGroupState(PGID, () => {
        throw Object.assign(new Error("Gone"), { code: "ESRCH" });
      })
    ).toBe("absent");
  });
  it.each(["EPERM", "EACCES", "EIO"])("does not interpret %s as exit", (code) => {
    expect(
      processGroupState(PGID, () => {
        throw Object.assign(new Error(code), { code });
      })
    ).toBe("unknown");
  });
  it.each([-1, 1, 1.5, NaN, Infinity, 0x80000000])("never probes an unsafe group id %s", (pgid) => {
    const calls: number[] = [];
    expect(
      processGroupState(pgid, (pid) => {
        calls.push(pid);
      })
    ).toBe("unknown");
    expect(calls).toEqual([]);
  });
  it("treats zero as no recorded group without invoking kill", () => {
    expect(
      processGroupState(0, () => {
        throw new Error("Must not be called");
      })
    ).toBe("absent");
  });
});

describe("leader identity", () => {
  it("reads start ticks after a comm containing spaces and parentheses", async () => {
    await fakeProc();
    expect(await readLeaderIdentity(PGID, fixture.dir, procRoot)).toEqual({
      bootId,
      startTicks: "777"
    });
  });
  it("requires the recorded runner directory", async () => {
    await fakeProc();
    expect(await readLeaderIdentity(PGID, SCAN_ROOT, procRoot)).toBeUndefined();
  });
  it("requires a group leader rather than an unrelated process", async () => {
    await fakeProc({ group: 999 });
    expect(await readLeaderIdentity(PGID, fixture.dir, procRoot)).toBeUndefined();
  });
  it.each(["Z", "X"])("does not use a %s process as live ownership evidence", async (state) => {
    await fakeProc({ state });
    expect(await readLeaderIdentity(PGID, fixture.dir, procRoot)).toBeUndefined();
  });
  it("does not invent identity from missing or malformed proc evidence", async () => {
    await fakeProc({ ticks: "invalid" });
    expect(await readLeaderIdentity(PGID, fixture.dir, procRoot)).toBeUndefined();
    await fs.remove(procRoot);
    expect(await readLeaderIdentity(PGID, fixture.dir, procRoot)).toBeUndefined();
  });
  it("inspects a real detached group and recognizes its exit", async () => {
    const child = spawn("sleep", ["30"], { cwd: fixture.dir, detached: true, stdio: "ignore" });
    await once(child, "spawn");
    if (!child.pid) throw new Error("Child did not start");
    try {
      expect(processGroupState(child.pid)).toBe("present");
      const identity = await readLeaderIdentity(child.pid, fixture.dir);
      expect(identity?.bootId).toMatch(/^[a-f0-9-]+$/);
      expect(identity?.startTicks).toMatch(/^\d+$/);
      expect(await readLeaderIdentity(child.pid, fixture.dir)).toEqual(identity);
    } finally {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
    expect(processGroupState(child.pid)).toBe("absent");
  });
});

describe("runtime compatibility", () => {
  const base = {
    v: 1 as const,
    dir: fixture.dir,
    pgid: PGID,
    startedAt: 1,
    lastAttemptAt: 1,
    desired: "running" as const,
    stopRequestedAt: 0,
    stopStage: 0,
    failures: 0,
    lastError: ""
  };
  it("round-trips leader identity across a supervisor restart", async () => {
    const leaderIdentity = { bootId, startTicks: "777" };
    await writeRuntime(fixture.markerId, { ...base, leaderIdentity });
    expect((await readRuntime(fixture.markerId))?.leaderIdentity).toEqual(leaderIdentity);
  });
  it("keeps older runtime records usable without granting wrapper ownership", async () => {
    await writeRuntime(fixture.markerId, base);
    expect(await readRuntime(fixture.markerId)).toMatchObject(base);
    expect((await readRuntime(fixture.markerId))?.leaderIdentity).toBeUndefined();
  });
  it.each([null, {}, { bootId, startTicks: -1 }, { bootId: {}, startTicks: "777" }])(
    "rejects malformed identity %j",
    async (leaderIdentity) => {
      await fs.outputJson(runtimePath(fixture.markerId), { ...base, leaderIdentity });
      expect((await readRuntime(fixture.markerId))?.leaderIdentity).toBeUndefined();
    }
  );
});

describe("recorded group lifetime", () => {
  const allocated = () => true;
  it("does not wait for an unrelated group after a host reboot", async () => {
    await fakeProc();
    expect(
      await inspectProcessGroup(
        PGID,
        { bootId: "previous-boot", startTicks: "777" },
        procRoot,
        allocated
      )
    ).toBe("absent");
  });
  it("recognizes reboot even if the reused group cannot be probed", async () => {
    await fakeProc();
    const probes: number[] = [];
    const state = await inspectProcessGroup(
      PGID,
      { bootId: "previous-boot", startTicks: "777" },
      procRoot,
      (pid) => {
        probes.push(pid);
        throw Object.assign(new Error("Denied"), { code: "EPERM" });
      }
    );
    expect(state).toBe("absent");
    expect(probes).toEqual([]);
  });
  it("keeps the same-boot live group present", async () => {
    await fakeProc();
    expect(
      await inspectProcessGroup(PGID, { bootId, startTicks: "777" }, procRoot, allocated)
    ).toBe("present");
  });
  it("treats a zombie-only group as stopped even before PID 1 reaps it", async () => {
    await fakeProc({ state: "Z" });
    await fs.remove(path.join(procRoot, String(PGID)));
    await fs.outputFile(
      path.join(procRoot, "9151/stat"),
      stat({ state: "Z" }).replace(/^9150 /, "9151 ")
    );
    expect(await inspectProcessGroup(PGID, undefined, procRoot, allocated)).toBe("absent");
  });
  it("keeps live descendants present after their group leader exits", async () => {
    await fakeProc();
    await fs.remove(path.join(procRoot, String(PGID)));
    await fs.outputFile(path.join(procRoot, "9151/stat"), stat().replace(/^9150 /, "9151 "));
    expect(await inspectProcessGroup(PGID, undefined, procRoot, allocated)).toBe("present");
  });
  it("does not confuse a missing leader with an absent group", async () => {
    await fakeProc({ state: "Z" });
    await fs.outputFile(path.join(procRoot, "9151/stat"), stat().replace(/^9150 /, "9151 "));
    expect(await inspectProcessGroup(PGID, undefined, procRoot, allocated)).toBe("present");
  });
  it("cannot confirm group exit with malformed member evidence", async () => {
    await fakeProc({ state: "Z" });
    await fs.outputFile(path.join(procRoot, "9151/stat"), "invalid");
    expect(await inspectProcessGroup(PGID, undefined, procRoot, allocated)).toBe("unknown");
  });
  it("cannot confirm group exit when proc or boot identity is unreadable", async () => {
    await fs.remove(procRoot);
    expect(await inspectProcessGroup(PGID, undefined, procRoot, allocated)).toBe("unknown");
    expect(
      await inspectProcessGroup(PGID, { bootId, startTicks: "777" }, procRoot, allocated)
    ).toBe("unknown");
  });
});

describe.each([
  { record: "prior-boot", savedBoot: "previous-boot", maySignal: false },
  { record: "current-boot", savedBoot: bootId, maySignal: true },
  { record: "legacy", savedBoot: undefined, maySignal: true },
  { record: "unreadable-boot", savedBoot: bootId, maySignal: false, bootReadable: false },
  { record: "legacy-unreadable-boot", savedBoot: undefined, maySignal: true, bootReadable: false },
  { record: "legacy-unknown-group", savedBoot: undefined, maySignal: true, probeFails: true }
])("stop authorization for a $record record", (scenario) => {
  const { savedBoot, maySignal, bootReadable = true, probeFails = false } = scenario;
  it.each([
    { stage: 0, elapsed: 0, signal: "SIGINT" },
    { stage: 1, elapsed: 31_000, signal: "SIGTERM" },
    { stage: 2, elapsed: 301_000, signal: "SIGKILL" }
  ])(
    "checks boot identity before $signal with a leaderless group",
    async ({ stage, elapsed, signal }) => {
      await fakeProc();
      const bootPath = path.join(procRoot, "sys/kernel/random/boot_id");
      if (!bootReadable) {
        await fs.remove(bootPath);
        await fs.ensureDir(bootPath); // EISDIR is reproducible even when tests run as root.
      }
      await fs.remove(path.join(procRoot, String(PGID)));
      const pid = PGID + 1;
      await fs.outputFile(
        path.join(procRoot, String(pid), "stat"),
        stat().replace(String(PGID), String(pid))
      );
      const deps = fakeDeps({
        groupState: (pgid, saved) =>
          inspectProcessGroup(pgid, saved, procRoot, () => {
            if (probeFails) throw Object.assign(new Error("Denied"), { code: "EPERM" });
            return true;
          }),
        readLeader: (pgid, dir) => readLeaderIdentity(pgid, dir, procRoot)
      });
      deps.procs = [listenerProc({ dir: fixture.dir, pid, pgid: PGID })];
      await writeRuntime(fixture.markerId, {
        v: 1,
        dir: fixture.dir,
        pgid: PGID,
        leaderIdentity: savedBoot ? { bootId: savedBoot, startTicks: "777" } : undefined,
        startedAt: 1,
        lastAttemptAt: 1,
        desired: "stopped",
        stopRequestedAt: deps.now(),
        stopStage: stage,
        failures: 0,
        lastError: ""
      });
      deps.advance(elapsed);
      const backend = createProcessSupervisor(deps);
      const advance = async () => {
        if (stage === 0) await backend.stop(fixture.dir, 0);
        else await backend.reconcileOne(fixture.dir, deps.procs);
      };
      await advance();
      expect(deps.signals).toEqual(maySignal ? [{ pid: -PGID, signal }] : []);
      expect((await readRuntime(fixture.markerId))?.stopStage).toBe(stage + (maySignal ? 1 : 0));
      if (!bootReadable && savedBoot) {
        await fs.remove(bootPath);
        await fs.writeFile(bootPath, bootId);
        await advance();
        expect(deps.signals).toEqual([{ pid: -PGID, signal }]);
        expect((await readRuntime(fixture.markerId))?.stopStage).toBe(stage + 1);
      }
    }
  );
});
