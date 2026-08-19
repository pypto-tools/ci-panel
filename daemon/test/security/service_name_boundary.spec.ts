import fs from "fs-extra";
import path from "path";
import { beforeAll, describe, expect, it } from "vitest";
import { DAEMON_ROOT, REPO_ROOT, SCAN_ROOT } from "../setup";
import { readRunnerEnv } from "../../src/service/runner_env";

// The systemd unit name comes from <runner dir>/.service — a file the runner's own owner can
// rewrite — and ends up in a systemctl argv and in a path under /etc/systemd/system. execFile
// passes an array and starts no shell, so this is not command injection, but an unconstrained
// name still selects the wrong unit or escapes the drop-in directory.
//
// The shape is declared in THREE places. The bash one is the real boundary because it runs as
// root; the two TypeScript copies only decide what the daemon bothers to ask for. They must not
// drift apart, and nothing in the build would notice if they did.

const HELPER = path.join(REPO_ROOT, "prod-scripts/ci-panel-runner-svc");

// Found by walking the tree, not by a hardcoded list of files. The list was two paths and both
// have since moved: the supervisor framework added a third copy in the systemd backend, and more
// of this is still in motion. A stale path here does not fail loudly at the assertion — extractTs
// throws during collection, and every case in this file disappears from the run. Walking is
// immune to the next move and also catches a fourth copy nobody mentioned.
const TS_LITERAL = /^(?:export )?const SERVICE_RE = \/(.+)\/;$/m;

const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    return e.isFile() && e.name.endsWith(".ts") ? [full] : [];
  });

const SOURCES = walk(path.join(DAEMON_ROOT, "src"))
  .map((file) => ({ file, literal: fs.readFileSync(file, "utf8").match(TS_LITERAL)?.[1] }))
  .filter((s): s is { file: string; literal: string } => Boolean(s.literal))
  .map((s) => ({ label: path.relative(DAEMON_ROOT, s.file), file: s.file, literal: s.literal }));

const extractTs = (file: string): string => {
  const m = fs.readFileSync(file, "utf8").match(TS_LITERAL);
  if (!m) throw new Error(`no SERVICE_RE literal found in ${file}`);
  return m[1];
};

const extractBash = (file: string): string => {
  const m = fs.readFileSync(file, "utf8").match(/^SERVICE_RE='(.+)'$/m);
  if (!m) throw new Error(`no SERVICE_RE assignment found in ${file}`);
  return m[1];
};

describe("every declaration agrees", () => {
  it("finds the TypeScript copies at all", () => {
    // Zero would make the next case pass vacuously; the count is deliberately a floor rather than
    // an exact number, since a new copy is not itself a defect — a diverging one is.
    expect(
      SOURCES.length,
      "no SERVICE_RE literal anywhere under daemon/src"
    ).toBeGreaterThanOrEqual(3);
  });

  it("the TypeScript copies are byte-identical", () => {
    const distinct = new Set(SOURCES.map((s) => s.literal));
    expect(
      Array.from(distinct),
      `copies disagree: ${SOURCES.map((s) => `${s.label}=${s.literal}`).join(" | ")}`
    ).toHaveLength(1);
  });

  it("the privileged helper's copy matches the daemon's", () => {
    // If the helper's pattern were ever narrowed, the daemon would happily send names the
    // helper then rejects — the failure would land after the runner is already registered
    // with GitHub, which is the expensive place to discover it.
    expect(extractBash(HELPER)).toBe(extractTs(SOURCES[0].file));
  });
});

describe("the shape it actually accepts", () => {
  const re = new RegExp(extractTs(SOURCES[0].file));

  it("accepts a real unit name", () => {
    expect(re.test("actions.runner.example-org-example-repo.runner-1.service")).toBe(true);
    expect(re.test("actions.runner.a_b.c@d.service")).toBe(true);
  });

  it("rejects anything with a path separator", () => {
    for (const bad of [
      "actions.runner.a/../../etc/passwd.service",
      "actions.runner.a/b.service",
      "actions.runner.a\\b.service"
    ]) {
      expect(re.test(bad), bad).toBe(false);
    }
  });

  it("rejects whitespace, which would split into extra argv entries downstream", () => {
    for (const bad of [
      "actions.runner.a b.service",
      "actions.runner.a\tb.service",
      "actions.runner.a\nb.service",
      " actions.runner.a.service",
      "actions.runner.a.service "
    ]) {
      expect(re.test(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("rejects a name that only looks like a systemctl option", () => {
    // querySystemd appends --property after the unit list, and systemctl's options are not
    // positional — an option-shaped entry would change the query.
    expect(re.test("--property=Nope")).toBe(false);
    expect(re.test("actions.runner.x.service --property=Nope")).toBe(false);
  });

  it("requires both the prefix and the suffix", () => {
    for (const bad of [
      "sshd.service",
      "actions.runner..service",
      "actions.runner.x.timer",
      "actions.runner.x",
      "prefix-actions.runner.x.service"
    ]) {
      expect(re.test(bad), bad).toBe(false);
    }
  });

  it("is anchored, so a newline cannot smuggle a second line past it", () => {
    // A non-anchored or multiline pattern would accept this; the $ must mean end-of-string.
    expect(re.test("actions.runner.x.service\nevil.service")).toBe(false);
  });
});

describe("readRunnerEnv enforces the boundary end to end", () => {
  const runnerDir = path.join(SCAN_ROOT, "env-repo", "runner-env");

  beforeAll(() => {
    fs.mkdirsSync(runnerDir);
    fs.writeFileSync(path.join(runnerDir, ".runner"), "{}");
  });

  it("refuses a directory outside the scan roots", () => {
    expect(() => readRunnerEnv("/etc")).toThrow(/只允许在扫描根下操作/);
  });

  it("refuses a directory that is not a runner", () => {
    const plain = path.join(SCAN_ROOT, "env-repo", "not-a-runner");
    fs.mkdirsSync(plain);
    expect(() => readRunnerEnv(plain)).toThrow(/不是 runner 目录/);
  });

  it("refuses a malformed unit name rather than passing it on", () => {
    // .service is attacker-writable if the runner account is compromised; reading it must
    // fail loudly instead of feeding the value to systemctl or to a path join.
    fs.writeFileSync(path.join(runnerDir, ".service"), "../../etc/evil.service");
    expect(() => readRunnerEnv(runnerDir)).toThrow(/非法的服务名/);
  });

  it("treats an absent .service as 'no unit installed', not as an error", () => {
    fs.removeSync(path.join(runnerDir, ".service"));
    expect(() => readRunnerEnv(runnerDir)).not.toThrow();
  });
});
