import { describe, expect, it } from "vitest";
import { assertActionAllowed } from "../../src/service/supervisor/resolve";
import type { RunnerOwnership, SupervisorAction } from "mcsmanager-common";

// The full matrix of "may the panel do this to this runner right now". It is one function on
// purpose: the frontend renders the same rules as disabled buttons, and two copies of a rule
// drift into a UI that offers an action the daemon then refuses.

const ACTIONS: SupervisorAction[] = ["start", "stop", "restart"];
const allowed = (action: SupervisorAction, ownership: RunnerOwnership): boolean => {
  try {
    assertActionAllowed(action, ownership, "systemd");
    return true;
  } catch {
    return false;
  }
};

describe("assertActionAllowed", () => {
  it("lets the panel drive a runner it supervises, except starting it twice", () => {
    expect(allowed("start", "self")).toBe(false); // already running
    expect(allowed("stop", "self")).toBe(true);
    expect(allowed("restart", "self")).toBe(true);
  });

  it("allows everything when the directory is idle", () => {
    // stop on an idle runner is idempotent, restart is just a start.
    for (const action of ACTIONS) expect(allowed(action, "idle"), action).toBe(true);
  });

  it("refuses to touch a process nobody claimed", () => {
    // Starting would make a second listener; stopping would kill a process we do not know how to
    // stop safely (and did not start).
    for (const action of ACTIONS) expect(allowed(action, "foreign"), action).toBe(false);
  });

  it("refuses everything while there is a conflict", () => {
    for (const action of ACTIONS) expect(allowed(action, "conflict"), action).toBe(false);
  });

  describe("when the observation was incomplete", () => {
    it("refuses start and restart", () => {
      // Both can claim the GitHub identity, and restart contains a start. Acting on "we could not
      // tell what is running" is how a node ends up with two listeners.
      expect(allowed("start", "unknown")).toBe(false);
      expect(allowed("restart", "unknown")).toBe(false);
    });

    it("still allows stop", () => {
      // Purely convergent: the worst case is one redundant signal, which cannot create a second
      // supervisor. Refusing it would leave the user with no way out of a bad state.
      expect(allowed("stop", "unknown")).toBe(true);
    });
  });

  it("refuses every action on a node that supervises nothing", () => {
    // The none backend observes but never acts, whatever the ownership says.
    for (const action of ACTIONS) {
      for (const ownership of ["idle", "self", "foreign", "conflict", "unknown"] as const) {
        expect(() => assertActionAllowed(action, ownership, "none")).toThrow();
      }
    }
  });
});
