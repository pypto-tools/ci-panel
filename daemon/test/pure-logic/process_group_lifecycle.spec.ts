import { beforeEach, describe, expect, it } from "vitest";
import { createProcessSupervisor } from "../../src/service/supervisor/process";
import {
  readRuntime,
  writeRuntime,
  type RunnerRuntime
} from "../../src/service/supervisor/process/store";
import { fakeDeps, listenerProc, makeRunner } from "../helpers/process_fixture";

const fixture = makeRunner("group-lifecycle");
const PGID = 8100;
const identity = { bootId: "test-boot", startTicks: "123456" };
const runtime = (over: Partial<RunnerRuntime> = {}): RunnerRuntime => ({
  v: 1,
  dir: fixture.dir,
  pgid: PGID,
  startedAt: 1000,
  lastAttemptAt: 1000,
  desired: "running",
  stopRequestedAt: 0,
  stopStage: 0,
  failures: 0,
  lastError: "",
  ...over
});

function liveGroup() {
  const deps = fakeDeps({ groupState: () => "present", readLeader: async () => identity });
  return deps;
}

beforeEach(async () => {
  await writeRuntime(fixture.markerId, runtime());
});

describe("a live group between listeners", () => {
  it("does not restart beside the wrapper after SIGINT removes the listener", async () => {
    const deps = liveGroup();
    deps.procs = [listenerProc({ dir: fixture.dir, pgid: PGID })];
    deps.kill = (pid, signal) => {
      deps.signals.push({ pid, signal });
      deps.procs = [];
    };
    const outcome = await createProcessSupervisor(deps).restart(fixture.dir);
    expect(deps.spawns).toHaveLength(0);
    expect(outcome.settled).toBe(false);
    expect((await readRuntime(fixture.markerId))?.pgid).toBe(PGID);
  });

  it("retains the group and stopping state when a legacy record has no listener", async () => {
    const deps = liveGroup();
    await writeRuntime(fixture.markerId, runtime({ stopRequestedAt: deps.now(), stopStage: 1 }));
    deps.advance(31_000);
    await createProcessSupervisor(deps).reconcileOne!(fixture.dir, []);
    expect(await readRuntime(fixture.markerId)).toMatchObject({
      pgid: PGID,
      stopStage: 1,
      desired: "running"
    });
    expect((await readRuntime(fixture.markerId))?.stopRequestedAt).not.toBe(0);
    expect(deps.signals).toEqual([]);
  });

  it("does not automatically respawn beside a live wrapper", async () => {
    const deps = liveGroup();
    await createProcessSupervisor(deps).reconcileOne!(fixture.dir, []);
    expect(deps.spawns).toHaveLength(0);
  });

  it("does not report stop complete in a retry window", async () => {
    const outcome = await createProcessSupervisor(liveGroup()).stop(fixture.dir, 0);
    expect(outcome.settled).toBe(false);
    expect((await readRuntime(fixture.markerId))?.pgid).toBe(PGID);
  });

  it("does not detach or remove runtime while the group survives", async () => {
    const deps = liveGroup();
    deps.scan = async () => {
      deps.advance(60_001);
      return [];
    };
    const outcome = await createProcessSupervisor(deps).detach(fixture.dir);
    expect(outcome.ok).toBe(false);
    expect((await readRuntime(fixture.markerId))?.pgid).toBe(PGID);
  });

  it("does not erase the previous group before attach checks it", async () => {
    const deps = liveGroup();
    await expect(createProcessSupervisor(deps).attach(fixture.dir)).rejects.toThrow();
    expect(deps.spawns).toHaveLength(0);
    expect((await readRuntime(fixture.markerId))?.pgid).toBe(PGID);
  });

  it("blocks an explicit start when the group cannot be inspected", async () => {
    const deps = fakeDeps({ groupState: () => "unknown" });
    await expect(createProcessSupervisor(deps).start(fixture.dir)).rejects.toThrow();
    expect(deps.spawns).toHaveLength(0);
    expect((await readRuntime(fixture.markerId))?.pgid).toBe(PGID);
  });

  it("resumes escalation without a listener using the persisted leader identity", async () => {
    const deps = liveGroup();
    await writeRuntime(
      fixture.markerId,
      runtime({ leaderIdentity: identity, stopRequestedAt: deps.now(), stopStage: 1 })
    );
    deps.advance(31_000);
    await createProcessSupervisor(deps).reconcileOne!(fixture.dir, []);
    expect(deps.signals).toEqual([{ pid: -PGID, signal: "SIGTERM" }]);
    expect((await readRuntime(fixture.markerId))?.stopStage).toBe(2);
  });

  it("never signals a recycled group leader or consumes a stop stage", async () => {
    const deps = fakeDeps({
      groupState: () => "present",
      readLeader: async () => ({ ...identity, startTicks: "999999" })
    });
    await writeRuntime(fixture.markerId, runtime({ leaderIdentity: identity }));
    await createProcessSupervisor(deps).stop(fixture.dir, 0);
    expect(deps.signals).toEqual([]);
    expect(await readRuntime(fixture.markerId)).toMatchObject({ pgid: PGID, stopStage: 0 });
  });

  it.each([
    { signal: "SIGINT", stage: 0, elapsed: 0 },
    { signal: "SIGTERM", stage: 1, elapsed: 31_000 },
    { signal: "SIGKILL", stage: 2, elapsed: 301_000 }
  ])(
    "does not send $signal when the group is replaced during leader inspection",
    async ({ stage, elapsed }) => {
      const deps = liveGroup();
      deps.procs = [listenerProc({ dir: fixture.dir, pgid: PGID })];
      deps.readLeader = async () => {
        deps.procs = [listenerProc({ dir: `${fixture.dir}-replacement`, pgid: PGID })];
        return undefined;
      };
      await writeRuntime(
        fixture.markerId,
        runtime({ leaderIdentity: identity, stopRequestedAt: deps.now(), stopStage: stage })
      );
      deps.advance(elapsed);
      await createProcessSupervisor(deps).reconcileOne!(fixture.dir, deps.procs);
      expect(deps.signals).toEqual([]);
      expect((await readRuntime(fixture.markerId))?.stopStage).toBe(stage);
    }
  );

  it("uses fresh owned listener evidence when leader identity is unavailable", async () => {
    const deps = fakeDeps({ groupState: () => "present", readLeader: async () => undefined });
    deps.procs = [listenerProc({ dir: fixture.dir, pgid: PGID })];
    await writeRuntime(
      fixture.markerId,
      runtime({ leaderIdentity: identity, stopRequestedAt: deps.now(), stopStage: 2 })
    );
    deps.advance(301_000);
    await createProcessSupervisor(deps).reconcileOne!(fixture.dir, deps.procs);
    expect(deps.signals).toEqual([{ pid: -PGID, signal: "SIGKILL" }]);
    expect((await readRuntime(fixture.markerId))?.stopStage).toBe(3);
  });

  it("retries a signal that was denied instead of consuming its rung", async () => {
    const deps = liveGroup();
    deps.procs = [listenerProc({ dir: fixture.dir, pgid: PGID })];
    deps.kill = () => {
      throw Object.assign(new Error("Denied"), { code: "EPERM" });
    };
    await createProcessSupervisor(deps).stop(fixture.dir, 0);
    expect((await readRuntime(fixture.markerId))?.stopStage).toBe(0);
  });

  it("keeps a spawned group recorded even when identity inspection fails", async () => {
    await writeRuntime(fixture.markerId, runtime({ pgid: 0 }));
    const deps = fakeDeps({
      readLeader: async () => {
        throw new Error("EACCES");
      }
    });
    await createProcessSupervisor(deps).spawnOnce(fixture.dir);
    expect((await readRuntime(fixture.markerId))?.pgid).toBe(4242);
    expect((await readRuntime(fixture.markerId))?.leaderIdentity).toBeUndefined();
  });

  it("does not clear a group whose existence is unknown", async () => {
    const deps = fakeDeps({ groupState: () => "unknown" });
    const outcome = await createProcessSupervisor(deps).stop(fixture.dir, 0);
    expect(outcome.settled).toBe(false);
    expect(await readRuntime(fixture.markerId)).toMatchObject({ pgid: PGID, stopStage: 0 });
    expect(deps.signals).toEqual([]);
  });

  it("checks fresh listener ownership before escalating a stale snapshot", async () => {
    const deps = liveGroup();
    const stale = [listenerProc({ dir: fixture.dir, pgid: PGID })];
    await writeRuntime(fixture.markerId, runtime({ stopRequestedAt: deps.now(), stopStage: 1 }));
    deps.advance(31_000);
    await createProcessSupervisor(deps).reconcileOne!(fixture.dir, stale);
    expect(deps.signals).toEqual([]);
    expect((await readRuntime(fixture.markerId))?.stopStage).toBe(1);
  });

  it("passes persisted identity to recovery checks after a host reboot", async () => {
    const seen: unknown[] = [];
    const deps = fakeDeps({
      groupState: (_pgid, saved) => {
        seen.push(saved);
        return saved?.bootId === identity.bootId ? "absent" : "present";
      }
    });
    await writeRuntime(fixture.markerId, runtime({ leaderIdentity: identity }));
    await createProcessSupervisor(deps).reconcileOne!(fixture.dir, []);
    expect(seen).toEqual([identity, identity]);
    expect(deps.spawns).toHaveLength(1);
  });

  it("persists a delivered rung when the next ownership scan fails", async () => {
    const deps = liveGroup();
    let scans = 0;
    deps.scan = async () => {
      if (++scans === 2) throw new Error("Proc temporarily unavailable");
      return [listenerProc({ dir: fixture.dir, pgid: PGID })];
    };
    await writeRuntime(fixture.markerId, runtime({ stopRequestedAt: deps.now() }));
    deps.advance(31_000);
    const backend = createProcessSupervisor(deps);
    await expect(backend.reconcileOne!(fixture.dir, [])).rejects.toThrow(
      "Proc temporarily unavailable"
    );
    expect((await readRuntime(fixture.markerId))?.stopStage).toBe(1);
    await backend.reconcileOne!(fixture.dir, []);
    expect(deps.signals).toEqual([
      { pid: -PGID, signal: "SIGINT" },
      { pid: -PGID, signal: "SIGTERM" }
    ]);
    expect((await readRuntime(fixture.markerId))?.stopStage).toBe(2);
  });

  it("keeps repeated restarts on the same ladder and starts once after group exit", async () => {
    let alive = true;
    const deps = fakeDeps({
      groupState: () => (alive ? "present" : "absent"),
      readLeader: async () => identity
    });
    await writeRuntime(fixture.markerId, runtime({ leaderIdentity: identity }));
    const backend = createProcessSupervisor(deps);
    await backend.restart(fixture.dir);
    const requestedAt = (await readRuntime(fixture.markerId))?.stopRequestedAt;
    deps.advance(1000);
    await backend.restart(fixture.dir);
    expect((await readRuntime(fixture.markerId))?.stopRequestedAt).toBe(requestedAt);
    expect(deps.signals).toEqual([{ pid: -PGID, signal: "SIGINT" }]);
    expect(deps.spawns).toHaveLength(0);
    alive = false;
    await backend.reconcileOne!(fixture.dir, []);
    await backend.reconcileOne!(fixture.dir, []);
    deps.procs = [listenerProc({ dir: fixture.dir, pgid: 4242 })];
    await backend.reconcileOne!(fixture.dir, deps.procs);
    expect(deps.spawns).toHaveLength(1);
    expect((await readRuntime(fixture.markerId))?.desired).toBe("running");
  });
});
