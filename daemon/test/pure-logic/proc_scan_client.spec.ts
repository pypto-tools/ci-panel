import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProcScanClient } from "../../src/service/supervisor/proc_scan_client";

const empty = { ok: true as const, procs: [], warnings: [], skipped: 0 };
class ControlledWorker extends EventEmitter {
  roots: string[] = [];
  postMessage(root: string): void {
    this.roots.push(root);
  }
  ref(): void {}
  unref(): void {}
  terminate = vi.fn(async () => 0);
}
const clients: ProcScanClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  vi.useRealTimers();
});
function makeClient(
  worker: ControlledWorker,
  options: { maxPending?: number; timeoutMs?: number } = {}
) {
  const client = new ProcScanClient({ createWorker: () => worker, ...options });
  clients.push(client);
  return client;
}

describe("process scan scheduling", () => {
  it("runs fresh requests sequentially, never joining the active snapshot", async () => {
    const worker = new ControlledWorker();
    const client = makeClient(worker);
    const first = client.requestFresh("first");
    const second = client.requestFresh("second");
    expect(worker.roots).toEqual(["first"]);
    worker.emit("message", empty);
    await expect(first).resolves.toEqual(empty);
    expect(worker.roots).toEqual(["first", "second"]);
    const next = { ...empty, procs: [{ pid: 2, pgid: 2, dir: "/runner", cgroup: "", busy: true }] };
    worker.emit("message", next);
    await expect(second).resolves.toEqual(next);
  });

  it("bounds outstanding requests without dropping accepted scans", async () => {
    const worker = new ControlledWorker();
    const client = makeClient(worker, { maxPending: 2 });
    const first = client.requestFresh("a");
    const second = client.requestFresh("b");
    await expect(client.requestFresh("overflow")).rejects.toThrow("queue is full");
    worker.emit("message", empty);
    worker.emit("message", empty);
    await Promise.all([first, second]);
  });

  it("propagates a failed scan and lets the next request recover", async () => {
    const worker = new ControlledWorker();
    const client = makeClient(worker);
    const failure = expect(client.requestFresh("missing")).rejects.toThrow("ENOENT");
    worker.emit("message", { ok: false, error: "ENOENT" });
    await failure;
    const next = client.requestFresh("present");
    worker.emit("message", empty);
    await expect(next).resolves.toEqual(empty);
  });

  it("waits for worker termination before replacing a crashed worker", async () => {
    const old = new ControlledWorker();
    let stopped!: (code: number) => void;
    old.terminate.mockImplementation(
      () =>
        new Promise<number>((resolve) => {
          stopped = resolve;
        })
    );
    const replacement = new ControlledWorker();
    const create = vi.fn().mockReturnValueOnce(old).mockReturnValue(replacement);
    const client = new ProcScanClient({ createWorker: create });
    clients.push(client);
    const failure = expect(client.requestFresh("first")).rejects.toThrow("crash");
    const next = client.requestFresh("second");
    old.emit("error", new Error("crash"));
    await failure;
    expect(create).toHaveBeenCalledTimes(1);
    // Even a late message from the old worker cannot settle the new request.
    old.emit("message", empty);
    stopped(1);
    await vi.waitFor(() => expect(replacement.roots).toEqual(["second"]));
    replacement.emit("message", empty);
    await expect(next).resolves.toEqual(empty);
  });

  it("rejects a worker exit even when its exit code is zero", async () => {
    const worker = new ControlledWorker();
    const client = makeClient(worker);
    const result = expect(client.requestFresh("a")).rejects.toThrow("exited (0)");
    worker.emit("exit", 0);
    await result;
  });

  it("bounds queue time as well as active scan time", async () => {
    vi.useFakeTimers();
    const worker = new ControlledWorker();
    const client = makeClient(worker, { timeoutMs: 100 });
    const first = expect(client.requestFresh("slow")).rejects.toThrow("timed out");
    const second = expect(client.requestFresh("queued")).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(100);
    await Promise.all([first, second]);
    expect(worker.terminate).toHaveBeenCalled();
  });

  it("rejects all waiters on close and refuses subsequent requests", async () => {
    const worker = new ControlledWorker();
    const client = makeClient(worker);
    const a = expect(client.requestFresh("a")).rejects.toThrow("closed");
    const b = expect(client.requestFresh("b")).rejects.toThrow("closed");
    await client.close();
    await Promise.all([a, b]);
    await expect(client.requestFresh("c")).rejects.toThrow("closed");
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("fails closed if the old worker cannot be terminated", async () => {
    const worker = new ControlledWorker();
    worker.terminate.mockRejectedValue(new Error("termination failed"));
    const client = new ProcScanClient({ createWorker: () => worker });
    const first = expect(client.requestFresh("first")).rejects.toThrow("crash");
    const queued = expect(client.requestFresh("queued")).rejects.toThrow("termination failed");
    worker.emit("error", new Error("crash"));
    await Promise.all([first, queued]);
    await expect(client.requestFresh("later")).rejects.toThrow("termination failed");
    await expect(client.close()).rejects.toThrow("termination failed");
  });

  it("recovers from a worker construction failure", async () => {
    const worker = new ControlledWorker();
    const create = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("missing bundle");
      })
      .mockReturnValue(worker);
    const client = new ProcScanClient({ createWorker: create });
    clients.push(client);
    await expect(client.requestFresh("a")).rejects.toThrow("missing bundle");
    const next = client.requestFresh("b");
    worker.emit("message", empty);
    await expect(next).resolves.toEqual(empty);
  });
});
