import { parentPort } from "node:worker_threads";
import { scanProcTree } from "./proc_scan_core";
import type { ProcScanResponse } from "./proc_scan_types";

if (!parentPort) throw new Error("Process scanner requires a worker thread");
const port = parentPort;
port.on("message", (procRoot: unknown) => {
  let response: ProcScanResponse;
  try {
    if (typeof procRoot !== "string" || !procRoot) throw new Error("Invalid process root");
    response = scanProcTree(procRoot);
  } catch (err: unknown) {
    response = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  port.postMessage(response);
});
