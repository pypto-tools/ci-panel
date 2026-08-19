// CI Panel 扩展：周期性自我收敛。
//
// 循环是通用的，工作是后端的：加一种托管方式时这里不用改，不需要收敛的后端不实现 reconcileOne。
//
// **必须是独立 timer，不能挂在扫描路径上。** 扫描是被面板 10 秒一轮的轮询驱动的，把重拉挂在
// 那里等于让「有没有人在看页面」决定「runner 要不要被拉起来」；而且扫描是只读热路径，不该有
// 副作用（runner_scan 里那条注释说的就是这件事）。
import logger from "../log";
import { dirKey, RunnerLockBusyError, withRunnerLock } from "../runner_lock";
import { readMarker } from "../runner_marker";
import { errText } from "../runner_provision";
import { managedRunnerDirs } from "../runner_scan";
import { canonicalPath } from "../../tools/path_link_check";
import { scanListenerProcs, type ListenerProc } from "./local_procs";
import { backendFor } from "./registry";
import { resolveSupervisor } from "./resolve";
import type { RunnerSupervisor } from "./types";
import type { SupervisorKind } from "mcsmanager-common";

const RECONCILE_INTERVAL_MS = 15_000;

export function isLockBusyError(err: unknown): boolean {
  return err instanceof RunnerLockBusyError;
}

async function tick(): Promise<void> {
  // 一轮扫一次 /proc，传给每个后端。扫不动就整轮跳过：收敛的两件事（推进停止阶梯、重拉）
  // 都需要知道现在有什么在跑，不知道就什么都别做。
  let procs: ListenerProc[];
  try {
    procs = await scanListenerProcs();
  } catch (err: unknown) {
    logger.error(`[supervisor] /proc 扫描失败，本轮 reconcile 跳过: ${errText(err)}`);
    return;
  }

  // managedRunnerDirs 回的是句柄实例的 cwd，这里归一化后才能和 ListenerProc.dir 比对——
  // 不归一，软链节点上观测恒空、恒判 idle，而这是一条无人值守的写路径，每 15 秒静默放行一次。
  for (const dir of managedRunnerDirs().map(canonicalPath)) {
    // 显式标注：不写类型的话这两个是 evolving any，下面那次 reconcileOne 的存在性检查与
    // 非空断言就都成了摆设 —— 类型系统根本没在看这条路。
    let kind: SupervisorKind;
    let backend: RunnerSupervisor;
    try {
      kind = resolveSupervisor(dir, readMarker(dir));
      backend = backendFor(kind);
    } catch (err: unknown) {
      logger.error(`[supervisor] 解析托管方式失败 ${dir}: ${errText(err)}`);
      continue;
    }
    if (!backend.reconcileOne) continue;

    try {
      const target = backend.prepare?.(dir);
      // **必须占锁，逐个目录占。** 这是本项目唯一无人触发的写路径，而每一条改 runner 状态的
      // 入口都占锁。具体的失败模式：listener 自己崩了、正处在退避里（正是用户会去点删除的那
      // 一刻）→ 本拍读到 rt → spawn 前的那次 /proc 全量扫描让出事件循环几十毫秒 → 删除侧
      // detach / 注销 / 清理全跑完 → spawn 恢复后把进程拉起来 → fs.remove 把工作目录从这个
      // 刚拉起的 run.sh 底下抽走，还留下一个孤儿 runtime 文件。
      //
      // 快速失败在这里恰好是对的语义：拿不到锁 = 有人正在置备/删除，本轮跳过，15 秒后再来。
      await withRunnerLock([dirKey(dir), ...(target?.lockKeys ?? [])], "service", () =>
        backend.reconcileOne!(dir, procs, target)
      );
    } catch (err: unknown) {
      if (isLockBusyError(err)) continue; // 预期内，不刷 error 日志
      logger.error(`[supervisor] ${kind} reconcile 失败 ${dir}: ${errText(err)}`);
    }
  }
}

let timer: NodeJS.Timeout | null = null;
let ticking = false;

/**
 * 起循环。**启动即跑一拍，不等第一个周期**：setInterval 不会立即触发，只挂 interval 的话
 * daemon 更新重启后要空等 15 秒才把被杀的 runner 拉回来。这一拍正是「重启可以接受，但重启后
 * 必须把所有该跑的 runner 拉起来」的落点。
 *
 * 调用点在 daemon 启动流程里，**必须排在实例载入之后**：managedRunnerDirs 是遍历句柄实例的
 * cwd 再按 .cipanel 过滤出来的，实例还没载入时它返回空数组，那第一拍就白跑了。
 */
export function startReconcileLoop(): void {
  if (timer) return;
  const run = (): void => {
    // 不许重入：一拍没跑完就到下一拍时直接跳过，否则慢节点上会叠起越来越多的并发 tick，
    // 每一拍都在抢同一批锁。
    if (ticking) return;
    ticking = true;
    // catch 不能省：tick 里 managedRunnerDirs() 与 canonicalPath 都在 try 之外，它们一抛就是
    // 一个没人接的 rejection。.finally() 返回的还是个会 reject 的 promise，void 只是丢掉它。
    // 这条循环 15 秒一拍且无人值守，持续失败会把日志刷满（Node 默认更会直接终止进程）。
    void tick()
      .catch((err: unknown) => logger.error(`[supervisor] reconcile tick 异常: ${errText(err)}`))
      .finally(() => {
        ticking = false;
      });
  };
  run();
  timer = setInterval(run, RECONCILE_INTERVAL_MS);
  timer.unref(); // 别让它吊住进程退出
  logger.info(`[supervisor] 收敛循环已启动，每 ${RECONCILE_INTERVAL_MS / 1000} 秒一拍`);
}

export function stopReconcileLoop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

// 仅供测试：跑一拍并等它结束。生产代码走 startReconcileLoop（它有防重入与 timer 生命周期）。
export async function __tickOnceForTest(): Promise<void> {
  await tick();
}
