import { beforeEach, describe, expect, it } from "vitest";
import { createProcessSupervisor } from "../../src/service/supervisor/process";
import {
  readRuntime,
  removeRuntime,
  writeRuntime
} from "../../src/service/supervisor/process/store";
import { fakeDeps, listenerProc, makeRunner } from "../helpers/process_fixture";

// systemd gives a runner unit KillSignal=SIGTERM and TimeoutStopSec=5min for free. Moving hosting
// into the daemon means re-implementing that escalation, and only the first rung happens in the
// stop() call — the other two are driven by the reconcile tick, which is why the stage has to be
// on disk rather than in a timer.

const fixture = makeRunner("stop-ladder");
const PGID = 6100;

const running = {
  v: 1 as const,
  dir: fixture.dir,
  pgid: PGID,
  startedAt: 1000,
  lastAttemptAt: 1000,
  desired: "running" as const,
  stopRequestedAt: 0,
  stopStage: 0,
  failures: 0,
  lastError: ""
};

beforeEach(async () => {
  await removeRuntime(fixture.markerId);
  await writeRuntime(fixture.markerId, running);
});

describe("the three rungs", () => {
  it("escalates SIGINT → SIGTERM → SIGKILL as the deadlines pass", async () => {
    const deps = fakeDeps();
    deps.procs = [listenerProc({ dir: fixture.dir, pgid: PGID })];
    const backend = createProcessSupervisor(deps);

    // The first rung is SIGINT, not SIGTERM: the official runsvc.sh traps TERM and converts it to
    // INT anyway, and Runner.Listener treats INT as a graceful stop.
    await backend.stop(fixture.dir, 0);
    expect(deps.signals.map((s) => s.signal)).toEqual(["SIGINT"]);

    deps.advance(30_000);
    await backend.reconcileOne!(fixture.dir, deps.procs);
    expect(deps.signals.map((s) => s.signal)).toEqual(["SIGINT", "SIGTERM"]);

    deps.advance(270_000);
    await backend.reconcileOne!(fixture.dir, deps.procs);
    expect(deps.signals.map((s) => s.signal)).toEqual(["SIGINT", "SIGTERM", "SIGKILL"]);
  });

  it("does not resend a rung it already sent", async () => {
    // The tick is every 15s. Without a persisted stage, everything between 30s and 300s resends
    // SIGTERM about 18 times — and repeated interrupts have a "second one means kill" meaning for
    // some processes, quietly downgrading the graceful stop.
    const deps = fakeDeps();
    deps.procs = [listenerProc({ dir: fixture.dir, pgid: PGID })];
    const backend = createProcessSupervisor(deps);

    await backend.stop(fixture.dir, 0);
    deps.advance(31_000);
    await backend.reconcileOne!(fixture.dir, deps.procs);
    for (let i = 0; i < 5; i++) {
      deps.advance(15_000);
      await backend.reconcileOne!(fixture.dir, deps.procs);
    }
    expect(deps.signals.map((s) => s.signal)).toEqual(["SIGINT", "SIGTERM"]);
  });

  it("keeps the stage across a daemon restart", async () => {
    // The state is on disk precisely so a restart mid-ladder does not leave a listener that can
    // never be stopped.
    const deps = fakeDeps();
    deps.procs = [listenerProc({ dir: fixture.dir, pgid: PGID })];
    await createProcessSupervisor(deps).stop(fixture.dir, 0);
    expect((await readRuntime(fixture.markerId))?.stopStage).toBe(1);

    const afterRestart = createProcessSupervisor(fakeDeps());
    const deps2 = fakeDeps();
    deps2.procs = deps.procs;
    deps2.advance(31_000);
    await createProcessSupervisor(deps2).reconcileOne!(fixture.dir, deps2.procs);
    expect(deps2.signals.map((s) => s.signal)).toEqual(["SIGTERM"]);
    expect(afterRestart.kind).toBe("process");
  });
});

describe("stopping is a change of intent, not just a signal", () => {
  it("records that the runner should stay down", async () => {
    // systemctl stop cancels Restart=always. With hosting in userland, "do not start it again"
    // has to be written down, or the next tick puts the runner the user just stopped straight
    // back up.
    const deps = fakeDeps();
    deps.procs = [listenerProc({ dir: fixture.dir, pgid: PGID })];
    await createProcessSupervisor(deps).stop(fixture.dir, 0);
    expect((await readRuntime(fixture.markerId))?.desired).toBe("stopped");
  });

  it("stays down across ticks once the process is gone", async () => {
    const deps = fakeDeps();
    deps.procs = [listenerProc({ dir: fixture.dir, pgid: PGID })];
    const backend = createProcessSupervisor(deps);
    await backend.stop(fixture.dir, 0);

    deps.procs = []; // the listener exited
    for (let i = 0; i < 3; i++) {
      deps.advance(15_000);
      await backend.reconcileOne!(fixture.dir, deps.procs);
    }
    expect(deps.spawns).toHaveLength(0);
    const rt = await readRuntime(fixture.markerId);
    expect(rt?.desired).toBe("stopped");
    // The stop bookkeeping is cleared, but the intent is not — that distinction is the whole
    // point of the two fields.
    expect(rt?.stopRequestedAt).toBe(0);
    expect(rt?.stopStage).toBe(0);
  });

  it("a repeated stop does not rewind the ladder", async () => {
    const deps = fakeDeps();
    deps.procs = [listenerProc({ dir: fixture.dir, pgid: PGID })];
    const backend = createProcessSupervisor(deps);
    await backend.stop(fixture.dir, 0);
    deps.advance(40_000);
    await backend.stop(fixture.dir, 0); // impatient user clicks again

    // Rewinding stopStage to 0 here would mean SIGKILL is never reached, however long it hangs.
    expect(deps.signals.map((s) => s.signal)).toEqual(["SIGINT", "SIGTERM"]);
    expect((await readRuntime(fixture.markerId))?.stopStage).toBe(2);
  });
});

describe("the panel contract", () => {
  it("reports settled:false rather than hanging when the listener will not go", async () => {
    const deps = fakeDeps();
    deps.procs = [listenerProc({ dir: fixture.dir, pgid: PGID })];
    const outcome = await createProcessSupervisor(deps).stop(fixture.dir, 0);
    expect(outcome.settled).toBe(false);
    expect(outcome.runtime?.running).toBe(true);
    expect(outcome.dir).toBe(fixture.dir);
  });

  it("reports settled:true once nothing is left running", async () => {
    const deps = fakeDeps();
    deps.procs = [];
    const outcome = await createProcessSupervisor(deps).stop(fixture.dir, 0);
    expect(outcome.settled).toBe(true);
    expect(outcome.runtime?.state).toBe("stopped");
  });
});
