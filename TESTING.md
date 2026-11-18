# Testing Strategy

Rollout is tracked in [#20](https://github.com/pypto-tools/ci-panel/issues/20). This document is
the reference: tool choices, full config files, and the reasoning behind them.

## 1. Where we stand

- Four independent packages have vitest suites and type-check commands. See each package's
  `package.json` and `.github/workflows/ci.yml` for the current gates; counts change with each PR.
- Process scanning specs (`proc_scan_client`, `proc_scan_isolation`, `listener_index`,
  `proc_snapshot_sharing`) exercise bounded scheduling, fresh reads, failures and real workers.
  `node scripts/release/check-proc-worker.cjs <daemon-dir>` verifies the shipped worker and error
  recovery; release smoke tests run it too. Unit tests load worker TypeScript through ts-node.
- `frontend/` already has `vitest@0.33.0`, `@vue/test-utils@2.4.1` and `jsdom@22.1.0` installed,
  and `tsconfig.vitest.json` exists — **day one needs no install at all**.
- ci-panel is not a CRUD app but a remote-execution control plane: it holds GitHub PATs, spawns
  processes on operator machines, and hands the browser a file manager. So the suite is organised
  around **invariants whose violation is unrecoverable**, not around coverage.
- **v1.0.4 shipped three security fixes with no test covering any of them** (§2). Those regression
  tests are the first thing owed.

**Plan: install vitest per package (this is not an npm workspace), advance through five layers —
security-regression → contract → boundary-validation → pure-logic → router-integration — roughly
16–21 engineer-days to the stopping line.**

## 2. Defect regressions pinned by spec — **paid, Phases 1–2**

§2.1–2.3 are the three high-severity defects v1.0.4 fixed and released without a single test
(advisories GHSA-9c3v-fg72-8wr9, GHSA-j2c6-2pg4-jqqw, GHSA-5c23-gcwf-wjpr); §2.4 came later, from a
production incident. Read the specs rather than a description of them. What each really guards:

### 2.1 Wildcard condition matching — `common/src/query_wrapper.ts`

`LocalFileSource.selectPage` treats a value as a substring match only when it starts *and* ends
with `%`. The old leading-`%`-only form searched `slice(1, length - 1)`, so a bare `"%"` searched
for `""` and matched every record — and panel's `getUuidByApiKey` accepts on `total === 1`.
The `%needle%` form must keep working: `manage_user_router` builds `` `%${userName}%` `` for its
admin search and depends on it. Spec: `common/test/security/apikey_wildcard.spec.ts`, which also
states outright that this layer is **not** the auth boundary — the byte-for-byte re-check in
`getUuidByApiKey` is, and that is Phase 4.

### 2.2 Pagination guard — `common/src/query_wrapper.ts`

`paginate()` floors `page` and `pageSize`, then rejects a non-positive or non-finite result.
Before 1.0.4 both data sources ran `while (size > 0) { size -= pageSize }`, which never terminates
for `pageSize <= 0`. Fractional values *floor* rather than reject, deliberately: callers pass
query-string values through `Number()` only, and the old loop tolerated `1.5`.
Spec: `common/test/security/pagination_dos.spec.ts`. Also covers the caller-side clamp in
`daemon/src/routers/Instance_router.ts` — `toNumber("")` and `toNumber(0)` both yield `0`, which
`??` does not rescue.

> ⚠️ **`testTimeout` cannot rescue this one.** `withTimeout` in `@vitest/runner` is
> `Promise.race([fn(...args), new Promise(...setTimeout...)])`, and `fn(...args)` is evaluated
> *before* the racing promise is constructed — against a synchronous body the timer is never even
> scheduled. Revert the guard and the spec does not fail in 2s; it wedges the worker until
> something outside the process kills it. Hence `timeout -k 10 120` on the CI step, and hence the
> fix must always land **before** the spec.

### 2.3 Scan-root boundary — `runner_logs.ts`, `runner_scan.ts`

`assertUnderRoots` compares `realpathSync` results, so it catches symlink escapes as well as `..`,
and it runs ahead of every `fs.*` access **and on each derived path** (GHSA-5c23-gcwf-wjpr). The
derived-path cases are what a naive fix misses: `<runner>/_diag` can be a symlink out even when
`<runner>` is not, and so can a `*.log` inside it. Ordering matters too — the guard runs before
`fs.existsSync`, so an out-of-roots path is indistinguishable from a non-existent one rather than
becoming a probe for what exists on the host. Specs: `daemon/test/security/scan_roots.spec.ts`,
`diag_logs_boundary.spec.ts`, `collect_boundary.spec.ts`, `meta_file_boundary.spec.ts`.

Writing these turned up three further gaps in the same boundary; see Phase 2 below.

**Deliberately not covered:** symlink-replacement races (TOCTOU) between check and read — closing
that needs descriptor-relative no-follow operations across every file path in the daemon, or
isolating the runner account's write permissions at the deployment layer.

### 2.4 Truncated config and swallowed handler errors — `system_storage.ts`, `router_app.ts`

A full disk truncated a node's `data/Config/global.json` to zero bytes (`writeFileSync` applies
`O_TRUNC` before writing), nearly costing the daemon the key the panel authenticates with — and the
`ENOSPC` vanished, because an `async` handler signals failure by rejecting and `emitRouter`'s
`try/catch` only sees synchronous throws. No packet, no log line, an RPC timeout at the panel.
`StorageSubsystem` now writes a sibling temp file, `fsync`s and renames; `RouterApp.on` wraps each
handler so a rejection reaches `responseError`. Specs: `common/test/storage/atomic_write.spec.ts`
(its full-disk stand-in truncates *before* throwing — a mock that only threw would let the old code
pass) and `daemon/test/contract/router_error_response.spec.ts`.

