import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProcessSupervisor } from "../../src/service/supervisor/process";
import { removeRuntime, writeListenerEnvFile } from "../../src/service/supervisor/process/store";
import { fakeDeps, makeRunner } from "../helpers/process_fixture";

// The official runner refuses to run as uid 0 unless RUNNER_ALLOW_RUNASROOT is set: it prints
// "Must not run interactively with sudo" and then exits **0**. An exit of 0 is not a failure to
// anything watching exit codes, so the supervisor could only report "did not survive HEALTHY_MS"
// — the panel showed `code=0 sig=null` and the backoff respawned into the same wall forever.
//
// A root daemon is not an accident here: the process backend exists for nodes with no systemd,
// which in practice means containers, and a K8s or task pod runs as uid 0 by default. The
// listener's environment is a whitelist, so it did not inherit the variable from the daemon even
// when the daemon had it set — which is exactly why config.sh succeeded and run.sh did not.

const fixture = makeRunner("run-as-root");

// The uid is forced rather than read: whether this suite runs as root is a property of the machine
// it runs on, and both branches have to be pinned on every machine.
const realGetuid = process.getuid;
const asUid = (uid: number) => {
  process.getuid = () => uid;
};

beforeEach(async () => {
  await removeRuntime(fixture.markerId);
});

afterEach(() => {
  process.getuid = realGetuid;
});

const spawnEnv = async (): Promise<NodeJS.ProcessEnv> => {
  const deps = fakeDeps();
  await createProcessSupervisor(deps).spawnOnce(fixture.dir);
  const env = deps.spawns[0].opts.env;
  // Asserted, not coerced: spawning with no env at all would make the child inherit the daemon's
  // whole environment, and a default of {} here would read as "the variable is absent".
  expect(env).toBeDefined();
  return env as NodeJS.ProcessEnv;
};

describe("a listener launched by a root daemon", () => {
  it("carries the variable the runner requires in order to run as root", async () => {
    asUid(0);
    expect((await spawnEnv()).RUNNER_ALLOW_RUNASROOT).toBe("1");
  });

  it("adds nothing when the daemon is not root", async () => {
    // Non-root is the systemd-node shape and the supported one; a variable nobody needs has no
    // business appearing in the listener's environment there.
    asUid(1000);
    expect((await spawnEnv()).RUNNER_ALLOW_RUNASROOT).toBeUndefined();
  });

  it("yields to an explicit listener-scope value", async () => {
    // What the daemon supplies is a default, not a policy: a node that deliberately wants the
    // runner to refuse root must still be able to say so, and the listener scope is where a user
    // says it.
    asUid(0);
    await writeListenerEnvFile(fixture.markerId, [{ key: "RUNNER_ALLOW_RUNASROOT", value: "0" }]);
    expect((await spawnEnv()).RUNNER_ALLOW_RUNASROOT).toBe("0");
  });
});
