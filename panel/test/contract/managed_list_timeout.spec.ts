import fs from "fs-extra";
import path from "path";
import { describe, expect, it } from "vitest";
import { PANEL_ROOT } from "../setup";

// 面板向每个节点要 runner 列表的超时，与浏览器的请求超时，是一对必须错开的数字。
//
// 它们原本都是 30000，撞在同一刻：面板要等到 30.0 秒才把慢节点判进 failedNodes、再拼响应，
// 而浏览器在 30.0 秒整点就已经 abort 了。于是 collectRunners 那条写好的部分失败降级
// （failedNodes + 前端的"数据不完整"横幅）一次都跑不到，用户看到的永远是整页「加载失败：
// timeout of 30000ms exceeded」—— 连扫得飞快的健康节点也一起空掉，因为整个 runner 界面都由
// 这一个响应推导出来。
//
// 两个值分别写在 panel 与 frontend 里，没有任何编译期关系，所以只能在这里对着源码比。
// 同理，它们也不适合搬进 common：这是部署形态的约束（浏览器 ↔ 面板），不是共享协议。

const PANEL_SRC = path.join(PANEL_ROOT, "src/app/service/repo_service.ts");
const FRONTEND_SRC = path.join(PANEL_ROOT, "../frontend/src/services/apiService.ts");

// 留给面板把剩下那些节点的结果拼好并发出去的余量。小于它，降级路径仍然可能被浏览器抢在前面。
const MARGIN_MS = 2_000;

function readNumber(file: string, re: RegExp, what: string): number {
  const m = fs.readFileSync(file, "utf8").match(re);
  expect(m, `在 ${path.basename(file)} 里找不到${what}，这条守卫要跟着改`).not.toBeNull();
  // 形如 `1000 * 30` 的写法也要算得出来，只取第一个数字会把 30000 读成 1000。
  return m![1]
    .split("*")
    .map((part) => Number(part.trim()))
    .reduce((a, b) => a * b, 1);
}

describe("runner 列表的超时分层", () => {
  const panelTimeout = readNumber(
    PANEL_SRC,
    /MANAGED_LIST_TIMEOUT_MS\s*=\s*([\d_\s*]+);/,
    "MANAGED_LIST_TIMEOUT_MS"
  );
  const browserTimeout = readNumber(
    FRONTEND_SRC,
    /config\.timeout\s*=\s*([\d\s*]+);/,
    "axios 的缺省超时"
  );

  it("两个值都解析得出来", () => {
    expect(panelTimeout).toBeGreaterThan(0);
    expect(browserTimeout).toBeGreaterThan(0);
  });

  it("面板必须先于浏览器放弃，且留出拼响应的余量", () => {
    expect(panelTimeout + MARGIN_MS).toBeLessThanOrEqual(browserTimeout);
  });
});
