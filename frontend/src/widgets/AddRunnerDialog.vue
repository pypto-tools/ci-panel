<script setup lang="ts">
// 「添加 Runner」对话框（批量 + 多组）：
// 共享 仓库/token/代理/基目录；每组 {基础名, 标签, 数量} → 生成 <基础名>-1..-N，
// 每个 runner 目录 = 基目录/<name>。无自带按钮，外部通过 ref 调 open() 触发。
import { ref, reactive, computed, watch } from "vue";
import { message } from "ant-design-vue";
import {
  PlusOutlined,
  DeleteOutlined,
  FolderOpenOutlined,
  SettingOutlined
} from "@ant-design/icons-vue";
import { onUnmounted } from "vue";
import { t } from "@/lang/i18n";
import { labelKey, previewGroupNames } from "@/tools/runnerNaming";
import { defaultRunnerLabels } from "@/tools/runnerLabels";
import { expandEnvVars, formatEnvPreview, parseEnvText, type EnvVar } from "@/tools/envText";
import { envTemplateIndexOf, hasEnvTemplate } from "@/tools/envTemplate";
import { openNodeSelectDialog } from "@/components/fc/index";
import SelectDirDialog from "./SelectDirDialog.vue";
import {
  checkRunnerPackage,
  checkRunnerProxy,
  startRunnerDownload,
  runnerDownloadProgress,
  startRunnerBatch,
  runnerBatchProgress,
  retryRunnerBatch,
  collectRunners,
  runnerRepoGroups,
  runnerDefaultEnv,
  listRunnerDirs,
  type RunnerBatchProgressItem,
  type RepoLabelGroup,
  type ProxyCheckTargetResult,
  type DefaultDotEnvPreview
} from "@/services/apis/runner";

const emit = defineEmits<{ (e: "created"): void }>();

const open = ref(false);
const submitting = ref(false);
const daemonId = ref("");
// direct = 用内置 GitHub runner 包；import = 用指定的 tar.gz 安装包
const mode = ref<"direct" | "import">("direct");

const shared = reactive({
  repoUrl: "",
  token: "",
  baseDir: "",
  // 默认预填可用代理：直连 GitHub CDN 常被重置，拉取/注册都需要走代理
  proxy: "http://127.0.0.1:7892",
  packagePath: "",
  // 同时创建几个（1..10）。代理脆时别调太高，并行注册挤同一代理易触发重试风暴。
  // 存字符串是为了绑 a-input（与其它字段同款控件，高度一致），发送时再 Number()
  concurrency: "3"
});

// 从 GitHub 给的 `./config.sh --url <仓库> --token <token>` 命令里解析并回填仓库地址与 token，
// 省得手动分别复制两个字段。粘贴即解析。
const cmdPaste = ref("");
function parseCmd() {
  const s = cmdPaste.value || "";
  const url = s.match(/--url\s+(\S+)/);
  const token = s.match(/--token\s+(\S+)/);
  if (url) shared.repoUrl = url[1];
  if (token) shared.token = token[1];
}

// number 输入用的是 a-input（原生 max 不拦输入），失焦时把值钳制到范围内；空/非法回落到 min
function clampStr(v: string, min: number, max: number): string {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return String(min);
  return String(Math.min(max, Math.max(min, n)));
}

// 基目录选择器：打开服务器端目录浏览/新建弹窗，选定后回填 baseDir
const dirDialog = ref<InstanceType<typeof SelectDirDialog>>();
function openDirPicker() {
  if (!daemonId.value) return message.error("请先选择节点");
  dirDialog.value?.openDialog(daemonId.value, shared.baseDir.trim() || undefined);
}

interface Group {
  baseName: string;
  labels: string;
  // 标签是否仍是我们按节点架构预填的。换节点时只重填这些组——用户手打的、或点已有标签组
  // 复用来的，都是他自己的选择，改掉就是背着他换 job 的落点。
  // 靠字符串形状反推做不到这件事：`linux,npu` 和 `linux,ppc64` 长得一模一样。
  labelsAuto: boolean;
  count: string; // 绑 a-input（同款控件保证高度一致）；用到时 Number(g.count)
  // 该组每个 runner 的初始环境变量，两个目标各一个文本框（每行 KEY=VALUE）。
  // 提交时解析成 {key,value}[]；值里的 {{index}} 这类占位符由 daemon 按每个 runner 展开。
  envOverride: string;
  envDotenv: string;
  envOpen: boolean; // 折叠面板是否展开，纯界面态、不提交
}
// 所选节点自报的架构（daemon 的 os.arch()），空表示还没选节点或节点没报。
const nodeArch = ref("");
const defaultLabels = computed(() => defaultRunnerLabels(nodeArch.value));

// 不给 labels 就按所选节点的架构预填（记为自动值，换节点时可重填）；给了就是用户的选择。
const newGroup = (baseName = "", labels?: string): Group => ({
  baseName,
  labels: labels ?? defaultLabels.value,
  labelsAuto: labels === undefined,
  count: "1",
  envOverride: "",
  envDotenv: "",
  envOpen: false
});
const groups = ref<Group[]>([newGroup()]);

const addGroup = () => groups.value.push(newGroup());
const removeGroup = (i: number) => groups.value.length > 1 && groups.value.splice(i, 1);

// 该仓库在当前基目录下已有的 label 组（来自后端扫描 .cipanel）。用于复用标签与锁定命名。
const repoGroups = ref<RepoLabelGroup[]>([]);
const loadingGroups = ref(false);

// 拉取已有 label 组：需已选节点且填了仓库地址与基目录。任一缺失或出错则清空（不打扰用户）。
async function fetchRepoGroups() {
  const repoUrl = shared.repoUrl.trim();
  const baseDir = shared.baseDir.trim();
  if (!daemonId.value || !/^https?:\/\/.+/.test(repoUrl) || !baseDir) {
    repoGroups.value = [];
    return;
  }
  loadingGroups.value = true;
  try {
    const { execute, state } = runnerRepoGroups();
    await execute({ params: { daemonId: daemonId.value }, data: { baseDir, repoUrl } });
    repoGroups.value = state.value?.groups || [];
  } catch {
    repoGroups.value = []; // 基目录尚不存在/节点不可达等：视为无已有组
  } finally {
    loadingGroups.value = false;
  }
}

// 基目录是否已存在：null=未知/未查，true=存在，false=不存在（提交时会自动新建，只做轻提示）。
const baseDirExists = ref<boolean | null>(null);

// 查基目录是否存在。listDirs 对不存在的路径会报错，据此判定；节点/路径缺失时置 null（不打扰）。
async function checkBaseDir() {
  const baseDir = shared.baseDir.trim();
  if (!daemonId.value || !baseDir) {
    baseDirExists.value = null;
    return;
  }
  try {
    const { execute } = listRunnerDirs();
    await execute({ params: { daemonId: daemonId.value }, data: { path: baseDir } });
    baseDirExists.value = true;
  } catch {
    baseDirExists.value = false; // 目录不存在（或不可达）：提示将自动新建
  }
}

// baseDir 变更：同时刷新已有标签组与目录存在性提示。
function onBaseDirChange() {
  fetchRepoGroups();
  checkBaseDir();
}

// 某组标签命中的既有 label 组（完全相等才算），否则 null → 走新组逻辑。
function matchOf(g: Group): RepoLabelGroup | null {
  const key = labelKey(g.labels);
  if (!key) return null;
  return repoGroups.value.find((rg) => rg.key === key) || null;
}

