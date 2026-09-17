# Plugin contract, version 1

Normative reference for anyone writing a ci-panel plugin. Design rationale lives in
[issue #7](https://github.com/pypto-tools/ci-panel/issues/7); this file is the specification.

> **Status.** The manifest schema, payload shapes and version negotiation in this document are
> **implemented and frozen** in `common/src/plugin_protocol.ts` — that file is the source of
> truth, and the contract spec (`common/test/contract/plugin_manifest.spec.ts`) pins it. The
> transport section is **specified but not yet implemented**; the loader that consumes it lands
> with Stage 1. Nothing in ci-panel reads a plugin today.

## 1. What a plugin is

A plugin is an **independent process** plus a **declarative manifest**. It is never code that
ci-panel loads. No plugin code runs inside the panel process, the daemon process, or the
browser's ci-panel origin.

The plugin implements a small, fixed RPC surface. ci-panel defines it; every plugin implements
the same one. A plugin contributes data and declares how it should be displayed; ci-panel owns
every renderer.

## 2. Version negotiation

`contract` is a **monotonic integer**, not semver. semver's comparison rules answer "are these
compatible", which they cannot actually answer here; all that is needed is a total order and a
supported window.

| Constant | Value | Meaning |
| --- | --- | --- |
| `PLUGIN_CONTRACT_CURRENT` | `1` | the newest contract this ci-panel understands |
| `PLUGIN_CONTRACT_MIN_SUPPORTED` | `1` | the oldest still accepted |

`checkContract(declared)` returns one of four verdicts, because the operator response differs:

| Verdict | Condition | What the operator must do |
| --- | --- | --- |
| `ok` | inside the window | nothing |
| `too-new` | `declared > CURRENT` | upgrade ci-panel |
| `too-old` | `declared < MIN_SUPPORTED` | upgrade the plugin |
| `malformed` | not an integer | fix the manifest |

Do not reimplement this as an equality test. `!==` collapses `too-new` and `too-old` into one
answer, and their remedies are opposite.

**Compatibility policy.** Adding a field that older plugins may omit does not bump the integer.
Anything that would invalidate an existing plugin bumps `CURRENT` and, after a deprecation
window, raises `MIN_SUPPORTED`. The *accepted input set* is frozen too: loosening what a field
accepts is safe later, tightening it is a breaking change.

## 3. Manifest

One JSON document, `plugin.json`. Unknown fields are **rejected, not ignored** — at the top level
and one level down. A plugin declaring something this version cannot honour fails loudly instead
of silently doing nothing.

### 3.1 Top level

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `contract` | integer | yes | see §2 |
| `id` | string | yes | `^[a-z0-9]+(-[a-z0-9]+)*$`, 1–64 chars |
| `version` | string | yes | SemVer 2.0, ≤64 chars |
| `displayName` | string | yes | an i18n key, not literal text |
| `runtime` | object | yes | §3.2 |
| `data` | array | yes | non-empty, §3.3 |
| `views` | array | yes | non-empty, §3.4 |
| `cards` | array | no | §3.5 |
| `pages` | array | no | §3.6 |
| `i18n` | object | no | §3.7 |

The `id` is also the directory name, a segment of the systemd unit name, the i18n key prefix, and
a key in objects keyed by plugin. Its alphabet is therefore narrower than "valid filename": no
uppercase, no underscores, no leading or trailing hyphen, no doubled hyphen. The names
`__proto__`, `constructor` and `prototype` are rejected everywhere an identifier is accepted.

### 3.2 `runtime`

```jsonc
"runtime": {
  "kind": "process",              // the only value in contract 1
  "entry": "bin/server",          // relative to the plugin directory; no leading /, no ..
  "limits": {                     // optional; each a positive integer
    "memoryMB": 256,
    "cpuPercent": 25,
    "tasks": 128
  }
}
```

`limits` become `MemoryMax=`, `CPUQuota=` and `TasksMax=` on the generated unit. ci-panel clamps
the upper bound; the manifest does not get the last word.

`"container"` will join the `kind` union if node-hosted containers are ever supported. It will be
a new member of that union, not a new field.

**How the host runs your process is not your concern, with one exception.** A node where the
systemd backend is available runs it as a unit with a transient uid; other nodes run it
differently. You
bind the socket path you are given and write to the state directory you are given either way. The
exception is that a node which can provide no isolation at all will refuse to host a plugin
declaring secrets, so such a plugin is simply unavailable there rather than running unprotected.
See [plugin-operations.md](plugin-operations.md) §4.

### 3.3 `data` — what the plugin serves

```jsonc
"data": [{ "id": "pending", "refresh": 30000 }]
```

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string | yes | `^[a-z0-9]+([-_][a-z0-9]+)*$`, unique within the array |
| `refresh` | number | no | poll interval in ms; ci-panel clamps it to a floor |

Each entry corresponds to one `GET /v1/data/:dataId` endpoint the plugin must serve.

### 3.4 `views` — how it is rendered

```jsonc
"views": [{ "id": "queue", "render": "table", "source": "pending", "columns": ["repo", "age"] }]
```

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string | yes | unique within the array |
| `render` | enum | yes | `table` · `kv` · `list` · `stat` · `chart` |
| `source` | string | yes | must name an existing `data[].id` |
| `columns` | string[] | no | column order for `table`; ignored by other kinds |

There is no `form` kind. A form is an action payload editor, and actions do not exist in
contract 1.

### 3.5 `cards`

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string | yes | unique within the array |
| `view` | string | yes | must name an existing `views[].id` |
| `title` | string | yes | an i18n key |
| `width` | integer | no | 1–12, the grid column count |
| `height` | enum | no | `MINI` · `SMALL` · `MEDIUM` · `BIG` · `LARGE` · `AUTO` |

`height` is a **name**, not a CSS value. A free string there would put a plugin-supplied value
straight into a style attribute.

### 3.6 `pages`

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string | yes | unique within the array |
| `title` | string | yes | an i18n key |
| `layout` | string[] | yes | non-empty; each entry names an existing `cards[].id` |

There is no `path` field. The route is derived as `/plugin/<pluginId>/<pageId>`; a manifest
cannot choose an arbitrary path.

### 3.7 `i18n`

```jsonc
"i18n": {
  "en_US": { "NAME": "Approval queue", "CARD_TITLE": "Pending approvals" },
  "zh_CN": { "NAME": "审批队列", "CARD_TITLE": "待审批" }
}
```

Keys match `^[A-Za-z0-9_]{1,64}$`. At runtime they are namespaced as
`plugin__<id_with_hyphens_as_underscores>__<KEY>` — for example `plugin__acme_approval__NAME`.

**Underscores, never dots.** vue-i18n resolves a dot as a path into a nested object, so a dotted
key falls back to rendering the raw key name.

Values must be **≤512 characters and must not contain `{`, `}`, `@` or `|`**. Those are vue-i18n
message syntax: `@:KEY` splices another catalogue entry into the output, `|` cuts plural
branches, and an unbalanced brace throws during *render*, which blanks the page rather than
failing at load.

## 4. Transport

> **Not yet implemented.** Specified here so plugin authors can build against it; the daemon side
> lands with Stage 1.

The plugin listens on a **unix domain socket**, not a TCP port. The path is supplied by systemd
through `RuntimeDirectory`, so the plugin reads `$RUNTIME_DIRECTORY` and binds
`plugin.sock` inside it. It must not chmod the socket — permissions are set by the unit.

A unix socket is used because it removes addressing entirely: there is no host and no URL, so
nothing for an SSRF redirect or a DNS rebind to point at, and no local port for another process
to squat before the plugin starts.

Persistent state belongs in `$STATE_DIRECTORY`, which is private to the plugin.

### 4.1 Endpoints

Every plugin implements the same four. HTTP over the unix socket.

```
GET  /v1/health                → PluginHealthPayload
GET  /v1/data/:dataId?params   → PluginDataPayload
```

`POST /v1/action` and `POST /v1/event` are **not part of contract 1**. They arrive with the
action and event-hook extension points, as contract 2.

### 4.2 Envelope

```ts
type PluginReply<T> =
  | { status: "ok";    data: T }
  | { status: "error"; code: PluginErrorCode; detail?: string };
```

`detail` is for logs and the admin view only. It is never rendered into the UI — a plugin cannot
put text on a ci-panel page except through an i18n key it declared.

### 4.3 Health

```ts
{ status: "ok" | "degraded" | "unknown", contract: number, detail?: string }
```

`unknown` is a deliberate third state. The common case is not that the plugin is broken but that
the host lacks something it needs; that should be visible and explained rather than counted as a
failure that drives restart backoff.

### 4.4 Data

```ts
{ rows: Array<Record<string, PluginCell>> }
```

A cell is a **tagged union**, never a bare string:

```ts
type PluginCell =
  | { kind: "text";   value: string }
  | { kind: "number"; value: number }
  | { kind: "badge";  value: string; tone: "neutral"|"info"|"success"|"warning"|"danger" }
  | { kind: "link";   value: string; href: string };
```

This makes the renderer a total switch, so no plugin-supplied value has a path into markup.
`href` is additionally checked against a scheme allowlist by ci-panel.

### 4.5 Error codes

`PLUGIN_NOT_INSTALLED` · `PLUGIN_DISABLED` · `PLUGIN_UNREACHABLE` · `PLUGIN_TIMEOUT` ·
`PLUGIN_CONTRACT_MISMATCH` · `PLUGIN_BAD_PAYLOAD` · `PLUGIN_BAD_REQUEST` · `PLUGIN_INTERNAL`

ci-panel normalises whatever a plugin returns into this closed set before anything reaches a
browser.

## 5. What contract 1 does not include

Rejected outright, so that declaring one fails loudly:

- **Actions** — buttons that do something
- **Event hooks** — reacting to runner or node changes
- **Callbacks** — a plugin asking ci-panel to do something
- **Secrets** — credentials for the plugin's own outbound integrations
- **Custom UI code** — a plugin ships no JS; UI is declarative and rendered by ci-panel

Each is designed in #7 and gated behind its own trigger. They arrive as contract 2 or later.

## 6. Worked example

```jsonc
{
  "contract": 1,
  "id": "acme-approval",
  "version": "0.1.0",
  "displayName": "NAME",

  "runtime": {
    "kind": "process",
    "entry": "bin/server",
    "limits": { "memoryMB": 256, "cpuPercent": 25, "tasks": 128 }
  },

  "data": [{ "id": "pending", "refresh": 30000 }],

  "views": [
    { "id": "queue", "render": "table", "source": "pending",
      "columns": ["repo", "requester", "age"] }
  ],

  "cards": [
    { "id": "queue_card", "view": "queue", "title": "CARD_TITLE",
      "width": 6, "height": "MEDIUM" }
  ],

  "pages": [
    { "id": "main", "title": "PAGE_TITLE", "layout": ["queue_card"] }
  ],

  "i18n": {
    "en_US": { "NAME": "Approval queue", "CARD_TITLE": "Pending approvals",
               "PAGE_TITLE": "Approvals" },
    "zh_CN": { "NAME": "审批队列", "CARD_TITLE": "待审批", "PAGE_TITLE": "审批" }
  }
}
```

A matching `GET /v1/data/pending` reply:

```json
{
  "status": "ok",
  "data": {
    "rows": [
      {
        "repo":      { "kind": "text", "value": "example-org/example-repo" },
        "requester": { "kind": "text", "value": "alice" },
        "age":       { "kind": "badge", "value": "3d", "tone": "warning" }
      }
    ]
  }
}
```

## 7. Validating a manifest

The validator ci-panel uses is exported, so an author can run exactly the same checks:

```ts
import { validatePluginManifest } from "mcsmanager-common"; // in-tree import path

const result = validatePluginManifest(JSON.parse(raw));
if (!result.ok) console.error(result.errors.join("\n"));
```

That import path is the in-tree one. A plugin author outside the repository cannot install it
from npm yet — the package of that name on the public registry belongs to upstream MCSManager.
See [plugin-authoring.md](plugin-authoring.md) §3 for how to build it from a checkout meanwhile.

It takes `unknown`, asserts nothing, and reports **every** problem in one pass rather than
stopping at the first — a manifest should take one editing round, not one per mistake.

See [plugin-authoring.md](plugin-authoring.md) for the authoring workflow and
[plugin-operations.md](plugin-operations.md) for how a plugin is hosted and isolated.
