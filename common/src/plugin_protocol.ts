// 插件契约：daemon 托管、panel 转发与鉴权、frontend 渲染，三方共用同一份声明；
// 而第四方 —— 插件作者 —— 在仓库之外，按同一份声明实现。
//
// 这是整套设计里唯一「以后改起来很贵」的东西：前三方一起发版，插件作者不跟着发版。
// 所以版本用一个单调整数显式协商（见 checkContract），而不是靠字段在不在。
//
// 只放类型与纯函数，且**不引任何运行时依赖**：前端用 `import type` 引类型、编译期擦除，
// 不会把 common 里的 fs / child_process 代码带进浏览器 bundle（同 runner_protocol.ts）。
//
// 本文件里的每个 string 字段都可能由不受信的第三方作者填写。凡是会进入渲染、路径、
// 事件名或 i18n 键的值，都在这里定形状与上限，而不是留给各个消费方各自当心。

// ---------------------------------------------------------------------------
// 版本协商
// ---------------------------------------------------------------------------

// 单调整数，不是 semver。semver 的比较规则要回答「兼容吗」这种它答不了的问题，
// 而我们只需要一条全序：插件声明的数字落没落在本端支持的窗口里。
// 加字段但不破坏旧插件 → 不动这个数；任何会让旧插件失效的改动 → +1 并抬高下界。
export const PLUGIN_CONTRACT_CURRENT = 1;

// 支持窗口的下界。抬高它就是宣告停止支持更旧的插件，属于破坏性动作，
// 要按 §生命周期 的弃用窗口先标 deprecated 再抬。
export const PLUGIN_CONTRACT_MIN_SUPPORTED = 1;

// 三种失败要分开，因为给运维看的处置完全不同：
//   too-new   插件比本端新 → 升级 ci-panel
//   too-old   插件比窗口旧 → 升级插件
//   malformed 根本不是整数 → 清单坏了
// 不要用 `a !== b` 判定（frontend/src/tools/version.ts 那种）：它没有序关系，
// 上面前两种会得到同一个答案，而它们的处置相反。
export type ContractVerdict = "ok" | "too-new" | "too-old" | "malformed";

export function checkContract(declared: unknown): ContractVerdict {
  if (typeof declared !== "number" || !Number.isInteger(declared)) return "malformed";
  if (declared > PLUGIN_CONTRACT_CURRENT) return "too-new";
  if (declared < PLUGIN_CONTRACT_MIN_SUPPORTED) return "too-old";
  return "ok";
}

// ---------------------------------------------------------------------------
// 插件 id
// ---------------------------------------------------------------------------

// id 同时是：目录名、systemd 单元名的一段、i18n 键前缀、以及各种以 id 为键的对象的键。
// 所以它的字母表必须比「能当文件名」更窄。
export const PLUGIN_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const PLUGIN_ID_MAX_LENGTH = 64;

// 以 id 为键去建对象时，这三个名字会改写原型链而不是新增一个键。
// JSON.parse('{"__proto__":{}}') 确实会产出一个自有可枚举的 __proto__ 键，
// 所以「反正来自 JSON」不构成豁免。
const HAZARDOUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function isValidPluginId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > PLUGIN_ID_MAX_LENGTH) return false;
  if (HAZARDOUS_KEYS.has(value)) return false;
  return PLUGIN_ID_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// i18n 键
// ---------------------------------------------------------------------------

// 用下划线分隔，不能用点：vue-i18n 默认把键里的点当**路径**解析，
// `a.b` 会去找名为 a 的父对象，找不到就回落成显示原始键名。
export const PLUGIN_I18N_PREFIX = "plugin__";
export const PLUGIN_I18N_KEY_PATTERN = /^[A-Za-z0-9_]{1,64}$/;

export function pluginI18nKey(pluginId: string, key: string): string {
  return `${PLUGIN_I18N_PREFIX}${pluginId.replace(/-/g, "_")}__${key}`;
}

// 插件提供的**译文**（不是键）还要过一道内容检查，见 isSafeI18nValue。
export const PLUGIN_TEXT_MAX_LENGTH = 512;

// vue-i18n 会编译每一条 message：`@:KEY` 把另一条目录项拼进输出（可用来偷别处的文案），
// `|` 切出复数分支，未闭合的花括号在渲染期抛 CompileError —— 那是渲染期，
// 不是加载期，所以一条坏译文能让某个页面直接白屏。
export function isSafeI18nValue(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length > PLUGIN_TEXT_MAX_LENGTH) return false;
  return !/[{}@|]/.test(value);
}