## 3. Layers

| Layer | Scope | Packages | Size | Phase |
| --- | --- | --- | --- | --- |
| **security-regression** | path containment, PAT disclosure, auth bypass, sudo argument boundary, delete blast radius | common / daemon / panel | 12–16 files, ~60 cases | 1–2, 4 |
| **contract** | panel↔daemon protocol, i18n keys and placeholders, logic duplicated across packages (`labelKey`, `SERVICE_RE`) | all four | 5 files, 70 cases (delivered) | 3 |
| **boundary-validation** | the two edges the code itself calls untrusted: browser↔panel and panel↔daemon coercion and narrowing | common / daemon / panel | 8–10 files, ~50 cases | 1, 4 |
| **pure-logic** | marker idempotency, log tail offsets, systemd output parsing, version compare, env parsing | daemon / common / frontend | 15–20 files, ~120 cases | 0, 5 |
| **router-integration** | in-process socket RPC through the existing `routerApp.emitRouter` seam | daemon / panel | 4–6 files, ~35 cases | 5 (cuttable) |

Only **security-regression** may block a release on its own.

## 4. Tool choice

**vitest, installed per package** — this is not an npm workspace, and a spec's
`import ... from "vitest"` resolves from the package containing the file. Versions are pinned to
each package's installed TypeScript / `@types/node` floor:

| Package | TypeScript | @types/node | vitest | Why |
| --- | --- | --- | --- | --- |
| frontend | 5.1.6 | 18.19.130 | **`^0.33.0` (already installed)** | vite is pinned to 4.5.14; vitest ≥1.x needs vite ^5 |
| daemon | 5.9.3 | 22.20.0 | `^0.34.6` | |
| panel | 4.9.5 | 14.18.35 | `^0.34.6` | 1.x/2.x `.d.ts` assume TS 5 |
| common | 4.9.5 | 20.9.0 | `^0.34.6` | |

**Never write `pool` / `poolOptions` in any of the four configs** — those fields arrived in vitest
1.0. The installed 0.33 type definitions only carry `threads?: boolean`. The 0.3x spelling is
**`threads: false`** (main-thread execution, which is also what makes `process.chdir` usable).

**Rejected alternatives**, all checked against the real toolchain:

