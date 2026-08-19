import fs from "fs-extra";
import path from "path";
import { describe, expect, it } from "vitest";
import { DAEMON_ROOT } from "../setup";

// A create that failed at the "install the unit" step used to leave a runner that existed on
// GitHub and nowhere else: the marker and the handle instance were both written after that step,
// and the managed list requires both. The runner was invisible in the panel and could only be
// recovered through the import dialog.
//
// The fix is ordering, and ordering is not something the type system can hold: both call sites
// still compile in either position, and the failure only shows up on a node where the step in
// between actually fails. Pin it textually, the same way the delete path pins which unit name it
// acts on.

const src = fs.readFileSync(path.join(DAEMON_ROOT, "src/service/runner_provision.ts"), "utf8");
const body = src.slice(
  src.indexOf("async function runProvision"),
  src.indexOf("export const RUNNER_SVC_HELPER")
);

const at = (needle: string): number => {
  const i = body.indexOf(needle);
  expect(i, `not found in runProvision: ${needle}`).toBeGreaterThan(-1);
  return i;
};

describe("adoption is recorded before anything can fail", () => {
  it("writes the marker and the handle instance before registering with GitHub", () => {
    // Both are needed for the runner to appear at all: the marker is the source of truth for
    // adoption, and managed runners are discovered by walking handle-instance working
    // directories. Moving only one of them would not make the runner visible.
    // Anchored on the invocation, not the string "config.sh": the extraction step checks for
    // that file by name well before this point.
    const register = at('run(path.join(targetDir, "config.sh")');
    expect(at("writeMarker(")).toBeLessThan(register);
    expect(at("ensureHandleInstance(")).toBeLessThan(register);
  });

  it("writes them before handing the runner to a supervisor", () => {
    // This is the step that failed on the container node — no sudo, so installing a unit threw.
    expect(at("writeMarker(")).toBeLessThan(at("backend.attach("));
    expect(at("ensureHandleInstance(")).toBeLessThan(at("backend.attach("));
  });

  it("records the supervision intent at that moment", () => {
    // Deciding it later, from node capability, would let a broken privileged helper flip an
    // existing runner to another backend and start a second listener beside the running unit.
    expect(body).toMatch(/writeMarker\([\s\S]{0,400}supervisor: nodeDefaultSupervisor\(\)/);
  });
});

describe("hosting goes through the backend", () => {
  it("does not install a unit directly any more", () => {
    // installSystemdService is still exported for the systemd backend to call; runProvision
    // itself must not, or a node without systemd is back to failing at step four.
    expect(body).not.toContain("installSystemdService(");
    expect(body).toContain("backend.attach(");
  });

  it("resolves the action target only after attaching", () => {
    // Under systemd the unit name does not exist until the helper has written .service.
    expect(at("backend.attach(")).toBeLessThan(at("backend.prepare?."));
  });

  it("writes the initial listener variables through the backend, then restarts", () => {
    // The proxy has to reach the listener process; .env only reaches jobs. And the listener is
    // already up by the time these land, so it needs a restart to pick them up.
    expect(at("writeListenerEnv(")).toBeLessThan(at("backend.restart("));
  });
});