// ---------------------------------------------------------------------------
// 线上信封
// ---------------------------------------------------------------------------

// ci-panel 自有的错误码，封闭 union。插件返回的任何文本都不直接进 UI：
// panel 把它归一成这里的某一个码，前端按码查**字面量**的 i18n 键。
// 不要用 t(`TXT_CODE_${code}`) 拼键 —— 仓库根的 scan-useless-key 按字面量扫描，
// 扫不到就会把这些键从语言目录里删掉。
export type PluginErrorCode =
  | "PLUGIN_NOT_INSTALLED"
  | "PLUGIN_DISABLED"
  | "PLUGIN_UNREACHABLE"
  | "PLUGIN_TIMEOUT"
  | "PLUGIN_CONTRACT_MISMATCH"
  | "PLUGIN_BAD_PAYLOAD"
  | "PLUGIN_BAD_REQUEST"
  | "PLUGIN_INTERNAL";

export const PLUGIN_ERROR_CODES: readonly PluginErrorCode[] = [
  "PLUGIN_NOT_INSTALLED",
  "PLUGIN_DISABLED",
  "PLUGIN_UNREACHABLE",
  "PLUGIN_TIMEOUT",
  "PLUGIN_CONTRACT_MISMATCH",
  "PLUGIN_BAD_PAYLOAD",
  "PLUGIN_BAD_REQUEST",
  "PLUGIN_INTERNAL"
] as const;

export interface PluginErrorReply {
  status: "error";
  code: PluginErrorCode;
  // 只用于日志与管理员视图，永远不直接渲染进 DOM。
  detail?: string;
}

export interface PluginOkReply<T> {
  status: "ok";
  data: T;
}

export type PluginReply<T> = PluginOkReply<T> | PluginErrorReply;

// GET /v1/health
export type PluginHealthStatus = "ok" | "degraded" | "unknown";

// unknown 是刻意的一档：最常见的情形不是插件坏了，而是宿主上根本没装它要的东西。
// 那种情况应当能被区分出来并展示原因，而不是一律算失败去触发重启退避。
export interface PluginHealthPayload {
  status: PluginHealthStatus;
  contract: number;
  detail?: string;
}

// GET /v1/data/:dataId
export interface PluginDataPayload {
  rows: PluginRow[];
}

export type PluginRow = Record<string, PluginCell>;

// 带标签的单元格，而不是任意字符串：渲染器因此是**穷尽**的 switch，
// 插件没有任何一条路径能把标记塞进 DOM。href 的协议白名单在消费端校验，
// 但形状在这里定死，消费端才有东西可校验。
export type PluginBadgeTone = "neutral" | "info" | "success" | "warning" | "danger";

export const PLUGIN_BADGE_TONES: readonly PluginBadgeTone[] = [
  "neutral",
  "info",
  "success",
  "warning",
  "danger"
] as const;

export type PluginCell =
  | { kind: "text"; value: string }
  | { kind: "number"; value: number }
  | { kind: "badge"; value: string; tone: PluginBadgeTone }
  | { kind: "link"; value: string; href: string };

// ---------------------------------------------------------------------------
// 清单
// ---------------------------------------------------------------------------

// contract 1 只有进程托管。"container" 会在有节点确实具备条件时作为可选后端加入，
// 届时它是这个 union 的新成员，而不是一个新字段。
export type PluginRuntimeKind = "process";

export interface PluginRuntimeSpec {
  kind: PluginRuntimeKind;
  // 相对插件目录的可执行文件路径。不接受绝对路径，也不接受 ..。
  entry: string;
  limits?: PluginResourceLimits;
}

// 落到 systemd 单元的 MemoryMax / CPUQuota / TasksMax。留空取 ci-panel 的默认值，
// 上限由 ci-panel 夹逼 —— 清单说了不算。
export interface PluginResourceLimits {
  memoryMB?: number;
  cpuPercent?: number;
  tasks?: number;
}

export interface PluginDataSourceSpec {
  id: string;
  // 前端轮询间隔（毫秒），由 ci-panel 夹逼到一个下界，防止清单把面板变成压测客户端。
  refresh?: number;
}

export type PluginRenderKind = "table" | "kv" | "list" | "stat" | "chart";

