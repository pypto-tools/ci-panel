import { beforeAll, describe, expect, it } from "vitest";
import { initI18n } from "@/lang/i18n";
import type { RunnerOwnership, SupervisorAction, SupervisorKind } from "mcsmanager-common";
import {
  canControl,
  kindLabel,
  ownershipHint,
  ownershipTag,
  serviceOf,
  shouldWarnConflict,
  type RunnerControlSubject
} from "../supervisor";

// The daemon refuses actions it must not perform; this module decides whether the button is even
// clickable. Both are needed — with only the daemon's, the user finds out by clicking; with only
// this one, the rule is decoration. What matters is that they agree, so the matrix below is the
// same one daemon/test/pure-logic/action_gate.spec.ts asserts.

// `let i18n` in src/lang/i18n.ts is assigned only by initI18n, and every refusal here goes
// through t() — without this they throw instead of returning a reason.
beforeAll(async () => {
  await initI18n("en_us");
});

const subject = (over: Partial<RunnerControlSubject> = {}): RunnerControlSubject => ({
  dir: "/srv/runners/r1",
  managed: true,
  supervisor: "process",
  runtime: {
    supervisor: "process",
    ownership: "idle",
    running: false,
    state: "stopped",
    detail: "",
    since: "",
    busy: false
  },
  ...over
});

const withOwnership = (ownership: RunnerOwnership): RunnerControlSubject =>
  subject({ runtime: { ...subject().runtime!, ownership } });

const ACTIONS: SupervisorAction[] = ["start", "stop", "restart"];

describe("canControl mirrors the daemon's gate", () => {
  it("allows everything on an idle runner", () => {
    for (const a of ACTIONS) expect(canControl(withOwnership("idle"), a).ok, a).toBe(true);
  });

  it("allows stop and restart but not a second start on one we supervise", () => {
    expect(canControl(withOwnership("self"), "start").ok).toBe(false);
    expect(canControl(withOwnership("self"), "stop").ok).toBe(true);
    expect(canControl(withOwnership("self"), "restart").ok).toBe(true);
  });

  it("refuses everything on a process nobody claimed", () => {
    for (const a of ACTIONS) expect(canControl(withOwnership("foreign"), a).ok, a).toBe(false);
  });

  it("refuses everything while there is a conflict", () => {
    for (const a of ACTIONS) expect(canControl(withOwnership("conflict"), a).ok, a).toBe(false);
  });

  it("allows only stop when the node could not tell what is running", () => {
    expect(canControl(withOwnership("unknown"), "start").ok).toBe(false);
    expect(canControl(withOwnership("unknown"), "restart").ok).toBe(false);
    expect(canControl(withOwnership("unknown"), "stop").ok).toBe(true);
  });

  it("treats a missing runtime as unknown, not as idle", () => {
    // An un-upgraded node sends no runtime. Defaulting to idle would enable Start on a runner
    // that may well be running — idle is the one value that lets a start through.
    const old = subject({ runtime: null });
    expect(canControl(old, "start").ok).toBe(false);
    expect(canControl(old, "stop").ok).toBe(true);
  });

  it("refuses anything on a runner the panel does not manage", () => {
    // The read-only detail page accepts unmanaged directories inside the scan roots, so without
    // this a hand-typed URL could drive start/stop on a runner nobody adopted.
    for (const a of ACTIONS) expect(canControl(subject({ managed: false }), a).ok, a).toBe(false);
  });

  it("refuses anything on a node that supervises nothing", () => {
    for (const a of ACTIONS)
      expect(canControl(subject({ supervisor: "none" }), a).ok, a).toBe(false);
  });

  it("always explains a refusal", () => {
    // The reason is what the tooltip shows; a disabled button with no explanation is worse than
    // an error message.
    for (const ownership of ["foreign", "conflict", "unknown"] as const)
      for (const a of ACTIONS) {
        const check = canControl(withOwnership(ownership), a);
        if (!check.ok) expect(check.reason, `${ownership}/${a}`).toBeTruthy();
      }
  });
});

describe("the label tables cover the unions", () => {
  it("has a label for every supervisor kind", () => {
    // Exhaustive by type: adding a hosting method reddens this object, and the table it indexes.
    const KINDS: Record<SupervisorKind, true> = { systemd: true, process: true, none: true };
    for (const kind of Object.keys(KINDS) as SupervisorKind[])
      expect(kindLabel(kind), kind).toBeTruthy();
  });

  it("has a tag for every ownership value", () => {
    const OWNERSHIP: Record<RunnerOwnership, true> = {
      self: true,
      idle: true,
      foreign: true,
      conflict: true,
      unknown: true
    };
    for (const ownership of Object.keys(OWNERSHIP) as RunnerOwnership[]) {
      const tag = ownershipTag(withOwnership(ownership));
      expect(tag.label, ownership).toBeTruthy();
      expect(tag.color, ownership).toBeTruthy();
    }
  });

  it("falls back to a label rather than rendering nothing", () => {
    expect(kindLabel(undefined)).toBeTruthy();
    expect(ownershipTag(subject({ runtime: null })).label).toBeTruthy();
  });
});

describe("shouldWarnConflict", () => {
  it("warns about a conflict anywhere", () => {
    expect(shouldWarnConflict(withOwnership("conflict"))).toBe(true);
  });

  it("warns about an unclaimed process on a node that does supervise", () => {
    expect(shouldWarnConflict(withOwnership("foreign"))).toBe(true);
  });

  it("stays quiet about an unclaimed process on a node that supervises nothing", () => {
    // There, something else running the runner is the normal arrangement, not a fault. Expressed
    // as a predicate rather than a special case inside the rendering.
    const external = subject({
      supervisor: "none",
      runtime: { ...subject().runtime!, ownership: "foreign" }
    });
    expect(shouldWarnConflict(external)).toBe(false);
  });

  it("stays quiet about the ordinary states", () => {
    for (const ownership of ["self", "idle"] as const)
      expect(shouldWarnConflict(withOwnership(ownership)), ownership).toBe(false);
  });
});

describe("what the row shows", () => {
  it("passes the backend's own explanation through when there is nothing to warn about", () => {
    const r = subject({ runtime: { ...subject().runtime!, detail: "unit entered failed" } });
    expect(ownershipHint(r)).toBe("unit entered failed");
  });

  it("reads the unit name out of raw, which is display-only", () => {
    const r = subject({
      runtime: { ...subject().runtime!, raw: { service: "actions.runner.x.service" } }
    });
    expect(serviceOf(r)).toBe("actions.runner.x.service");
    expect(serviceOf(subject())).toBe("");
  });
});
