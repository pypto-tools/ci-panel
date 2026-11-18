import path from "node:path";
import { Worker } from "node:worker_threads";
import type { ProcScanResponse } from "./proc_scan_types";

type ScanResult = Extract<ProcScanResponse, { ok: true }>;
export interface ScanWorker {
  on(event: "message", listener: (message: ProcScanResponse) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  postMessage(root: string): void;
  terminate(): Promise<number>;
  ref(): void;
  unref(): void;
}
interface PendingScan {
  root: string;
  resolve: (result: ScanResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
interface ScanClientOptions {
  createWorker?: () => ScanWorker;
  timeoutMs?: number;
  maxPending?: number;
}

/** A bounded FIFO. Fresh callers never join a scan that started before their request. */
export class ProcScanClient {
  private worker: ScanWorker | null = null;
  private active: PendingScan | null = null;
  private queue: PendingScan[] = [];
  private stopping: Promise<void> | null = null;
  private closed = false;
  private stopError: Error | null = null;
  private readonly createWorker: () => ScanWorker;
  private readonly timeoutMs: number;
  private readonly maxPending: number;

  constructor(options: ScanClientOptions = {}) {
    this.createWorker =
      options.createWorker ?? (() => new Worker(path.join(__dirname, "proc_scan_worker.js")));
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxPending = options.maxPending ?? 32;
  }

  requestFresh(root: string): Promise<ScanResult> {
    if (this.closed)
      return Promise.reject(this.stopError ?? new Error("Process scanner is closed"));
    if (this.queue.length + Number(this.active !== null) >= this.maxPending)
      return Promise.reject(new Error("Process scan queue is full"));
    return new Promise((resolve, reject) => {
      const request: PendingScan = {
        root,
        resolve,
        reject,
        // Include queue time in the deadline so overload cannot retain callers indefinitely.
        timer: setTimeout(() => this.expire(request), this.timeoutMs)
      };
      this.queue.push(request);
      this.drain();
    });
  }

  private finish(request: PendingScan, error?: Error, result?: ScanResult): void {
    clearTimeout(request.timer);
    if (error) request.reject(error);
    else if (result) request.resolve(result);
  }

  private expire(request: PendingScan): void {
    const error = new Error("Process scan timed out");
    if (this.active === request) {
      this.active = null;
      this.finish(request, error);
      this.retire();
    } else {
      this.queue = this.queue.filter((pending) => pending !== request);
      this.finish(request, error);
    }
  }

  private failWorker(worker: ScanWorker, error: Error): void {
    if (this.worker !== worker) return;
    if (this.active) {
      this.finish(this.active, error);
      this.active = null;
    }
    this.retire();
  }

  private retire(): void {
    const worker = this.worker;
    this.worker = null;
    if (!worker) {
      this.drain();
      return;
    }
    // Do not start a replacement until the previous worker has actually stopped.
    this.stopping = Promise.resolve()
      .then(() => worker.terminate())
      .then(() => undefined)
      .catch((err: unknown) => {
        this.closed = true;
        const error = err instanceof Error ? err : new Error(String(err));
        this.stopError = error;
        for (const pending of this.queue.splice(0)) this.finish(pending, error);
      })
      .finally(() => {
        this.stopping = null;
        this.drain();
      });
  }

  private drain(): void {
    if (this.closed || this.stopping || this.active || !this.queue.length) return;
    this.active = this.queue.shift()!;
    try {
      if (!this.worker) {
        const worker = this.createWorker();
        this.worker = worker;
        worker.on("message", (response: ProcScanResponse) => {
          if (this.worker !== worker || !this.active) return;
          const request = this.active;
          this.active = null;
          if (response.ok) this.finish(request, undefined, response);
          else this.finish(request, new Error(response.error));
          worker.unref();
          this.drain();
        });
        worker.on("error", (error: Error) => this.failWorker(worker, error));
        worker.on("exit", (code: number) =>
          this.failWorker(worker, new Error(`Process scan worker exited (${code})`))
        );
      }
      this.worker.ref();
      this.worker.postMessage(this.active.root);
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (this.active) this.finish(this.active, error);
      this.active = null;
      this.retire();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const error = new Error("Process scanner is closed");
    if (this.active) this.finish(this.active, error);
    this.active = null;
    for (const pending of this.queue.splice(0)) this.finish(pending, error);
    this.retire();
    await this.stopping;
    if (this.stopError) throw this.stopError;
  }
}