// 点击已有标签组 chip：新增一组、预填其标签，命名交给后端对齐（基础名留空）。
function reuseGroup(rg: RepoLabelGroup) {
  groups.value.push(newGroup(rg.prefix, rg.labels));
}

// 预览：将创建的全部 runner 名，按组分开（每组的首个名字还要单独显示在该组下方）。
// 采番规则本体在 tools/runnerNaming.ts，与 daemon 的 allocateRunnerNames 配对——命中既有
// label 组的沿用其前缀，先填删除留下的空缺、填完再往后累加。这里只负责把表单里的一组组
// 映射成它要的锚点；下标与 groups 一一对应，模板按 index 取。
const groupNames = computed<string[][]>(() =>
  previewGroupNames(
    groups.value.map((g) => {
      const matched = matchOf(g);
      return {
        prefix: matched ? matched.prefix : g.baseName.trim(),
        count: Number(g.count) || 0,
        maxIndex: matched?.maxIndex ?? 0,
        freeIndexes: matched?.freeIndexes ?? []
      };
    })
  )
);
const allNames = computed(() => groupNames.value.flat());

// ---- 每组的初始环境变量：解析文本框 + 按该组首/末个 runner 展开占位符做预览 ----
// 两件事必须在提交前做完：把写坏的行/表达式挡下来（否则要等一批 runner 建到一半才失败），
// 以及把 {{index}} 展开给用户看一眼——占位符的意义全在「每台不一样」，看不到展开结果就等于
// 让人闭着眼睛建 20 个。
interface GroupEnvState {
  override: EnvVar[];
  dotenv: EnvVar[];
  count: number; // 两个目标合计条数，显示在按钮角标上
  error: string; // 第一个错误（解析或占位符求值），非空则拦住提交
  preview: string[]; // 展开预览，最多两行（首个 / 末个 runner）
}

// 占位符的示例与说明文本。必须从脚本里传进模板：`{{` 正是 Vue 的插值起始符，直接写在模板
// 里会被当成表达式解析（vue/no-parsing-error 会报「Unexpected end of expression」）。
const PH = {
  name: "{{name}}",
  index: "{{index}}",
  seq: "{{seq}}",
  overrideExample: "每行一个 KEY=VALUE，如\nHTTPS_PROXY=http://127.0.0.1:7892",
  dotenvExample:
    "每行一个 KEY=VALUE，如\nASCEND_RT_VISIBLE_DEVICES={{(index-1)*4}}-{{(index-1)*4+3}}"
};

// 某组某个目标的一份预览行；names 为空（数量还没填）时不预览。
function previewLine(vars: EnvVar[], name: string, seq: number): string {
  const { vars: expanded, error } = expandEnvVars(vars, {
    name,
    index: envTemplateIndexOf(name, seq),
    seq
  });
  return error ? "" : `${name}：${formatEnvPreview(expanded)}`;
}

const envStates = computed<GroupEnvState[]>(() =>
  groups.value.map((g, i) => {
    const ov = parseEnvText(g.envOverride);
    const de = parseEnvText(g.envDotenv);
    const vars = [...ov.vars, ...de.vars];
    const state: GroupEnvState = {
      override: ov.vars,
      dotenv: de.vars,
      count: vars.length,
      error: ov.error || de.error,
      preview: []
    };
    if (state.error) return state;
    const names = groupNames.value[i] || [];
    if (!names.length || !vars.length) return state;
    // 占位符的求值错误也要报出来：解析过关不代表 {{(index-}} 这种表达式过关。
    // 逐个 runner 校验，不能只查首尾：index 取自名字里的编号，所以 {{100/(index-2)}} 这种
    // 首尾都算得出、偏偏中间那台除零——那样就要等 daemon 拒了才知道，而拦在提交前正是这段的
    // 全部意义。单批上限 99 个，展开又是纯字符串运算，全查一遍不值一提。
    for (const [at, name] of names.entries()) {
      const seq = at + 1;
      const { error } = expandEnvVars(vars, { name, index: envTemplateIndexOf(name, seq), seq });
      if (error) {
        state.error = error;
        state.preview = [];
        return state;
      }
    }
    // 没有占位符时每台都一样，预览一行就够；有占位符才把末个也列出来
    const templated = vars.some((v) => hasEnvTemplate(v.value));
    state.preview = [previewLine(vars, names[0], 1)];
    if (templated && names.length > 1)
      state.preview.push(previewLine(vars, names[names.length - 1], names.length));
    return state;
  })
);

// ---- 「不填也会进 .env」的两批变量 ----
// 一批是面板按代理字段写的，另一批是 runner 自己在注册末尾（config.sh → env.sh）从 daemon 的
// 进程环境里快照的 —— LANG / LD_LIBRARY_PATH 这些用户没填却会凭空出现在 .env 里的，就是它。
// 只有 daemon 知道自己的进程环境，所以得问一次；打开对话框与代理失焦时各拉一次。
const defaultEnv = ref<DefaultDotEnvPreview | null>(null);
const defaultEnvOpen = ref(false); // 展开明细（值可能很长，如 LD_LIBRARY_PATH）
const defaultEnvLoading = ref(false);

async function fetchDefaultEnv() {
  if (!daemonId.value) return;
  defaultEnvLoading.value = true;
  try {
    const { execute, state } = runnerDefaultEnv();
    await execute({
      params: { daemonId: daemonId.value },
      data: { proxy: shared.proxy.trim() }
    });
    defaultEnv.value = state.value ?? null;
  } catch {
    defaultEnv.value = null; // 节点不可达等：这只是提示，静默降级，不打扰创建流程
  } finally {
    defaultEnvLoading.value = false;
  }
}

// 展示用清单：标出每条的来源，以及它会不会被用户已填的同名变量顶掉。
// 两批的覆盖规则不同，写在一起会说错，所以逐条带上 note。
interface DefaultEnvRow {
  key: string;
  value: string;
  from: string;
  overridden: boolean;
}
const defaultEnvRows = computed<DefaultEnvRow[]>(() => {
  const d = defaultEnv.value;
  if (!d) return [];
  // 任一组填了同名变量就算被覆盖：这里只是提示，宁可说得保守些
  const filled = new Set(envStates.value.flatMap((s) => s.dotenv.map((v) => v.key)));
  return [
    // 代理进两个作用域：.env（job/step）与监听进程。只说 .env 会让人以为 listener 没有代理，
    // 而那恰好是这批变量最要紧的去处 —— 少了它 runner 连不上 GitHub。
    ...d.panel.map((v) => ({
      ...v,
      from: "面板（代理，.env 与监听进程各一份）",
      overridden: filled.has(v.key)
    })),
    ...d.runner.map((v) => ({ ...v, from: "runner 注册时快照", overridden: filled.has(v.key) }))
  ];
});

