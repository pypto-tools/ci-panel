import fs from "fs-extra";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listenerEnvPath, writeListenerEnvFile } from "../../src/service/supervisor/process/store";

// The listener environment file is where the proxy string lives, and a proxy string routinely
// carries credentials (http://user:secret@host). On the systemd path the equivalent data sits in
// a root-owned drop-in; here it is an ordinary file under the daemon's data directory, so its
// mode is the only thing keeping it from same-group and other users.
//
// fs.writeFile applies `mode` only when it CREATES the file. An already-existing file — written
// by an older build, or created under a permissive umask — keeps whatever mode it had, so the
// write silently leaves credentials world-readable.

const MARKER_ID = "0123456789abcdef0123456789abcdef";
const VARS = [{ key: "HTTPS_PROXY", value: "http://user:secret@127.0.0.1:7890" }];

const modeOf = (p: string): number => fs.statSync(p).mode & 0o777;

// Pre-create the file at a deliberately wider mode. The explicit chmod defeats any umask
// influence on the create, so the starting point is 0644 on every machine.
const preCreateWide = async (): Promise<string> => {
  const file = listenerEnvPath(MARKER_ID);
  await fs.ensureDir(path.dirname(file));
  await fs.writeFile(file, "OLD=1\n", { encoding: "utf8", mode: 0o644 });
  await fs.chmod(file, 0o644);
  expect(modeOf(file)).toBe(0o644);
  return file;
};

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.remove(listenerEnvPath(MARKER_ID));
});

describe("the listener environment file", () => {
  it("is created 0600", async () => {
    await writeListenerEnvFile(MARKER_ID, VARS);
    expect(modeOf(listenerEnvPath(MARKER_ID))).toBe(0o600);
  });

  it("is tightened to 0600 when it already exists with a wider mode", async () => {
    // The regression this pins: against a plain writeFile-with-mode the file stays 0644 and the
    // credentials stay readable by every user on the node.
    const file = await preCreateWide();

    await writeListenerEnvFile(MARKER_ID, VARS);

    expect(modeOf(file)).toBe(0o600);
    expect(fs.readFileSync(file, "utf8")).toContain("HTTPS_PROXY=");
  });

  it("never exposes the new contents at the old wider mode", async () => {
    // Ordering matters, not just the end state: tightening *after* the write leaves a real window
    // in which the credentials sit on disk at 0644. Sampled at the moment the secret is written.
    const file = await preCreateWide();

    let modeWhenSecretLanded: number | null = null;
    const spy = vi.spyOn(fs, "writeFile").mockImplementation(async (...args: unknown[]) => {
      modeWhenSecretLanded = modeOf(file);
      spy.mockRestore();
      return (fs.writeFile as (...a: unknown[]) => Promise<void>)(...args);
    });

    await writeListenerEnvFile(MARKER_ID, VARS);

    expect(modeWhenSecretLanded).toBe(0o600);
    expect(modeOf(file)).toBe(0o600);
  });
});
