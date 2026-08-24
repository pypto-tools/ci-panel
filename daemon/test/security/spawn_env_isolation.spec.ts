import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProcessSupervisor } from "../../src/service/supervisor/process";
import { removeRuntime, writeListenerEnvFile } from "../../src/service/supervisor/process/store";
import { fakeDeps, makeRunner } from "../helpers/process_fixture";

// Handing the daemon's own environment to the listener would open a leak that does not exist on
// the systemd path at all: the unit the privileged helper writes has neither Environment= nor
// EnvironmentFile=, so a listener's environment is exactly what root put in the drop-in.
//
// The daemon's environment, by contrast, holds CIP_RUNNER_PROXY (proxy strings carry credentials),
// CIP_SCAN_ROOTS, CIP_RUNNER_SVC_HELPER — and on a --role all box the unit injects the deploy
// .env, which contains CIP_GITHUB_TOKEN. That PAT would travel listener → Runner.Worker → every
// job step, i.e. into untrusted CI code.

const fixture = makeRunner("env-isolation");

// Restored after every test: vitest shares one process per worker, so leaving the synthetic PAT
// and proxy behind would hand them to whichever spec runs next and make that spec order-dependent.
const INJECTED = ["CIP_GITHUB_TOKEN", "CIP_RUNNER_PROXY", "CIP_SOMETHING_NEW"] as const;
const saved = new Map<string, string | undefined>();

// The daemon adds RUNNER_ALLOW_RUNASROOT when it is root, so what belongs in the listener's
// environment depends on the uid. Pinned to a non-root value rather than read from the machine:
// otherwise these assertions say something different on a root container than on a developer's
// box, and the exact-membership check below — the one that catches a variable nobody anticipated
// — would have to be loosened to a subset check to survive both.
const realGetuid = process.getuid;
const asUid = (uid: number) => {
  process.getuid = () => uid;
};

beforeEach(async () => {
  await removeRuntime(fixture.markerId);
  asUid(1000);
  for (const k of INJECTED) saved.set(k, process.env[k]);
  process.env.CIP_GITHUB_TOKEN = "ghp_this_must_not_leak";
  process.env.CIP_RUNNER_PROXY = "http://user:secret@127.0.0.1:7890";
  process.env.CIP_SOMETHING_NEW = "future variable nobody thought about";
});

afterEach(() => {
  process.getuid = realGetuid;
  for (const k of INJECTED) {
    const prev = saved.get(k);
    if (prev === undefined) delete process.env[k];
    else process.env[k] = prev;
  }
});

const spawnEnv = async (): Promise<NodeJS.ProcessEnv> => {
  const deps = fakeDeps();
  await createProcessSupervisor(deps).spawnOnce(fixture.dir);
  const env = deps.spawns[0].opts.env;
  // Asserted, not coerced: spawning with no env at all makes the child inherit the daemon's whole
  // environment — precisely the leak this file exists to prevent. Defaulting to {} here would turn
  // that failure into a passing test.
  expect(env).toBeDefined();
  return env as NodeJS.ProcessEnv;
};

describe("the listener's environment", () => {
  it("carries no CIP_ variable at all", async () => {
    const env = await spawnEnv();
    // Asserted by prefix rather than by naming today's variables: a whitelist that is only
    // checked against a fixed list stops protecting the moment someone adds a new one.
    expect(Object.keys(env).filter((k) => k.startsWith("CIP_"))).toEqual([]);
  });

  it("passes through only the handful of base variables a process needs", async () => {
    const env = await spawnEnv();
    const allowed = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TZ"];
    expect(Object.keys(env).every((k) => allowed.includes(k))).toBe(true);
    expect(env.PATH).toBe(process.env.PATH);
  });

  it("adds exactly one variable when the daemon is root, and no more", async () => {
    // The root-container path needs RUNNER_ALLOW_RUNASROOT or the listener exits 0 on startup.
    // Supplying it must stay a single named addition: reaching for process.env to solve that
    // problem is what this whole file exists to prevent, and a root daemon is the case where the
    // daemon's own environment is most likely to hold the deploy .env's CIP_GITHUB_TOKEN.
    asUid(0);
    const allowed = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TZ"];
    const env = await spawnEnv();
    expect(env.RUNNER_ALLOW_RUNASROOT).toBe("1");
    expect(Object.keys(env).filter((k) => !allowed.includes(k))).toEqual([
      "RUNNER_ALLOW_RUNASROOT"
    ]);
  });

  it("carries what was configured for the listener scope", async () => {
    // The proxy has to reach the listener — that is the whole point of the scope. It comes from
    // the daemon's own file for this runner, not from inheriting the daemon's environment.
    await writeListenerEnvFile(fixture.markerId, [
      { key: "HTTPS_PROXY", value: "http://127.0.0.1:7890" }
    ]);
    const env = await spawnEnv();
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
  });
});

describe("how the child is launched", () => {
  it("runs in the runner directory, in its own process group, without a shell", async () => {
    const deps = fakeDeps();
    await createProcessSupervisor(deps).spawnOnce(fixture.dir);
    const { cmd, args, opts } = deps.spawns[0];
    expect(cmd).toBe("./run.sh");
    expect(args).toEqual([]);
    expect(opts.cwd).toBe(fixture.dir);
    // detached: the child must outlive a daemon upgrade, and it needs its own group so the stop
    // ladder can signal the whole tree.
    expect(opts.detached).toBe(true);
    // No shell: the escape-hatch argv goes through this same call.
    expect(opts.shell).toBe(false);
  });
});