| Alternative | Why not |
| --- | --- |
| `node --test` | CI pins Node 20 — no type stripping. The code has 7 `enum` declarations and constructor parameter properties (non-erasable syntax), and there is no module-alias mechanism for `@languages` / `mcsmanager-common` |
| Jest / ts-jest | Would duplicate the webpack aliases via `moduleNameMapper` for no capability vitest lacks; frontend already has vitest, so a second framework means two mental models |
| Mocha | `@types/mocha@^8.2.2` was upstream residue — nothing in `daemon/src` referenced it, and it declared `describe`/`it` globals that would collide with vitest's. Removed in #24 rather than followed |
| One root vitest workspace | The toolchains are genuinely incompatible (panel on TS 4.9.5 + Node 14 typings vs daemon on TS 5.9 + Node 22); forcing one version breaks panel's type-checking |
| `vi.mock` on the heavy singletons | Fights the import-time side effects head-on and breaks on every dependency bump. Where a seam is needed, add a narrow port (setter / constructor parameter) and pass a hand-written fake |
| Specs colocated under `src/` | The webpack entry is `./src/app.ts`; a stray import would bundle a spec into production. Specs live in `panel/test/` and `daemon/test/`. frontend is the exception — `tsconfig.app.json` already excludes `src/**/__tests__/*` |
| `scan-useless-key` as the i18n gate | It always `process.exit(0)` (`scripts/useless-key-scanner.mjs:130`), so it can never fail. `npm run i18n` must stay out of CI entirely — its `customTransform` rewrites source files in place |
| Fixing panel/daemon lint alongside | Both eslint setups are broken (panel's 9.39.1 rejects its `.eslintrc.js`; daemon's 7.32.0 cannot parse TypeScript) and neither declares a `lint` script. That is its own PR |

## 5. Rollout

Every command notes its directory — **the four packages install separately**.

### Phase 0 — prove the loop, zero installs (half a day) — **done, #28**

frontend already had vitest, so nothing was installed and no production code touched. Added
`vitest.config.ts` + `vitest.setup.ts`, the `test` scripts, three specs under
`src/tools/__tests__/` (41 cases), and the CI `test` job.

Three decisions worth carrying forward: pin jsdom's URL (`protocol.ts` reads `window.location` in
every function, so the alternative is asserting against a version-dependent default or restating
`window.location.*` back at itself); `tsconfig.vitest.json` needs `"files": ["vitest.setup.ts"]`
because `files` merges with the inherited `include` where a second `include` would replace it; and
no `passWithNoTests`, which would turn a broken glob into a green job that ran nothing.

The defect it targets — `isCompressFile` offering "decompress" on volume 2 of a split archive —
was fixed ahead of the suite in #24, with the two `unref` calls (§7.1), the `redactTokenArgs`
extraction (§7.2) and the `@types/mocha` removal. Reverting the pre-#24 extension ordering reddens
two cases.

### Phase 1 — common, and the regressions owed by 1.0.4 (1 day) — **done, #29**

`common/` got vitest 0.34.6 with vite constrained to `^4.5.14` (0.34's peer range admits vite 5,
which prints a CJS-deprecation warning on every run; the range matches `frontend/`, so the repo
stays on one vite major), plus the §2.1 and §2.2 specs — 35 cases, no production code changed.

**Exit criteria met:** suite green; reverting the wildcard fix reddens 4 cases and the pageSize
guard 9; restoring the real pre-1.0.4 loop hangs until `timeout` kills it with exit 124.

> **Not in this phase:** moving `"typescript"` out of `common`'s `dependencies`. Genuinely
> misplaced — a build tool all three consumers inherit through `file:../common` — but unrelated to
> tests and on the release path (`build.sh` runs `npm install --production` in `production-code/`).
> Verifying it means the full `build.sh` → `pack.sh` → `smoke-test.sh` chain: its own PR.

### Phase 2 — daemon path boundary and secret redaction (3–4 days) — **done, #30**

