import fs from "fs/promises";
import path from "path";
import logger from "../../log";
import { $t } from "../../../i18n";
import { canonicalPath } from "../../../tools/path_link_check";
import type { ListenerProc } from "../local_procs";

function statFields(stat: string): string[] {
  return stat
    .slice(stat.lastIndexOf(")") + 1)
    .trim()
    .split(/\s+/);
}

export type GroupState = "absent" | "present" | "unknown";

export interface LeaderIdentity {
  bootId: string;
  startTicks: string;
}

export function isLeaderIdentity(value: unknown): value is LeaderIdentity {
  if (typeof value !== "object" || value === null) return false;
  const identity = value as Record<string, unknown>;
  return (
    typeof identity.bootId === "string" &&
    /^[a-zA-Z0-9-]{1,64}$/.test(identity.bootId) &&
    typeof identity.startTicks === "string" &&
    /^\d{1,20}$/.test(identity.startTicks)
  );
}

export function validPgid(pgid: number): boolean {
  return Number.isSafeInteger(pgid) && pgid > 1 && pgid <= 0x7fffffff;
}

/** Existence is a start/cleanup guard, never permission to send a signal. */
export function processGroupState(
  pgid: number,
  probe: (pid: number, signal: 0) => unknown = process.kill
): GroupState {
  if (pgid === 0) return "absent";
  if (!validPgid(pgid)) return "unknown";
  try {
    probe(-pgid, 0);
    return "present";
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ESRCH") return "absent";
    logger.warn(`[supervisor-process] Cannot inspect process group ${pgid}: ${String(err)}`);
    return "unknown";
  }
}

function leaderTicks(stat: string, pgid: number): string | undefined {
  // comm may contain both whitespace and parentheses. Field 22 is starttime.
  const end = stat.lastIndexOf(")");
  if (end < 0 || Number(stat.slice(0, stat.indexOf(" "))) !== pgid) return;
  const fields = statFields(stat);
  if (fields[0] === "Z" || fields[0] === "X" || Number(fields[2]) !== pgid) return;
  return /^\d{1,20}$/.test(fields[19] ?? "") ? fields[19] : undefined;
}

/** Read the detached leader's identity; missing or unreadable evidence grants no ownership. */
export async function readLeaderIdentity(
  pgid: number,
  dir: string,
  procRoot = "/proc"
): Promise<LeaderIdentity | undefined> {
  if (!validPgid(pgid)) return;
  const statPath = path.join(procRoot, String(pgid), "stat");
  try {
    const first = leaderTicks(await fs.readFile(statPath, "utf8"), pgid);
    if (!first) return;
    const [boot, cwd, expectedDir] = await Promise.all([
      fs.readFile(path.join(procRoot, "sys/kernel/random/boot_id"), "utf8"),
      fs.realpath(path.join(procRoot, String(pgid), "cwd")),
      fs.realpath(dir)
    ]);
    // Re-read after cwd to reject a PID recycled during the inspection.
    if (cwd !== expectedDir || leaderTicks(await fs.readFile(statPath, "utf8"), pgid) !== first)
      return;
    const identity = { bootId: boot.trim(), startTicks: first };
    return isLeaderIdentity(identity) ? identity : undefined;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT" && code !== "ESRCH")
      logger.warn(`[supervisor-process] Cannot identify group leader ${pgid}: ${String(err)}`);
    return;
  }
}

