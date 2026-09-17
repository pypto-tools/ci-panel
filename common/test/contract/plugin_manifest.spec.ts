import { describe, expect, it } from "vitest";
import {
  PLUGIN_BADGE_TONES,
  PLUGIN_CONTRACT_CURRENT,
  PLUGIN_CONTRACT_MIN_SUPPORTED,
  PLUGIN_ERROR_CODES,
  PLUGIN_RENDER_KINDS,
  checkContract,
  isSafeI18nValue,
  isValidPluginId,
  pluginI18nKey,
  validatePluginManifest
} from "../../src/plugin_protocol";

// 插件清单是这套设计里唯一「作者在仓库之外、不跟着我们发版」的输入。三方（daemon/panel/
// frontend）一起改，第四方不改，所以这里钉的不是实现细节而是**对外承诺**：
// 版本怎么比、id 长什么样、哪些字段认、以及哪些敌意输入必须被挡下。
//
// 每个用例都写明它对什么样的错误实现变红 —— 一个两种实现都能过的断言证明不了任何事。

const validManifest = () => ({
  contract: PLUGIN_CONTRACT_CURRENT,
  id: "acme-approval",
  version: "0.1.0",
  displayName: "NAME",
  runtime: { kind: "process", entry: "bin/server" },
  data: [{ id: "pending", refresh: 30000 }],
  views: [{ id: "queue", render: "table", source: "pending", columns: ["repo", "age"] }],
  cards: [{ id: "queue_card", view: "queue", title: "CARD_TITLE" }],
  pages: [{ id: "main", title: "PAGE_TITLE", layout: ["queue_card"] }],
  i18n: { en_US: { NAME: "Approval queue" }, zh_CN: { NAME: "审批队列" } }
});

const errorsFor = (raw: unknown): string[] => {
  const r = validatePluginManifest(raw);
  return r.ok ? [] : r.errors;
};

describe("contract version negotiation", () => {
  it("distinguishes too-new from too-old instead of merely unequal", () => {
    // 对 `declared !== CURRENT` 这种实现变红：它会把两者都报成同一个答案，
    // 而两者的处置相反（升 ci-panel vs 升插件）。
    expect(checkContract(PLUGIN_CONTRACT_CURRENT + 1)).toBe("too-new");
    expect(checkContract(PLUGIN_CONTRACT_MIN_SUPPORTED - 1)).toBe("too-old");
    expect(checkContract(PLUGIN_CONTRACT_CURRENT)).toBe("ok");
  });

  it("treats a non-integer as malformed, not as a number to compare", () => {
    // 对 `Number(declared) > CURRENT` 这种实现变红："1" 会被悄悄当成 1 通过。
    for (const bad of ["1", 1.5, NaN, null, undefined, {}, []]) {
      expect(checkContract(bad)).toBe("malformed");
    }
  });

  it("keeps the supported window non-empty", () => {
    expect(PLUGIN_CONTRACT_MIN_SUPPORTED).toBeLessThanOrEqual(PLUGIN_CONTRACT_CURRENT);
  });
});

describe("plugin id", () => {
  it("accepts the documented alphabet and nothing near it", () => {
    expect(isValidPluginId("acme-npu-stats")).toBe(true);
    expect(isValidPluginId("a1")).toBe(true);
    for (const bad of [
      "Acme", // 大写：会让目录名在大小写不敏感的文件系统上撞车
      "acme_stats", // 下划线：留给 i18n 键的分隔符，id 里不用
      "-acme",
      "acme-",
      "acme--stats",
      "acme stats",
      "acme/stats", // 路径分隔符
      "../acme",
      ""
    ]) {
      expect(isValidPluginId(bad), bad).toBe(false);
    }
  });

  it("rejects the three names that would poison an object used as a map", () => {
    // 对「只跑正则」的实现变红：__proto__ 本身是能通过那个正则的。
    for (const bad of ["__proto__", "constructor", "prototype"]) {
      expect(isValidPluginId(bad), bad).toBe(false);
    }
  });

  it("rejects a non-string without throwing", () => {
    for (const bad of [null, undefined, 1, {}, []]) expect(isValidPluginId(bad)).toBe(false);
  });
});

describe("i18n keys and values", () => {
  it("joins with underscores, never dots", () => {
    // vue-i18n 把点当路径解析，带点的键会回落成显示原始键名。
    const key = pluginI18nKey("acme-approval", "CARD_TITLE");
    expect(key).toBe("plugin__acme_approval__CARD_TITLE");
    expect(key).not.toContain(".");
  });

  it("rejects message syntax that would reach into the catalogue or break rendering", () => {
    // 对「只限长度」的实现变红。
    expect(isSafeI18nValue("Approval queue")).toBe(true);
    expect(isSafeI18nValue("@:TXT_CODE_app.forcedShutdown")).toBe(false); // 拼进别处文案
    expect(isSafeI18nValue("one | many")).toBe(false); // 复数分支
    expect(isSafeI18nValue("unbalanced {")).toBe(false); // 渲染期 CompileError
    expect(isSafeI18nValue("x".repeat(513))).toBe(false);
    expect(isSafeI18nValue(42)).toBe(false);
  });
});

describe("closed unions stay closed", () => {
  it("pins the v1 render kinds", () => {
    expect([...PLUGIN_RENDER_KINDS]).toEqual(["table", "kv", "list", "stat", "chart"]);
  });

  it("pins the badge tones and the error codes", () => {
    expect([...PLUGIN_BADGE_TONES]).toEqual(["neutral", "info", "success", "warning", "danger"]);
    // 每个码都要在语言目录里有一条**字面量**键；这里先锁住集合本身。
    expect(PLUGIN_ERROR_CODES).toHaveLength(8);
    expect(new Set(PLUGIN_ERROR_CODES).size).toBe(PLUGIN_ERROR_CODES.length);
  });
});

