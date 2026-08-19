import { describe, expect, it } from "vitest";
import { legacyManagedBy, legacySystemdState } from "../../src/service/supervisor/legacy";
import type { RunnerRuntimeState } from "mcsmanager-common";

// Nodes and the panel machine are upgraded separately — install.sh takes --role and there is no
// version handshake — so a new daemon will report to an old panel. The old panel reads
// `systemd` and `managedBy`; when they are absent it silently falls back to judging by the handle
// instance, which never runs. The whole node then reads as "all stopped / unmanaged / no controls",
// with no error anywhere. These two helpers are what keeps that window survivable.

const rt = (over: Partial<RunnerRuntimeState> = {}): RunnerRuntimeState => ({
  supervisor: "systemd",
  ownership: "self",
  running: true,
  state: "running",
  detail: "",
  since: "Mon 2026-08-17 10:00:00 UTC",
  busy: false,
  raw: {
    service: "actions.runner.org-repo.runner-1.service",
    activeState: "active",
    subState: "running",
    unitFileState: "enabled"
  },
  ...over
});

describe("legacySystemdState", () => {
  it("rebuilds the shape an old panel parses", () => {
    expect(legacySystemdState(rt())).toEqual({
      service: "actions.runner.org-repo.runner-1.service",
      loaded: true,
      activeState: "active",
      subState: "running",
      enabled: "enabled",
      since: "Mon 2026-08-17 10:00:00 UTC"
    });
  });

  it("is null when the backend has no unit to report", () => {
    // Only systemd nodes can be rescued this way, and that is the accepted limit: other hosting
    // methods are new in this release, so no old panel knows about them anyway.
    expect(legacySystemdState(rt({ raw: { pid: "31245", pgid: "31245" } }))).toBeNull();
    expect(legacySystemdState(null)).toBeNull();
  });
});

describe("legacyManagedBy", () => {
  it("maps our own supervision to the value an old panel calls systemd", () => {
    expect(legacyManagedBy(rt())).toBe("systemd");
  });

  it("maps a conflict to both, which is what the old conflict banner keys on", () => {
    expect(legacyManagedBy(rt({ ownership: "conflict" }))).toBe("both");
  });

  it("maps everything else to none", () => {
    for (const ownership of ["idle", "foreign", "unknown"] as const)
      expect(legacyManagedBy(rt({ ownership })), ownership).toBe("none");
    expect(legacyManagedBy(null)).toBe("none");
  });
});
