import { beforeEach, describe, expect, it } from "vitest";
import { createProcessSupervisor } from "../../src/service/supervisor/process";
import {
  readRuntime,
  removeRuntime,
  writeRuntime,
  type RunnerRuntime
} from "../../src/service/supervisor/process/store";
import { fakeDeps, listenerProc, makeRunner } from "../helpers/process_fixture";

const fixture = makeRunner("group-recovery");
const runtime: RunnerRuntime = {
  v: 1,
  dir: fixture.dir,
  pgid: 5150,
  startedAt: 1000,
  lastAttemptAt: 1000,
  desired: "running",
  stopRequestedAt: 0,
  stopStage: 0,
  failures: 0,
  lastError: ""
};

beforeEach(async () => {
  await removeRuntime(fixture.markerId);
  await writeRuntime(fixture.markerId, runtime);
});

describe("preserving the runner process group", () => {
  it("does not overwrite ownership when a repeated attach is refused", async () => {
    const deps = fakeDeps();
    deps.procs = [listenerProc({ dir: fixture.dir, pgid: runtime.pgid })];
    await expect(createProcessSupervisor(deps).attach(fixture.dir)).rejects.toThrow();
    expect(await readRuntime(fixture.markerId)).toEqual(runtime);
    expect(deps.spawns).toEqual([]);
  });

  it("does not respawn between listener generations while run.sh is alive", async () => {
    const deps = { ...fakeDeps(), groupExists: () => true };
    await createProcessSupervisor(deps).reconcileOne!(fixture.dir, []);
    expect(deps.spawns).toEqual([]);
    expect(await readRuntime(fixture.markerId)).toEqual(runtime);
  });

  it("refuses an explicit start while the recorded group is still alive", async () => {
    const deps = { ...fakeDeps(), groupExists: () => true };
    await expect(createProcessSupervisor(deps).spawnOnce(fixture.dir)).rejects.toThrow();
    expect(deps.spawns).toEqual([]);
    expect(await readRuntime(fixture.markerId)).toEqual(runtime);
  });
});

describe("stopping between listener generations", () => {
  it("preserves the group and reports unsettled until the launcher exits", async () => {
    const deps = fakeDeps({ groupExists: () => true });
    const backend = createProcessSupervisor(deps);
    expect((await backend.stop(fixture.dir, 0)).settled).toBe(false);
    expect((await readRuntime(fixture.markerId))?.pgid).toBe(runtime.pgid);
    expect((await readRuntime(fixture.markerId))?.desired).toBe("stopped");
    expect(deps.signals).toEqual([]);
  });
});
