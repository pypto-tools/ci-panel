import { describe, expect, it } from "vitest";
import type { RunnerRuntimeState, ScannedRunner } from "mcsmanager-common";
import { legacyRunning, toRunnerRef } from "../../src/app/service/repo_service";

// The panel turns each node's scan into the shape the repository page renders. Two things make
// this worth pinning: nodes and the panel machine are upgraded separately, so a payload without
// `runtime` is a normal thing to receive; and "is it online" used to be re-derived here from an
// activeState string, which is exactly the duplication the runtime field exists to remove.

const scanned = (over: Partial<ScannedRunner> = {}): ScannedRunner => ({
  dir: "/srv/runners/org-repo/runner-1",
  dirName: "runner-1",
  repo: "org/repo",
  agentName: "runner-1",
  instanceUuid: "uuid-1",
  instanceStatus: 0,
  managed: true,
  markerId: "abcdef0123456789abcdef0123456789",
  source: "provision",
  group: "npu",
  exists: true,
  ...over
});

const runtime = (over: Partial<RunnerRuntimeState> = {}): RunnerRuntimeState => ({
  supervisor: "process",
  ownership: "self",
  running: true,
  state: "running",
  detail: "",
  since: "2026-08-19T00:00:00.000Z",
  busy: false,
  ...over
});

describe("a payload from an upgraded node", () => {
  it("takes the supervisor from the runtime when the top-level field is absent", () => {
    // `supervisor` is optional in the protocol while the transition lasts. Defaulting straight
    // to "none" would label a perfectly normal runner as externally supervised and disable
    // every control on it.
    const ref = toRunnerRef(
      "node-1",
      "NPU node",
      scanned({ supervisor: undefined, runtime: runtime({ supervisor: "systemd" }) })
    );
    expect(ref.supervisor).toBe("systemd");
  });

  it("takes online-ness straight from the runtime", () => {
    const ref = toRunnerRef(
      "node-1",
      "NPU node",
      scanned({ supervisor: "process", runtime: runtime() })
    );
    expect(ref.running).toBe(true);
    expect(ref.supervisor).toBe("process");
    expect(ref.runtime?.ownership).toBe("self");
  });

  it("reports a stopped runner as not running even though a handle instance exists", () => {
    // The old branch fell back to the handle instance's status when there was no unit. Handle
    // instances carry no start command and never run, so on a process-supervised node every
    // runner would have read as stopped.
    const ref = toRunnerRef(
      "node-1",
      "NPU node",
      scanned({ supervisor: "process", runtime: runtime({ running: false, ownership: "idle" }) })
    );
    expect(ref.running).toBe(false);
  });

  it("carries busy and the start time from the runtime, not from a systemd field", () => {
    const ref = toRunnerRef(
      "node-1",
      "NPU node",
      scanned({ runtime: runtime({ busy: true, since: "2026-08-19T01:02:03.000Z" }) })
    );
    expect(ref.busy).toBe(true);
    expect(ref.since).toBe("2026-08-19T01:02:03.000Z");
  });
});

describe("a payload from a node that has not been upgraded", () => {
  // Those nodes send no `runtime`, but a new daemon backfills the systemd shape for the reverse
  // direction, and an old daemon simply still has it. Reading `runtime` alone would report a
  // whole node's runners as offline with no error anywhere.
  const legacy = scanned({
    runtime: undefined,
    supervisor: undefined,
    systemd: {
      service: "actions.runner.org-repo.runner-1.service",
      loaded: true,
      activeState: "active",
      subState: "running",
      enabled: "enabled",
      since: "Mon 2026-08-17 10:00:00 UTC"
    }
  });

  it("falls back to the systemd fields for online-ness", () => {
    expect(legacyRunning(legacy)).toBe(true);
    expect(toRunnerRef("node-1", "old node", legacy).running).toBe(true);
  });

  it("is not running when the unit is loaded but inactive", () => {
    const stopped = scanned({
      runtime: undefined,
      systemd: { ...legacy.systemd!, activeState: "inactive", subState: "dead" }
    });
    expect(legacyRunning(stopped)).toBe(false);
  });

  it("is not running when there is no unit at all", () => {
    expect(legacyRunning(scanned({ runtime: undefined, systemd: null }))).toBe(false);
  });

  it("keeps the unit name so the panel can still control that node", () => {
    // Those daemons address runners by unit name only; dropping it here would make every
    // start/stop against a not-yet-upgraded node fail during the upgrade window.
    expect(toRunnerRef("node-1", "old node", legacy).systemd?.service).toBe(
      "actions.runner.org-repo.runner-1.service"
    );
  });

  it("degrades to 'external' rather than inventing a supervisor", () => {
    const ref = toRunnerRef("node-1", "old node", legacy);
    expect(ref.supervisor).toBe("none");
    expect(ref.runtime).toBeNull();
  });
});
