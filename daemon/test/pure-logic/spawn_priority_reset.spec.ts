import { spawn } from "child_process";
import os from "os";
import { beforeEach, describe, expect, it } from "vitest";
import { createProcessSupervisor, resetChildPriority } from "../../src/service/supervisor/process";
import { removeRuntime } from "../../src/service/supervisor/process/store";
import { fakeChild, fakeDeps, makeRunner } from "../helpers/process_fixture";

// The daemon's unit gives it Nice=-10 and OOMScoreAdjust=-800: it is the control plane, and it
// has to get scheduled and survive memory pressure on a node whose CPU is pinned by CI. Both are
// inherited by children, and under the process supervisor run.sh IS the daemon's child. Without a
// reset, every Runner.Listener and every job it runs would carry the control plane's priority
// and OOM immunity — the heaviest consumers on the machine outranking everything, and the
// processes most worth killing under memory pressure shielded from it.
//
// The effect of the reset itself (-10 → 0) cannot be reproduced here: an unprivileged test
// process cannot start a child at a negative nice. What is pinned is that every spawn is followed
// by the reset, which is the part a refactor of the spawn path could quietly drop.

const fixture = makeRunner("spawn-priority");

beforeEach(async () => {
  await removeRuntime(fixture.markerId);
});

describe("process supervisor resets a spawned runner's priority", () => {
  it("resets the pid it just spawned", async () => {
    const deps = fakeDeps();
    await createProcessSupervisor(deps).spawnOnce(fixture.dir);

    expect(deps.spawns).toHaveLength(1);
    expect(deps.priorityResets).toEqual([4242]);
  });

  it("does not try to reset a spawn that produced no process", async () => {
    // No pid means nothing started; there is nothing to reset and the failure path owns it.
    const deps = fakeDeps({ spawn: () => fakeChild(undefined) });
    await expect(createProcessSupervisor(deps).spawnOnce(fixture.dir)).rejects.toThrow();

    expect(deps.priorityResets).toEqual([]);
  });

  it("still counts the start as successful when the reset fails", async () => {
    // run.sh is already running by the time the reset happens. Failing the start over a
    // priority would record a failure, back off, and later spawn a second listener next to
    // the live one.
    const deps = fakeDeps({
      resetPriority: () => {
        throw new Error("EPERM");
      }
    });

    // The default implementation never throws, but the call site must not depend on that.
    await expect(createProcessSupervisor(deps).spawnOnce(fixture.dir)).resolves.toBeUndefined();
    expect(deps.spawns).toHaveLength(1);
  });
});

describe("resetChildPriority", () => {
  it("does not throw for a pid that is already gone", () => {
    // run.sh can exit between spawn returning and the reset. That must stay a log line: the
    // default implementation is called inline on the start path.
    expect(() => resetChildPriority(2 ** 22 + 12345)).not.toThrow();
  });

  it("leaves a live child at normal priority", async () => {
    const child = spawn("sleep", ["5"], { stdio: "ignore" });
    try {
      resetChildPriority(child.pid!);
      expect(os.getPriority(child.pid!)).toBe(0);
    } finally {
      child.kill();
    }
  });
});
