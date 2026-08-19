import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  collectRegisteredRepoSlugs,
  type RegisterRunnerResult,
  type RegisterRunnersResponse,
  type RunnerOwnership,
  type RunnerRunState,
  type RunnerRuntimeState,
  type SupervisorAction,
  type SupervisorKind
} from "../../src/runner_protocol";

// panel forwards daemon's runner/register reply and mines it for repo slugs to auto-register.
// RemoteRequest returns `unknown`, so panel used to write
//   (result as { results?: RegisterRunnerResult[] })?.results
// — an assertion nothing checks. Rename a field on the daemon side and the compiler stays silent,
// `results` is undefined at runtime, the loop never runs, and `registeredRepos` is permanently
// empty: the repo list keeps showing "unmanaged" with no error anywhere.
//
// The narrowing now lives beside the type declaration it depends on, and this pins both.

const REPO = "example-org/example-repo";
const OTHER = "example-org/other-repo";

const ok = (dir: string, repo: string): RegisterRunnerResult => ({ dir, ok: true, repo });

describe("the happy path panel actually depends on", () => {
  it("collects the repo of every successful item", () => {
    const payload: RegisterRunnersResponse = {
      results: [ok("/r/a", REPO), ok("/r/b", OTHER)]
    };
    expect(collectRegisteredRepoSlugs(payload).sort()).toEqual([OTHER, REPO].sort());
  });

  it("deduplicates — several runners usually share one repo", () => {
    const payload: RegisterRunnersResponse = {
      results: [ok("/r/a", REPO), ok("/r/b", REPO), ok("/r/c", REPO)]
    };
    expect(collectRegisteredRepoSlugs(payload)).toEqual([REPO]);
  });
});

describe("what must NOT be collected", () => {
  it("skips failed items", () => {
    // A failed item's repo may be the caller-supplied fallback rather than the slug daemon read
    // from .runner. Registering that produces a registry key that never matches managed_list.
    const payload: RegisterRunnersResponse = {
      results: [{ dir: "/r/a", ok: false, repo: REPO, error: "boom" }, ok("/r/b", OTHER)]
    };
    expect(collectRegisteredRepoSlugs(payload)).toEqual([OTHER]);
  });

  it("skips successful items with no repo", () => {
    // daemon leaves `repo` unset when it could not parse .runner.
    const payload: RegisterRunnersResponse = {
      results: [{ dir: "/r/a", ok: true }, ok("/r/b", REPO)]
    };
    expect(collectRegisteredRepoSlugs(payload)).toEqual([REPO]);
  });

  it("skips an empty-string repo", () => {
    expect(collectRegisteredRepoSlugs({ results: [{ dir: "/r/a", ok: true, repo: "" }] })).toEqual(
      []
    );
  });

  it("treats a truthy-but-not-true ok as a failure", () => {
    // `ok` is declared boolean; anything else means the payload is not what it claims to be.
    expect(collectRegisteredRepoSlugs({ results: [{ dir: "/r/a", ok: 1, repo: REPO }] })).toEqual(
      []
    );
  });
});

describe("it survives a payload that is not the shape it claims", () => {
  // The whole reason this is a function rather than a cast: the input is `unknown` off the wire.
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a string", "nope"],
    ["a number", 42],
    ["an empty object", {}],
    ["results missing", { registeredRepos: [] }],
    ["results not an array", { results: "nope" }],
    ["results null", { results: null }],
    ["an array of junk", { results: [null, undefined, 7, "x", []] }]
  ])("returns [] for %s", (_label, payload) => {
    expect(collectRegisteredRepoSlugs(payload)).toEqual([]);
  });

  it("does not throw on a nested null", () => {
    expect(() => collectRegisteredRepoSlugs({ results: [null] })).not.toThrow();
  });
});

