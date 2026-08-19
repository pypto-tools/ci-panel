import { beforeEach, describe, expect, it } from "vitest";
import { createProcessSupervisor } from "../../src/service/supervisor/process";
import { owns } from "../../src/service/supervisor/process/observe";
import { removeRuntime, writeRuntime } from "../../src/service/supervisor/process/store";
import { fakeDeps, listenerProc, makeRunner } from "../helpers/process_fixture";

// The panel can now make the daemon send signals. Everything that keeps that from becoming an
// arbitrary-kill channel is the ownership check below: the recorded process group has to match
// AND the process has to be running out of this runner's directory. SIGKILL is not reversible,
// so the check is repeated before every rung of the ladder rather than once at the entrance —
// the ladder spans five minutes, and a process group can exit and be recycled inside it.

const fixture = makeRunner("signal-owner");

const base = {
  v: 1 as const,
  dir: fixture.dir,
  pgid: 5150,
  startedAt: 1000,
  lastAttemptAt: 1000,
  desired: "stopped" as const,
  stopRequestedAt: 1000,
  stopStage: 0,
  failures: 0,
  lastError: ""
};

beforeEach(async () => {
  await removeRuntime(fixture.markerId);
});

describe("owns()", () => {
  const rt = { ...base };

  it("needs both the process group and the directory", () => {
    expect(owns(rt, listenerProc({ dir: fixture.dir, pgid: 5150 }))).toBe(true);
    // Same group id, different runner: pids and pgids get recycled, and the directory is what
    // says which runner this actually is.
    expect(owns(rt, listenerProc({ dir: "/srv/runners/other", pgid: 5150 }))).toBe(false);
    // Right directory, but not the group we started: somebody launched this one by hand.
    expect(owns(rt, listenerProc({ dir: fixture.dir, pgid: 9999 }))).toBe(false);
  });

  it("owns nothing when no process group was ever recorded", () => {
    expect(owns({ ...rt, pgid: 0 }, listenerProc({ dir: fixture.dir, pgid: 0 }))).toBe(false);
    expect(owns(null, listenerProc({ dir: fixture.dir, pgid: 5150 }))).toBe(false);
  });
});

describe("stop() only signals what it owns", () => {
  it("sends nothing when the live process is in another directory", async () => {
    await writeRuntime(fixture.markerId, { ...base, stopRequestedAt: 0 });
    const deps = fakeDeps();
    deps.procs = [listenerProc({ dir: "/srv/runners/other", pgid: 5150 })];
    await createProcessSupervisor(deps).stop(fixture.dir, 0);
    expect(deps.signals).toEqual([]);
  });

  it("sends nothing when the live process is not in our process group", async () => {
    await writeRuntime(fixture.markerId, { ...base, stopRequestedAt: 0 });
    const deps = fakeDeps();
    deps.procs = [listenerProc({ dir: fixture.dir, pgid: 9999 })];
    await createProcessSupervisor(deps).stop(fixture.dir, 0);
    expect(deps.signals).toEqual([]);
  });

  it("signals the whole group, not just the leader", async () => {
    // run.sh forks Runner.Listener, which forks Runner.Worker. A signal to the leader alone
    // leaves the grandchildren running.
    await writeRuntime(fixture.markerId, { ...base, stopRequestedAt: 0 });
    const deps = fakeDeps();
    deps.procs = [listenerProc({ dir: fixture.dir, pgid: 5150 })];
    await createProcessSupervisor(deps).stop(fixture.dir, 0);
    expect(deps.signals).toEqual([{ pid: -5150, signal: "SIGINT" }]);
  });
});

describe("the ladder re-proves ownership before each rung", () => {
  it("stops signalling once the group is gone, even mid-ladder", async () => {
    await writeRuntime(fixture.markerId, { ...base, stopRequestedAt: 0 });
    const deps = fakeDeps();
    deps.procs = [listenerProc({ dir: fixture.dir, pgid: 5150 })];
    const backend = createProcessSupervisor(deps);

    await backend.stop(fixture.dir, 0); // rung 1: SIGINT
    expect(deps.signals).toHaveLength(1);

    // The listener exits; the pid is recycled by an unrelated process in another directory.
    deps.procs = [listenerProc({ dir: "/srv/runners/unrelated", pgid: 5150 })];
    deps.advance(31_000);
    await backend.reconcileOne!(fixture.dir, deps.procs);
    deps.advance(300_000);
    await backend.reconcileOne!(fixture.dir, deps.procs);

    // Still exactly the one signal from before: no SIGTERM and, above all, no SIGKILL into
    // whatever now holds that group id.
    expect(deps.signals).toEqual([{ pid: -5150, signal: "SIGINT" }]);
  });
});
