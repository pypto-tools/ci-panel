import { describe, expect, it } from "vitest";
import { backoffFor, resolveStartArgv } from "../../src/service/supervisor/process";

// CIP_RUNNER_START is an escape hatch read only from the daemon's own environment — never from
// .cipanel and never from an API. The threat model is "panel session → arbitrary execution on a
// node", and whoever can set this variable already has a shell there.
//
// A malformed value must not take the node down: refusing to start the daemon over a typo in an
// optional knob is worse than running the default and saying so loudly.

describe("resolveStartArgv", () => {
  it("defaults to the runner's own launcher", () => {
    expect(resolveStartArgv(undefined).argv).toEqual(["./run.sh"]);
    expect(resolveStartArgv("").argv).toEqual(["./run.sh"]);
    expect(resolveStartArgv("   ").argv).toEqual(["./run.sh"]);
  });

  it("accepts a JSON string array", () => {
    expect(resolveStartArgv('["./run.sh", "--once"]')).toEqual({ argv: ["./run.sh", "--once"] });
    // A wrapper is allowed as long as it execs in place; the array form is what keeps this out of
    // a shell.
    expect(resolveStartArgv('["/usr/bin/setsid", "./run.sh"]').argv).toEqual([
      "/usr/bin/setsid",
      "./run.sh"
    ]);
  });

  it("falls back with a warning on anything malformed", () => {
    for (const raw of ["./run.sh", "{}", "[]", "[1,2]", '["", "x"]', '["ok", 3]', "null"]) {
      const r = resolveStartArgv(raw);
      expect(r.argv, raw).toEqual(["./run.sh"]);
      expect(r.warning, raw).toBeTruthy();
    }
  });
});

describe("backoffFor", () => {
  it("does not delay the first attempt", () => {
    expect(backoffFor(0)).toBe(0);
  });

  it("doubles and then caps at the unit's own stop timeout", () => {
    // Aligned with RestartSec=10 at the bottom and 5 minutes at the top: a runner that cannot
    // start must not respawn every tick and fill the disk with logs.
    expect(backoffFor(1)).toBe(10_000);
    expect(backoffFor(2)).toBe(20_000);
    expect(backoffFor(5)).toBe(160_000);
    expect(backoffFor(9)).toBe(300_000);
    expect(backoffFor(50)).toBe(300_000);
  });

  it("starts letting ticks pass from the second failure onward", () => {
    // The tick is 15s, so the first backoff (10s, matching RestartSec) is effectively "retry on
    // the next tick" — which is what you want for a one-off failure. What must hold is that a
    // runner which keeps failing stops being retried every tick: from the second failure the
    // delay covers more than one tick, and it keeps growing from there.
    expect(backoffFor(1)).toBeLessThan(15_000);
    expect(backoffFor(2)).toBeGreaterThan(15_000);
    expect(backoffFor(3)).toBeGreaterThan(backoffFor(2));
  });
});
