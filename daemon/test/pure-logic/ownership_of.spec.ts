import { describe, expect, it } from "vitest";
import { ownershipOf } from "../../src/service/supervisor/ownership";
import type { ObservedInstance } from "../../src/service/supervisor/types";

// ownershipOf is the executable definition of "only one supervisor at a time". Every guard in the
// framework — start/stop/restart, the reconcile loop, the conflict banner — reads its output, and
// none of them re-derive it. It also knows no backend, which is the property that has to survive:
// adding a hosting method must not require touching this matrix.

const inst = (over: Partial<ObservedInstance> = {}): ObservedInstance => ({
  id: "1",
  state: "running",
  since: "",
  busy: false,
  ...over
});

describe("ownershipOf", () => {
  it("reads nothing running as idle", () => {
    expect(ownershipOf("systemd", [])).toBe("idle");
  });

  it("reads the declared backend's own instance as self", () => {
    expect(ownershipOf("systemd", [inst({ by: "systemd" })])).toBe("self");
  });

  it("reads an unclaimed process as foreign, not as idle", () => {
    // Somebody started a listener by hand. It is really running, so the panel must not offer to
    // start a second one — but it is also not ours to stop.
    expect(ownershipOf("systemd", [inst()])).toBe("foreign");
  });

  it("reads an instance claimed by a different backend as conflict", () => {
    // Intent says systemd, something else is actually running it. That is the drift a broken
    // privileged helper produces, and it is exactly as dangerous as two listeners.
    expect(ownershipOf("none", [inst({ by: "systemd" })])).toBe("conflict");
  });

  it("reads two instances in one directory as conflict", () => {
    expect(ownershipOf("systemd", [inst({ id: "1", by: "systemd" }), inst({ id: "2" })])).toBe(
      "conflict"
    );
  });

  it("reads one instance claimed by two backends as conflict", () => {
    // Deduplication by pid must not swallow this: it is one process, but two supervisors each
    // believe they own it, so whichever one acts will surprise the other.
    expect(ownershipOf("systemd", [inst({ by: "systemd", disputed: true })])).toBe("conflict");
  });

  describe("an incomplete observation", () => {
    it("answers unknown rather than idle when it saw nothing", () => {
      // This is the whole reason "unknown" exists. idle is the one value that lets a start
      // through, so collapsing a failed scan into it turns one systemctl timeout into two
      // listeners fighting over the same GitHub identity.
      expect(ownershipOf("systemd", [], false)).toBe("unknown");
    });

    it("still answers from what it did see", () => {
      // One backend failing does not make another backend's sighting less true.
      expect(ownershipOf("systemd", [inst({ by: "systemd" })], false)).toBe("self");
      expect(ownershipOf("systemd", [inst()], false)).toBe("foreign");
    });
  });

  it("ignores the instance state, counting only that something is alive", () => {
    // A unit can be `failed` while its listener is still running — systemd reports the unit, not
    // the process tree. Filtering by state here would read that as idle and let a start through.
    // "Only report what is alive" is enforced on the observe side instead.
    expect(ownershipOf("systemd", [inst({ by: "systemd", state: "failed" })])).toBe("self");
    expect(ownershipOf("systemd", [inst({ state: "stopping" })])).toBe("foreign");
  });
});
