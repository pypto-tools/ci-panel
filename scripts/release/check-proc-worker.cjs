// Exercise the shipped worker, including error recovery, without scanning the host.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Worker } = require("node:worker_threads");

async function main() {
  const workerFile = path.resolve(process.argv[2], "proc_scan_worker.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ci-panel-worker-smoke-"));
  let worker;
  try {
    const runner = path.join(root, "runner");
    fs.mkdirSync(runner);
    fs.mkdirSync(path.join(root, "123"));
    fs.writeFileSync(path.join(root, "123", "comm"), "Runner.Listener\n");
    fs.writeFileSync(path.join(root, "123", "stat"), "123 (Runner.Listener) S 1 123\n");
    fs.writeFileSync(path.join(root, "123", "cmdline"), `${runner}/bin/Runner.Listener\0run`);
    worker = new Worker(workerFile);
    const scan = (procRoot) =>
      new Promise((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          worker.off("message", onMessage);
          worker.off("error", onError);
          worker.off("exit", onExit);
        };
        const onMessage = (result) => {
          cleanup();
          resolve(result);
        };
        const onError = (error) => {
          cleanup();
          reject(error);
        };
        const onExit = (code) => onError(new Error(`Scanner exited (${code})`));
        const timer = setTimeout(() => onError(new Error("Scanner smoke test timed out")), 10_000);
        worker.once("message", onMessage);
        worker.once("error", onError);
        worker.once("exit", onExit);
        worker.postMessage(procRoot);
      });
    assert.equal((await scan(path.join(root, "missing"))).ok, false);
    const result = await scan(root);
    assert.equal(result.ok, true);
    assert.deepEqual(result.procs, [
      { pid: 123, pgid: 123, dir: fs.realpathSync(runner), cgroup: "", busy: false }
    ]);
    console.log("Process scan worker: discovery and failure recovery passed");
  } finally {
    if (worker) await worker.terminate();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