`daemon/` got vitest plus `test/setup.ts` (a `/tmp` sandbox it chdirs into before any daemon module
loads) and `tsconfig.test.json` (the only thing covering `test/`; the build's tsconfig includes
`src/` alone). Six specs, 64 cases at the time. `service_name_boundary` asserts **all three** copies
of `SERVICE_RE` agree — `runner_scan.ts`, `runner_env.ts`, and `prod-scripts/ci-panel-runner-svc`.
The bash one is the real boundary, being the copy that runs as root, and nothing in the build would
notice if they drifted.

**Exit criteria met:** every §2.3 case passes including the symlink ones; `ProvisionError.fullLog`
provably redacts the token; `type-check` clean.

> **Corrections to §2.3, found by writing the specs.** The table described intent, not behaviour,
> in two places. Both fixed in the same PR.
>
> 1. *"a child of `base` is a symlink outside the roots → skipped with a reason"* —
>    `collectRunnerDirs` guarded only the root it was handed; the recursive descent had no check.
>    `statSync` / `readdirSync` / `isRunnerDir` all follow links, so one `<root>/<repo>/x -> /anywhere`
>    made the scan read that directory's `.runner` and report it as a normal runner, `errors` empty.
> 2. **Directory-level guarding is not enough, which the table did not consider.** The three metadata
>    files are writable by the runner's own account and `readFileSync` follows links.
>    `.runner -> <secret>` put its `gitHubUrl`/`agentName` into the list; against a non-JSON target,
>    Node's parse error embedded the first ~10 bytes and shipped them to the UI as `broken`; and
>    `.cipanel -> <anywhere>` made `hasMarker` true, which is what `registerRunners` and
>    `scanOneRunner` use to *skip* `assertUnderRoots`. New `metaFilePath` requires each metadata file
>    to resolve inside its own directory — deliberately not an `assertUnderRoots` call, since managed
>    runners may live outside the roots.
>
> A third, found in review: `assertUnderRoots` fell back to a lexical comparison for a missing path,
> so a not-yet-created child of an escaping symlink was accepted. Not reachable (`makeDir` requires
> its base to exist, and an existing base resolves through realpath), but the guard was leaning on a
> caller's `existsSync` to cover its own blind spot. It now resolves the deepest existing ancestor.
> Also: `collectFromRoots` **collects** the root rejection into `errors` rather than throwing, so
> `collectRunners("/etc") → throws` is really "returns no runners and one error".

### Phase 3 — contract layer (2–3 days) — **done**

Four contracts, none of which any compiler or build step was checking.

1. `common/test/contract/i18n_keys.spec.ts` — **the plan's numbers were stale**: it said 7
   untranslated ci-panel keys; there are 16, and ten of the eleven translations are missing the same
   set. Calibrated against the real catalogues rather than the plan: extra keys gated across all
   eleven (0 today), completeness on `zh_CN` only, placeholders on `zh_CN` + `zh_TW`. The rest is
   recorded as a known gap with an assertion that it has not *grown* — a gate that fails from its
   first commit gets ignored (§10).
   Placeholders keep their brace form: `{{x}}` is the backend's `$t()`, `{x}` the frontend's `t()`,
   and normalising them together would miss a changed brace count. It also catches a translated
   placeholder *name* — `th_TH` renders `{{seconds}}` as `{{วินาที}}`, so vue-i18n substitutes
   nothing and the number vanishes.
2. `common/test/contract/runner_protocol.spec.ts` — panel mined daemon's reply through
   `(result as { results?: RegisterRunnerResult[] })`, an assertion nothing checks: rename a field
   on the daemon side and the compiler stays silent while `registeredRepos` is permanently empty.
   Rather than restate that cast in a spec, the narrowing moved into `collectRegisteredRepoSlugs`
   beside the type declaration it depends on, and panel now calls it.
