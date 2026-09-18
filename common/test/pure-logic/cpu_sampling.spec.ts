import fs from "fs";
import { describe, expect, it } from "vitest";
import { cpuUsageBetween, parseProcStatCpu, type CpuTimes } from "../../src/system_info";

// The CPU figure behind the panel's node chart used to come from os.cpus(), twice a second
// apart. That call also reads /proc/cpuinfo, which the kernel materialises per core: on a
// 320-core host it costs 59ms against 0.6ms for the one line of /proc/stat these numbers
// actually live on — and it is synchronous, so it stalls the event loop the panel is
// heart-beating against. This spec pins the replacement's arithmetic and its refusals.

// A real first line, trimmed to the fields that matter. Positions are load-bearing: they are
// what os.cpus() reports, by index.
//          user   nice   system idle    iowait irq   softirq steal
const LINE = "cpu  100000 2000   30000  800000  5000   400   700     0";

describe("parseProcStatCpu", () => {
  it("sums the same fields os.cpus() exposes, and no others", () => {
    // user+nice+system+idle+irq = 100000+2000+30000+800000+400. iowait, softirq and steal are
    // deliberately absent: libuv parses iowait and throws it away, and the chart's numbers must
    // not shift for deployments that have been watching them.
    expect(parseProcStatCpu(`${LINE}\ncpu0 1 2 3 4 5 6 7\n`)).toEqual({
      idle: 800000,
      total: 932400
    });
  });

  it("reads the aggregate line, not the first per-core line", () => {
    // "cpu0" would parse just as cleanly and be wrong by a factor of the core count.
    const parsed = parseProcStatCpu(`${LINE}\ncpu0 9 9 9 9 9 9\n`);
    expect(parsed?.idle).toBe(800000);
  });

  it("refuses input that is not /proc/stat", () => {
    // Returning a zeroed sample here would read as a perfectly idle machine forever.
    expect(parseProcStatCpu("")).toBeNull();
    expect(parseProcStatCpu("MemTotal: 123 kB\n")).toBeNull();
    expect(parseProcStatCpu("cpu  1 2 3\n")).toBeNull(); // truncated: no irq column
    expect(parseProcStatCpu("cpu  a b c d e f\n")).toBeNull();
  });

  // Linux only: macOS and Windows dev machines have no /proc. CI runs on ubuntu, so the case
  // still runs where it matters.
  it.skipIf(process.platform !== "linux")("parses the real /proc/stat on this machine", () => {
    // The fixtures above are hand-written; this is the guard that they resemble the real thing.
    const real = parseProcStatCpu(fs.readFileSync("/proc/stat", "utf-8"));
    expect(real).not.toBeNull();
    expect(real!.total).toBeGreaterThan(real!.idle);
  });
});

describe("cpuUsageBetween", () => {
  const at = (idle: number, total: number): CpuTimes => ({ idle, total });

  it("is the busy fraction over the interval", () => {
    // 1000 jiffies passed, 250 of them idle → 75% busy.
    expect(cpuUsageBetween(at(800000, 932400), at(800250, 933400))).toBeCloseTo(0.75, 10);
  });

  it("reports a fully idle and a fully busy interval exactly", () => {
    expect(cpuUsageBetween(at(0, 0), at(1000, 1000))).toBe(0);
    expect(cpuUsageBetween(at(0, 0), at(0, 1000))).toBe(1);
  });

  it("returns null instead of a number when the pair is unusable", () => {
    // Two ticks inside one jiffy (total unchanged), and a counter that went backwards.
    // Both must leave the previous reading in place: a chart that drops to 0% under load is
    // worse than one that holds its last value for a tick — 0% is a reading people act on.
    expect(cpuUsageBetween(at(800000, 932400), at(800000, 932400))).toBeNull();
    expect(cpuUsageBetween(at(800000, 932400), at(700000, 800000))).toBeNull();
    // idle grew by more than total did — impossible, so it is corruption, not 0% busy.
    expect(cpuUsageBetween(at(0, 0), at(2000, 1000))).toBeNull();
  });
});