// 把当前填的代理补进某组的监听进程变量框。daemon 置备时已经会自动写这几条，所以这个按钮
// 剩下的用途是「让它显式可见」与「改成另一个地址」——填进来的同名变量赢。已有同名行不重复追加。
function fillProxyEnv(g: Group) {
  const proxy = shared.proxy.trim();
  if (!proxy) return message.error("请先在上面填写代理地址");
  const existing = parseEnvText(g.envOverride).vars;
  const has = new Set(existing.map((v) => v.key));
  const wanted: EnvVar[] = [
    { key: "HTTP_PROXY", value: proxy },
    { key: "HTTPS_PROXY", value: proxy },
    { key: "NO_PROXY", value: "localhost,127.0.0.1,::1" }
  ].filter((v) => !has.has(v.key));
  if (!wanted.length) return message.info("这三个代理变量都已填过了");
  const lines = wanted.map((v) => `${v.key}=${v.value}`).join("\n");
  g.envOverride = g.envOverride.trim() ? `${g.envOverride.replace(/\n+$/, "")}\n${lines}` : lines;
}

// 把某组的两个文本框原样复制到其它组：多组共用同一套变量时省得逐个粘贴。
function copyEnvToAll(i: number) {
  const src = groups.value[i];
  let n = 0;
  groups.value.forEach((g, j) => {
    if (j === i) return;
    g.envOverride = src.envOverride;
    g.envDotenv = src.envDotenv;
    g.envOpen = Boolean(src.envOverride.trim() || src.envDotenv.trim());
    n++;
  });
  message[n ? "success" : "info"](n ? `已复制到其它 ${n} 组` : "只有这一组，无需复制");
}

// 某组下方的命名提示：并入了哪个组、从哪个名字起、这一批是不是在补空缺。
// 在 script 里拼成一整句而不是在模板里用 v-if 拼片段——模板里换行会被 Vue 的空白压缩留成
// 多余空格，正好落在中文标点前面。
function alignHint(g: Group, i: number): string {
  const rg = matchOf(g);
  if (!rg) return "";
  const first = groupNames.value[i]?.[0];
  return (
    `该标签组已存在，将并入 ${rg.prefix} 组` +
    (first ? `，命名从 ${first} 起` : "") +
    (rg.freeIndexes.length ? "（先补已删除的空缺编号）" : "")
  );
}
const previewText = computed(() => {
  const names = allNames.value;
  if (!names.length) return "（填写基础名与数量后预览）";
  const head = names.slice(0, 12).join(", ");
  return names.length > 12 ? `${head} … 等 ${names.length} 个` : head;
});

// 检查结果
const checking = ref(false);
const checkText = ref("");
const checkOk = ref<boolean | null>(null);
const proxyChecking = ref(false);
const proxyCheckResults = ref<ProxyCheckTargetResult[]>([]);

// 下载（拉取最新版）状态
const downloading = ref(false);
const dlPercent = ref(0);
const dlSpeed = ref(0); // bytes/s
const dlVersion = ref("");
const downloadedPath = ref(""); // 下载完成后的包路径，用于创建
let dlTimer: ReturnType<typeof setTimeout> | null = null;

const stopPolling = () => {
  if (dlTimer) {
    clearTimeout(dlTimer);
    dlTimer = null;
  }
};

// 批量创建进度（后台跑 + 轮询）
const batchItems = ref<RunnerBatchProgressItem[]>([]);
const batchRunning = ref(false); // 后台任务是否仍在跑
const batchDone = ref(false); // 是否已全部结束
const batchLost = ref(false); // 进度通道断了（后台多半还在跑）——与"全部结束"是两回事
const batchStat = reactive({ total: 0, doneCount: 0, failCount: 0 });
const currentBatchId = ref(""); // 当前批次 id，用于重试失败项
const retryToken = ref(""); // 重试时重新填的注册 token
const retrying = ref(false);
const collecting = ref(false);
let batchTimer: ReturnType<typeof setTimeout> | null = null;
// 进度查询连续失败多少次才判定通道断了。panel→daemon 是 socket 转发（15s 超时，且重连窗口内
// 会直接抛"节点未连接"），单次失败不代表批量任务出事，退避重试即可自愈。
const POLL_MAX_FAILS = 5;
const pollFails = ref(0); // 当前连续失败次数，>0 时界面上如实显示"重试中"
// 轮询代数：stopBatchPolling 递增它，在途请求回来后代数对不上就自行作废。
// 清 timer 拦不住已经 await 出去的那一次请求，退避重试又把它的存活窗口拉长到了十几秒，
// 没有这个的话 resetBatch / 组件卸载之后仍会冒出一次续排，把已经归零的进度改回去。
let pollGen = 0;

const stopBatchPolling = () => {
  pollGen++;
  if (batchTimer) {
    clearTimeout(batchTimer);
    batchTimer = null;
  }
};

const resetBatch = () => {
  stopBatchPolling();
  batchItems.value = [];
  batchRunning.value = false;
  batchDone.value = false;
  batchLost.value = false;
  pollFails.value = 0;
  batchStat.total = 0;
  batchStat.doneCount = 0;
  batchStat.failCount = 0;
  currentBatchId.value = "";
  retryToken.value = "";
  retrying.value = false;
};

// 轮询某批进度，刷新每个 runner 的状态 + 当前步骤（submit / 重试共用）
const pollBatch = (batchId: string) => {
  const gen = ++pollGen;
  const poll = async () => {
    try {
      const { execute, state } = runnerBatchProgress();
      await execute({
        params: { daemonId: daemonId.value },
        data: { batchId },
        // apiService 有 2s 响应缓存，800ms 的轮询三次里两次会拿到旧快照，进度看着一跳一跳
        forceRequest: true,
        // forceRequest 分支不套用 apiService 的默认超时，这里显式给一个，
        // 免得单个请求卡死后整轮轮询再也不往下走
        timeout: 20000
      });
      if (gen !== pollGen) return; // 期间被 reset / 卸载 / 重连了，这次结果作废
      pollFails.value = 0;
      batchLost.value = false;
      const p: any = state.value || {};
      if (Array.isArray(p.items)) batchItems.value = p.items;
      batchStat.total = p.total ?? batchStat.total;
      batchStat.doneCount = p.doneCount ?? 0;
      batchStat.failCount = p.failCount ?? 0;
      if (p.done) {
        batchRunning.value = false;
        batchDone.value = true;
        if (p.doneCount > 0) {
          shared.token = "";
          emit("created");
        }
        if (p.failCount > 0) {
          message.warning(`本轮结束：成功 ${p.doneCount}，失败 ${p.failCount}（可重试失败项）`);
        } else {
          message.success(`已成功注册并创建 ${p.doneCount} 个 runner 实例，去列表启动`);
        }
        return;
      }
      batchTimer = setTimeout(poll, 800);
    } catch (err: any) {
      if (gen !== pollGen) return;
      // 后台任务在 daemon 里独立跑，查询失败只说明这条查询链路抖了一下：退避重试，
      // 绝不能把它当成"全部结束"——那会让用户在 runner 还在装的时候就以为可以关窗了
      if (++pollFails.value < POLL_MAX_FAILS) {
        batchTimer = setTimeout(poll, Math.min(800 * 2 ** pollFails.value, 8000));
        return;
      }
      batchRunning.value = false;
      batchLost.value = true;
      // 断开的成因（节点掉线 / daemon 重启把内存里的批次丢了）在前端分不出来，
      // 所以只陈述事实、把两条出路都给出去，不去断言"后台仍在运行"
      message.error(
        t("TXT_CODE_RUNNER_BATCH_PROGRESS_LOST", {
          count: POLL_MAX_FAILS,
          message: String(err?.message || err)
        })
      );
    }
  };
  pollFails.value = 0;
  poll();
};

