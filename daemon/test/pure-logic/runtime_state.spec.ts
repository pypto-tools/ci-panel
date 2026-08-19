import { describe, expect, it } from "vitest";
import { toRuntimeState } from "../../src/service/supervisor/ownership";
import type { ObservedInstance } from "../../src/service/supervisor/types";

// toRuntimeState collapses N observed instances into the single row the panel renders. Each of
// the four collapse rules below is a decision that reads as arbitrary until it is wrong in
// production, so they are pinned rather than left to the implementation.

const inst = (over: Partial<ObservedInstance> = {}): ObservedInstance => ({
  id: "1",
  state: "running",
  since: "",
  busy: false,
  ...over
});

describe("toRuntimeState", () => {
  it("counts a foreign process as running", () => {
    // "Is it online" and "do we manage it" are different questions. A hand-started listener is
    // picking up jobs, and a panel that shows it as stopped is lying about the CI capacity.
    const rt = toRuntimeState("systemd", { instances: [inst()] }, true);
    expect(rt.ownership).toBe("foreign");
    expect(rt.running).toBe(true);
  });

  it("is not running when nothing is alive", () => {
    expect(toRuntimeState("systemd", { instances: [] }, true).running).toBe(false);
  });

  it("counts a conflicted directory as running", () => {
    // conflict is the one ownership that *requires* live instances — two listeners in one
    // directory, or two backends claiming the same one. Reporting it as offline while `state`
    // says "running" told the panel two contradictory things about the same row, and the count
    // of online runners silently dropped the case that most needs looking at.
    const rt = toRuntimeState(
      "systemd",
      { instances: [inst({ id: "1" }), inst({ id: "2" })] },
      true
    );
    expect(rt.ownership).toBe("conflict");
    expect(rt.running).toBe(true);
    expect(rt.state).toBe("running");
  });

  it("counts a single disputed instance as running too", () => {
    // The other road to conflict: one process, claimed by two backends.
    const rt = toRuntimeState(
      "systemd",
      { instances: [inst({ by: "systemd", disputed: true })] },
      true
    );
    expect(rt.ownership).toBe("conflict");
    expect(rt.running).toBe(true);
  });

  it("is not running when the observation failed and found nothing", () => {
    // unknown must not be mistaken for online either — there is no live instance behind it.
    const rt = toRuntimeState("systemd", { instances: [] }, false);
    expect(rt.ownership).toBe("unknown");
    expect(rt.running).toBe(false);
  });

  it("takes busy as the union across instances", () => {
    // Any worker anywhere in this directory means stopping it interrupts CI.
    const rt = toRuntimeState(
      "systemd",
      { instances: [inst({ id: "1" }), inst({ id: "2", busy: true })] },
      true
    );
    expect(rt.busy).toBe(true);
  });

  it("takes the liveliest state when instances disagree", () => {
    const rt = toRuntimeState(
      "systemd",
      { instances: [inst({ id: "1", state: "starting" }), inst({ id: "2", state: "running" })] },
      true
    );
    expect(rt.state).toBe("running");
  });

  describe("with no instances", () => {
    it("says stopped when the observation was complete", () => {
      expect(toRuntimeState("systemd", { instances: [] }, true).state).toBe("stopped");
    });

    it("says unknown when it was not", () => {
      expect(toRuntimeState("systemd", { instances: [] }, false).state).toBe("unknown");
    });

    it("takes its explanation from the directory-level detail", () => {
      // A runner that keeps failing to start has no instances at all, and "why it will not start"
      // is precisely what the user needs at that moment. The backend puts it on the Observation.
      const rt = toRuntimeState("systemd", { instances: [], detail: "unit entered failed" }, true);
      expect(rt.detail).toBe("unit entered failed");
    });
  });

  it("takes detail, since and raw from one and the same instance", () => {
    // The row the panel renders describes a process, so its fields must describe the *same*
    // process. Picking each field from whichever instance happened to have one produced a row
    // pairing one listener's unit name with another's start time — worse than a blank field,
    // because it reads as fact.
    const rt = toRuntimeState(
      "systemd",
      {
        instances: [
          inst({ id: "1", state: "starting", since: "yesterday", raw: { pid: "1" } }),
          inst({
            id: "2",
            state: "running",
            since: "today",
            raw: { pid: "2" },
            detail: "the live one"
          })
        ]
      },
      true
    );
    expect(rt.state).toBe("running");
    expect(rt.since).toBe("today");
    expect(rt.raw).toEqual({ pid: "2" });
    expect(rt.detail).toBe("the live one");
  });

  it("prefers an instance's own detail over the directory's", () => {
    const rt = toRuntimeState(
      "systemd",
      { instances: [inst({ detail: "from the instance" })], detail: "from the directory" },
      true
    );
    expect(rt.detail).toBe("from the instance");
  });
});