export const PLUGIN_RENDER_KINDS: readonly PluginRenderKind[] = [
  "table",
  "kv",
  "list",
  "stat",
  "chart"
] as const;

export interface PluginViewSpec {
  id: string;
  render: PluginRenderKind;
  // 引用 data[].id
  source: string;
  // render 为 table 时的列顺序；其余 render 忽略。
  columns?: string[];
}

// 高度取的是 frontend LayoutCardHeight 的**枚举名**，不是 CSS 值：让插件填
// "100px" 这种自由字符串，等于把一个它说了算的值直接送进 style 属性。
export type PluginCardHeight = "MINI" | "SMALL" | "MEDIUM" | "BIG" | "LARGE" | "AUTO";

export const PLUGIN_CARD_HEIGHTS: readonly PluginCardHeight[] = [
  "MINI",
  "SMALL",
  "MEDIUM",
  "BIG",
  "LARGE",
  "AUTO"
] as const;

// 布局是 12 栅格（ant 的 a-col span），所以宽度是 1..12 的整数而不是任意数。
export const PLUGIN_CARD_MAX_WIDTH = 12;

export interface PluginCardSpec {
  id: string;
  // 引用 views[].id
  view: string;
  // 标题走 i18n 键，不是字面文案。
  title: string;
  width?: number;
  height?: PluginCardHeight;
}

export interface PluginPageSpec {
  id: string;
  // 只允许 /plugin/<pluginId> 之下，且由 ci-panel 拼出，清单不能自己指定任意路径。
  title: string;
  // 引用 cards[].id
  layout: string[];
}

export type PluginI18nCatalogues = Record<string, Record<string, string>>;

export interface PluginManifest {
  contract: number;
  id: string;
  version: string;
  // i18n 键
  displayName: string;
  runtime: PluginRuntimeSpec;
  data: PluginDataSourceSpec[];
  views: PluginViewSpec[];
  cards?: PluginCardSpec[];
  pages?: PluginPageSpec[];
  i18n?: PluginI18nCatalogues;
}

// ---------------------------------------------------------------------------
// 清单校验
// ---------------------------------------------------------------------------

export type PluginManifestValidation =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; errors: string[] };

// contract 1 认得的顶层字段。多一个就拒，而不是忽略：
// 一个写了 `actions` 的插件如果被静默接受，作者会以为动作生效了，实际什么都不会发生。
// 将来加扩展点就是 contract +1 并在这里放行新字段。
const KNOWN_TOP_LEVEL_KEYS = new Set([
  "contract",
  "id",
  "version",
  "displayName",
  "runtime",
  "data",
  "views",
  "cards",
  "pages",
  "i18n"
]);

// semver.org 给出的官方正则。自己手写的宽松版有两头都错的毛病：会误拒合法的
// build metadata（1.2.3+linux.x64），又会放行非法的空预发布标识（1.2.3-alpha..1）。
// 这一点在契约里比别处更要紧 —— 被冻结的不只是字段，还有「接受哪些输入」：
// 今天放宽了将来收紧就是破坏性变更，今天误拒了将来放宽反而是安全的。
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
const VERSION_MAX_LENGTH = 64;
// 清单内部的引用 id（data/views/cards/pages 互指）比插件 id 宽一格，允许下划线：
// 它们不会变成目录名或 systemd 单元名，只在清单内部解析。插件 id 不放开下划线，
// 是因为它要参与 i18n 键的拼接，而那里下划线是分隔符。
const REF_PATTERN = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const REF_MAX_LENGTH = 64;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isRef(v: unknown): v is string {
  return (
    typeof v === "string" &&
    v.length > 0 &&
    v.length <= REF_MAX_LENGTH &&
    !HAZARDOUS_KEYS.has(v) &&
    REF_PATTERN.test(v)
  );
}

// rejectUnknown 只管字段名。字段**值**也必须逐个收窄，否则结尾那句
// `raw as unknown as PluginManifest` 就是在撒谎：limits.memoryMB 会被声明成 number
// 而实际是 "unlimited"，然后原样拼进 systemd 单元的 MemoryMax=。
function isPositiveInt(v: unknown, max?: number): v is number {
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) return false;
  return max === undefined || v <= max;
}

