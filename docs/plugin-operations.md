# Plugin operations

For operators running ci-panel: how a plugin is hosted, what contains it, and how to convince
yourself of that on your own hardware.

> **Status.** §1–§3 are **settled and measured** — the isolation model was verified end to end on
> a real host, and §3 is a procedure you can re-run to verify it on yours. §4 mixes verified facts
> about the existing supervisor registry with plugin policy that is not yet implemented, and says
> which is which. §5 onward is **designed but not implemented**; it is recorded here so the shape
> is agreed before the code exists, and is marked accordingly.

## 1. Why the isolation model looks the way it does

Two facts about a ci-panel node decide everything else.

**The daemon runs unprivileged.** `deploy/systemd/ci-panel-daemon.service.tmpl:9` sets
`User=__USER__`, defaulting to `ci-runner`.

**That same user runs the CI jobs.** The invariant is stated outright in four places, including
`prod-scripts/install-runner-privileges.sh:16`:

```
RUN_USER="${SUDO_USER:-ci-runner}" # daemon 的运行用户 = runner 目录属主 = 单元里的 User=
```

A GitHub Actions workflow step is an arbitrary command executing as a child of the runner
process, so it executes as that user. If your nodes serve public repositories or accept fork
pull requests, **code written by strangers runs as the same uid as the daemon**.

The consequence is not about plugin invocation — the panel route that invokes a plugin is
admin-gated and stays that way. It is about the filesystem, which the panel cannot gate. Anything
owned by the daemon's uid is readable by every CI job, whatever the panel's permission model
says. A plugin whose secrets or socket were owned by that uid would hand both to every fork PR,
and could have its own files rewritten underneath it.

So a plugin must run as an identity that is **not** the daemon's own user. That is a requirement,
not a preference.

### Why not containers

The obvious alternative was a container per plugin. It was rejected on three grounds:

- Docker is not present. `grep -rn docker deploy/` returns nothing — the deploy tooling never
  installs it, never provisions group membership, never mounts the socket.
- Putting the daemon's uid in the `docker` group is root-equivalent, so it would hand node root
  to every CI job. Granting CI jobs root in order to contain plugins is a net-negative trade.
- A container's host-side bind mounts are still owned by whoever created them. Container
  isolation does not fix a host-side ownership problem.

## 2. The isolation model

Each plugin runs as a **systemd unit with a transient per-unit UID**. There is no user to create,
no user to delete, and nothing left orphaned by a half-failed install.

```ini
[Service]
DynamicUser=yes
Group=cipanel-plugin            # one static group, created once at deploy time
RuntimeDirectory=cipanel-plugin-<id>
RuntimeDirectoryMode=0750       # socket dir: <transient uid>:cipanel-plugin
StateDirectory=cipanel-plugin-<id>
StateDirectoryMode=0700         # secrets:    <transient uid>, group excluded
UMask=0007                      # the socket is created 0770, not 0755
```

Resulting ownership:

```
/run/cipanel-plugin-<id>/              <transient uid>:cipanel-plugin  0750   ← the actual gate
/run/cipanel-plugin-<id>/plugin.sock   <transient uid>:cipanel-plugin  0770
<StateDirectory>/                      <transient uid>                 0700
```

**Security comes from the directory mode, not the socket mode.** Outside the group the run
directory cannot be entered at all, so the socket's own permissions never come into play. The
socket's group-write bit only decides whether the daemon, already inside the group, can connect.

`DynamicUser=yes` additionally implies `ProtectSystem=strict`, `PrivateTmp=yes`,
`NoNewPrivileges=yes` and `RemoveIPC=yes`, which covers much of the hardening list at no cost.

Two details that each cost a round of experiment, recorded so nobody repeats them:

- **`Group=` works with `DynamicUser=yes`**, and it is what makes both directories carry the
  static group. `SupplementaryGroups=` does not — the directories keep the transient group and
  the daemon is locked out.
- **A unix socket needs *write* permission to `connect()`**, not merely a traversable parent.
  Without `UMask=0007` the socket is created `0755` and the daemon still fails, even though it
  can enter the directory.

`UMask=0007` is preferred over having the plugin `chmod` its own socket: a security property that
depends on a third party remembering to do something is not a property.

### Known limitation

All plugins share one static group, so plugin B can enter plugin A's run directory and open its
socket. A's secrets stay safe — `StateDirectory` is `0700` and excludes the group. Reachability
is not authorisation: each plugin verifies a per-plugin secret on every request, and B cannot
read A's.

A group per plugin would close even reachability, but the daemon would have to restart to pick up
each new group, forfeiting install-without-restart. The trade was taken deliberately.

## 3. Verifying this on your own hardware

The model above was measured, not assumed. To re-verify after changing hosts, distributions or
systemd versions, check these five properties. All five must hold; four is a fail.

| # | Property | Why it matters |
| --- | --- | --- |
| P1 | the plugin's uid is **not** the daemon's user | the premise of the whole model |
| P2 | the daemon **can** `connect()` the socket | otherwise ci-panel cannot reach the plugin |
| P3 | the daemon **cannot** read `StateDirectory` | this is what keeps secrets from CI jobs |
| P4 | the daemon **cannot** unlink or replace the socket | otherwise a local process can squat it |
| P5 | a local user outside the group can neither connect nor read | the direct CI-job test |

