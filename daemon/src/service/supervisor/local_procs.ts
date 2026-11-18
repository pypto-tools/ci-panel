import { $t } from "../../i18n";
import { singleFlightBy } from "../../utils/single_flight";
import logger from "../log";
import { ProcScanClient } from "./proc_scan_client";
import type { ListenerProc } from "./proc_scan_types";

export type { ListenerProc } from "./proc_scan_types";

// One worker for every caller, including reconciliation and fresh action checks.
const scanner = new ProcScanClient();

/** Every call starts a new scan after this request, never reuses an older scan. */
export async function scanListenerProcs(procRoot = "/proc"): Promise<ListenerProc[]> {
  try {
    const result = await scanner.requestFresh(procRoot);
    if (result.skipped) {
      logger.warn(
        `[supervisor] Skipped ${result.skipped} process entries: ${result.warnings.join("; ")}`
      );
    }
    return result.procs;
  } catch (err: unknown) {
    logger.error(
      `[supervisor] Process scan failed: ${err instanceof Error ? err.message : String(err)}`
    );
    throw new Error($t("TXT_CODE_RUNNER_PROC_SCAN_FAILED"));
  }
}

// Only read paths may reuse a completed snapshot. Actions must call the fresh API.
const SNAPSHOT_TTL_MS = 1000;
export const sharedListenerProcs = singleFlightBy<[procRoot?: string], ListenerProc[]>(
  (procRoot = "/proc") => procRoot,
  (procRoot = "/proc") => scanListenerProcs(procRoot),
  { ttlMs: SNAPSHOT_TTL_MS }
);
