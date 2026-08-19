import fs from "fs-extra";
import { beforeEach, describe, expect, it } from "vitest";
import {
  listenerEnvPath,
  mutateRuntime,
  readRuntime,
  removeRuntime,
  rotateAndOpenRunLog,
  runLogPath,
  runtimePath,
  writeListenerEnvFile,
  writeRuntime,
  type RunnerRuntime
} from "../../src/service/supervisor/process/store";

const ID = "abcdef0123456789abcdef0123456789";

const rt = (over: Partial<RunnerRuntime> = {}): RunnerRuntime => ({
  v: 1,
  dir: "/srv/runners/r1",
  pgid: 4242,
  startedAt: 1000,
  lastAttemptAt: 1000,
  desired: "running",
  stopRequestedAt: 0,
  stopStage: 0,
  failures: 0,
  lastError: "",
  ...over
});

beforeEach(async () => {
  await fs.remove(runtimePath(ID));
  await fs.remove(listenerEnvPath(ID));
  await fs.remove(runLogPath(ID));
  await fs.remove(`${runLogPath(ID)}.1`);
});

describe("removeRuntime clears everything the marker id names", () => {
  it("removes the state, the listener environment and both log generations", async () => {
    await writeRuntime(ID, rt());
    await writeListenerEnvFile(ID, [
      { key: "HTTPS_PROXY", value: "http://user:pw@127.0.0.1:7890" }
    ]);
    await fs.close(await rotateAndOpenRunLog(ID));
    await fs.close(await rotateAndOpenRunLog(ID)); // second start rotates the first log to .1

    expect(fs.existsSync(listenerEnvPath(ID))).toBe(true);
    expect(fs.existsSync(`${runLogPath(ID)}.1`)).toBe(true);

    await removeRuntime(ID);

    // The env file is the one that must not survive: a marker id is minted per provision, so a
    // leftover is never touched again — a file with proxy credentials in it, orphaned forever.
    for (const file of [
      runtimePath(ID),
      listenerEnvPath(ID),
      runLogPath(ID),
      `${runLogPath(ID)}.1`
    ])
      expect(fs.existsSync(file), file).toBe(false);
  });
});

describe("the start log keeps at most two generations", () => {
  it("rotates the previous one and does not accumulate", async () => {
    const fd1 = await rotateAndOpenRunLog(ID);
    await fs.write(fd1, "first\n");
    await fs.close(fd1);
    const fd2 = await rotateAndOpenRunLog(ID);
    await fs.close(fd2);

    // run.sh writes continuously to a node-local disk; an unbounded log hurts more than ci-panel.
    expect(await fs.readFile(`${runLogPath(ID)}.1`, "utf8")).toBe("first\n");
    expect(fs.existsSync(`${runLogPath(ID)}.2`)).toBe(false);
  });
});

describe("writes are serialised per runner", () => {
  it("does not lose an update when two writers interleave", async () => {
    // The 'error' and 'exit' callbacks fire outside the lock (a child can exit at any moment)
    // while reconcile clears failures inside it. Two read-modify-write cycles would drop one of
    // them — and the one that gets dropped is the failure count, which is what the backoff runs on.
    await writeRuntime(ID, rt({ failures: 0 }));
    await Promise.all(
      Array.from({ length: 20 }, () =>
        mutateRuntime(ID, (cur) => (cur ? { ...cur, failures: cur.failures + 1 } : cur))
      )
    );
    expect((await readRuntime(ID))?.failures).toBe(20);
  });
});

describe("reading a file written by an older daemon", () => {
  it("fills in fields that did not exist yet", async () => {
    // Missing stopStage is the dangerous one: `while (stage < …)` with undefined is false, so the
    // stop ladder would never send a single signal.
    await fs.outputFile(
      runtimePath(ID),
      JSON.stringify({ v: 1, dir: "/srv/runners/r1", pgid: 7, startedAt: 500, desired: "running" })
    );
    const read = await readRuntime(ID);
    expect(read?.stopStage).toBe(0);
    expect(read?.lastAttemptAt).toBe(500); // falls back to startedAt so the backoff has a basis
  });

  it("discards a file from a version whose fields meant something else", async () => {
    await fs.outputFile(runtimePath(ID), JSON.stringify({ v: 99, dir: "/srv/x", pgid: 7 }));
    expect(await readRuntime(ID)).toBeNull();
  });

  it("treats a corrupted file as 'never supervised' rather than throwing", async () => {
    await fs.outputFile(runtimePath(ID), "{not json");
    expect(await readRuntime(ID)).toBeNull();
  });
});