3. Deleted the duplicate `RunnerSource` in `runner_marker.ts`; it re-exports common's.
4. `labelKey` extracted to `frontend/src/tools/runnerNaming.ts`, with parity against the daemon copy
   asserted in `daemon/test/contract/label_key_parity.spec.ts` — textually *and* behaviourally.
   **Deliberately still two copies:** the frontend's imports from `mcsmanager-common` are all
   `import type` and erased at compile time; a value import would be the first, and the barrel
   re-exports `system_info` (a `setInterval`) and `system_storage` (fs), pulling node built-ins into
   the browser bundle. Divergence produces fleet-wide duplicate runner names, so the test is the
   price of that trade.

Phase 3 also gave `common/` the `tsconfig.test.json` + `type-check` script daemon got in Phase 2.
Without it the protocol spec's compile-time claim was hollow: `common`'s build tsconfig includes
`src/` alone and vitest transpiles through esbuild, so the whole suite could reference a renamed
export and stay green. Renaming `RegisterRunnersResponse` now reports the spec by name.

**Exit criteria met:** breaking each contract reddens it — drifting `labelKey` 1 case, renaming
`results` 5, dropping a `zh_CN` key 2, downgrading a `{{x}}` to `{x}` 1, and turning one frontend
`import type` into a value import 1.

### Phase 4 — panel authorization and remaining boundaries (4–5 days) — **done; this is the line**

`panel/` gets vitest, and with it every package now has a suite. Its config **must** set
`threads: false`: `common/src/system_storage.ts` computes `DATA_PATH` from `process.cwd()` at
*class-definition* time, so the store can only be redirected by `process.chdir` in the setup file —
and that throws inside a worker thread. `test.env` also blanks `CIP_GITHUB_REPOS` /
`CIP_GITHUB_TOKEN`: `repo_service.ts` calls `migrateFromEnv()` at module scope.

**`permission_middleware.spec.ts`** covers all four ways a request can be admitted — API key,
session, `token: false`, and a route that declares no `level` at all. Two behaviours worth knowing
are pinned rather than smoothed over: an API key **bypasses the CSRF and ajax checks entirely**
(an API request has no session to carry a token), and a route with no `level` skips authorisation
altogether because `isNaN(parseInt(String(undefined)))` is true.

**Three fixes.** Each was characterised before being made rather than after — none needed a
private advisory, but they are not all the same shape and the summary should not flatten them:

1. **SSRF in `/api/auth/proxy` — genuinely exploitable, by an ADMIN.** It called `axios.request`
   on a caller-supplied URL and returned the body: a working read primitive aimed at whatever the
   panel host can reach. The mitigating factor is the privilege bar, not the absence of a bug.
   Public rather than an advisory because an ADMIN can already point node connections at arbitrary
   hosts — but that argues about *marginal* gain, and reading the response exceeds it. `checkSafeUrl`
   already existed in `panel/` with **zero callers**; it is now wired in, plus `maxRedirects: 0` so
   a publicly-resolving host cannot 302 to loopback and bypass the check.
2. **`checkSafeUrl` existed twice and had drifted** — panel's had a protocol allow-list, daemon's
   did not, so `file/download_from_url` accepted `ftp://`. Both copies are now identical and
   pinned by `panel/test/security/safe_url.spec.ts`. The dead private-range block (unreachable
   because the IPv4 check above it already returns) is gone.
