import fs from "fs-extra";
import path from "path";
import { canonicalPath } from "../../../tools/path_link_check";
import type { ListenerProc } from "../local_procs";

function statFields(stat: string): string[] {
  return stat
    .slice(stat.lastIndexOf(")") + 1)
    .trim()
    .split(/\s+/);
}

/** Signal zero includes zombies; only a non-zombie group member can keep a runner alive. */
export async function processGroupExists(pgid: number, procRoot = "/proc"): Promise<boolean> {
  if (!Number.isSafeInteger(pgid) || pgid <= 1) return false;
  try {
    process.kill(-pgid, 0);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw err;
  }

  const isLiveMember = async (pid: string): Promise<boolean> => {
    try {
      const fields = statFields(await fs.readFile(path.join(procRoot, pid, "stat"), "utf8"));
      return Number(fields[2]) === pgid && fields[0] !== "Z" && fields[0] !== "X";
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ESRCH") return false;
      throw err;
    }
  };
  // The usual case costs one stat read. A dead leader may leave live descendants, so absence
  // of the leader is not sufficient; only then scan the group with bounded file concurrency.
  if (await isLiveMember(String(pgid))) return true;
  const pids = (await fs.readdir(procRoot)).filter((pid) => /^\d+$/.test(pid));
  for (let i = 0; i < pids.length; i += 256) {
    if ((await Promise.all(pids.slice(i, i + 256).map(isLiveMember))).some(Boolean)) return true;
  }
  return false;
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
