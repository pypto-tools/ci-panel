import { beforeEach, describe, expect, it } from "vitest";
import { createProcessSupervisor } from "../../src/service/supervisor/process";
import {
  readRuntime,
  removeRuntime,
  writeRuntime,
  type RunnerRuntime
} from "../../src/service/supervisor/process/store";
import { fakeDeps, listenerProc, makeRunner } from "../helpers/process_fixture";

const fixture = makeRunner("reclaim");
const rt: RunnerRuntime = {
  v: 1,
  dir: fixture.dir,
  pgid: 5150,
  startedAt: 1000,
  lastAttemptAt: 1000,
  desired: "running",
  stopRequestedAt: 0,
  stopStage: 0,
  failures: 2,
  lastError: "old failure"
};
const listener = listenerProc({ dir: fixture.dir, pid: 9201, pgid: 9200, busy: true });

beforeEach(async () => {
  await removeRuntime(fixture.markerId);
  await writeRuntime(fixture.markerId, rt);
});

function setup() {
  const deps = fakeDeps();
  deps.procs = [listener];
  const backend = createProcessSupervisor(deps);
  return { deps, backend, reclaim: () => backend.reclaim!(fixture.dir, String(listener.pid)) };
}

describe("explicit recovery of stale process ownership", () => {
  it("restores a busy runner without signalling or spawning and survives daemon recreation", async () => {
    const { deps, reclaim } = setup();
    const state = await reclaim();
    expect(state.ownership).toBe("self");
    expect(state.busy).toBe(true);
    expect(state.since).toBe(""); // Recovery time is not process start time.
    expect(deps.signals).toEqual([]);
    expect(deps.spawns).toEqual([]);
    expect(await readRuntime(fixture.markerId)).toEqual({
      ...rt,
      pgid: 9200,
      startedAt: 0,
      failures: 0,
      lastError: ""
    });
    const restarted = createProcessSupervisor(deps);
    await restarted.reconcileOne!(fixture.dir, deps.procs);
    expect(deps.spawns).toEqual([]);
    await restarted.stop(fixture.dir, 0);
    expect(deps.signals).toEqual([{ pid: -9200, signal: "SIGINT" }]);
  });

  it.each([true, false])(
    "replaces stale leader identity during reclaim (available=%s)",
    async (available) => {
      const oldIdentity = { bootId: "old-boot", startTicks: "100" };
      const newIdentity = available ? { bootId: "current-boot", startTicks: "200" } : undefined;
      await writeRuntime(fixture.markerId, { ...rt, leaderIdentity: oldIdentity });
      const deps = fakeDeps({ readLeader: async () => newIdentity });
      deps.procs = [listener];
      const backend = createProcessSupervisor(deps);
      await backend.reclaim!(fixture.dir, String(listener.pid));
      const saved = await readRuntime(fixture.markerId);
      expect(saved?.pgid).toBe(listener.pgid);
      expect(saved?.leaderIdentity).toEqual(newIdentity);
      expect(deps.signals).toEqual([]);
      expect(deps.spawns).toEqual([]);
      await backend.stop(fixture.dir, 0);
      expect(deps.signals).toEqual([{ pid: -listener.pgid, signal: "SIGINT" }]);
    }
  );

  it.each(["missing", "other-directory", "stopped", "stopping", "no-pgid"])(
    "rejects a %s runtime record",
    async (mode) => {
      if (mode === "missing") await removeRuntime(fixture.markerId);
      else
        await writeRuntime(fixture.markerId, {
          ...rt,
          ...(mode === "other-directory" ? { dir: fixture.dir + "-other" } : {}),
          ...(mode === "stopped" ? { desired: "stopped" as const } : {}),
          ...(mode === "stopping" ? { stopRequestedAt: 1000 } : {}),
          ...(mode === "no-pgid" ? { pgid: 0 } : {})
        });
      const before = await readRuntime(fixture.markerId);
      const { deps, reclaim } = setup();
      await expect(reclaim()).rejects.toThrow();
      expect(await readRuntime(fixture.markerId)).toEqual(before);
      expect(deps.signals).toEqual([]);
      expect(deps.spawns).toEqual([]);
    }
  );

  it.each([
    "live-old-group",
    "not-dedicated",
    "multiple",
    "shared-group",
    "vanished",
    "replaced",
    "not-observed"
  ])("refuses %s without rewriting ownership", async (mode) => {
    const deps = fakeDeps({
      groupState: () => (mode === "live-old-group" ? "present" : "absent"),
      verifyGroup: async () => mode !== "not-dedicated"
    });
    deps.procs = [listener];
    if (mode === "multiple") deps.procs.push({ ...listener, pid: 9202 });
    if (mode === "shared-group")
      deps.procs.push({ ...listener, dir: fixture.dir + "-other", pid: 9202 });
    let scans = 0;
    if (mode === "vanished" || mode === "replaced")
      deps.scan = async () => {
        if (++scans === 1) return [listener];
        return mode === "vanished" ? [] : [{ ...listener, pid: 9202 }];
      };
    await expect(
      createProcessSupervisor(deps).reclaim!(
        fixture.dir,
        mode === "not-observed" ? "9300" : String(listener.pid)
      )
    ).rejects.toThrow();
    expect(await readRuntime(fixture.markerId)).toEqual(rt);
    expect(deps.signals).toEqual([]);
    expect(deps.spawns).toEqual([]);
  });

  it("does not override a stop requested during verification", async () => {
    const deps = fakeDeps({
      verifyGroup: async () => {
        await writeRuntime(fixture.markerId, { ...rt, desired: "stopped" });
        return true;
      }
    });
    deps.procs = [listener];
    await expect(
      createProcessSupervisor(deps).reclaim!(fixture.dir, String(listener.pid))
    ).rejects.toThrow();
    expect(await readRuntime(fixture.markerId)).toEqual({ ...rt, desired: "stopped" });
  });
});
