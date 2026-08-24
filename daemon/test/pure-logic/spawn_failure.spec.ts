import fs from "fs-extra";
import { beforeEach, describe, expect, it } from "vitest";
import { createProcessSupervisor } from "../../src/service/supervisor/process";
import {
  readRuntime,
  removeRuntime,
  runLogPath,
  writeRuntime
} from "../../src/service/supervisor/process/store";
import { fakeChild, fakeDeps, listenerProc, makeRunner } from "../helpers/process_fixture";

// Node does not throw when a spawn fails: it returns a ChildProcess with an undefined pid and
// reports the error on the next tick as an 'error' event. Without a listener that becomes an
// uncaughtException, which app.ts swallows into a log line — so a create would report success
// while nothing is running.

const fixture = makeRunner("spawn-failure");

beforeEach(async () => {
  await removeRuntime(fixture.markerId);
});

const flush = () => new Promise((r) => setTimeout(r, 5));

describe("a spawn that never produced a process", () => {
  it("throws instead of reporting success", async () => {
    const deps = fakeDeps({ spawn: () => fakeChild(undefined) });
    await expect(createProcessSupervisor(deps).spawnOnce(fixture.dir)).rejects.toThrow();
  });

  it("counts the failure exactly once, not once per signal path", async () => {
    // 'error' and the missing-pid fallback both fire when the command does not exist. Counting
    // both moves the whole backoff curve one step along on every attempt.
    const child = fakeChild(undefined);
    const deps = fakeDeps({ spawn: () => child });
    await createProcessSupervisor(deps)
      .spawnOnce(fixture.dir)
      .catch(() => undefined);
    child.emit("error", new Error("spawn ./run.sh ENOENT"));
    await flush();
    expect((await readRuntime(fixture.markerId))?.failures).toBe(1);
  });

  it("records why, so the panel can show it", async () => {
    const child = fakeChild(undefined);
    const deps = fakeDeps({ spawn: () => child });
    await createProcessSupervisor(deps)
      .spawnOnce(fixture.dir)
      .catch(() => undefined);
    await flush();
    const rt = await readRuntime(fixture.markerId);
    expect(rt?.lastError).toBeTruthy();
    // Never a half-written record: a missing pgid key would make owns() false forever, so the UI
    // would read idle, stop would send nothing, and the tick would respawn every 15 seconds.
    expect(rt?.pgid).toBe(0);
    expect(typeof rt?.pgid).toBe("number");
  });
});

describe("a run.sh that exits on its own", () => {
  it("counts an exit code of 0 as a failure when it did not survive long", async () => {
    // The official run.sh exits 0 on several paths (listener removed from GitHub, a stray
    // --once, its own "exit 0, no retry" branch). Judging by exit code alone leaves failures at
    // zero, so the backoff never engages and the tick respawns forever with an empty detail.
    const child = fakeChild(4242);
    const deps = fakeDeps({ spawn: () => child });
    await createProcessSupervisor(deps).spawnOnce(fixture.dir);
    child.emit("exit", 0, null);
    await flush();
    const rt = await readRuntime(fixture.markerId);
    expect(rt?.failures).toBe(1);
    expect(rt?.lastError).toContain("过早退出");
  });

  it("says what run.sh printed on its way out", async () => {
    // `code=0 sig=null` is the same sentence for every one of those exit paths, so on its own it
    // tells a user nothing. The reason is in the runner's own output — on a root container it is
    // literally "Must not run interactively with sudo" — and the detail shown in the panel comes
    // from lastError, so that is where the tail has to land.
    const child = fakeChild(4242);
    const deps = fakeDeps({ spawn: () => child });
    await createProcessSupervisor(deps).spawnOnce(fixture.dir);
    fs.appendFileSync(
      runLogPath(fixture.markerId),
      "√ Connected to GitHub\n\nMust not run interactively with sudo\nExiting runner...\n\n"
    );
    child.emit("exit", 0, null);
    await flush();
    const rt = await readRuntime(fixture.markerId);
    expect(rt?.lastError).toContain("Must not run interactively with sudo");
    // Blank trailing lines are what a real exit leaves behind; keeping them would push the one
    // sentence that matters out of a length-capped field.
    expect(rt?.lastError).toContain("Exiting runner...");
  });

  it("does not count an exit after a long healthy run", async () => {
    const child = fakeChild(4242);
    const deps = fakeDeps({ spawn: () => child });
    await createProcessSupervisor(deps).spawnOnce(fixture.dir);
    deps.advance(10 * 60_000);
    child.emit("exit", 0, null);
    await flush();
    expect((await readRuntime(fixture.markerId))?.failures).toBe(0);
  });

  it("does not count an exit the user asked for", async () => {
    const child = fakeChild(4242);
    const deps = fakeDeps({ spawn: () => child });
    const backend = createProcessSupervisor(deps);
    await backend.spawnOnce(fixture.dir);
    deps.procs = [listenerProc({ dir: fixture.dir, pgid: 4242 })];
    await backend.stop(fixture.dir, 0);
    child.emit("exit", 0, "SIGINT");
    await flush();
    // lastError is shown to a human; writing "it stopped" there as a fault is misleading.
    expect((await readRuntime(fixture.markerId))?.failures).toBe(0);
  });

  it("keeps the process group on an exit, because the listener may still be alive", async () => {
    // run.sh can die while Runner.Listener keeps running — that is the entire reason ownership is
    // tracked by process group. Clearing the pgid here would turn a live listener into "foreign"
    // and lock the user out of stopping it.
    const child = fakeChild(4242);
    const deps = fakeDeps({ spawn: () => child });
    await createProcessSupervisor(deps).spawnOnce(fixture.dir);
    child.emit("exit", 1, null);
    await flush();
    expect((await readRuntime(fixture.markerId))?.pgid).toBe(4242);
  });
});

