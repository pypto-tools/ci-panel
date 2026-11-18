import fs from "fs-extra";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { $t } from "../../src/i18n";
import { deleteRunner } from "../../src/service/runner_scan";
import * as localProcs from "../../src/service/supervisor/local_procs";
import * as registry from "../../src/service/supervisor/registry";
import { systemdFactory } from "../../src/service/supervisor/systemd";
import { listenerProc, makeRunner } from "../helpers/process_fixture";

let fixture: ReturnType<typeof makeRunner>;
const backend = systemdFactory.create();

beforeEach(() => {
  fixture = makeRunner("delete-scan-failure");
  fs.writeFileSync(path.join(fixture.dir, ".service"), "actions.runner.example.delete.service");
  vi.spyOn(registry, "backendFor").mockReturnValue(backend);
  // An installed systemd unit can be stopped without another process scan.
  vi.spyOn(backend, "detach").mockResolvedValue({ ok: true });
  vi.spyOn(localProcs, "scanListenerProcs").mockResolvedValue([]);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.remove(fixture.dir);
});

describe("runner deletion requires a successful fresh process scan", () => {
  it.each([false, true])("aborts before detach or file removal when force=%s", async (force) => {
    const error = new Error($t("TXT_CODE_RUNNER_PROC_SCAN_FAILED"));
    vi.mocked(localProcs.scanListenerProcs).mockRejectedValue(error);
    const marker = fs.readFileSync(path.join(fixture.dir, ".cipanel"), "utf8");

    await expect(deleteRunner(fixture.dir, { force })).rejects.toBe(error);

    expect(backend.detach).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(fixture.dir, ".cipanel"), "utf8")).toBe(marker);
    expect(fs.existsSync(path.join(fixture.dir, ".runner"))).toBe(true);
    expect(fs.existsSync(path.join(fixture.dir, ".service"))).toBe(true);
  });

  it("releases the deletion lock and permits a fresh retry after scan recovery", async () => {
    const error = new Error($t("TXT_CODE_RUNNER_PROC_SCAN_FAILED"));
    vi.mocked(localProcs.scanListenerProcs).mockRejectedValueOnce(error);

    await expect(deleteRunner(fixture.dir)).rejects.toBe(error);
    expect(backend.detach).not.toHaveBeenCalled();

    const result = await deleteRunner(fixture.dir);

    expect(localProcs.scanListenerProcs).toHaveBeenCalledTimes(2);
    expect(backend.detach).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    expect(fs.existsSync(fixture.dir)).toBe(false);
  });

  it("still requires force to delete a runner reported as busy by a successful scan", async () => {
    vi.mocked(localProcs.scanListenerProcs).mockResolvedValue([
      listenerProc({ dir: fixture.dir, busy: true })
    ]);

    await expect(deleteRunner(fixture.dir)).rejects.toThrow(/force/);
    expect(backend.detach).not.toHaveBeenCalled();
    expect(fs.existsSync(fixture.dir)).toBe(true);

    const result = await deleteRunner(fixture.dir, { force: true });

    expect(result.ok).toBe(true);
    expect(backend.detach).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(fixture.dir)).toBe(false);
  });
});
