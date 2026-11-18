export interface ListenerProc {
  pid: number;
  pgid: number;
  dir: string;
  cgroup: string;
  busy: boolean;
}

export type ProcScanResponse =
  | { ok: true; procs: ListenerProc[]; warnings: string[]; skipped: number }
  | { ok: false; error: string };