// 进度通道断开后手动重连：批次若还在 daemon 内存里，重新轮询即可续上真实进度
const resumePolling = () => {
  if (!currentBatchId.value) return;
  stopBatchPolling();
  batchLost.value = false;
  batchDone.value = false;
  batchRunning.value = true;
  pollBatch(currentBatchId.value);
};

// 重试失败项：用重新填的 token 对本批失败的 runner 重跑注册（--replace 幂等，会收编 GitHub 孤儿）
const retryFailed = async () => {
  if (!currentBatchId.value) return message.error("没有可重试的批次");
  if (!retryToken.value.trim()) return message.error("请重新填写注册 token（旧的多半已过期）");
  retrying.value = true;
  try {
    const { execute, state } = retryRunnerBatch();
    await execute({
      params: { daemonId: daemonId.value },
      data: {
        batchId: currentBatchId.value,
        token: retryToken.value.trim(),
        proxy: shared.proxy.trim()
      }
    });
    const r: any = state.value || {};
    if (!r.batchId) throw new Error("重试启动失败");
    batchDone.value = false;
    batchLost.value = false;
    batchRunning.value = true;
    retryToken.value = "";
    pollBatch(currentBatchId.value);
  } catch (err: any) {
    message.error("重试失败：" + (err?.message || err));
  } finally {
    retrying.value = false;
  }
};

// 扫描并收集：把基目录下"已注册(有 .runner)但面板没建实例"的 runner 纳入看护
const collect = async () => {
  const base = shared.baseDir.trim();
  if (!base) return message.error("请先填写基目录");
  collecting.value = true;
  try {
    const { execute, state } = collectRunners();
    await execute({ params: { daemonId: daemonId.value }, data: { baseDir: base } });
    const r: any = state.value || {};
    const got = r.collected?.length || 0;
    const skip = r.skipped?.length || 0;
    if (got > 0) {
      emit("created");
      message.success(`已收集 ${got} 个 runner 纳入看护${skip ? `，跳过 ${skip}` : ""}`);
    } else {
      message.info(`没有可收集的 runner（跳过 ${skip} 个：均已看护或未注册）`);
    }
  } catch (err: any) {
    message.error("收集失败：" + (err?.message || err));
  } finally {
    collecting.value = false;
  }
};

onUnmounted(() => {
  stopPolling();
  stopBatchPolling();
});

const fmtSpeed = (bps: number) => {
  if (bps >= 1e6) return (bps / 1e6).toFixed(1) + " MB/s";
  if (bps >= 1e3) return (bps / 1e3).toFixed(0) + " KB/s";
  return bps + " B/s";
};

const openDialog = async (m: "direct" | "import" = "direct") => {
  try {
    const node = await openNodeSelectDialog();
    if (!node) return;
    daemonId.value = node.uuid;
    // 默认标签跟着节点的架构走。表单在关窗后是留着的，所以这里要把还是自动值的组重填一遍——
    // 上一个节点是 arm64、这次选了 x86 服务器，留下来的 linux,arm64 就是错的。
    nodeArch.value = node.system?.arch || "";
    for (const g of groups.value) {
      if (g.labelsAuto) g.labels = defaultLabels.value;
    }
    mode.value = m;
    checkText.value = "";
    checkOk.value = null;
    proxyCheckResults.value = [];
    stopPolling();
    downloading.value = false;
    dlPercent.value = 0;
    dlSpeed.value = 0;
    dlVersion.value = "";
    downloadedPath.value = "";
    repoGroups.value = []; // 清掉上次会话的已有组，换节点/仓库后重新拉取
    baseDirExists.value = null;
    defaultEnv.value = null; // 换节点即作废：这批变量取自 daemon 自己的进程环境
    defaultEnvOpen.value = false;
    resetBatch();
    open.value = true;
    // 若已预填仓库地址与基目录，进来即拉一次已有 label 组 + 目录存在性
    fetchRepoGroups();
    checkBaseDir();
    fetchDefaultEnv();
  } catch {
    // 用户取消
  }
};

defineExpose({ open: openDialog });

// 直接创建 → 检查更新；导入压缩包 → 检查路径存在
const doCheck = async () => {
  if (mode.value === "import" && !shared.packagePath.trim()) {
    return message.error("请先填写压缩包路径");
  }
  checking.value = true;
  checkText.value = "";
  checkOk.value = null;
  try {
    const { execute, state } = checkRunnerPackage();
    await execute({
      params: { daemonId: daemonId.value },
      data: {
        mode: mode.value,
        packagePath: shared.packagePath.trim(),
        proxy: shared.proxy.trim()
      }
    });
    const r: any = state.value || {};
    if (mode.value === "import") {
      checkOk.value = !!r.exists && !!r.isTarGz;
      if (!r.exists) checkText.value = "✗ 路径不存在";
      else
        checkText.value =
          `✓ 存在（${r.sizeMB} MB${r.version ? "，版本 " + r.version : ""}）` +
          (r.isTarGz ? "" : "，但不是 tar.gz 文件");
    } else {
      checkOk.value = !!r.exists && (!r.latestVersion || !r.updateAvailable);
      let s = r.exists ? `内置包版本 ${r.localVersion || "未知"}` : "✗ 内置包不存在";
      if (r.latestVersion)
        s += `；GitHub 最新 ${r.latestVersion}` + (r.updateAvailable ? '（有更新，可点"拉取最新版"下载）' : "（已是最新）");
      else if (r.checkError) s += `；未能查询最新版本（${r.checkError}）`;
      checkText.value = s;
    }
  } catch (err: any) {
    checkOk.value = false;
    checkText.value = "检查失败：" + (err?.message || err);
  } finally {
    checking.value = false;
  }
};

// 检测代理连通性：用当前填的代理探测 GitHub / Google 等目标
const doProxyCheck = async () => {
  // 请求耗时数秒，其间用户可能改代理/换节点——先快照，回来不匹配就丢弃这次结果
  const submittedProxy = shared.proxy.trim();
  const submittedDaemon = daemonId.value;
  const stale = () => shared.proxy.trim() !== submittedProxy || daemonId.value !== submittedDaemon;
  proxyChecking.value = true;
  proxyCheckResults.value = [];
  try {
    const { execute, state } = checkRunnerProxy();
    await execute({
      params: { daemonId: submittedDaemon },
      data: { proxy: submittedProxy }
    });
    if (stale()) return;
    const r = state.value;
    proxyCheckResults.value = r?.results ?? [];
    if (!proxyCheckResults.value.length) message.error("未获取到检测结果");
  } catch (err: any) {
    if (stale()) return;
    message.error("代理检测失败：" + (err?.message || err));
  } finally {
    proxyChecking.value = false;
  }
};

// 代理输入变化时清掉上次结果，避免旧代理的结论停留在界面上
watch(
  () => shared.proxy,
  () => {
    proxyCheckResults.value = [];
  }
);

