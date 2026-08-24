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
    osUtils.cpuUsage((p) => (info.cpuUsage = p));
  } catch (error: any) {
    // If the reading is wrong, the default general reading method is automatically used
    otherSystemInfo();
  }
}

export function systemInfo() {
  return info;
}
