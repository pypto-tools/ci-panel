import { describe, expect, it } from "vitest";
import { ensureHandleInstance } from "../../src/service/runner_provision";
import { scanManagedRunners } from "../../src/service/runner_scan";
import { makeRunner } from "../helpers/process_fixture";

// runner/managed_list merges concurrent calls, because six independent full /proc scans queued
// on the libuv threadpool are what pushed the runner page past the browser's 30s timeout. The
// merge must not reach across an adoption, though. The sequence that matters: a scan is in
// flight, the user imports a runner, the import dialog closes and the list is fetched again.
// If that fetch joins the scan that started before the import, the new runner is missing from
// the list the user is looking at — and nothing will fetch it again for another poll interval.
//
// The window is real, not simulated. The first call fixes its directory set synchronously, before
// it awaits anything; the second runner is adopted right after, while that scan is still in
// flight. A merge keyed on nothing would hand the second call that fixed, pre-adoption set —
// however fast the scan itself is.

const adopt = (name: string) => {
  const r = makeRunner(name);
  ensureHandleInstance(r.dir, "org/repo", name);
  return r.dir;
};

describe("scanManagedRunners", () => {
  it("does not hand a request that follows an adoption a scan from before it", async () => {
    const first = adopt("mutation-a");

    const before = scanManagedRunners(); // in flight: walking /proc
    const second = adopt("mutation-b"); // adopted while that scan is still running
    const after = scanManagedRunners();

    const dirs = (await after).runners.map((r) => r.dir);
    expect(dirs).toContain(first);
    expect(dirs).toContain(second);

    // The earlier scan is allowed to be missing it — it started first. What must not happen
    // is the later request being handed that same result.
    await before;
  });

  it("still merges concurrent calls when nothing changed in between", async () => {
    adopt("mutation-c");
    // The same promise object is the observable form of "one scan, shared". Losing this would
    // put the page back to one full /proc walk per concurrent request.
    const a = scanManagedRunners();
    const b = scanManagedRunners();
    expect(await a).toBe(await b);
  });
});
