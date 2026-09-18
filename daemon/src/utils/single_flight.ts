// CI Panel 扩展：把「同一件昂贵的只读活儿」的并发调用合并成一次。
//
// 面板的状态轮询是扇出的：概览 3 秒一轮、runner 列表 10 秒一轮、详情页 5 秒一轮，最后全都落到
// 同一批 /proc 全量扫描与 systemctl 查询上，而这些路径此前各扫各的。实测（6400 个 pid 的节点）：
// 单独一次 runner/managed_list 要 659 ms，6 个并发时每个都要 3.4 秒 —— 6 轮独立的全量扫描在只有
// 4 个线程的 libuv 线程池里互相排队，并发度换来的是等量的延迟。合并之后这 6 个调用共享同一轮。
//
// **只给只读路径用。** 动作路径（start / stop / detach）要的是「此时此刻」的事实：共享一个早它
// 几百毫秒就开始的调用，等于拿一份过期快照去做不可逆的决定，而那正是双托管的入口。
//
// 失败不缓存：被合并的调用一起收到同一个 rejection，下一次调用重新发起。缓存住一次抖动出来的
// 失败，会把「systemctl 抖了一下」放大成「接下来 N 秒内所有人都看不到状态」。

export interface SingleFlightOptions {
  /**
   * 已完成的结果可以复用多久（毫秒）。缺省 0 表示只合并并发调用、不缓存已完成的结果 ——
   * 这是最保守的取值：调用方永远拿不到一份在它发起之前就已经**结束**的观测。
   */
  ttlMs?: number;
  /** 时钟。仅供测试注入，生产用 Date.now。 */
  now?: () => number;
}

/**
 * 按 key 合并：同一个 key 上并发的调用共享一次 `load`，不同 key 互不影响。
 *
 * key 必须覆盖 `load` 的全部入参，否则不同参数的调用会互相顶掉结果。
 */
export function singleFlightBy<A extends unknown[], T>(
  keyOf: (...args: A) => string,
  load: (...args: A) => Promise<T>,
  opts: SingleFlightOptions = {}
): (...args: A) => Promise<T> {
  const ttlMs = opts.ttlMs ?? 0;
  // 每次调用现查 Date.now，而不是在这里把函数引用抓走：抓走的话，之后任何替换全局 Date 的人
  // （测试里的 fake timers，生产上没有）拿到的还是原来那一个，TTL 会看着一个与调用方不同的时钟。
  const now = opts.now ?? (() => Date.now());
  const inFlight = new Map<string, Promise<T>>();
  const done = new Map<string, { at: number; value: T }>();

  return (...args: A): Promise<T> => {
    const key = keyOf(...args);

    if (ttlMs > 0) {
      const cached = done.get(key);
      if (cached && now() - cached.at < ttlMs) return Promise.resolve(cached.value);
      // 过期的条目不留着：key 可变时（比如按单元名列表 key）这张表会无上限地长。
      if (cached) done.delete(key);
    }

    const running = inFlight.get(key);
    if (running) return running;

    const task = load(...args)
      .then((value) => {
        if (ttlMs > 0) {
          const at = now();
          // 写入时顺手清掉所有已过期的条目：只在「同一个 key 再来时」才删的话，一个再也不会
          // 被问到的 key 会一直留在闭包里。O(n) 但 n 就是 key 的个数，而写入只发生在一次
          // 昂贵的 load 完成之后 —— 相比 load 本身可以忽略。
          for (const [k, entry] of done) if (at - entry.at >= ttlMs) done.delete(k);
          done.set(key, { at, value });
        }
        return value;
      })
      .finally(() => {
        // finally 而不是只在 then 里删：失败也必须让出位置，否则一次 rejection 会把这个 key
        // 永久钉在一个已经 settle 的 promise 上，之后每个调用都立刻拿到那个旧错误。
        inFlight.delete(key);
      });

    inFlight.set(key, task);
    return task;
  };
}

/** 无参版本：整个函数只有一件活儿要合并。 */
export function singleFlight<T>(
  load: () => Promise<T>,
  opts: SingleFlightOptions = {}
): () => Promise<T> {
  return singleFlightBy(() => "", load, opts);
}
