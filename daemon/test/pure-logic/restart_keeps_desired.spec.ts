import { beforeEach, describe, expect, it } from "vitest";
import { createProcessSupervisor } from "../../src/service/supervisor/process";
import {
  readRuntime,
  removeRuntime,
  writeRuntime,
  type RunnerRuntime
} from "../../src/service/supervisor/process/store";
import { fakeDeps, listenerProc, makeRunner } from "../helpers/process_fixture";

const fixture = makeRunner("restart-desired");
const PGID = 8100;

const rt = (over: Partial<RunnerRuntime> = {}): RunnerRuntime => ({
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

beforeEach(async () => {
  await removeRuntime(fixture.markerId);
  await writeRuntime(fixture.markerId, rt());
});

describe("restart", () => {
  it("never records the intent to stay stopped", async () => {
    // A restart implemented as stop-then-start flips desired to "stopped" for an instant. If the
    // daemon is killed in that instant, the next boot reads "stopped" and never brings the runner
    // back: the user asked for a restart and got a permanent stop.
    const deps = fakeDeps();
    deps.procs = [listenerProc({ dir: fixture.dir, pgid: PGID })];
    const backend = createProcessSupervisor(deps);

    // The listener goes away as soon as it has been signalled.
    deps.scan = async () => {
      const now = deps.procs;
      deps.procs = [];
      return now;
    };
    const seen: string[] = [];
    const watch = setInterval(() => {
      void readRuntime(fixture.markerId).then((r) => r && seen.push(r.desired));
    }, 1);
    await backend.restart(fixture.dir);
    clearInterval(watch);

    expect(seen).not.toContain("stopped");
    expect((await readRuntime(fixture.markerId))?.desired).toBe("running");
  });

  it("signals the running listener before starting a new one", async () => {
    const deps = fakeDeps();
    deps.procs = [listenerProc({ dir: fixture.dir, pgid: PGID })];
    deps.scan = async () => {
      const now = deps.procs;
      deps.procs = [];
      return now;
    };
    await createProcessSupervisor(deps).restart(fixture.dir);
    expect(deps.signals.map((s) => s.signal)).toEqual(["SIGINT"]);
    expect(deps.spawns).toHaveLength(1);
  });

  it("does not start a second listener when the old one will not go", async () => {
    // Starting anyway is precisely how two listeners end up fighting over one GitHub identity.
    const deps = fakeDeps();
    deps.procs = [listenerProc({ dir: fixture.dir, pgid: PGID })];
    const outcome = await createProcessSupervisor(deps).restart(fixture.dir);
    expect(outcome.settled).toBe(false);
    expect(deps.spawns).toHaveLength(0);
  });

  it("does not rewind a stop that is already in progress", async () => {
    // Clicking restart while the ladder is climbing must not reset it to rung one, or SIGKILL is
    // never reached.
    await writeRuntime(fixture.markerId, rt({ stopRequestedAt: 1_700_000_000_000, stopStage: 1 }));
    const deps = fakeDeps();
    deps.procs = [listenerProc({ dir: fixture.dir, pgid: PGID })];
    deps.advance(31_000);
    await createProcessSupervisor(deps).restart(fixture.dir);
    expect(deps.signals.map((s) => s.signal)).toEqual(["SIGTERM"]);
  });
});