describe("the field names are the contract", () => {
  // These read as tautologies but are not: they are what makes a daemon-side rename fail here
  // instead of silently at runtime. The literal strings are the point.
  it("reads the list from `results`", () => {
    expect(collectRegisteredRepoSlugs({ results: [ok("/r/a", REPO)] })).toEqual([REPO]);
    // The same payload under any other key yields nothing — which is exactly the silent failure
    // the old cast produced.
    expect(collectRegisteredRepoSlugs({ items: [ok("/r/a", REPO)] })).toEqual([]);
    expect(collectRegisteredRepoSlugs({ runners: [ok("/r/a", REPO)] })).toEqual([]);
  });

  it("reads `ok` and `repo` from each item", () => {
    expect(
      collectRegisteredRepoSlugs({ results: [{ dir: "/r/a", success: true, repo: REPO }] })
    ).toEqual([]);
    expect(
      collectRegisteredRepoSlugs({ results: [{ dir: "/r/a", ok: true, slug: REPO }] })
    ).toEqual([]);
  });

  it("keeps RegisterRunnersResponse assignable to what the function accepts", () => {
    // A compile-time check with a runtime tail. `npm run build --prefix common` does NOT cover
    // this — its tsconfig includes `src/**/*` only, and vitest transpiles through esbuild without
    // type-checking. `npm run type-check --prefix common` (tsconfig.test.json) is what sees it;
    // verified by renaming the interface, which reports this exact line.
    const response: RegisterRunnersResponse = { results: [], registeredRepos: [] };
    expect(collectRegisteredRepoSlugs(response)).toEqual([]);
  });
});

// The supervision protocol is consumed by three packages that ship separately. These pins are
// about the shape surviving a rename: the frontend renders label tables keyed by these unions,
// and daemon's registry is a Record over SupervisorKind, so a quiet member change reaches users
// as an unlabelled tag or a backend that stops being reachable.
describe("the supervision axes", () => {
  it("keeps intent and observation as two separate unions", () => {
    // Exhaustive by type: adding a member reddens the object, which is the point — the same edit
    // has to add a registry row on the daemon side and a label on the frontend side.
    const KINDS: Record<SupervisorKind, true> = { systemd: true, none: true };
    const OWNERSHIP: Record<RunnerOwnership, true> = {
      self: true,
      foreign: true,
      conflict: true,
      idle: true,
      unknown: true
    };
    expect(Object.keys(KINDS).sort()).toEqual(["none", "systemd"]);
    // "unknown" is load-bearing: it is what keeps a failed observation from reading as "idle",
    // which is the one value that lets a start through.
    expect(Object.keys(OWNERSHIP)).toContain("unknown");
  });

  it("keeps the run state a closed set", () => {
    // A free-form string would have every consumer string-matching per backend.
    const STATES: Record<RunnerRunState, true> = {
      running: true,
      starting: true,
      stopping: true,
      stopped: true,
      failed: true,
      unknown: true
    };
    expect(Object.keys(STATES)).toHaveLength(6);
  });

  it("keeps the field names the panel and frontend read", () => {
    const rt: RunnerRuntimeState = {
      supervisor: "systemd",
      ownership: "self",
      running: true,
      state: "running",
      detail: "",
      since: "",
      busy: false,
      raw: { service: "actions.runner.x.service" }
    };
    expect(Object.keys(rt).sort()).toEqual(
      ["busy", "detail", "ownership", "raw", "running", "since", "state", "supervisor"].sort()
    );
    // raw is display-only by contract, so it is deliberately untyped per backend — which is
    // exactly why nothing may branch on it.
    expect(typeof rt.raw?.service).toBe("string");
  });

  it("no longer declares a systemd-shaped state in the protocol", () => {
    // Keeping it would leave a systemd-shaped hole the next backend has nowhere to fit into. The
    // four fields live in raw now; the compat copy that the daemon backfills for a not-yet-
    // upgraded panel is deliberately a separate, deprecated type.
    const src = fs.readFileSync(path.resolve(__dirname, "../../src/runner_protocol.ts"), "utf8");
    expect(src).not.toMatch(/export interface SystemdState\b/);
    expect(src).toMatch(/export interface SystemdStateCompat\b/);
    const index = fs.readFileSync(path.resolve(__dirname, "../../src/index.ts"), "utf8");
    expect(index).not.toMatch(/\bSystemdState\b(?!Compat)/);
  });

  it("keeps the action union stable across the rename", () => {
    // SupervisorAction is the new name; the wire values must not move, or a new panel talking to
    // an old daemon (and the reverse) silently stops controlling anything.
    const ACTIONS: Record<SupervisorAction, true> = { start: true, stop: true, restart: true };
    expect(Object.keys(ACTIONS).sort()).toEqual(["restart", "start", "stop"]);
  });
});
