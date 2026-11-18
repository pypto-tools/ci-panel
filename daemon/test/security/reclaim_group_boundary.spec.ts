import fs from "fs-extra";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isDedicatedRunnerGroup,
  processGroupExists
} from "../../src/service/supervisor/process/group";
import { listenerProc, makeRunner } from "../helpers/process_fixture";
import { SCAN_ROOT } from "../setup";

const runner = makeRunner("dedicated-group");
const procRoot = path.join(SCAN_ROOT, "fake-reclaim-proc");
const listener = listenerProc({ dir: runner.dir, pid: 9201, pgid: 9200 });

beforeEach(async () => {
  await fs.remove(procRoot);
  for (const pid of [9200, 9201]) {
    const dir = path.join(procRoot, String(pid));
    await fs.ensureDir(dir);
    await fs.writeFile(path.join(dir, "stat"), `${pid} (runner (test)) S 1 9200 9200 0`);
  }
  await fs.symlink(runner.dir, path.join(procRoot, "9200/cwd"));
  await fs.writeFile(path.join(procRoot, "9200/cmdline"), "/bin/bash\0./run.sh\0");
});

describe("dedicated runner group proof", () => {
  it("accepts a run.sh session owned by the daemon user", async () => {
    expect(await isDedicatedRunnerGroup(listener, procRoot)).toBe(true);
  });
  it.each([
    "shell-session",
    "wrong-cwd",
    "wrong-command",
    "shell-command",
    "different-member",
    "zombie",
    "missing-leader"
  ])("rejects %s", async (mode) => {
    if (mode === "shell-session")
      await fs.writeFile(path.join(procRoot, "9200/stat"), "9200 (bash) S 1 9200 8000");
    if (mode === "wrong-cwd") {
      await fs.remove(path.join(procRoot, "9200/cwd"));
      await fs.symlink(SCAN_ROOT, path.join(procRoot, "9200/cwd"));
    }
    if (mode === "wrong-command")
      await fs.writeFile(path.join(procRoot, "9200/cmdline"), "/bin/bash\0./other.sh\0");
    if (mode === "shell-command")
      await fs.writeFile(path.join(procRoot, "9200/cmdline"), "/bin/bash\0-c\0./run.sh\0");
    if (mode === "different-member")
      await fs.writeFile(path.join(procRoot, "9201/stat"), "9201 (Runner.Listener) S 1 9300 9300");
    if (mode === "zombie")
      await fs.writeFile(path.join(procRoot, "9200/stat"), "9200 (bash) Z 1 9200 9200");
    if (mode === "missing-leader") await fs.remove(path.join(procRoot, "9200"));
    expect(await isDedicatedRunnerGroup(listener, procRoot)).toBe(false);
  });
  it.each([0, 1, -10, 2.5, NaN, Infinity])("rejects invalid group %s", async (pgid) => {
    expect(await isDedicatedRunnerGroup({ ...listener, pgid }, procRoot)).toBe(false);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("live process groups, including orphaned descendants", () => {
  beforeEach(() => {
    // Linux signal-zero succeeds even for a group containing only zombies.
    vi.spyOn(process, "kill").mockReturnValue(true);
  });

  it("does not treat a zombie-only group as running", async () => {
    for (const pid of [9200, 9201])
      await fs.writeFile(path.join(procRoot, String(pid), "stat"), `${pid} (runner) Z 1 9200 9200`);
    expect(await processGroupExists(listener.pgid, procRoot)).toBe(false);
  });

  it.each(["zombie", "missing"])(
    "keeps a group with a %s leader and a live descendant",
    async (mode) => {
      if (mode === "missing") await fs.remove(path.join(procRoot, "9200"));
      else await fs.writeFile(path.join(procRoot, "9200/stat"), "9200 (bash) Z 1 9200 9200");
      expect(await processGroupExists(listener.pgid, procRoot)).toBe(true);
    }
  );

  it("ignores unrelated live groups after the recorded group exits", async () => {
    await fs.remove(path.join(procRoot, "9200"));
    await fs.writeFile(path.join(procRoot, "9201/stat"), "9201 (other) S 1 9300 9300");
    expect(await processGroupExists(listener.pgid, procRoot)).toBe(false);
  });

  it("does not report absence when the process table is unreadable", async () => {
    await expect(processGroupExists(listener.pgid, procRoot + "-missing")).rejects.toThrow();
  });
});