/** Inspect the recorded group's lifetime, not merely whether its number is allocated. */
export async function inspectProcessGroup(
  pgid: number,
  identity?: LeaderIdentity,
  procRoot = "/proc",
  probe: (pid: number, signal: 0) => unknown = process.kill
): Promise<GroupState> {
  if (pgid === 0) return "absent";
  if (!validPgid(pgid)) return "unknown";
  try {
    if (identity) {
      const bootId = (
        await fs.readFile(path.join(procRoot, "sys/kernel/random/boot_id"), "utf8")
      ).trim();
      if (!bootId) return "unknown";
      // No process can survive a host reboot. A reused number belongs to another group.
      if (bootId !== identity.bootId) return "absent";
    }

    const existence = processGroupState(pgid, probe);
    if (existence !== "present") return existence;

    const memberState = async (pid: string): Promise<"live" | "dead" | "other" | "unknown"> => {
      try {
        const stat = await fs.readFile(path.join(procRoot, pid, "stat"), "utf8");
        const end = stat.lastIndexOf(")");
        if (end < 0) return "unknown";
        const fields = statFields(stat);
        if (!fields[0] || !/^\d+$/.test(fields[2] ?? "")) return "unknown";
        if (Number(fields[2]) !== pgid) return "other";
        return fields[0] === "Z" || fields[0] === "X" ? "dead" : "live";
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === "ENOENT" || code === "ESRCH") return "other";
        return "unknown";
      }
    };

    // The common case needs one stat read. Only a missing/dead leader needs a group sweep.
    if ((await memberState(String(pgid))) === "live") return "present";
    const pids = (await fs.readdir(procRoot)).filter((pid) => /^\d+$/.test(pid));
    let unknown = false;
    for (let i = 0; i < pids.length; i += 256) {
      const states = await Promise.all(pids.slice(i, i + 256).map(memberState));
      if (states.includes("live")) return "present";
      unknown ||= states.includes("unknown");
    }
    // Zombies cannot restart a listener. Treat them as stopped even if PID 1 never reaps them.
    return unknown ? "unknown" : "absent";
  } catch (err: unknown) {
    logger.warn(`[supervisor-process] Cannot inspect group members ${pgid}: ${String(err)}`);
    return "unknown";
  }
}

/** Compatibility API: unknown observations must never be reported as an exited group. */
export async function processGroupExists(pgid: number, procRoot = "/proc"): Promise<boolean> {
  if (!validPgid(pgid)) return false;
  const state = await inspectProcessGroup(pgid, undefined, procRoot);
  if (state === "unknown") throw new Error($t("TXT_CODE_RUNNER_OBSERVE_INCOMPLETE"));
  return state === "present";
}

/** Only reclaim a dedicated run.sh session, never an interactive shell's group. */
export async function isDedicatedRunnerGroup(
  listener: ListenerProc,
  procRoot = "/proc"
): Promise<boolean> {
  if (!Number.isSafeInteger(listener.pgid) || listener.pgid <= 1) return false;
  const leader = path.join(procRoot, String(listener.pgid));
  const member = path.join(procRoot, String(listener.pid));
  try {
    const [leaderStat, memberStat, cwd, cmdline, leaderMeta, memberMeta] = await Promise.all([
      fs.readFile(path.join(leader, "stat"), "utf8"),
      fs.readFile(path.join(member, "stat"), "utf8"),
      fs.realpath(path.join(leader, "cwd")),
      fs.readFile(path.join(leader, "cmdline"), "utf8"),
      fs.stat(leader),
      fs.stat(member)
    ]);
    const head = statFields(leaderStat);
    const child = statFields(memberStat);
    const uid = process.getuid?.();
    const argv = cmdline.split("\0").filter(Boolean);
    // bash run.sh and an exec'd run.sh both occur. Do not accept a script name hidden in -c.
    const script = path.basename(argv[0] || "") === "bash" ? argv[1] : argv[0];
    return (
      uid !== undefined &&
      leaderMeta.uid === uid &&
      memberMeta.uid === uid &&
      head[0] !== "Z" &&
      child[0] !== "Z" &&
      Number(head[2]) === listener.pgid &&
      Number(head[3]) === listener.pgid &&
      Number(child[2]) === listener.pgid &&
      Number(child[3]) === listener.pgid &&
      canonicalPath(cwd) === listener.dir &&
      !!script &&
      !script.startsWith("-") &&
      canonicalPath(path.resolve(cwd, script)) === path.join(listener.dir, "run.sh")
    );
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ESRCH") return false;
    throw err;
  }
}
