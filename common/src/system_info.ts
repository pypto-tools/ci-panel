import os from "os";
import osUtils from "os-utils";
import fs from "fs";
// import systeminformation from "systeminformation";

interface IInfoTable {
  [key: string]: number;
}

interface ISystemInfo {
  cpuUsage: number;
  memUsage: number;
  totalmem: number;
  freemem: number;
  type: string;
  hostname: string;
  platform: string;
  // os.arch() of the reporting process: x64 / arm64 / ... The panel needs it to prefill
  // architecture-dependent values for a node, e.g. the default runner labels.
  arch: string;
  release: string;
  distro: string;
  uptime: number;
  cwd: string;
  processCpu: number;
  processMem: number;
  loadavg: number[];
}

// 读取 Linux 发行版名（Node 的 os 模块拿不到，需读 /etc/os-release 的 PRETTY_NAME）。
// 发行版是静态信息，启动时读一次即可。读不到时回退到 os.type()（如 Windows/Mac）。
function readDistro(): string {
  try {
    const text = fs.readFileSync("/etc/os-release", { encoding: "utf-8" });
    const m = text.match(/^PRETTY_NAME="?(.+?)"?$/m);
    if (m && m[1]) return m[1];
  } catch {
    // 非 Linux 或无该文件，忽略
  }
  return os.type();
}

// System details are updated every time
const info: ISystemInfo = {
  type: os.type(),
  hostname: os.hostname(),
  platform: os.platform(),
  arch: os.arch(),
  release: os.release(),
  distro: readDistro(),
  uptime: os.uptime(),
  cwd: process.cwd(),
  loadavg: os.loadavg(),
  freemem: 0,
  cpuUsage: 0,
  memUsage: 0,
  totalmem: 0,
  processCpu: 0,
  processMem: 0
};

// periodically refresh the cache
const refreshTimer = setInterval(() => {
  if (os.platform() === "linux") {
    return setLinuxSystemInfo();
  }
  if (os.platform() === "win32") {
    return setWindowsSystemInfo();
  }
  return otherSystemInfo();
}, 3000);

// unref so this timer alone cannot keep a process alive. panel and daemon run forever anyway, but
// index.ts re-exports this module, so any short-lived importer of the barrel — a script, or a test
// runner — would otherwise never exit.
refreshTimer.unref();

function otherSystemInfo() {
  info.freemem = os.freemem();
  info.totalmem = os.totalmem();
  info.memUsage = (os.totalmem() - os.freemem()) / os.totalmem();
  osUtils.cpuUsage((p) => (info.cpuUsage = p));
}

function setWindowsSystemInfo() {
  info.freemem = os.freemem();
  info.totalmem = os.totalmem();
  info.memUsage = (os.totalmem() - os.freemem()) / os.totalmem();
  osUtils.cpuUsage((p) => (info.cpuUsage = p));
}

/** Aggregate CPU jiffies, in the units /proc/stat reports them. Only the ratio is ever used. */
export interface CpuTimes {
  idle: number;
  total: number;
}

/**
 * Read those two numbers off the first line of /proc/stat.
 *
 * The obvious way to get them is os.cpus(), and that is what os-utils does — twice, a second
 * apart. On a many-core host that is ruinous: libuv's uv_cpu_info reads /proc/cpuinfo as well as
 * /proc/stat, and /proc/cpuinfo is generated per core on demand. Measured on a 320-core machine:
 * os.cpus() takes 59ms (43ms of it inside /proc/cpuinfo, 131KB), against 0.6ms to read and parse
 * this one line. Two of those every 3 seconds is ~4% of a core burnt — and it is synchronous, so
 * each one is a 59ms stall of the event loop, in a process whose responsiveness is what the panel
 * uses to decide whether the node is reachable at all.
 *
 * Nothing here needs per-core detail or the model names that make /proc/cpuinfo expensive.
 *
 * The field selection deliberately mirrors os-utils so the number on the chart does not shift
 * under existing deployments: total counts user+nice+system+idle+irq, idle counts only the idle
 * field. iowait, softirq and steal are left out — that is what os.cpus() exposes (libuv parses
 * iowait but discards it), and matching it matters more here than being right in the abstract.
 *
 * Exported for the spec: the parsing has to be exercised against fixture text, since the real
 * file cannot be made to hold a chosen value.
 */
export function parseProcStatCpu(text: string): CpuTimes | null {
  const first = text.split("\n", 1)[0];
  if (!/^cpu\s/.test(first)) return null;
  const f = first
    .trim()
    .split(/\s+/)
    .slice(1)
    .map((v) => Number(v));
  // user nice system idle iowait irq …  — the five os.cpus() reports, by position.
  if (f.length < 6 || f.slice(0, 6).some((v) => !Number.isFinite(v))) return null;
  return { idle: f[3], total: f[0] + f[1] + f[2] + f[3] + f[5] };
}

/**
 * Busy fraction between two samples, or null when the pair says nothing usable.
 *
 * Two ticks inside the same jiffy give total === 0, and a counter that went backwards (a
 * suspended VM, a fixture typo) would produce a nonsense ratio. Both mean "keep the previous
 * reading" rather than "the machine is 0% busy" — a monitoring chart that drops to zero under
 * load is worse than one that holds its last value for one tick.
 */
export function cpuUsageBetween(prev: CpuTimes, cur: CpuTimes): number | null {
  const idle = cur.idle - prev.idle;
  const total = cur.total - prev.total;
  if (total <= 0 || idle < 0 || idle > total) return null;
  return 1 - idle / total;
}

let prevCpuTimes: CpuTimes | null = null;

function setLinuxCpuUsage() {
  const cur = parseProcStatCpu(fs.readFileSync("/proc/stat", { encoding: "utf-8" }));
  // Unparseable /proc/stat: fall back to the portable path rather than freezing the reading.
  if (!cur) return osUtils.cpuUsage((p) => (info.cpuUsage = p));
  // The window is now the refresh interval (3s) instead of os-utils' 1s probe once every 3s,
  // so the value covers the whole period rather than a sample of it. The first tick after
  // startup has no predecessor and leaves cpuUsage at its initial 0.
  if (prevCpuTimes) {
    const usage = cpuUsageBetween(prevCpuTimes, cur);
    if (usage !== null) info.cpuUsage = usage;
  }
  prevCpuTimes = cur;
}

function setLinuxSystemInfo() {
  try {
    // read memory data based on /proc/meminfo
    const data = fs.readFileSync("/proc/meminfo", { encoding: "utf-8" });
    const list = data.split("\n");
    const infoTable: IInfoTable = {};
    list.forEach((line) => {
      const kv = line.split(":");
      if (kv.length === 2) {
        const k = kv[0].replace(/ /gim, "").replace(/\t/gim, "").trim().toLowerCase();
        let v = kv[1].replace(/ /gim, "").replace(/\t/gim, "").trim().toLowerCase();
        v = v.replace(/kb/gim, "").replace(/mb/gim, "").replace(/gb/gim, "");
        let vNumber = parseInt(v);
        if (isNaN(vNumber)) vNumber = 0;
        infoTable[k] = vNumber;
      }
    });
    const memAvailable = infoTable["memavailable"] ?? infoTable["memfree"];
    const memTotal = infoTable["memtotal"];
    info.freemem = memAvailable * 1024;
    info.totalmem = memTotal * 1024;
    info.memUsage = (info.totalmem - info.freemem) / info.totalmem;
    setLinuxCpuUsage();
  } catch (error: any) {
    // If the reading is wrong, the default general reading method is automatically used
    otherSystemInfo();
  }
}

export function systemInfo() {
  return info;
}
