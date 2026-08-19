import { beforeEach, describe, expect, it } from "vitest";
import { createProcessSupervisor } from "../../src/service/supervisor/process";
import {
  removeRuntime,
  writeRuntime,
  type RunnerRuntime
} from "../../src/service/supervisor/process/store";
import { ownershipOf } from "../../src/service/supervisor/ownership";
import { fakeDeps, listenerProc, makeRunner } from "../helpers/process_fixture";

// observe has to report every live listener in the directory, including ones this backend did not
// start. A backend that only reports its own work can never detect double supervision — and that
// is the case worth catching.

const fixture = makeRunner("process-observe");
const PGID = 9100;

const rt = (over: Partial<RunnerRuntime> = {}): RunnerRuntime => ({
  v: 1,
  dir: fixture.dir,
  pgid: PGID,
  startedAt: 1_700_000_000_000,
  lastAttemptAt: 1_700_000_000_000,
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

const observe = async (procs: ReturnType<typeof listenerProc>[]) =>
  (await createProcessSupervisor(fakeDeps()).observe([fixture.dir], procs)).get(fixture.dir)!;

describe("what observe reports", () => {
  it("claims the process it started", async () => {
    await writeRuntime(fixture.markerId, rt());
    const obs = await observe([listenerProc({ dir: fixture.dir, pgid: PGID, pid: 9101 })]);
    expect(obs.instances).toHaveLength(1);
    expect(obs.instances[0].by).toBe("process");
    expect(ownershipOf("process", obs.instances)).toBe("self");
  });

  it("reports a listener somebody else started, without claiming it", async () => {
    await writeRuntime(fixture.markerId, rt());
    const obs = await observe([listenerProc({ dir: fixture.dir, pgid: 31245, pid: 31245 })]);
    expect(obs.instances[0].by).toBeUndefined();
    expect(ownershipOf("process", obs.instances)).toBe("foreign");
  });

  it("identifies instances by listener pid, so other backends can dedupe against it", async () => {
    // The none backend observes the same /proc on every node. If this backend used its own
    // identifier, one listener would be counted twice and read as a permanent conflict.
    await writeRuntime(fixture.markerId, rt());
    const obs = await observe([listenerProc({ dir: fixture.dir, pgid: PGID, pid: 9101 })]);
    expect(obs.instances[0].id).toBe("9101");
    // The backend's own identifiers are display-only.
    expect(obs.instances[0].raw).toEqual({ pid: "9101", pgid: String(PGID) });
  });

  it("carries busy through, because stopping a busy runner interrupts CI", async () => {
    await writeRuntime(fixture.markerId, rt());
    const obs = await observe([listenerProc({ dir: fixture.dir, pgid: PGID, busy: true })]);
    expect(obs.instances[0].busy).toBe(true);
  });

  it("explains itself when there is nothing running", async () => {
    // No instances is exactly when "why will it not start" matters, and it is the only place the
    // reason can come from.
    await writeRuntime(fixture.markerId, rt({ failures: 3, lastError: "spawn ./run.sh ENOENT" }));
    const obs = await observe([]);
    expect(obs.instances).toEqual([]);
    expect(obs.detail).toBe("spawn ./run.sh ENOENT");
  });

  it("still reports a directory it has no record of", async () => {
    // Imported but never started from the panel: no runtime file, but the listener is real and
    // the list must show it.
    const obs = await observe([listenerProc({ dir: fixture.dir, pgid: 4242 })]);
    expect(obs.instances).toHaveLength(1);
    expect(obs.instances[0].by).toBeUndefined();
  });
});