3. **`disk_limit_service` ran `du` through a shell — not exploitable as it stood.**
   `checkFilePath` blocked `"`, `$` and `` ` ``, which is exactly what can break out of the
   surrounding double quotes. But that conclusion needed *both* the quotes and the blacklist to
   hold; the argv form of `execFile` needs neither.

**`file_manager_paths.spec.ts`** documents the largest piece of standing authority in the daemon:
`isRootTopRath()` short-circuits `checkPath`, `isOutsideWorkspace` and the copy/move guard, and
`system_instance.ts` gives the built-in global instance `cwd: "/"`. That is intentional — the
global instance exists to give an operator a file browser on the host — but it is a lot resting on
one boolean, so it is pinned. Also documents that an absolute path is re-interpreted as
workspace-relative (`/etc/passwd` → `<workspace>/etc/passwd`) rather than rejected: containment
holds, but the client gets no error.

> **Two more of the same class, found in review.** Fix 1 had closed the panel half of the redirect
> bypass while leaving the daemon half open, and fix 2 had validated `url` but not its sibling:
> `fallbackUrl` reached `downloadFromUrl` unchecked (supply an unreachable `url` plus a
> `fallbackUrl` pointing at the metadata service and the daemon fetches it into the workspace),
> and `download_manager` still ran `maxRedirects: 10`. Both fixed here. daemon keeps redirects —
> downloads legitimately go through CDNs — but validates **每一跳** via `beforeRedirect`; panel's
> proxy has no legitimate redirect need, so it stays at 0.

**Exit criteria met:** every fix reddens on revert — dropping the proxy guard 1 case, following
redirects 1, re-introducing the daemon URL drift 2, loosening the API-key level check 3, removing
the ban logout 1, and comparing paths lexically instead of by realpath 1.

### Phase 5 — router integration and pure-logic breadth — **partly done**

Unlocked by a specific escaped bug, not by a plan — and §2.4 is that escape, so its first two items
landed with it: handler rejections now reach `responseError` instead of emitting nothing, and
`RouterApp` moved to `daemon/src/service/router_app.ts` so handlers are testable without the whole
daemon (`router.ts` re-exports it, leaving `app.ts` and every router untouched). What remains:

1. Export the private parsers in `runner_env.ts` / `runner_provision.ts` / `runner_scan.ts` (no
   behaviour change) and add pure-logic specs.
2. Upload coverage as an artifact — still no thresholds.

**Stopping rule: the line has been reached.** Phase 4 is done, so from here a new spec is added
only when a bug reaches master — failing test first, then the fix.

## 6. Config files

All four packages' vitest configs, setup files and `tsconfig.test.json` are now in the tree — read
them there. `TESTING_SETUP.md`, which held their contents while they were still being written, was
deleted when panel's landed, per its own rule: a checked-in config and a copy of it in prose will
drift, and the copy is the one nobody updates.

The non-obvious decisions each config encodes are recorded next to the phase that made them (§5).
The one that applies to every package: **`threads: false`**, for the reasons in §9.

## 7. Minimum refactors — all landed

Only what was required to unlock high-value tests; none changed behaviour.

**No barrel imports.** `require('common/dist/index.js')` used to never exit (exit 124) because
`index.ts` re-exports `system_info` and its `setInterval` was not `unref`'d. That timer and
`daemon/src/service/log.ts`'s were fixed in #24, but the import rule stands regardless: specs in
`common/` import the specific module, **never the barrel**, which drags in every consumer's side
effects for no benefit.

**`redactTokenArgs`** (#24) was extracted out of `runner_provision.ts` because testing inline logic
means restating it in the spec, and a spec that mirrors the implementation cannot detect a bug in
it. It matches by argument *position*, so renaming `--token` would silently stop redacting — which
is what `token_redaction.spec.ts` pins. Specs use placeholder tokens and `example-org/example-repo`
only: **this is a public repository**.

**Exports for Phase 5** (no behaviour change), if it is ever unlocked: the private parsers in
`runner_env.ts`, `runner_provision.ts` and `runner_scan.ts`.

## 8. CI

The **second job** — `test:` in [.github/workflows/ci.yml](.github/workflows/ci.yml) — landed with
Phase 0. As of Phase 4 it runs the whole block below — every suite and every type-check. The
existing `build:` job stays
byte-identical: it is the current release gate and must not be slowed or destabilised by
test-install variance.

Its first three steps (`actions/checkout@v4`, `actions/setup-node@v4` with its five-line
`cache-dependency-path`, and `Install dependencies: npm install`) are **byte-identical to the
`build:` job**. The root `npm install` lifecycle script chains install-dependents and preview-build,
so that one command provisions every package's devDependencies including vitest.

The block below is the **target state** once every phase has landed — add each step in the phase
that gives its package a suite, never ahead of it:

```yaml
      - name: Build common          # guard for the day the preview-build hook goes away
        run: npm run build --prefix common

      # `timeout` is load-bearing here, not redundant: reverting the pagination guard hangs the
      # worker synchronously, where vitest's own testTimeout never even gets scheduled (§2.2).
      - name: Test common           # carries the formerly-exploitable defects; fails fastest
        run: timeout -k 10 120 npm run test --prefix common

      # Also wrapped: these specs walk /proc and can reach systemctl, so a wedge
      # here would otherwise burn the job's whole default timeout.
      - name: Test daemon
        run: timeout -k 10 300 npm run test --prefix daemon

      # panel's suite will drive Koa middleware; same wrapper, so one wedged
      # request cannot burn the job.
      - name: Test panel
        run: timeout -k 10 300 npm run test --prefix panel

      - name: Test frontend
        run: npm run test --prefix frontend

      # panel/daemon tsconfig include does not cover test/, so webpack never sees a spec.
      - name: Type-check common (incl. tests)
        run: npm run type-check --prefix common

      - name: Type-check daemon (incl. tests)
        run: npm run type-check --prefix daemon

      - name: Type-check panel (incl. tests)
        run: npm run type-check --prefix panel

      - name: Upload coverage
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: coverage
          path: |
            common/coverage/lcov.info
            daemon/coverage/lcov.info
            panel/coverage/lcov.info
            frontend/coverage/lcov.info
          if-no-files-found: ignore
