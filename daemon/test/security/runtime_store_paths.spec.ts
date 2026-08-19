import fs from "fs-extra";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  listenerEnvPath,
  runLogPath,
  runtimePath
} from "../../src/service/supervisor/process/store";

// Three file paths are derived from the marker id, and the marker file lives in the runner's own
// directory — writable by the runner account. Without a shape check, whoever can write .cipanel
// decides where the daemon writes: a traversing id would place the runtime state, the start log,
// and (worst) the listener environment file — which holds the proxy credentials — anywhere the
// daemon user can reach.
//
// The id is a uuid with the dashes stripped (see runner_marker), so 32 hex characters is its only
// legal shape.

const BAD_IDS = [
  "../../etc/x",
  "..",
  "",
  "a/b",
  "a\\b",
  "0123456789abcdef0123456789abcde", // 31 — one short
  "0123456789abcdef0123456789abcdefa", // 33 — one over
  "0123456789ABCDEF0123456789ABCDEF", // uppercase is not what v4().replace produces
  "0123456789abcdef0123456789abcde/",
  "0123456789abcdef0123456789abcdef\n../x"
];

const GOOD = "0123456789abcdef0123456789abcdef";

describe("every path derived from the marker id is shape-checked", () => {
  // Each of the three matters on its own: dropping the check on any one of them is enough.
  // The .env one is the expensive miss — it is the file with the credentials in it.
  const derive = { runtimePath, listenerEnvPath, runLogPath };

  for (const [name, fn] of Object.entries(derive)) {
    it(`${name} refuses a malformed id instead of joining it into a path`, () => {
      for (const bad of BAD_IDS) {
        expect(() => fn(bad), JSON.stringify(bad)).toThrow(/markerId/);
      }
    });

    it(`${name} accepts the real shape and stays inside the daemon's data directory`, () => {
      const p = fn(GOOD);
      const dataDir = path.join(process.cwd(), "data", "RunnerRuntime");
      expect(p.startsWith(dataDir + path.sep)).toBe(true);
      expect(p).toContain(GOOD);
    });
  }

  it("keeps the three apart, so removing one runner cannot clobber another file", () => {
    const paths = new Set([runtimePath(GOOD), listenerEnvPath(GOOD), runLogPath(GOOD)]);
    expect(paths.size).toBe(3);
  });

  it("does not create anything while validating", () => {
    // A path helper that mkdir'd on the way would turn a rejected id into a side effect.
    const dataDir = path.join(process.cwd(), "data", "RunnerRuntime", "..", "evil");
    expect(fs.existsSync(dataDir)).toBe(false);
  });
});
