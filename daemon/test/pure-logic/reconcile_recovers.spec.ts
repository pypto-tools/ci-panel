import { beforeEach, describe, expect, it } from "vitest";
import { createProcessSupervisor } from "../../src/service/supervisor/process";
import {
  readRuntime,
  removeRuntime,
  writeRuntime,
  type RunnerRuntime
} from "../../src/service/supervisor/process/store";
import { fakeDeps, listenerProc, makeRunner } from "../helpers/process_fixture";

// "Restarting the daemon is acceptable, but after a restart every runner that should be running
// must come back" — this is the executable form of that requirement. Each link in the chain is on
// disk: which runners exist (handle instances + .cipanel), whether they should run (desired),
// whether to hold off (failures / lastAttemptAt), and what is running right now (/proc, which is
// never taken from disk).

const fixture = makeRunner("reconcile-recovers");

const rt = (over: Partial<RunnerRuntime> = {}): RunnerRuntime => ({
  v: 1,
  dir: fixture.dir,
  pgid: 0,
  startedAt: 0,
  lastAttemptAt: 0,
  desired: "running",
  stopRequestedAt: 0,
  stopStage: 0,
  failures: 0,
  lastError: "",
  ...over
});

beforeEach(async () => {
  await removeRuntime(fixture.markerId);
});

describe("bringing runners back", () => {
  it("respawns on the very first tick when it should be running and nothing is", async () => {
    await writeRuntime(fixture.markerId, rt());
    const deps = fakeDeps();
    await createProcessSupervisor(deps).reconcileOne!(fixture.dir, []);
    expect(deps.spawns).toHaveLength(1);
  });

  it("leaves a runner the user stopped alone", async () => {
    await writeRuntime(fixture.markerId, rt({ desired: "stopped" }));
    const deps = fakeDeps();
    await createProcessSupervisor(deps).reconcileOne!(fixture.dir, []);
    expect(deps.spawns).toHaveLength(0);
  });

  it("does not adopt a runner it never started", async () => {
    // No runtime file means the panel only ever imported this directory. Spawning here would be
    // the daemon claiming something it was never asked to supervise — the same reason detach
    // refuses to report success while a foreign listener is alive. The cost is that an imported
    // runner has to be started once from the panel before it joins automatic recovery.
    const deps = fakeDeps();
    await createProcessSupervisor(deps).reconcileOne!(fixture.dir, []);
    expect(deps.spawns).toHaveLength(0);
  });

  it("does nothing when something is already running there", async () => {
    // Whoever it belongs to: starting a second listener beside a live one is the failure this
    // whole framework exists to prevent.
    await writeRuntime(fixture.markerId, rt({ pgid: 777 }));
    const deps = fakeDeps();
    const procs = [listenerProc({ dir: fixture.dir, pgid: 777 })];
    await createProcessSupervisor(deps).reconcileOne!(fixture.dir, procs);
    expect(deps.spawns).toHaveLength(0);

    const foreign = [listenerProc({ dir: fixture.dir, pgid: 31245 })];
    await createProcessSupervisor(deps).reconcileOne!(fixture.dir, foreign);
    expect(deps.spawns).toHaveLength(0);
  });
});

describe("backing off instead of hammering", () => {
  it("waits out the backoff after a failure", async () => {
    await writeRuntime(fixture.markerId, rt({ failures: 3, lastAttemptAt: 1_700_000_000_000 }));
    const deps = fakeDeps();
    const backend = createProcessSupervisor(deps);

    deps.advance(15_000); // one tick later — 40s of backoff still to go
    await backend.reconcileOne!(fixture.dir, []);
    expect(deps.spawns).toHaveLength(0);

    deps.advance(30_000);
    await backend.reconcileOne!(fixture.dir, []);
    expect(deps.spawns).toHaveLength(1);
  });

  it("measures the backoff from the last attempt, not the last success", async () => {
    // A runner that has never started has no startedAt at all; measuring from it would mean no
    // backoff whatsoever for exactly the runner that is failing hardest.
    await writeRuntime(
      fixture.markerId,
      rt({ failures: 4, startedAt: 0, lastAttemptAt: 1_700_000_000_000 })
    );
    const deps = fakeDeps();
    deps.advance(20_000);
    await createProcessSupervisor(deps).reconcileOne!(fixture.dir, []);
    expect(deps.spawns).toHaveLength(0);
  });

  it("clears the failure count only after a run that lasted", async () => {
    // Clearing right after spawn would make the counter oscillate between 0 and 1 through a crash
    // loop, so the delay would never climb. Surviving the healthy window is what proves the start
    // actually worked.
    const started = 1_700_000_000_000;
    await writeRuntime(fixture.markerId, rt({ failures: 4, pgid: 777, startedAt: started }));
    const deps = fakeDeps();
    const procs = [listenerProc({ dir: fixture.dir, pgid: 777 })];

    deps.advance(30_000); // not long enough yet
    await createProcessSupervisor(deps).reconcileOne!(fixture.dir, procs);
    expect((await readRuntime(fixture.markerId))?.failures).toBe(4);

    deps.advance(90_000);
    await createProcessSupervisor(deps).reconcileOne!(fixture.dir, procs);
    const cleared = await readRuntime(fixture.markerId);
    expect(cleared?.failures).toBe(0);
    expect(cleared?.lastError).toBe("");
  });
});

describe("the tick does not wait for a runner to come up", () => {
  it("respawns without settling", async () => {
    // start() settles for up to 8 seconds. The tick is serial and non-reentrant, so N unstartable
    // runners would stretch the effective period to 8N seconds — and the stop ladder's 30s and
    // 5min rungs advance on that same period. Automatic restart would starve automatic stop.
    await writeRuntime(fixture.markerId, rt());
    const deps = fakeDeps({ settlePollMs: 10_000 });
    const before = Date.now();
    await createProcessSupervisor(deps).reconcileOne!(fixture.dir, []);
    expect(Date.now() - before).toBeLessThan(1000);
    expect(deps.spawns).toHaveLength(1);
  });
});
