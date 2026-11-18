import fs from "fs-extra";
import nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scanListenerProcs } from "../../src/service/supervisor/local_procs";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.removeSync(root);
});

describe("process discovery isolation", () => {
  it("does not schedule per-PID reads on the daemon's main thread", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "proc-isolation-"));
    roots.push(root);
    for (let pid = 1; pid <= 300; pid++) {
      fs.ensureDirSync(path.join(root, String(pid)));
      fs.writeFileSync(path.join(root, String(pid), "comm"), "sleep\n");
    }
    const reads = vi.spyOn(fs.promises, "readFile");
    const syncReads = vi.spyOn(nodeFs, "readFileSync");
    expect(await scanListenerProcs(root)).toEqual([]);
    expect(reads.mock.calls.filter(([file]) => String(file).startsWith(root))).toHaveLength(0);
    expect(syncReads.mock.calls.filter(([file]) => String(file).startsWith(root))).toHaveLength(0);
  });
});