describe("manifest validation: the happy path", () => {
  it("accepts a complete manifest and hands back the typed value", () => {
    const r = validatePluginManifest(validManifest());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.manifest.id).toBe("acme-approval");
  });

  it("accepts a manifest with only the required half", () => {
    const m = validManifest();
    delete (m as Record<string, unknown>).cards;
    delete (m as Record<string, unknown>).pages;
    delete (m as Record<string, unknown>).i18n;
    expect(validatePluginManifest(m).ok).toBe(true);
  });

  it("reports every problem at once rather than the first", () => {
    // 作者改一轮清单应当看到全部问题。对 early-return 式实现变红。
    const errors = errorsFor({ ...validManifest(), id: "BAD", version: "v1" });
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });
});

describe("manifest validation: refusing what contract 1 does not implement", () => {
  it("rejects an unknown top-level field instead of ignoring it", () => {
    // 这是整条前向兼容路线的支点：写了 actions 的插件必须当场报错，
    // 否则作者会以为动作生效了，而实际上什么都不会发生。
    const errors = errorsFor({ ...validManifest(), actions: [{ id: "approve" }] });
    expect(errors.some((e) => e.includes("actions"))).toBe(true);
  });

  it("rejects a runtime kind that is not process", () => {
    const m = validManifest();
    m.runtime = { kind: "container", entry: "bin/server" } as never;
    expect(errorsFor(m).some((e) => e.includes("runtime.kind"))).toBe(true);
  });
});

describe("manifest validation: hostile input", () => {
  it("rejects an entry that escapes the plugin directory", () => {
    for (const entry of ["/usr/bin/id", "../../usr/bin/id", "a/../../b"]) {
      const m = validManifest();
      m.runtime = { kind: "process", entry };
      expect(errorsFor(m).some((e) => e.includes("runtime.entry")), entry).toBe(true);
    }
  });

  it("rejects __proto__ used as a data id", () => {
    const m = validManifest();
    m.data = [{ id: "__proto__" as string, refresh: 1000 }];
    expect(validatePluginManifest(m).ok).toBe(false);
  });

  it("survives a payload carrying an own __proto__ key without polluting Object", () => {
    // JSON.parse 确实会产出自有可枚举的 __proto__ 键，所以「反正来自 JSON」不是豁免。
    const raw = JSON.parse('{"__proto__":{"polluted":true},"contract":1}');
    expect(validatePluginManifest(raw).ok).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("rejects a view whose source names a data id that does not exist", () => {
    const m = validManifest();
    m.views = [{ id: "queue", render: "table", source: "nope", columns: [] }];
    expect(errorsFor(m).some((e) => e.includes("unknown data"))).toBe(true);
  });

  it("rejects a page whose layout names a card that does not exist", () => {
    const m = validManifest();
    m.pages = [{ id: "main", title: "PAGE_TITLE", layout: ["ghost_card"] }];
    expect(errorsFor(m).some((e) => e.includes("unknown card"))).toBe(true);
  });

  it("rejects duplicate ids within a collection", () => {
    const m = validManifest();
    m.data = [{ id: "pending", refresh: 1000 }, { id: "pending", refresh: 1000 }];
    expect(errorsFor(m).some((e) => e.includes("duplicate data id"))).toBe(true);
  });

  it("rejects an unknown render kind", () => {
    const m = validManifest();
    m.views = [{ id: "queue", render: "iframe", source: "pending", columns: [] } as never];
    expect(errorsFor(m).some((e) => e.includes("render"))).toBe(true);
  });

  it("rejects a title that is free text rather than an i18n key", () => {
    // 标题必须是键，因为字面文案会被原样渲染，而它由不受信作者提供。
    const m = validManifest();
    m.cards = [{ id: "queue_card", view: "queue", title: "<img src=x onerror=alert(1)>" }];
    expect(errorsFor(m).some((e) => e.includes("title"))).toBe(true);
  });

  it("rejects __proto__ as an i18n key or locale name", () => {
    // 键的正则含下划线，所以 __proto__ 能匹配 —— 这条守的是那个单独的判定。
    // 眼下 intlify 的 deepCopy 确实跳过 __proto__，但那是它的实现细节，不是承诺。
    //
    // 夹具必须走 JSON.parse：对象字面量里的 `__proto__:` 是设置原型的特殊语法，
    // 不产生自有属性，Object.entries 根本看不到它。而清单本来就是 JSON 解析来的，
    // 那条路径才会真的产出一个自有的 __proto__ 键。
    const withKey = validManifest();
    withKey.i18n = JSON.parse('{"en_US":{"__proto__":"x"}}');
    expect(errorsFor(withKey).some((e) => e.includes("__proto__"))).toBe(true);

    const withLocale = validManifest();
    withLocale.i18n = JSON.parse('{"__proto__":{"NAME":"x"}}');
    expect(errorsFor(withLocale).some((e) => e.includes("__proto__"))).toBe(true);
  });

  it("rejects an unknown field one level down, not just at the top", () => {
    // 与顶层同一个理由：作者写了 views[].chart 期待图表配置生效，静默忽略的话
    // 他拿到的是一个什么都不做的视图，且没有任何提示。
    const m = validManifest();
    m.views = [
      { id: "queue", render: "table", source: "pending", columns: [], chart: { x: "a" } } as never
    ];
    expect(errorsFor(m).some((e) => e.includes("views[0].chart"))).toBe(true);
  });

  it("rejects a non-object manifest without throwing", () => {
    for (const bad of [null, undefined, 42, "manifest", []]) {
      expect(validatePluginManifest(bad).ok, String(bad)).toBe(false);
    }
  });
});