function isI18nKey(v: unknown): v is string {
  // 正则里有下划线，所以 __proto__ 是能匹配的 —— 必须单独挡。这些键会作为对象键
  // 进 vue-i18n 的 mergeLocaleMessage；intlify 的 deepCopy 眼下确实跳过 __proto__，
  // 但那是它的实现细节，不是我们能依赖的承诺。
  return typeof v === "string" && !HAZARDOUS_KEYS.has(v) && PLUGIN_I18N_KEY_PATTERN.test(v);
}

// 顶层用「白名单之外一律拒」而不是忽略：作者写了本版不支持的字段时必须当场报错，
// 否则他会以为那个功能生效了。这个理由在嵌套层同样成立 —— views[0].chart 被静默丢掉，
// 和 actions 被静默丢掉是同一种失败。
function rejectUnknown(
  obj: Record<string, unknown>,
  known: readonly string[],
  where: string,
  err: (m: string) => void
) {
  for (const key of Object.keys(obj)) {
    if (!known.includes(key)) err(`unknown field: ${where}.${key}`);
  }
}

// 入参是不受信第三方写的 JSON，因此逐字段判定，不做任何 `as` 断言。
// 一次收集全部错误再返回：作者改一轮清单应当能看到所有问题，而不是修一个冒一个。
export function validatePluginManifest(raw: unknown): PluginManifestValidation {
  const errors: string[] = [];
  const err = (m: string) => errors.push(m);

  if (!isPlainObject(raw)) return { ok: false, errors: ["manifest must be a JSON object"] };

  for (const key of Object.keys(raw)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(key)) err(`unknown top-level field: ${key}`);
  }

  const verdict = checkContract(raw.contract);
  if (verdict !== "ok") err(`contract ${String(raw.contract)} is ${verdict}`);

  if (!isValidPluginId(raw.id)) err("id must match ^[a-z0-9]+(-[a-z0-9]+)*$ and be 1-64 chars");
  if (
    typeof raw.version !== "string" ||
    raw.version.length > VERSION_MAX_LENGTH ||
    !SEMVER_PATTERN.test(raw.version)
  ) {
    err("version must be a semver 2.0 string");
  }
  if (!isI18nKey(raw.displayName)) err("displayName must be an i18n key ([A-Za-z0-9_]{1,64})");

  // runtime
  if (!isPlainObject(raw.runtime)) {
    err("runtime is required and must be an object");
  } else {
    if (raw.runtime.kind !== "process") err('runtime.kind must be "process" in contract 1');
    const entry = raw.runtime.entry;
    if (typeof entry !== "string" || entry.length === 0) {
      err("runtime.entry is required");
    } else if (entry.startsWith("/") || entry.split("/").includes("..")) {
      err("runtime.entry must be a relative path inside the plugin directory");
    }
    if (raw.runtime.limits !== undefined && !isPlainObject(raw.runtime.limits)) {
      err("runtime.limits must be an object when present");
    } else if (isPlainObject(raw.runtime.limits)) {
      rejectUnknown(raw.runtime.limits, ["memoryMB", "cpuPercent", "tasks"], "runtime.limits", err);
      // 上界由 ci-panel 在下发时夹逼，清单说了不算；这里只保证它是个正整数，
      // 因为这三个值会原样变成 MemoryMax= / CPUQuota= / TasksMax=。
      for (const f of ["memoryMB", "cpuPercent", "tasks"] as const) {
        const v = raw.runtime.limits[f];
        if (v !== undefined && !isPositiveInt(v)) err(`runtime.limits.${f} must be a positive integer`);
      }
    }
    rejectUnknown(raw.runtime, ["kind", "entry", "limits"], "runtime", err);
  }

  // data
  const dataIds = new Set<string>();
  if (!Array.isArray(raw.data) || raw.data.length === 0) {
    err("data must be a non-empty array");
  } else {
    raw.data.forEach((d, i) => {
      if (!isPlainObject(d) || !isRef(d.id)) return err(`data[${i}].id is missing or malformed`);
      if (dataIds.has(d.id)) err(`duplicate data id: ${d.id}`);
      dataIds.add(d.id);
      rejectUnknown(d, ["id", "refresh"], `data[${i}]`, err);
      if (d.refresh !== undefined && (typeof d.refresh !== "number" || d.refresh <= 0)) {
        err(`data[${i}].refresh must be a positive number`);
      }
    });
  }

  // views
  const viewIds = new Set<string>();
  if (!Array.isArray(raw.views) || raw.views.length === 0) {
    err("views must be a non-empty array");
  } else {
    raw.views.forEach((v, i) => {
      if (!isPlainObject(v) || !isRef(v.id)) return err(`views[${i}].id is missing or malformed`);
      if (viewIds.has(v.id)) err(`duplicate view id: ${v.id}`);
      viewIds.add(v.id);
      rejectUnknown(v, ["id", "render", "source", "columns"], `views[${i}]`, err);
      if (!PLUGIN_RENDER_KINDS.includes(v.render as PluginRenderKind)) {
        err(`views[${i}].render must be one of ${PLUGIN_RENDER_KINDS.join(" | ")}`);
      }
      if (!isRef(v.source)) err(`views[${i}].source is missing or malformed`);
      else if (!dataIds.has(v.source)) err(`views[${i}].source references unknown data: ${v.source}`);
      if (v.columns !== undefined && (!Array.isArray(v.columns) || !v.columns.every(isRef))) {
        err(`views[${i}].columns must be an array of identifiers`);
      }
    });
  }

  // cards
  const cardIds = new Set<string>();
  if (raw.cards !== undefined) {
    if (!Array.isArray(raw.cards)) err("cards must be an array when present");
    else {
      raw.cards.forEach((c, i) => {
        if (!isPlainObject(c) || !isRef(c.id)) return err(`cards[${i}].id is missing or malformed`);
        if (cardIds.has(c.id)) err(`duplicate card id: ${c.id}`);
        cardIds.add(c.id);
        rejectUnknown(c, ["id", "view", "title", "width", "height"], `cards[${i}]`, err);
        if (!isRef(c.view)) err(`cards[${i}].view is missing or malformed`);
        else if (!viewIds.has(c.view)) err(`cards[${i}].view references unknown view: ${c.view}`);
        if (!isI18nKey(c.title)) err(`cards[${i}].title must be an i18n key`);
        if (c.width !== undefined && !isPositiveInt(c.width, PLUGIN_CARD_MAX_WIDTH)) {
          err(`cards[${i}].width must be an integer between 1 and ${PLUGIN_CARD_MAX_WIDTH}`);
        }
        if (c.height !== undefined && !PLUGIN_CARD_HEIGHTS.includes(c.height as PluginCardHeight)) {
          err(`cards[${i}].height must be one of ${PLUGIN_CARD_HEIGHTS.join(" | ")}`);
        }
      });
    }
  }

  // pages
  if (raw.pages !== undefined) {
    if (!Array.isArray(raw.pages)) err("pages must be an array when present");
    else {
      const pageIds = new Set<string>();
      raw.pages.forEach((p, i) => {
        if (!isPlainObject(p) || !isRef(p.id)) return err(`pages[${i}].id is missing or malformed`);
        if (pageIds.has(p.id)) err(`duplicate page id: ${p.id}`);
        pageIds.add(p.id);
        rejectUnknown(p, ["id", "title", "layout"], `pages[${i}]`, err);
        if (!isI18nKey(p.title)) err(`pages[${i}].title must be an i18n key`);
        if (!Array.isArray(p.layout) || p.layout.length === 0) {
          err(`pages[${i}].layout must be a non-empty array`);
        } else {
          p.layout.forEach((ref, j) => {
            if (!isRef(ref)) err(`pages[${i}].layout[${j}] is malformed`);
            else if (!cardIds.has(ref)) err(`pages[${i}].layout[${j}] references unknown card: ${ref}`);
          });
        }
      });
    }
  }

  // i18n：键与值都是作者写的，两头都查。
  if (raw.i18n !== undefined) {
    if (!isPlainObject(raw.i18n)) err("i18n must be an object when present");
    else {
      for (const [locale, table] of Object.entries(raw.i18n)) {
        if (HAZARDOUS_KEYS.has(locale)) {
          err(`i18n has a hazardous locale name: ${locale}`);
          continue;
        }
        if (!isPlainObject(table)) {
          err(`i18n.${locale} must be an object`);
          continue;
        }
        for (const [key, value] of Object.entries(table)) {
          if (!isI18nKey(key)) err(`i18n.${locale} has a malformed key: ${key}`);
          if (!isSafeI18nValue(value)) {
            err(`i18n.${locale}.${key} must be a string under ${PLUGIN_TEXT_MAX_LENGTH} chars with no { } @ |`);
          }
        }
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, manifest: raw as unknown as PluginManifest };
}
