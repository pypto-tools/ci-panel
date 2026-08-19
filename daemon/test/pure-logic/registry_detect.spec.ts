import { afterEach, describe, expect, it } from "vitest";
import {
  __resetNodeCapabilitiesForTest,
  nodeCapabilities,
  nodeDefaultSupervisor,
  registeredKinds
} from "../../src/service/supervisor/registry";
import type { SupervisorKind } from "mcsmanager-common";

// The registry is the single line a new hosting method adds, and the enforcement behind that
// claim is a Record keyed by SupervisorKind: add a member, the table stops compiling. What the
// type cannot check is that anything ever walks the table — an entry could exist and never be
// reachable, which does not crash, it just makes the new backend dead code while the node quietly
// falls back to its default. That is the case below.

afterEach(() => {
  delete process.env.CIP_RUNNER_SUPERVISOR;
  __resetNodeCapabilitiesForTest();
});

describe("the registry covers the protocol", () => {
  it("registers every SupervisorKind", () => {
    // This object is exhaustive by type, so adding a member to the union reddens it here too —
    // deliberately, because the person adding a backend should see both halves at once.
    const EVERY_KIND: Record<SupervisorKind, true> = { systemd: true, none: true };
    expect(registeredKinds().sort()).toEqual(Object.keys(EVERY_KIND).sort());
  });

  it("reports each kind with a reason when it is unavailable", () => {
    // The reason travels with the node info so the panel can explain why a node cannot use
    // systemd, instead of showing an unexplained missing capability.
    for (const c of nodeCapabilities()) {
      expect(registeredKinds()).toContain(c.kind);
      if (!c.available) expect(c.reason, c.kind).not.toBe("");
    }
  });
});

describe("choosing the node default", () => {
  // The suite pins CIP_RUNNER_SVC_HELPER at a path that does not exist (see test/setup.ts), so
  // the privileged helper preflight fails and the systemd backend reports itself unavailable —
  // which is exactly the container-node shape this framework exists for.
  it("falls back to the always-available backend when the others are out", () => {
    expect(nodeCapabilities().find((c) => c.kind === "systemd")?.available).toBe(false);
    expect(nodeDefaultSupervisor()).toBe("none");
  });

  it("ignores CIP_RUNNER_SUPERVISOR when that backend is not available here", () => {
    // Honouring it would pick a backend that cannot act at all. Falling back and saying so in the
    // log beats a node that accepts every request and fails each one.
    process.env.CIP_RUNNER_SUPERVISOR = "systemd";
    __resetNodeCapabilitiesForTest();
    expect(nodeDefaultSupervisor()).toBe("none");
  });

  it("ignores a value that is not a registered kind", () => {
    process.env.CIP_RUNNER_SUPERVISOR = "docker";
    __resetNodeCapabilitiesForTest();
    expect(nodeDefaultSupervisor()).toBe("none");
  });

  it("marks exactly one kind as the default", () => {
    expect(nodeCapabilities().filter((c) => c.isDefault)).toHaveLength(1);
  });
});
