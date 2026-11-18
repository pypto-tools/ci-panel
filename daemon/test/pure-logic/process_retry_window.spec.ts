import fs from "fs-extra";
import path from "path";
import { spawn, type ChildProcess } from "child_process";
import { once } from "events";
import { expect, it } from "vitest";
import { createProcessSupervisor } from "../../src/service/supervisor/process";
import {
  inspectProcessGroup,
  processGroupState,
  readLeaderIdentity
} from "../../src/service/supervisor/process/group";
import { readRuntime } from "../../src/service/supervisor/process/store";
import { fakeDeps, listenerProc, makeRunner } from "../helpers/process_fixture";

it("keeps one wrapper through a real five-second listener retry window", async () => {
  const fixture = makeRunner("real-retry-window");
  const ready = path.join(fixture.dir, "ready");
  const retry = path.join(fixture.dir, "retry");
  // Model run-helper's exit-2 retry without contacting GitHub or running CI jobs.
  await fs.writeFile(
    path.join(fixture.dir, "listener.cjs"),
    `
const fs = require("fs");
process.on("SIGINT", () => { fs.unlinkSync("ready"); process.exit(2); });
fs.writeFileSync("ready", String(process.pid));
setInterval(() => {}, 1000);
`
  );
  await fs.writeFile(
    path.join(fixture.dir, "run.sh"),
    `#!/bin/bash
trap '' INT
trap 'exit 0' TERM
while true; do
  "$1" listener.cjs
  result=$?
  if [ "$result" != 2 ]; then exit "$result"; fi
  touch retry
  sleep 5
done
`,
    { mode: 0o700 }
  );

  let child: ChildProcess | undefined;
  let pgid = 0;
  let spawns = 0;
  const deps = fakeDeps({
    groupState: inspectProcessGroup,
    readLeader: readLeaderIdentity,
    kill: (pid, signal) => {
      process.kill(pid, signal);
    },
    spawn: (_cmd, _args, options) => {
      spawns++;
      child = spawn("./run.sh", [process.execPath], options);
      pgid = child.pid ?? 0;
      return child;
    },
    scan: async () => {
      try {
        const pid = Number(await fs.readFile(ready, "utf8"));
        return [listenerProc({ dir: fixture.dir, pid, pgid })];
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
        throw err;
      }
    }
  });
  const waitForFile = async (file: string) => {
    const deadline = Date.now() + 7000;
    while (!(await fs.pathExists(file))) {
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path.basename(file)}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  try {
    const backend = createProcessSupervisor(deps);
    await backend.spawnOnce(fixture.dir);
    await waitForFile(ready);
    const firstPid = Number(await fs.readFile(ready, "utf8"));
    const outcome = await backend.restart(fixture.dir);
    await waitForFile(retry);
    expect(outcome.settled).toBe(false);
    expect(await deps.scan()).toEqual([]);
    expect(processGroupState(pgid)).toBe("present");
    await backend.reconcileOne!(fixture.dir, []);
    expect((await readRuntime(fixture.markerId))?.pgid).toBe(pgid);
    await waitForFile(ready);
    expect(Number(await fs.readFile(ready, "utf8"))).not.toBe(firstPid);
    expect(spawns).toBe(1);
    expect((await readRuntime(fixture.markerId))?.pgid).toBe(pgid);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      // TERM kills the test listener; the wrapper traps it and reaps its child before exit.
      process.kill(-pgid, "SIGTERM");
      await exited;
    }
  }
}, 15_000);
