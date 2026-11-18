import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reclaimRunner } from "../../src/service/supervisor/resolve";
import * as registry from "../../src/service/supervisor/registry";
import * as localProcs from "../../src/service/supervisor/local_procs";
import { createProcessSupervisor } from "../../src/service/supervisor/process";
import { removeMarker, writeMarker } from "../../src/service/runner_marker";
import { toRuntimeState } from "../../src/service/supervisor/ownership";
import type { Observation } from "../../src/service/supervisor/types";
import { fakeDeps, makeRunner } from "../helpers/process_fixture";

const fixture = makeRunner("reclaim-gate");
const obs: Observation = { instances: [{ id: "9201", state: "running", since: "", busy: true }] };

function setup(observation: Observation = obs) {
  const backend = createProcessSupervisor(fakeDeps());
  vi.spyOn(backend, "observe").mockResolvedValue(new Map([[fixture.dir, observation]]));
  const reclaim = vi
    .spyOn(backend, "reclaim")
    .mockResolvedValue(toRuntimeState("process", obs, true));
  vi.spyOn(registry, "backendFor").mockReturnValue(backend);
  vi.spyOn(registry, "availableBackends").mockReturnValue([backend]);
  vi.spyOn(localProcs, "scanListenerProcs").mockResolvedValue([]);
  return { backend, reclaim };
}

beforeEach(() => {
  removeMarker(fixture.dir);
  writeMarker(fixture.dir, { source: "import", repo: "org/repo", supervisor: "process" });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("reclaim authorization and cross-backend observation", () => {
  it("passes the freshly observed identity to recovery", async () => {
    const { reclaim } = setup();
    await reclaimRunner(fixture.dir);
    expect(reclaim).toHaveBeenCalledTimes(1);
    expect(reclaim).toHaveBeenCalledWith(fixture.dir, "9201");
  });

  it.each([null, {}, [], "relative", "/", "bad\0path"])(
    "rejects malformed target %j",
    async (value) => {
      const { reclaim } = setup();
      await expect(reclaimRunner(value)).rejects.toThrow();
      expect(reclaim).not.toHaveBeenCalled();
    }
  );

  it("requires a managed directory", async () => {
    const { reclaim } = setup();
    await expect(reclaimRunner(fixture.dir + "-unmanaged")).rejects.toThrow();
    expect(reclaim).not.toHaveBeenCalled();
  });

  it.each(["systemd", "none"] as const)("refuses the %s supervisor", async (supervisor) => {
    removeMarker(fixture.dir);
    writeMarker(fixture.dir, { source: "import", repo: "org/repo", supervisor });
    const { reclaim } = setup();
    await expect(reclaimRunner(fixture.dir)).rejects.toThrow();
    expect(reclaim).not.toHaveBeenCalled();
  });

  it.each(["self", "conflict", "idle", "disputed", "incomplete"])(
    "refuses %s observation",
    async (mode) => {
      const observation: Observation = { instances: obs.instances.map((i) => ({ ...i })) };
      if (mode === "self") observation.instances[0].by = "process";
      if (mode === "conflict") observation.instances[0].by = "systemd";
      if (mode === "idle") observation.instances = [];
      if (mode === "disputed") observation.instances[0].disputed = true;
      const { backend, reclaim } = setup(observation);
      if (mode === "incomplete")
        vi.mocked(backend.observe).mockRejectedValue(new Error("observation unavailable"));
      await expect(reclaimRunner(fixture.dir)).rejects.toThrow();
      expect(reclaim).not.toHaveBeenCalled();
    }
  );
});
