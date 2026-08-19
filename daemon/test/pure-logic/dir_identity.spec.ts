import fs from "fs-extra";
import path from "path";
import { beforeAll, describe, expect, it } from "vitest";
import { SCAN_ROOT } from "../setup";
import { dirKey } from "../../src/service/runner_lock";

// 「同一个 runner 只有一种 key」是 withRunnerLock 全部互斥语义的前提：算出两个 key，
// 置备与删除就会同时拿到锁，单元被重新装上/拉起之后目录才被删掉，留下一个工作目录已不存在的
// 服务（runner_lock.ts 文件头详述了这个失败模式）。
//
// 这里逐一构造「同一个目录的不同写法」，断言它们收敛到同一个 key。危险的那一格是**祖先**
// 符号链接：叶子链接（<root>/alias -> <root>/r1）任何实现都能归一，而祖先链接
// （/data -> /mnt/data）只在归一化一路上溯到「最深的那个存在的祖先」时才被解开。

const box = () => path.join(SCAN_ROOT, "identity");
const real = (...p: string[]) => path.join(box(), "real", ...p);
const via = (...p: string[]) => path.join(box(), "alias", ...p);

beforeAll(() => {
  // <box>/alias -> <box>/real，于是 <box>/alias/... 与 <box>/real/... 是同一批目录的两种写法
  fs.mkdirsSync(real("runners", "repo1", "r1"));
  fs.symlinkSync(path.join(box(), "real"), path.join(box(), "alias"), "dir");
});

describe("同一个 runner 目录只算出一种锁 key", () => {
  it("结尾斜杠不产生第二个 key", () => {
    expect(dirKey(real("runners", "repo1", "r1") + path.sep)).toBe(
      dirKey(real("runners", "repo1", "r1"))
    );
  });

  it("目录已存在时，祖先符号链接被解开", () => {
    expect(dirKey(via("runners", "repo1", "r1"))).toBe(dirKey(real("runners", "repo1", "r1")));
  });

  it("目录尚不存在、父目录存在时，祖先符号链接被解开", () => {
    // provision 在一个已有仓库下新建 runner：只缺叶子这一级
    expect(dirKey(via("runners", "repo1", "new"))).toBe(dirKey(real("runners", "repo1", "new")));
  });

  it("目录与父目录都不存在时，祖先符号链接仍被解开", () => {
    // provision 在一个**新仓库**下新建第一个 runner：repo9 与 r1 两级都不存在。
    // 这是只上溯一层的实现会漏掉的那一格——它在 realpath(dirname) 上也失败，退回字面路径，
    // 于是置备算出 <box>/alias/...，而这个 runner 建好之后再删算出 <box>/real/...，两把锁。
    expect(dirKey(via("runners", "repo9", "r1"))).toBe(dirKey(real("runners", "repo9", "r1")));
  });

  it("整条路径都不存在时也要给出一个可比较的 key，而不是抛错", () => {
    // 归一化算不出真实落点时退回字面 resolve：key 是内存 Map 的键，没有「算不出」这个取值。
    const nowhere = path.join(box(), "no", "such", "tree", "r1");
    expect(dirKey(nowhere)).toBe(dirKey(nowhere + path.sep));
    expect(dirKey(nowhere)).toContain(path.join("no", "such", "tree", "r1"));
  });

  it("key 带 dir: 前缀，与单元名命名空间分开", () => {
    // serviceKey 用 svc: 前缀。两个命名空间必须分开，否则一个叫 dir 的单元名会误撞目录 key。
    expect(dirKey(real("runners", "repo1", "r1")).startsWith(`dir:${path.sep}`)).toBe(true);
  });
});
