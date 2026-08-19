import { afterEach, describe, expect, it, vi } from "vitest";

// tick() guards the /proc scan and each directory's work, but managedRunnerDirs() and the
// canonicalPath mapping over its result sit outside every try. If either throws, the promise
// tick() returns rejects.
//
// The loop driver attaches only .finally(). A .finally() returns a NEW promise that rejects in
// turn, and `void` discards it without a handler — an unhandled rejection, which Node terminates
// the process over by default from v15. This loop is unattended and fires every 15 seconds, so a
// persistent failure in managedRunnerDirs() (a bad scan root, an unreadable instance config)
// would restart the daemon over and over.

const BOOM = "managedRunnerDirs exploded";

// Stubbed so a tick costs microseconds rather than a real /proc walk: this file is about what
// happens to the rejection, and the scan is already guarded by its own try/catch upstream.
vi.mock("../../src/service/supervisor/local_procs", async () => {
  const actual = await vi.importActual<typeof import("../../src/service/supervisor/local_procs")>(
    "../../src/service/supervisor/local_procs"
  );
  return { ...actual, scanListenerProcs: async () => [] };
});

vi.mock("../../src/service/runner_scan", async () => {
  const actual = await vi.importActual<typeof import("../../src/service/runner_scan")>(
    "../../src/service/runner_scan"
  );
  return {
    ...actual,
    managedRunnerDirs: () => {
      throw new Error(BOOM);
    }
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the reconcile loop when the part outside every try throws", () => {
  it("really does produce a rejecting tick", async () => {
    const { __tickOnceForTest } = await import("../../src/service/supervisor/reconcile");

    // __tickOnceForTest is tick() unwrapped, so the rejection is observable directly. Without
    // this the next case could pass simply because nothing ever failed.
    await expect(__tickOnceForTest()).rejects.toThrow(BOOM);
  });

  it("startReconcileLoop handles it rather than crashing the process", async () => {
    const { startReconcileLoop, stopReconcileLoop } =
      await import("../../src/service/supervisor/reconcile");

    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown): void => void unhandled.push(err);
    process.on("unhandledRejection", onUnhandled);

    try {
      // startReconcileLoop runs one tick immediately — the failing one.
      startReconcileLoop();
      // Long enough for the tick to reject and for Node to report an unhandled rejection, which
      // it does after the microtask queue drains.
      await new Promise((r) => setTimeout(r, 200));
    } finally {
      stopReconcileLoop();
      process.off("unhandledRejection", onUnhandled);
    }

    expect(unhandled).toEqual([]);
  });
});
