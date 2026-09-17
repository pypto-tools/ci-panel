# Writing a ci-panel plugin

Practical guide. The specification is [plugin-contract.md](plugin-contract.md); read it for field
semantics. This file is about the workflow.

> **Status.** The manifest schema and its validator are implemented, so §2 and §3 work today.
> §4 onward describes the install and run loop, which **does not exist yet** — the daemon loader,
> the panel routes and the frontend renderer are Stage 1 of
> [issue #7](https://github.com/pypto-tools/ci-panel/issues/7). You can write and validate a
> manifest now; you cannot yet install one.

## 1. What you are building

Two things:

1. **A manifest** (`plugin.json`) declaring what your plugin serves and how it should be shown.
2. **A program** that serves a couple of HTTP endpoints over a unix socket.

You are not building a ci-panel module. Your code never runs inside ci-panel — not in the panel,
not in the daemon, not in the browser. Any language works; the only requirement is that it can
bind a unix socket and speak HTTP.

You also do not write any UI code. The manifest says "render this data source as a table"; the
table is ci-panel's.

## 2. The shape of a plugin directory

```
acme-approval/
├── plugin.json        the manifest
└── bin/
    └── server         whatever `runtime.entry` points at
```

`runtime.entry` is relative to the plugin directory. Absolute paths and `..` segments are
rejected.

## 3. Validate before you ship

ci-panel's own validator is exported, so you run exactly the checks it will run.

> **It is not on npm yet.** The `mcsmanager-common` package on the public registry belongs to
> upstream MCSManager, which ci-panel is a fork of; it does not contain any of this. Publishing a
> plugin SDK is part of Stage 1. Until then, build it from a checkout:
>
> ```bash
> git clone https://github.com/pypto-tools/ci-panel.git
> cd ci-panel && npm run preview-build     # builds common/ into common/dist
> ```

```ts
// point the import at your checkout until the SDK is published
import { validatePluginManifest } from "../ci-panel/common/dist/index.js";
import { readFileSync } from "node:fs";

const result = validatePluginManifest(JSON.parse(readFileSync("plugin.json", "utf8")));
if (!result.ok) {
  console.error(result.errors.join("\n"));
  process.exit(1);
}
```

It reports every problem at once, so one editing round should clear them all.

The mistakes it most often catches:

| Message | Cause |
| --- | --- |
| `unknown top-level field: actions` | declaring an extension point this contract does not have (§5 of the contract) |
| `unknown field: views[0].chart` | same thing one level down |
| `id must match …` | uppercase, underscores, or a leading/trailing hyphen in the plugin id |
| `version must be a semver 2.0 string` | `v1.2.3`, `1.2`, or an empty prerelease identifier like `1.2.3-alpha..1` |
| `… must be an i18n key` | literal display text where a key belongs |
| `i18n.en_US.X must be a string under 512 chars with no { } @ \|` | vue-i18n message syntax in a translation |
| `views[0].source references unknown data: …` | a typo'd cross-reference between manifest sections |

## 4. Implementing the endpoints

> Pending Stage 1 — the daemon that calls these does not exist yet.

Bind `plugin.sock` inside the directory systemd gives you, and do **not** chmod it:

```js
const path = `${process.env.RUNTIME_DIRECTORY}/plugin.sock`;
server.listen(path);
```

Permissions are set by the unit. Loosening them from inside the plugin would widen the socket to
every local process, including CI jobs sharing the node.

Persistent state goes in `process.env.STATE_DIRECTORY`, which is private to your plugin. Do not
write anywhere else; the unit is sandboxed and most paths are read-only.

Two endpoints in contract 1:

```
GET /v1/health              → { status: "ok" | "degraded" | "unknown", contract: 1 }
GET /v1/data/:dataId        → { rows: [ { column: { kind: "text", value: "…" } } ] }
```

Return `unknown` from health when the host lacks something you need, rather than an error.
It is a distinct state precisely because "this host does not have the tooling" is the common
case, and it should be reported and explained rather than counted as a crash.

Every cell is a tagged value, never a bare string — see §4.4 of the contract. If you find
yourself wanting to return markup, the answer is a different cell `kind`, not HTML.

## 5. Text and translations

Every user-visible string is an i18n key declared in your manifest, never literal text in a
payload. ci-panel merges your catalogue under a namespace derived from your id, so
`"NAME"` becomes `plugin__acme_approval__NAME` and cannot collide with ci-panel's own keys or
another plugin's.

Error text works the same way: you return a code, ci-panel renders it. A plugin cannot put
arbitrary text on a ci-panel page. This is not a restriction on wording — declare as many keys as
you like — it is what keeps a plugin from injecting content into someone else's origin.

## 6. Things that will be rejected, and why

| You might try | What happens | Why |
| --- | --- | --- |
| HTML in a cell value | rendered as visible text | cells are escaped; the renderer never parses markup |
| `"height": "100px"` | manifest rejected | height is a name (`MEDIUM`), not a CSS value you control |
| a regex in the manifest | no field accepts one | a supplied pattern is a ReDoS primitive aimed at a single-threaded panel |
| chmod on your socket | works, but do not | it widens access to every local process |
| writing outside `STATE_DIRECTORY` | fails | the unit is sandboxed |
| an `actions` block | manifest rejected | not in contract 1; rejection is deliberate so you find out now |

## 7. Local development

> Pending Stage 1. There is no install path and no dev loop yet.

Until there is, what you can do today: write the manifest, validate it with §3, and build your
server against the endpoint shapes in §4. The payload types are exported as TypeScript types from
the same build as the validator (§3), so you can type your responses against the very declarations
ci-panel uses rather than a transcription of them.

---

See [plugin-operations.md](plugin-operations.md) for how your plugin will be hosted and what
contains it.