describe("a spawn that throws synchronously", () => {
  it("still records the failure, so the backoff engages", async () => {
    // Most spawn failures surface as an 'error' event, but some throw on the spot (EACCES on the
    // resolved binary, an option Node rejects outright). If that path skips recordFailure,
    // failures stays at 0 for a runner that never started, backoffFor(0) returns 0, and the
    // reconcile tick respawns every 15 seconds — rotating a run log on each pass.
    const deps = fakeDeps({
      spawn: () => {
        throw new Error("EACCES: permission denied");
      }
    });
    await createProcessSupervisor(deps)
      .spawnOnce(fixture.dir)
      .catch(() => undefined);
    const rt = await readRuntime(fixture.markerId);
    expect(rt?.failures).toBe(1);
    expect(rt?.lastError).toContain("EACCES");
    // A process that never existed owns no group; leaving a stale pgid would read as "running".
    expect(rt?.pgid).toBe(0);
  });

  it("propagates the original error rather than swallowing it", async () => {
    const deps = fakeDeps({
      spawn: () => {
        throw new Error("EACCES: permission denied");
      }
    });
    await expect(createProcessSupervisor(deps).spawnOnce(fixture.dir)).rejects.toThrow(/EACCES/);
  });
});

describe("starting twice", () => {
  it("refuses when a listener is already running in that directory", async () => {
    // The ownership gate ran earlier in controlRunner, but there is an await between there and
    // here, and attach comes in without passing that gate at all. Claiming a GitHub identity is
    // not reversible, so it is proven once more at the last moment.
    await writeRuntime(fixture.markerId, {
      v: 1,
      dir: fixture.dir,
      pgid: 0,
      startedAt: 0,
      lastAttemptAt: 0,
      desired: "running",
      stopRequestedAt: 0,
      stopStage: 0,
      failures: 0,
      lastError: ""
    });
    const deps = fakeDeps();
    deps.procs = [listenerProc({ dir: fixture.dir, pgid: 999 })];
    await expect(createProcessSupervisor(deps).spawnOnce(fixture.dir)).rejects.toThrow();
    expect(deps.spawns).toHaveLength(0);
  });
});

describe("intent is written before the process is launched", () => {
  it("leaves desired=running even when the spawn fails", async () => {
    // Otherwise: stop, then start, then a failed spawn — desired is still "stopped", the tick
    // returns immediately, and the backoff retry never reaches this runner even though the user
    // pressed start.
    const child = fakeChild(undefined);
    const deps = fakeDeps({ spawn: () => child });
    await createProcessSupervisor(deps)
      .spawnOnce(fixture.dir)
      .catch(() => undefined);
    await flush();
    expect((await readRuntime(fixture.markerId))?.desired).toBe("running");
  });
});
