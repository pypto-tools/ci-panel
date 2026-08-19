import fs from "fs-extra";
import path from "path";
import { beforeEach, describe, expect, it } from "vitest";
import { readRunnerEnv, scopeOfTarget, writeRunnerEnv } from "../../src/service/runner_env";
import { listenerEnvPath, removeRuntime } from "../../src/service/supervisor/process/store";
import { makeRunner } from "../helpers/process_fixture";

// Proxy variables have to reach the listener process itself — the runner only reads .env to build
// the environment for jobs and steps, so a proxy there never helps the listener connect to GitHub.
// On a node with no systemd there was no route at all: the listener scope was the systemd drop-in,
// and writing it threw outright. That is the whole of breakpoint 4.

const fixture = makeRunner("listener-env");

beforeEach(async () => {
  await removeRuntime(fixture.markerId);
  await fs.remove(path.join(fixture.dir, ".env"));
});

describe("the listener scope on a node without systemd", () => {
  it("reports itself as writable", () => {
    // The panel used to decide this from "does a systemd unit exist", which is false here and
    // greyed the input out. It is the backend's answer now.
    return expect(readRunnerEnv(fixture.dir)).resolves.toMatchObject({
      supervisor: "process",
      canWriteListenerEnv: true
    });
  });

  it("accepts a write and reads it back", async () => {
    const after = await writeRunnerEnv(fixture.dir, "listener", {
      upsert: [{ key: "HTTPS_PROXY", value: "http://127.0.0.1:7890" }]
    });
    expect(after.override.vars).toEqual([{ key: "HTTPS_PROXY", value: "http://127.0.0.1:7890" }]);
  });

  it("keeps it in the daemon's own directory, not in the runner's", async () => {
    // The runner account can write its own directory; a proxy string carries credentials.
    await writeRunnerEnv(fixture.dir, "listener", {
      upsert: [{ key: "HTTPS_PROXY", value: "http://user:pw@127.0.0.1:7890" }]
    });
    expect(fs.existsSync(listenerEnvPath(fixture.markerId))).toBe(true);
    expect(fs.existsSync(path.join(fixture.dir, ".env"))).toBe(false);
    expect(fs.statSync(listenerEnvPath(fixture.markerId)).mode & 0o077).toBe(0);
  });
});

describe("the two scopes stay apart", () => {
  it("writes the job scope to the runner's own .env", async () => {
    const after = await writeRunnerEnv(fixture.dir, "job", {
      upsert: [{ key: "DEVICE_ID", value: "3" }]
    });
    expect(after.dotenv.vars).toEqual([{ key: "DEVICE_ID", value: "3" }]);
    expect(fs.readFileSync(path.join(fixture.dir, ".env"), "utf8")).toContain("DEVICE_ID=3");
    // A job variable must not end up where the listener reads it.
    expect(after.override.vars).toEqual([]);
  });

  it("merges within a scope without touching the other", async () => {
    await writeRunnerEnv(fixture.dir, "listener", {
      upsert: [{ key: "HTTPS_PROXY", value: "http://127.0.0.1:7890" }]
    });
    await writeRunnerEnv(fixture.dir, "job", { upsert: [{ key: "DEVICE_ID", value: "3" }] });
    const after = await writeRunnerEnv(fixture.dir, "job", {
      upsert: [{ key: "LD_LIBRARY_PATH", value: "/opt/lib" }]
    });
    // Merge keeps each runner's own pre-existing variables; only the named ones change.
    expect(after.dotenv.vars.map((v) => v.key).sort()).toEqual(["DEVICE_ID", "LD_LIBRARY_PATH"]);
    expect(after.override.vars.map((v) => v.key)).toEqual(["HTTPS_PROXY"]);
  });
});

describe("the wire value is mapped once, at the boundary", () => {
  it("maps the two values the protocol defines", () => {
    expect(scopeOfTarget("override")).toBe("listener");
    expect(scopeOfTarget("dotenv")).toBe("job");
  });

  it("refuses anything else instead of guessing", () => {
    // The old daemon normalised any unrecognised value to "override". A new frontend sending a
    // scope name it does not know would therefore have written job-only variables into the
    // root-owned drop-in, and leaked them into the listener's own environment. Failing the
    // request is the only safe answer.
    for (const bad of ["listener", "job", "", "toString", undefined, null, 1])
      expect(() => scopeOfTarget(bad), JSON.stringify(bad)).toThrow();
  });
});
