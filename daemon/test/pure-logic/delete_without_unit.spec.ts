import { randomUUID } from "crypto";
import fs from "fs-extra";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteRunner } from "../../src/service/runner_scan";
import { createProcessSupervisor } from "../../src/service/supervisor/process";
import { removeRuntime, writeRuntime } from "../../src/service/supervisor/process/store";
import { fakeDeps, listenerProc, makeRunner } from "../helpers/process_fixture";

// A runner on a node with no systemd could never be deleted: runDelete called the privileged
// helper unconditionally, sudo is absent in a container, the ENOENT came back as a failed step,
// and the fail-closed rule then skipped the GitHub deregistration, the panel cleanup and the
// directory removal. Once such a runner was adopted, the panel could not get rid of it.
//
// The fix is not to relax the fail-closed rule — it is to stop treating "there was nothing to
// detach" as a failure. What still has to hold is the other half: nothing may be deleted while a
// listener is alive in that directory.

describe("deleting a runner that was never handed to systemd", () => {
  let fixture: ReturnType<typeof makeRunner>;

  beforeEach(() => {
    // randomUUID, not hrtime()[1]: that field is nanoseconds-within-the-second, and vitest runs
    // spec files in parallel workers under one scan root — two files can land on the same name.
    fixture = makeRunner(`delete-no-unit-${randomUUID().slice(0, 8)}`);
  });

  it("removes the directory instead of stopping at the first step", async () => {
    const result = await deleteRunner(fixture.dir);

    expect(result.ok).toBe(true);
    expect(fs.existsSync(fixture.dir)).toBe(false);
    const supervisorStep = result.steps.find((s) => s.key === "systemd");
    expect(supervisorStep?.status).toBe("ok");
    // The point of the bug: everything after step one used to be skipped.
    expect(result.steps.filter((s) => s.status === "skipped").map((s) => s.key)).not.toContain(
      "panel"
    );
    expect(result.steps.find((s) => s.key === "dir")?.status).toBe("ok");
  });

  it("still clears the panel-side adoption marker", async () => {
    await deleteRunner(fixture.dir);
    expect(fs.existsSync(path.join(fixture.dir, ".cipanel"))).toBe(false);
  });
});

describe("the fail-closed half is unchanged", () => {
  let fixture: ReturnType<typeof makeRunner>;

  // In afterEach rather than at the end of each test body: a failing expect above would skip the
  // cleanup and leak the directory into the next run, where makeRunner would reuse it.
  afterEach(async () => {
    if (fixture) await fs.remove(fixture.dir);
  });

  // deleteRunner reaches the real /proc, so the "a listener is alive" case is proven one level
  // down, on the backend call the delete path makes.
  it("refuses to detach while a listener is running in that directory", async () => {
    fixture = makeRunner("delete-live-listener");
    await removeRuntime(fixture.markerId);
    const deps = fakeDeps();
    deps.procs = [listenerProc({ dir: fixture.dir, pgid: 31245 })];

    const r = await createProcessSupervisor(deps).detach(fixture.dir);

    // "We have no record of supervising it" is not the same as "nothing is running there".
    // Both import paths leave no runtime file, so a hand-started listener that was then adopted
    // through the panel lands in exactly this state — and reporting ok here would let the delete
    // run to completion: GitHub refuses to remove an online runner, and fs.remove would pull
    // _work and _diag out from under a live process.
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });

  it("refuses when the live listener is not the process group we recorded", async () => {
    fixture = makeRunner("delete-stale-pgid");
    await writeRuntime(fixture.markerId, {
      v: 1,
      dir: fixture.dir,
      pgid: 4242, // recorded before a daemon restart; that group is long gone
      startedAt: 1000,
      lastAttemptAt: 1000,
      desired: "running",
      stopRequestedAt: 0,
      stopStage: 0,
      failures: 0,
      lastError: ""
    });
    const deps = fakeDeps();
    deps.procs = [listenerProc({ dir: fixture.dir, pgid: 9999 })];

    // Without this branch the stop ladder would send no signal at all (it owns nothing), then the
    // delete would wait out the full deadline and report a timeout with no hint of what to do.
    const r = await createProcessSupervisor(deps).detach(fixture.dir);
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });
});