P4 is the one most designs get wrong. Giving the daemon ownership of the socket directory makes
P2 pass and P4 fail — and since CI jobs share the daemon's uid, that is the port-squatting
problem wearing different clothes.

Procedure: create the static group, add the daemon's user to it, install a unit with the stanza
in §2 running any process that binds `$RUNTIME_DIRECTORY/plugin.sock` and writes a file into
`$STATE_DIRECTORY`, then test each property as the daemon's user — `sg <group> -c` reproduces the
group membership a restarted daemon would have. Remove the unit, the directories and the group
afterwards.

Measured on systemd 249: all five hold.

## 4. Nodes without systemd

A node running inside a container usually has no systemd, and the daemon already knows how to
tell — this check is existing, shipped code:

```ts
// daemon/src/service/supervisor/systemd.ts:514
if (!fs.existsSync("/run/systemd/system"))
  return { available: false, reason: "该节点不是 systemd 启动的（无 /run/systemd/system）" };
```

The repository already solves this shape for runners, and the mechanism is reusable as-is.
`daemon/src/service/supervisor/registry.ts` holds a `Record<SupervisorKind, Factory>` in which
each backend self-reports availability, a reason and a priority; a node picks the highest-priority
available one. Adding a backend is one row, and `satisfies` turns a forgotten row into a compile
error rather than a backend that silently becomes dead code. Root container nodes are already a
supported deployment shape (`edb35fc8`).

**For a runner the two backends are equivalent; for a plugin they are not.** For a runner,
systemd versus process is a question of who supervises the process. For a plugin, systemd *is*
the isolation — `DynamicUser=`, `Group=`, `RuntimeDirectory` and `UMask` are the entire
mechanism. A daemon that merely forks a plugin runs it **as the daemon's own uid**, which is
exactly what §1 says must not happen.

So there are three cases, not two:

| Node | Backend | Isolation | Policy |
| --- | --- | --- | --- |
| systemd available | `systemd` | full — transient per-unit uid | preferred |
| no systemd, daemon runs as **root** | `process`, spawning with `{uid, gid}` onto a pre-created unprivileged user; the daemon chowns the run and state directories itself | comparable — uid separation preserved | viable |
| no systemd, daemon unprivileged | `none` | **not achievable** | refuse by default |

> The second and third rows are **policy, not current behaviour** — no plugin host backend exists
> yet in either form.

The middle case is genuine new work rather than a fallback that comes free. Nothing in
`daemon/src` passes `uid` or `gid` to `spawn` today, so dropping privileges is a new capability.
It is available at all only because the parent is root: an unprivileged process cannot change its
uid, which is precisely why the third row cannot be solved the same way.

**The third case must refuse rather than degrade.** Running a plugin with no isolation because
the node cannot provide any is the failure mode this whole model exists to prevent, and doing it
silently is worse than not supporting the node. The precedent is already there — the `none`
backend exists to say "this node cannot do it" — and the planned `plugin/capabilities` verb is
where a node reports that upward. Two rules for this case:

- Hosting is refused unless an operator explicitly opts in for that node.
- A plugin declaring secrets is refused outright even then, because its credentials would sit
  under the daemon's uid, which is the exposure isolation exists to close.

**Not investigated:** whether an unprivileged daemon could obtain a uid mapping through a user
namespace (`unshare -U`), the way rootless container runtimes do. It depends on kernel
configuration and has not been tested here. It is worth a probe when a node of that shape
actually exists, not before — §3 is the template for that probe.

---

> Everything below is **designed, not implemented**. It records agreed shape, not current
> behaviour.

## 5. Lifecycle (pending)

Install (admin supplies the manifest) → **disabled by default** → approve declared grants →
select target nodes → daemon creates the unit → start → health probe → ready.

- Convergence reuses the supervisor's existing 15-second loop and desired-state file.
- Restart backoff 5s → 5min; five consecutive start failures move the plugin to quarantine.
- Quarantine surfaces a **visible reason** and must never take the daemon down.
- A plugin outside the contract window is marked `deprecated` and keeps running for two minor
  versions. Only `too-new` is hard-quarantined.

## 6. Uninstall (pending)

An ordered, idempotent sequence: stop the unit → remove the unit → remove the run and state
directories → confirm secrets and dead-letter data separately, since both may be wanted for
forensics → remove the panel registry record → keep audit rows → report how many layout cards
still point at the plugin and let the admin trigger a prune with a dry-run count first.

Never prune layouts silently: a temporarily disabled plugin would lose the operator's card
placement.

## 7. Backup and upgrade (pending)

`deploy/update.sh` archives `data/` before upgrading, excluding `InstanceData`, `runner-pkg` and
`InstanceLog`. Plugin manifests, the registry **and** secrets are to be included; plugin payload
files are excluded alongside the other three.

Secrets ride the protection the script already applies to the node access key in
`Config/global.json` — `umask 077` before `mkdir`, then `chmod 600` on the archive — so this adds
no exposure beyond the status quo.

## 8. Logs (pending)

A plugin's stdout and stderr go to the journal under its unit name. A `plugin/logs` verb, a panel
route and a UI drawer are planned; until they exist, quarantine can report that a plugin
crash-looped without showing why, which is the gap to close first.

---

See [plugin-contract.md](plugin-contract.md) for the specification and
[plugin-authoring.md](plugin-authoring.md) for writing one.