// 拉取最新版：从 GitHub 下载，轮询进度 + 速度
// force=false（默认）：本地已有同版本包时后端直接跳过；force=true 强制覆盖重下
const pullLatest = async (force = false) => {
  downloading.value = true;
  dlPercent.value = 0;
  dlSpeed.value = 0;
  downloadedPath.value = "";
  stopPolling();
  try {
    const { execute, state } = startRunnerDownload();
    await execute({
      params: { daemonId: daemonId.value },
      data: { proxy: shared.proxy.trim(), force } // 不传 version → 拉最新
    });
    const started: any = state.value || {};
    const downloadId = started.downloadId;
    const skipped = !!started.skipped;
    dlVersion.value = started.version || "";
    if (!downloadId) throw new Error("启动下载失败");

    const poll = async () => {
      try {
        const { execute: exeP, state: stP } = runnerDownloadProgress();
        await exeP({ params: { daemonId: daemonId.value }, data: { downloadId } });
        const p: any = stP.value || {};
        dlPercent.value = p.percent || 0;
        dlSpeed.value = p.speed || 0;
        if (p.done) {
          downloading.value = false;
          if (p.error) {
            const hint = !shared.proxy.trim()
              ? "（直连 GitHub CDN 常被重置，请在代理字段填写可用代理，如 http://127.0.0.1:7892）"
              : "（若走代理仍失败，确认代理可访问 GitHub CDN）";
            message.error("下载失败：" + p.error + " " + hint);
          } else {
            downloadedPath.value = p.path || "";
            dlPercent.value = 100;
            if (skipped)
              message.info(
                `本地已有 runner ${p.version}，已跳过下载，创建时将使用现有包（如需覆盖请点"强制重新下载"）`
              );
            else message.success(`已下载 runner ${p.version}，创建时将使用此新包`);
          }
          return;
        }
        dlTimer = setTimeout(poll, 500);
      } catch (err: any) {
        downloading.value = false;
        message.error("进度查询失败：" + (err?.message || err));
      }
    };
    poll();
  } catch (err: any) {
    downloading.value = false;
    message.error("启动下载失败：" + (err?.message || err));
  }
};

const submit = async () => {
  if (!shared.repoUrl || !shared.token || !shared.baseDir) {
    return message.error("请填写：仓库地址 / 注册 token / 基目录");
  }
  if (mode.value === "import" && !shared.packagePath.trim()) {
    return message.error("导入模式需填写压缩包路径（服务器上的 tar.gz）");
  }
  if (!allNames.value.length) {
    return message.error("请至少配置一组有效的 runner（基础名 + 数量）");
  }
  if (allNames.value.length > 99) {
    return message.error(`单批最多 99 个 runner，当前 ${allNames.value.length} 个，请减少数量`);
  }
  // 环境变量写坏了就别开工：一批跑起来就是几十次注册，错在第几组这时候还能直接指出来
  const badEnv = envStates.value.findIndex((s) => s.error);
  if (badEnv >= 0) {
    groups.value[badEnv].envOpen = true;
    return message.error(`第 ${badEnv + 1} 组的环境变量有误：${envStates.value[badEnv].error}`);
  }
  submitting.value = true;
  resetBatch();
  try {
    // 1) 启动后台批量任务，立刻拿到 batchId + 初始清单
    const { execute, state } = startRunnerBatch();
    await execute({
      params: { daemonId: daemonId.value },
      data: {
        repoUrl: shared.repoUrl.trim(),
        token: shared.token.trim(),
        proxy: shared.proxy.trim(),
        baseDir: shared.baseDir.trim(),
        packagePath: mode.value === "import" ? shared.packagePath.trim() : downloadedPath.value,
        // 命中既有组时用其前缀作基础名，既通过后端非空校验，也让命名对齐既有组
        groups: groups.value.map((g, i) => ({
          baseName: (matchOf(g)?.prefix || g.baseName).trim(),
          labels: g.labels.trim(),
          count: Number(g.count) || 0,
          // 文本框在前端解析成 {key,value}[]（与 env_set 同一形状）；占位符原样送过去，
          // 由 daemon 按每个 runner 的名字展开——预览用的是同一份实现（tools/envTemplate.ts）
          env: {
            override: envStates.value[i].override,
            dotenv: envStates.value[i].dotenv
          }
        })),
        concurrency: Number(shared.concurrency) || 3
      }
    });
    const started: any = state.value || {};
    const batchId = started.batchId;
    if (!batchId) throw new Error("启动批量任务失败");
    currentBatchId.value = batchId;

    // 有组因标签命中既有组被对齐到既有前缀：告知用户实际命名，不静默改名
    const aligned: { baseName: string; labels: string; prefix: string }[] = started.aligned || [];
    if (aligned.length) {
      const desc = aligned.map((a) => `${a.labels} → 并入 ${a.prefix}`).join("；");
      message.info(`部分组标签已存在，命名已对齐既有组：${desc}`);
    }

    // 初始清单：全部 pending
    batchItems.value = (started.items || []).map((i: { name: string }) => ({
      name: i.name,
      status: "pending",
      step: ""
    }));
    batchStat.total = batchItems.value.length;
    batchRunning.value = true;
    batchDone.value = false;
    pollBatch(batchId);
  } catch (err: any) {
    batchRunning.value = false;
    message.error("批量添加失败：" + (err?.message || err));
  } finally {
    submitting.value = false;
  }
};

// 失败项：完整日志文本
const fullLogOf = (it: RunnerBatchProgressItem) =>
  `# runner: ${it.name}\n# 错误: ${it.error || ""}\n\n${it.log || it.error || "（无日志）"}\n`;

const copyText = async (text: string) => {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    message.success("已复制到剪贴板");
  } catch {
    message.error("复制失败，请手动选择文本");
  }
};

