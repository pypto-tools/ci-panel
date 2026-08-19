import fs from "fs-extra";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeRunner } from "../helpers/process_fixture";

// A backend's detach() is contracted to RETURN { ok, error, hint } — but every implementation
// reaches outside itself to honour it: the systemd one shells out to the privileged helper and
// uninstalls a unit, and all three re-check /proc. A helper that will not spawn, or an EIO while
// walking /proc, makes detach REJECT rather than resolve false.
//
// Letting that rejection escape puts the delete back in the shape this PR exists to remove: the
// router returns a bare error string with no `steps` and no `hint`, so the panel shows "it
// failed" with no next action and the runner stays undeletable. A throw and an ok:false mean the
// same thing here — we did not get supervision back — so it must land as a failed step and let
// the fail-closed branch below report normally.

const DETACH_ERROR = "helper spawn failed: EACCES";

// backendFor is resolved through the registry, so the fake is installed there. importActual keeps
// every other export real — resolveSupervisor still reads the marker, hints still localise.
vi.mock("../../src/service/supervisor/registry", async () => {
  const actual = await vi.importActual<typeof import("../../src/service/supervisor/registry")>(
    "../../src/service/supervisor/registry"
  );
  return {
    ...actual,
    backendFor: () => ({
      kind: "process" as const,
      detach: () => Promise.reject(new Error(DETACH_ERROR)),
      observe: async () => new Map(),
      readListenerEnv: async () => ({ present: false, vars: [] }),
      writeListenerEnv: async () => undefined,
      attach: async () => undefined,
      start: async () => ({ settled: true }),
      stop: async () => ({ settled: true }),
      restart: async () => ({ settled: true })
    })
  };
});

let fixture: ReturnType<typeof makeRunner>;

beforeEach(() => {
  fixture = makeRunner("delete-detach-throws");
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (fixture) await fs.remove(fixture.dir);
});

describe("a detach that rejects instead of returning ok:false", () => {
  it("reports a failed step with a hint rather than rejecting the whole delete", async () => {
    const { deleteRunner } = await import("../../src/service/runner_scan");

    const result = await deleteRunner(fixture.dir);

    expect(result.ok).toBe(false);
    // The whole point: the caller still gets the structured report.
    const step = result.steps.find((s) => s.key === "systemd");
    expect(step?.status).toBe("failed");
    expect(step?.detail).toContain(DETACH_ERROR);
    expect(step?.hint).toBeTruthy();
  });

  it("still fails closed — nothing after the failed step runs", async () => {
    const { deleteRunner } = await import("../../src/service/runner_scan");

    const result = await deleteRunner(fixture.dir);

    // Skipping the rest is the invariant the throw must not be allowed to bypass: deleting the
    // directory under a listener that may still be alive is the outcome being guarded against.
    const skipped = result.steps.filter((s) => s.status === "skipped").map((s) => s.key);
    expect(skipped).toEqual(expect.arrayContaining(["github", "panel", "dir"]));
    expect(fs.existsSync(fixture.dir)).toBe(true);
  });
});
