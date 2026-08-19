import fs from "fs-extra";
import path from "path";
import { describe, expect, it } from "vitest";
import { DAEMON_ROOT } from "../setup";
import { withRunnerLock } from "../../src/service/runner_lock";

// Deleting a runner has to wait for its unit to actually stop before the directory goes away.
// Who does the waiting matters:
//
//   the helper's blocking `disable --now` — bounded by the unit's TimeoutStopSec=5min, while the
//   daemon only gives the call HELPER_TIMEOUT_MS. A Listener that ignores SIGTERM therefore times
//   out by construction, and an execFile timeout is indistinguishable from a sudo refusal.
//
//   the daemon itself — helper stop is `--no-block`, so it polls `systemctl show` against its own
//   deadline and gets a definite settled/not-settled answer either way.
//
// The second is what runDelete does now. The trap in writing it is the lock.

describe("the lock is not re-entrant, which is why the delete path cannot re-enter it", () => {
  // runDelete already holds the runner's svc: key. Anything that takes that same key on the way in
  // would block the delete on itself — and because withRunnerLock fails fast rather than queueing,
  // the failure is immediate and looks like a user error ("正在删除中"). That is why every backend
  // method is lock-free and the framework takes the locks.
  //
  // Assert the property rather than the workaround: if the lock ever gained re-entrancy or a
  // queue, the comment in stopBeforeUninstall would be stale and this case would say so.

  it("taking a held key from inside the holder throws instead of waiting", async () => {
    const key = "svc:actions.runner.example.re-entry.service";
    await expect(
      withRunnerLock([key], "delete", async () =>
        withRunnerLock([key], "service", async () => "should never get here")
      )
    ).rejects.toThrow(/正在删除中/);
  });

  it("names the contended target so a batch shows which one was blocked", async () => {
    await expect(
      withRunnerLock(["dir:/srv/runners/r1"], "provision", async () =>
        withRunnerLock(["dir:/srv/runners/r1"], "delete", async () => "no")
      )
    ).rejects.toThrow(/^\/srv\/runners\/r1 正在置备中/);
  });

  it("releases on the way out, including when the body throws", async () => {
    const key = "dir:/srv/runners/r2";
    await expect(
      withRunnerLock([key], "delete", async () => {
        throw new Error("body blew up");
      })
    ).rejects.toThrow("body blew up");
    // Still takeable — a leaked hold here would wedge this runner until the daemon restarts.
    await expect(withRunnerLock([key], "service", async () => "free")).resolves.toBe("free");
  });
});

describe("the systemd backend stops before it uninstalls, and acts on the name it locked", () => {
  // These assertions moved with the code: stopping, uninstalling and the settle deadlines now live
  // in the systemd backend. What they assert is unchanged — only where they read it from.
  //
  // Nothing in the type system distinguishes "the unit name we locked" from "whatever .service
  // says right now" — both are strings. Swapping one for the other type-checks cleanly and only
  // misbehaves at runtime, on a path that needs a real systemd to exercise. Pin it textually.
  const src = fs.readFileSync(path.join(DAEMON_ROOT, "src/service/supervisor/systemd.ts"), "utf8");
  const stopFn = src.match(/export async function stopBeforeUninstall[\s\S]*?\n}\n/)?.[0];
  // The action path: the three control actions all funnel through `act`, and detach is the one
  // the delete path calls. Both must take the unit name from the prepared target.
  const actFn = src.match(/const act = async[\s\S]*?\n  };\n/)?.[0];
  const detachFn = src.match(/async detach\([\s\S]*?\n    },\n/)?.[0];

  it("stopBeforeUninstall exists and is what detach gates the uninstall on", () => {
    expect(stopFn, "stopBeforeUninstall not found in supervisor/systemd.ts").toBeTruthy();
    // Anchored loosely on purpose: what must hold is "the stop result decides whether uninstall
    // runs at all", not the exact spelling of the early return. A reflow should not redden it.
    expect(detachFn, "detach not found in supervisor/systemd.ts").toBeTruthy();
    expect(detachFn).toMatch(
      /stopBeforeUninstall\(service\)[\s\S]{0,300}uninstallSystemdService\(dir\)/
    );
  });

  it("acts on the unit prepare() resolved, not on whatever .service says by then", () => {
    // .service is writable by the runner's own owner. Re-reading it on the action path would let
    // the file change between the read that chose the lock key and the read that chooses what to
    // stop — we would stop an unlocked unit while the locked one keeps running, and then delete
    // the directory out from under it. The validated name has to be handed down instead, which is
    // what prepare() → SupervisorTarget.ctx is for.
    //
    // prepare() and observe() are deliberately exempt: prepare IS that single read, and a stale
    // name in observe costs at most one under-reported instance for one round. The action path is
    // the irreversible one.
    expect(actFn, "act not found in supervisor/systemd.ts").toBeTruthy();
    expect(actFn).not.toContain("readServiceName");
    expect(detachFn).not.toContain("readServiceName");
    // ...and it is not merely absent: the name is actually taken from the prepared target.
    expect(actFn).toContain("requireUnit(t");
    expect(detachFn).toContain("unitOf(t)");
  });

  it("the backend takes no locks of its own", () => {
    // Every backend method runs inside a lock the framework already holds (controlRunner,
    // deleteRunner, provisionRunner, writeRunnerEnv, the reconcile tick). withRunnerLock is not
    // re-entrant and fails fast, so a lock taken in here would block the caller on itself and
    // surface as a bogus "正在删除中". This is the stronger form of the older assertion that the
    // delete path must call the inside-the-lock half rather than the public entry point.
    // Matches a call, not a mention: the file's header comment explains why it holds no locks,
    // and that sentence is worth keeping.
    expect(src).not.toMatch(/withRunnerLock\(/);
  });

  it("it waits longer than the button-press path does", () => {
    // 8s is tuned for "clicking start/stop should feel responsive, the status poll will converge".
    // A delete that gives up has to be redone from the top, so it earns more patience.
    const settle = Number(src.match(/^const SETTLE_TIMEOUT_MS = (\d+);$/m)?.[1]);
    const del = Number(src.match(/^export const DELETE_SETTLE_MS = (\d+);$/m)?.[1]);
    expect(settle).toBeGreaterThan(0);
    expect(del).toBeGreaterThan(settle);
    // ...but still well under the unit's own TimeoutStopSec=5min: the point is to reach a verdict,
    // not to outlast systemd.
    expect(del).toBeLessThan(5 * 60 * 1000);
  });
});