const downloadText = (filename: string, text: string) => {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

const copyLog = (it: RunnerBatchProgressItem) => copyText(fullLogOf(it));
const downloadLog = (it: RunnerBatchProgressItem) =>
  downloadText(`runner-${it.name}-error.log`, fullLogOf(it));

// 汇总所有失败项日志（复制/下载全部）
const failedItems = computed(() => batchItems.value.filter((i) => i.status === "failed"));
const allFailedLog = () =>
  failedItems.value
    .map((it) => `==================== ${it.name} ====================\n${fullLogOf(it)}`)
    .join("\n");
const copyAllFailed = () => copyText(allFailedLog());
const downloadAllFailed = () => downloadText(`runner-batch-errors.log`, allFailedLog());

// 单个 runner 状态 → 图标/颜色
const statusIcon = (s: string) =>
  s === "done" ? "✓" : s === "failed" ? "✗" : s === "running" ? "…" : "○";
const statusColor = (s: string) =>
  s === "done"
    ? "#17b890"
    : s === "failed"
      ? "#ef5350"
      : s === "running"
        ? "#1890ff"
        : "var(--color-gray-7)";
</script>

<template>
  <a-modal
    v-model:open="open"
    :title="mode === 'import' ? '批量添加 Runner（导入压缩包）' : '批量添加 Runner（直接创建）'"
    :width="720"
    :confirm-loading="submitting"
    :mask-closable="!downloading && !submitting && !batchRunning"
    :closable="!downloading && !submitting && !batchRunning"
    :keyboard="!downloading && !submitting && !batchRunning"
  >
    <!-- 底部按钮：编辑态 → 提交/取消；跑批或已完成 → 只留关闭 -->
    <template #footer>
      <template v-if="!batchItems.length">
        <a-button :disabled="submitting || downloading" @click="open = false">取消</a-button>
        <a-button type="primary" :loading="submitting" @click="submit">
          批量注册并创建实例
        </a-button>
      </template>
      <template v-else>
        <a-button v-if="batchDone" @click="resetBatch">再建一批</a-button>
        <a-button type="primary" :disabled="batchRunning" @click="open = false">
          {{ batchRunning ? "创建中…" : "关闭" }}
        </a-button>
      </template>
    </template>

    <!-- 批量创建进度：勾选清单 -->
    <div v-if="batchItems.length" class="batch-progress">
      <div class="batch-summary">
        <span>共 {{ batchStat.total }} 个</span>
        <span class="ok">✓ 成功 {{ batchStat.doneCount }}</span>
        <span v-if="batchStat.failCount" class="fail">✗ 失败 {{ batchStat.failCount }}</span>
        <template v-if="failedItems.length">
          <a-button type="link" size="small" style="padding: 0" @click="copyAllFailed">
            复制全部失败日志
          </a-button>
          <a-button type="link" size="small" style="padding: 0" @click="downloadAllFailed">
            下载
          </a-button>
        </template>
        <!-- 退避重试期间窗口是锁死的，不出声用户只会对着转圈干等，如实报出重试进度 -->
        <span v-if="batchRunning && pollFails" class="fail" style="margin-left: auto">
          {{ t("TXT_CODE_RUNNER_BATCH_RETRYING", { count: pollFails, max: POLL_MAX_FAILS }) }}
        </span>
        <a-spin v-if="batchRunning" size="small" :style="pollFails ? {} : { marginLeft: 'auto' }" />
        <span v-else-if="batchDone" class="ok" style="margin-left: auto">
          {{ t("TXT_CODE_RUNNER_BATCH_ALL_DONE") }}
        </span>
        <!-- 只有 batchDone 才配叫"全部结束"；通道断了要如实说，并给出两条出路 -->
        <span v-else-if="batchLost" class="fail" style="margin-left: auto">
          {{ t("TXT_CODE_RUNNER_BATCH_PROGRESS_DISCONNECTED") }}
          <a-button type="link" size="small" style="padding: 0" @click="resumePolling">
            {{ t("TXT_CODE_RUNNER_BATCH_RECONNECT") }}
          </a-button>
          <a-button type="link" size="small" :loading="collecting" @click="collect">
            {{ t("TXT_CODE_RUNNER_SCAN_COLLECT") }}
          </a-button>
        </span>
      </div>
      <div class="batch-list">
        <div v-for="it in batchItems" :key="it.name" class="batch-row">
          <span class="icon" :style="{ color: statusColor(it.status) }">
            <a-spin v-if="it.status === 'running'" size="small" />
            <template v-else>{{ statusIcon(it.status) }}</template>
          </span>
          <span class="name">{{ it.name }}</span>
          <span
            class="step"
            :style="{ color: it.status === 'failed' ? '#ef5350' : 'var(--cip-text-sub, #8a91a3)' }"
          >
            {{
              it.status === "failed"
                ? it.error || "失败"
                : it.status === "done"
                  ? it.step || "完成"
                  : it.status === "running"
                    ? it.step || "进行中…"
                    : "等待中"
            }}
          </span>
          <span v-if="it.status === 'failed'" class="row-actions">
            <a-button type="link" size="small" @click="copyLog(it)">复制日志</a-button>
            <a-button type="link" size="small" @click="downloadLog(it)">下载</a-button>
          </span>
        </div>
      </div>

      <!-- 失败项重试：注册 token 一次性且约 1h 过期，重试需重新填 -->
      <div v-if="batchDone && batchStat.failCount > 0" class="batch-retry">
        <a-input-password
          v-model:value="retryToken"
          :placeholder="t('TXT_CODE_RUNNER_BATCH_RETRY_TOKEN_PLACEHOLDER')"
          style="flex: 1"
          @press-enter="retryFailed"
        />
        <a-button type="primary" :loading="retrying" @click="retryFailed">
          {{ t("TXT_CODE_RUNNER_BATCH_RETRY_FAILED", { count: batchStat.failCount }) }}
        </a-button>
        <a-button :loading="collecting" @click="collect">
          {{ t("TXT_CODE_RUNNER_SCAN_COLLECT") }}
        </a-button>
      </div>
    </div>

    <a-form v-else layout="vertical" style="margin-top: 8px">
      <a-row :gutter="16">
        <a-col :span="24">
          <a-form-item label="从 config.sh 命令解析（可选，粘贴即自动填仓库和 token）">
            <a-input
              v-model:value="cmdPaste"
              placeholder="./config.sh --url https://github.com/owner/repo --token AXXXX..."
              allow-clear
              @input="parseCmd"
              @change="parseCmd"
            />
          </a-form-item>
        </a-col>
        <a-col :span="24">
          <a-form-item label="仓库地址" required>
            <a-input
              v-model:value="shared.repoUrl"
              placeholder="https://github.com/owner/repo"
              @blur="fetchRepoGroups"
            />
          </a-form-item>
        </a-col>
        <a-col :span="24">
          <a-form-item label="注册 token（registration token）" required>
            <a-input
              v-model:value="shared.token"
              placeholder="仓库 Settings → Actions → Runners → New self-hosted runner 里获取"
            />
          </a-form-item>
        </a-col>
        <a-col :span="24">
          <a-form-item label="基目录（每个 runner = 基目录/<name>）" required>
            <a-input-group compact>
              <a-input
                v-model:value="shared.baseDir"
                style="width: calc(100% - 80px)"
                placeholder="/data/ci-runner/ci-runners"
                @blur="onBaseDirChange"
              />
              <a-button style="width: 80px" @click="openDirPicker">
                <FolderOpenOutlined /> 浏览
              </a-button>
            </a-input-group>
            <div
              v-if="baseDirExists === false && shared.baseDir.trim()"
              style="font-size: 12px; color: #d48806; margin-top: 4px"
            >
              该目录不存在，创建时会自动新建。
            </div>
          </a-form-item>
        </a-col>
        <a-col :span="18">
          <a-form-item label="代理（可选，连 GitHub 用）">
            <a-input-group compact>
              <a-input
                v-model:value="shared.proxy"
                placeholder="http://127.0.0.1:7890"
                style="width: calc(100% - 96px)"
                @blur="fetchDefaultEnv"
              />
              <a-button style="width: 96px" :loading="proxyChecking" @click="doProxyCheck">
                检测代理
              </a-button>
            </a-input-group>
            <div v-if="proxyCheckResults.length" style="font-size: 12px; margin-top: 4px">
              <span
                v-for="r in proxyCheckResults"
                :key="r.url"
                :style="{ color: r.ok ? '#17b890' : '#ef5350', marginRight: '12px' }"
              >
                {{ r.name }}
                {{ r.ok ? "✓ " + r.status + "（" + r.ms + "ms）" : "✗ " + (r.error || "不通") }}
              </span>
            </div>
          </a-form-item>
        </a-col>
        <a-col :span="6">
          <a-form-item label="并发数（同时创建几个）">
            <a-input
              v-model:value="shared.concurrency"
              type="number"
              min="1"
              max="10"
              @blur="shared.concurrency = clampStr(shared.concurrency, 1, 10)"
            />
          </a-form-item>
        </a-col>
        <a-col v-if="mode === 'import'" :span="24">
          <a-form-item label="压缩包路径（服务器上的 tar.gz 绝对路径）" required>
            <a-input
              v-model:value="shared.packagePath"
              placeholder="/data/ci-runner/actions-runner-linux-arm64-2.331.0.tar.gz"
            />
          </a-form-item>
        </a-col>
      </a-row>

      <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 4px">
        <a-button :loading="checking" @click="doCheck">
          {{ mode === "import" ? "检查路径" : "检查更新" }}
        </a-button>
        <a-button v-if="mode === 'direct'" :loading="downloading" @click="pullLatest(false)">
          拉取最新版
        </a-button>
        <a-button
          v-if="mode === 'direct'"
          type="link"
          size="small"
          :disabled="downloading"
          @click="pullLatest(true)"
        >
          强制重新下载
        </a-button>
        <span
          v-if="checkText"
          :style="{ fontSize: '13px', color: checkOk ? '#17b890' : '#ef5350' }"
        >
          {{ checkText }}
        </span>
        <a-tooltip :title="t('TXT_CODE_RUNNER_SCAN_COLLECT_TIP')" style="margin-left: auto">
          <a-button size="small" :loading="collecting" @click="collect">
            {{ t("TXT_CODE_RUNNER_SCAN_COLLECT") }}
          </a-button>
        </a-tooltip>
      </div>

      <!-- 下载进度 + 速度 -->
      <div v-if="mode === 'direct' && (downloading || downloadedPath)" style="margin-bottom: 6px">
        <a-progress
          :percent="dlPercent"
          :status="downloading ? 'active' : 'success'"
          :stroke-color="'#17b890'"
        />
        <div style="font-size: 12px; color: var(--cip-text-sub, #8a91a3)">
          <template v-if="downloading">
            正在下载 runner {{ dlVersion }} … {{ fmtSpeed(dlSpeed) }}
          </template>
          <template v-else> ✓ 已下载 runner {{ dlVersion }}，创建时将使用此新包 </template>
        </div>
      </div>

      <a-divider style="margin: 10px 0 14px">标签组（可多组，每组按数量生成 名-1 名-2 …）</a-divider>

      <!-- 该仓库已有的 label 组：点击即复用标签、并入既有命名 -->
      <div v-if="repoGroups.length" style="margin-bottom: 12px">
        <div style="font-size: 12px; color: var(--cip-text-sub, #8a91a3); margin-bottom: 6px">
          该仓库已有标签组（点击复用，命名将并入既有前缀）：
        </div>
        <a-space wrap>
          <a-tag
            v-for="rg in repoGroups"
            :key="rg.key"
            color="blue"
            style="cursor: pointer"
            @click="reuseGroup(rg)"
          >
            {{ rg.labels }}（{{ rg.prefix }}，已有 {{ rg.count }}）
          </a-tag>
        </a-space>
      </div>

      <div v-for="(g, i) in groups" :key="i" style="margin-bottom: 10px">
        <div class="group-row">
          <a-form-item label="基础名" style="flex: 1; margin: 0">
            <a-input
              v-model:value="g.baseName"
              :disabled="!!matchOf(g)"
              :placeholder="matchOf(g) ? '按既有组自动命名' : '如 cpu / npu'"
            />
          </a-form-item>
          <a-form-item label="标签（逗号分隔）" style="flex: 2; margin: 0">
            <!-- update:value 只在用户改动时由输入框发出，程序赋值不会触发它 -->
            <a-input
              v-model:value="g.labels"
              :placeholder="`${defaultLabels},npu`"
              @update:value="g.labelsAuto = false"
            />
          </a-form-item>
          <a-form-item label="数量" style="width: 90px; margin: 0">
            <a-input
              v-model:value="g.count"
              type="number"
              min="1"
              max="99"
              @blur="g.count = clampStr(g.count, 1, 99)"
            />
          </a-form-item>
          <!-- 两个按钮共用一个 a-form-item：label 用一个不换行空格占位，让它和前面三列共用
               同一套「label 行 + 控件行」盒模型 —— 表单项的盒子比输入框本身高（底下还留着
               校验信息的位置），拿一个裸 div 去按底边对齐会整个沉下去。行内再套一层定高
               32px 的 flex 容器，把两个按钮在控件行里居中并排。 -->
          <a-form-item :label="' '" style="flex: none; margin: 0">
            <div class="group-actions">
              <a-tooltip title="该组的初始环境变量（systemd 与 .env）">
                <a-badge :count="envStates[i].count" :offset="[-4, 2]">
                  <a-button
                    class="group-env"
                    :type="g.envOpen ? 'primary' : 'default'"
                    :danger="!!envStates[i].error"
                    @click="g.envOpen = !g.envOpen"
                  >
                    <template #icon><SettingOutlined /></template>
                  </a-button>
                </a-badge>
              </a-tooltip>
              <a-button
                class="group-del"
                danger
                type="text"
                :disabled="groups.length <= 1"
                @click="removeGroup(i)"
              >
                <template #icon><DeleteOutlined /></template>
              </a-button>
            </div>
          </a-form-item>
        </div>
        <div
          v-if="matchOf(g)"
          style="font-size: 12px; color: #17b890; margin-top: 4px"
        >
          {{ alignHint(g, i) }}
        </div>

        <!-- 该组的初始环境变量：两个目标各一个文本框，每行 KEY=VALUE -->
        <div v-if="g.envOpen" class="env-panel">
          <div class="env-block">
            <div class="env-head">
              <span class="env-title">systemd（override.conf）</span>
              <a-button type="link" size="small" @click="fillProxyEnv(g)">
                用上面的代理填充
              </a-button>
            </div>
            <div class="env-tip">
              写入 systemd 单元的 Environment=，进「监听进程」。代理这类要让 runner 连上 GitHub
              的变量必须放这里——上面填的代理创建时会自动写入，这里只在要覆盖它时填。创建时写入，
              并重启单元使其生效。
            </div>
            <a-textarea
              v-model:value="g.envOverride"
              :auto-size="{ minRows: 2, maxRows: 8 }"
              :placeholder="PH.overrideExample"
            />
          </div>
          <div class="env-block">
            <div class="env-head">
              <span class="env-title">运行时 .env</span>
            </div>
            <div class="env-tip">
              写入 runner 目录的 .env，只注入到 job/step 执行环境（不进监听进程）。设备号、库路径
              这类放这里。创建时随注册一起写入，首个 job 即生效。
            </div>
            <a-textarea
              v-model:value="g.envDotenv"
              :auto-size="{ minRows: 2, maxRows: 8 }"
              :placeholder="PH.dotenvExample"
            />
          </div>
          <!-- 不填也会进 .env 的东西。runner 自己那批（config.sh 末尾 source ./env.sh）取自 daemon
               的进程环境，用户没填却会凭空出现在 .env 里——不摆出来，谁也想不到该去哪儿找它。 -->
          <div v-if="defaultEnvRows.length" class="env-auto">
            <a-button type="link" size="small" @click="defaultEnvOpen = !defaultEnvOpen">
              {{ defaultEnvOpen ? "收起" : "展开" }}：创建时还会自动写入
              {{ defaultEnvRows.length }} 项（{{ defaultEnvRows.map((r) => r.key).join("、") }}）
            </a-button>
            <div v-if="defaultEnvOpen" class="env-auto-list">
              <div v-for="r in defaultEnvRows" :key="r.key" :class="{ dim: r.overridden }">
                <span class="k">{{ r.key }}</span>=<span class="v">{{ r.value }}</span>
                <span class="from">
                  — {{ r.from }}{{ r.overridden ? "，已被你填的同名变量覆盖" : "" }}
                </span>
              </div>
            </div>
          </div>
          <div v-else-if="defaultEnvLoading" class="env-tip">正在读取会被自动写入的变量…</div>

          <div class="env-foot">
            <span class="env-tip">
              值里可用占位符按每个 runner 展开：<code>{{ PH.name }}</code> 全名、<code>{{
                PH.index
              }}</code>
              名字里的编号、<code>{{ PH.seq }}</code> 本批序号（1 起）；支持
              <code>+ - * / %</code> 与括号。
            </span>
            <a-button
              v-if="groups.length > 1"
              type="link"
              size="small"
              style="margin-left: auto; flex: none"
              @click="copyEnvToAll(i)"
            >
              复制到其它组
            </a-button>
          </div>
          <div v-if="envStates[i].error" class="env-err">✗ {{ envStates[i].error }}</div>
          <template v-else>
            <div v-for="line in envStates[i].preview" :key="line" class="env-preview">
              {{ line }}
            </div>
          </template>
        </div>
      </div>

      <a-button type="dashed" block style="margin-bottom: 12px" @click="addGroup">
        <template #icon><PlusOutlined /></template>
        添加一组标签
      </a-button>

      <a-alert :type="allNames.length > 99 ? 'error' : 'info'" show-icon>
        <template #message>
          将创建 <b>{{ allNames.length }}</b> 个 runner（单批上限 99）：{{ previewText }}
        </template>
      </a-alert>
    </a-form>
    <a-alert
      v-if="!batchItems.length"
      type="warning"
      show-icon
      style="margin-top: 12px"
      message="注册 token 一次性有效（约 1 小时），整批共用一个。数量多时耗时较长，请耐心等待；创建后会装成 systemd 服务并自动启动。"
    />

    <!-- 基目录选择器 -->
    <SelectDirDialog
      ref="dirDialog"
      @select="(p: string) => { shared.baseDir = p; onBaseDirChange(); }"
    />
  </a-modal>
</template>

<style lang="scss" scoped>
// 隐藏原生 number 输入的上下箭头：它不跟随暗色主题（暗色下是白的、也丑）。
// 去掉后就是个干净的数字文本框，和旁边 a-input 同高，直接敲数字即可。
:deep(input[type="number"]) {
  -moz-appearance: textfield;
  appearance: textfield;
}
:deep(input[type="number"]::-webkit-outer-spin-button),
:deep(input[type="number"]::-webkit-inner-spin-button) {
  -webkit-appearance: none;
  margin: 0;
}

// 标签组一行：三个 a-form-item（标题在上、输入框在下）+ 一个装着两个按钮的 a-form-item。
// 对齐靠的是「大家都是 a-form-item」这件事：表单项的盒子比输入框本身高（底下留着校验信息的
// 位置），所以按底边对齐的必须是同款盒子，裸 div 会整个沉下去。按钮锁成 a-input 的 32px 高，
// 在控件行里居中，中线便与输入框一致。
.group-row {
  display: flex;
  gap: 10px;
  align-items: flex-end;

  .group-actions {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  // 两个按钮都只有图标，ant 会给它们 .ant-btn-icon-only —— 宽高都取 controlHeight，
  // 与 a-input 同源，天然同高。所以这里不写死 32px：写死的那份和主题的 controlHeight
  // 是两个独立的数，一旦不等就是「底边对齐了、高度却不一样」。
  .group-del,
  .group-env {
    flex: none;
    padding: 0;
  }

  // a-badge 默认是 inline-block，按文字基线摆放，底下会多出一截行高，把里面的按钮顶得
  // 比旁边的删除按钮高几像素。inline-flex 让它正好裹住按钮，不再引入行高。
  :deep(.ant-badge) {
    display: inline-flex;
    line-height: 1;
  }
}

// 某组展开的初始环境变量面板：缩进一格挂在该组行下面，视觉上从属于这一组而不是下一组。
.env-panel {
  margin: 6px 0 2px 12px;
  padding: 10px 12px;
  border-left: 2px solid var(--color-gray-5);
  background: var(--color-gray-1, transparent);
  border-radius: 4px;

  .env-block + .env-block {
    margin-top: 10px;
  }

  .env-head {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 24px;
  }

  .env-title {
    font-size: 13px;
    font-weight: 600;
  }

  .env-tip {
    font-size: 12px;
    color: var(--cip-text-sub, #8a91a3);
    margin-bottom: 6px;
    line-height: 1.6;
  }

  .env-foot {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 8px;

    .env-tip {
      margin-bottom: 0;
    }

    code {
      font-family: var(--font-code, monospace);
    }
  }

  .env-err {
    font-size: 12px;
    color: #ef5350;
    margin-top: 6px;
    word-break: break-all;
  }

  // 「不填也会写进去」的那批：默认只留一行按钮，展开才铺开值——LD_LIBRARY_PATH 这种一条能
  // 顶十行，默认铺开会把整个表单挤没。
  .env-auto {
    margin-top: 2px;

    :deep(.ant-btn) {
      padding: 0;
      height: auto;
      white-space: normal;
      text-align: left;
    }
  }

  .env-auto-list {
    margin-top: 4px;
    max-height: 160px;
    overflow-y: auto;
    font-family: var(--font-code, monospace);
    font-size: 12px;
    line-height: 1.7;
    word-break: break-all;

    .k {
      color: var(--cip-text-sub, #8a91a3);
    }
    .from {
      margin-left: 8px;
      font-family: inherit;
      color: var(--cip-text-sub, #8a91a3);
    }
    // 被用户填的同名变量顶掉的那条：留着但压暗，好过直接不显示——「我填的到底生不生效」
    // 正是这时候最想知道的事。
    .dim {
      opacity: 0.55;
      text-decoration: line-through;
    }
  }

  // 展开预览：占位符的意义就是每台不一样，这里如实显示首个（有占位符时再加末个）runner
  // 实际会拿到的值。
  .env-preview {
    font-family: var(--font-code, monospace);
    font-size: 12px;
    color: #17b890;
    margin-top: 4px;
    word-break: break-all;
  }
}

.batch-progress {
  margin-top: 8px;

  .batch-summary {
    display: flex;
    align-items: center;
    gap: 14px;
    padding-bottom: 10px;
    margin-bottom: 8px;
    font-size: 13px;
    border-bottom: 1px solid var(--color-gray-4);

    .ok {
      color: #17b890;
    }
    .fail {
      color: #ef5350;
    }
  }

  .batch-list {
    max-height: 340px;
    overflow-y: auto;
  }

  .batch-retry {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px solid var(--color-gray-4);
  }

  .batch-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 4px;
    border-bottom: 1px solid var(--color-gray-3);

    &:last-child {
      border-bottom: none;
    }

    .icon {
      flex: 0 0 20px;
      text-align: center;
      font-weight: 700;
    }
    .name {
      flex: 0 0 auto;
      min-width: 140px;
      font-family: var(--font-code, monospace);
      font-size: 13px;
    }
    .step {
      flex: 1;
      min-width: 0;
      font-size: 12px;
      text-align: right;
      word-break: break-all;
    }
    .row-actions {
      flex: 0 0 auto;
      white-space: nowrap;

      :deep(.ant-btn) {
        padding: 0 4px;
      }
    }
  }
}
</style>