```

Two prerequisites. **Add the steps one phase at a time** — a `Test <pkg>` step must not land before
that package has a suite. And `passWithNoTests: true` is a temporary crutch: a config needs it only
in the window between adding the package's `test` script and writing its first spec (an empty suite
exits 1). **Drop it in the same commit as the first spec** — kept afterwards, it turns a broken
`include` glob into a green job that ran nothing. frontend's config does not have it.

**`release.yml` needs no change.** Its gate is `pack.sh` + `smoke-test.sh` + Playwright. Unit tests
belong on the PR path; the tag path would only get slower, and `release.yml` holds
`contents: write`, so its dependency surface should stay narrow.

## 9. Coverage and gating

| | Initially | After Phase 4 |
| --- | --- | --- |
| Coverage threshold | **none** — lcov uploaded as an artifact only | line coverage ≥60% on `common/src` and `daemon/src/service/runner_*` |
| Blocks merge | security-regression layer + all `type-check` | same, plus the contract layer |
| Blocks release (`release.yml`) | no | no |
| Suite runtime budget | — | < 3 min on ubuntu-latest |

**Why no threshold at first:** a risk-first order concentrates the cases in a handful of files and
leaves `frontend/` (33.6K lines) almost untouched. Any threshold would either fail at once or be
meaningless, and ratcheting early pushes effort toward easily-covered formatters.

**Every package sets `threads: false`.** Not a preference — tinypool sizes its worker pool from the
CPU count, and these suites are a handful of files whose assertions run in milliseconds, so the
entire wall time is worker startup. Measured on a 320-core machine:

| Package | default | `threads: false` |
| --- | --- | --- |
| `common` (2 files, 34 cases at the time) | 106s | **1.1s** |
| `frontend` (3 files, 41 cases) | 84s | **3.6s** |

(Measured during Phase 1; the case counts have grown since. Left as taken — the ratio is the point.)

On GitHub's 4-core `ubuntu-latest` the default is survivable (frontend measured 56s), but this
project provisions self-hosted runners — the day the `test` job moves onto a big one, `Test common`
blows through its `timeout -k 10 120` and dies with **exit 124, the same code the infinite-loop
regression produces**. A green suite failing indistinguishably from the defect the watchdog catches
is the worst failure mode, and one line prevents it.

The cost is a shared process: module-level singletons persist across spec files. Nothing relies on
per-file module isolation today; do not start. (`common/test/storage/` is the one file that chdirs,
and it restores the working directory in `afterAll` for exactly this reason.)

## 10. Trade-offs, and what we deliberately skip

- **Testing the daemon means importing the daemon.** `runner_scan.ts` / `runner_provision.ts`
  transitively import the `InstanceSubsystem` singleton, whose constructor does `fs.mkdirsSync`.
  The `test/setup.ts` chdir and the `.unref()` calls **contain** that rather than remove it; the real
  fix (narrow `HandleInstanceStore` / `runner_exec` ports) is deferred to Phase 5, being bigger than
  the security tests it would unlock.
- **Aliasing to source is a deliberate asymmetry.** daemon and panel test `common/src` while the
  frontend build consumes `common/dist`. A change that breaks the built output but not the source
  would pass the daemon suite — the `Build common` CI step exists for exactly that.
- **The i18n gate is narrower than it looks.** Ten of the eleven translations are missing the same
  **16** ci-panel keys (the plan said 7; measured in Phase 3), and 9 of 11 have placeholder
  mismatches (ru_RU 19, pt_BR 18, es_ES 16, fr 14, tr 13, de 10, ko 8, ja 6, th 2). Completeness is
  therefore scoped to **zh_CN alone** and placeholders to **zh_CN + zh_TW** — better a weak gate
  that is green from the first commit than a strong one that goes red and gets ignored. The 16 are
  listed explicitly in the spec, so adding an English-only key is a reviewable one-line declaration
  rather than a bumped counter.
- **Router integration is the likeliest casualty** (it needs the `router_app.ts` split and an
  await-aware `emitRouter`, both touching ten router files). Cutting it leaves the daemon's worst
  defect — an async handler rejection emits nothing and hangs the panel's request — uncovered.

| Skipped | Why |
| --- | --- |
| E2E / browser tests | `scripts/release/smoke-test.sh` + `browser-check.mjs` already boot the stack and run Playwright on the release path. The risks this plan targets — path traversal, token leakage, protocol drift — are caught more deterministically at the unit and contract layers |
| Broad Vue component mounting | Most of the 205 files are presentational; xterm / monaco / echarts / codemirror need heavy stubs for very little return. Test the extracted pure functions instead |
| Pure-function specs for panel | Its only pure function, `checkSafeUrl` (`utils/url.ts:5`), currently has **zero callers**. panel's real logic is Koa-middleware shaped — test the middleware |
| Lint gate / snapshot tests | The former needs a dependency migration (both eslint setups are broken); the latter produces "changed, so update it" ritual and catches none of the risks here |

## 11. How to verify the setup itself

Run each of these rather than assuming.

1. **Run every suite, then build and type-check every package** (note the prefix). This is the
   whole gate, not a subset of it:

   ```bash
   npm run build --prefix common           # FIRST: frontend resolves common/dist, so its
                                           #   suite is meaningless against a stale build
   timeout -k 10 120 npm run test --prefix common
   timeout -k 10 300 npm run test --prefix daemon
   timeout -k 10 300 npm run test --prefix panel
   npm run test --prefix frontend

   npm run type-check --prefix common      # these three also cover their test/ dirs
   npm run type-check --prefix daemon
   npm run type-check --prefix panel
   npm run type-check --prefix frontend    # covers src/**/__tests__ via tsconfig.vitest.json;
                                           #   also runs inside `build --prefix frontend`
   npm run lint --prefix frontend          # only package with lint; rewrites files (--fix)

   npm run build --prefix panel
   npm run build --prefix daemon
   npm run build --prefix frontend         # this is run-p type-check build-only
   ```

2. **Prove the loop:** in each package with a suite, first write an assertion that must fail and confirm it
   **does**, then correct it. A test that passes against broken code tests nothing.
3. **Handle leaks:** `cd daemon && npx vitest run --reporter=verbose` and confirm the process exits
   on its own. If it hangs, some `setInterval` is missing `.unref()` (§7.1).
4. **Sandbox:** after the daemon suite, `git status` must be clean. A `logs/` or `data/` directory
   means the `test/setup.ts` chdir did not take effect.
5. **Reverting a 1.0.4 fix must turn a spec red** — the only real proof the §2 specs work. Check
   once per spec, then restore.
6. **i18n:** confirm new `TXT_CODE_*` keys resolve in the UI rather than rendering as raw keys.
