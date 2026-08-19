<script setup lang="ts">
// Runner 实例（自研补充）：节点 → 仓库 → runner 三级下钻，作为 /instances 页面的卡片。
//
// 数据全部来自 /api/repo/list，它会去每个节点扫磁盘：runner 目录下的 .runner 决定它属于哪个仓库，
// .service 决定由哪个 systemd 单元托管，systemctl 给出真实状态。所以这里看到的是机器上的
// 既成事实，而不是面板自己的记账——面板托管的实例只是其中一种托管方式，systemd 才是生产常态。
//
// 层级用 query 参数（?node=&repo=）而不是 path 参数：这个组件是卡片，寄居在 /instances 页面下，
// 没有自己的路由段。用 query 仍然保住了刷新、后退和分享链接的能力。
import { computed, h, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { message, Modal } from "ant-design-vue";
import {
  CheckSquareOutlined,
  CloudServerOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  DownOutlined,
  ExclamationCircleOutlined,
  PauseCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  RightOutlined,
  SettingOutlined,
  WarningOutlined
} from "@ant-design/icons-vue";
import BetweenMenus from "@/components/BetweenMenus.vue";
import NodeSimpleChart from "@/components/NodeSimpleChart.vue";
import CreateInstanceOptions from "./CreateInstanceOptions.vue";
import ImportRunnerDialog from "./ImportRunnerDialog.vue";
import { useOverviewInfo } from "@/hooks/useOverviewInfo";
import type { LayoutCard } from "@/types/index";
import { repoList, type RepoRunner, type RepoSummary } from "@/services/apis/repo";
import {
  controlRunnerService,
  controlRunnerServiceBatch,
  deleteRunnerBatch,
  getRunnerEnv,
  setRunnerEnvBatch,
  type DeleteRunnerResult,
  type RunnerEnvVar,
  type EnvTarget
} from "@/services/apis/runner";
import DeleteResultView from "./DeleteResultView.vue";
import { remoteNodeList } from "@/services/apis";
import { t } from "@/lang/i18n";
import {
  canControl,
  kindLabel,
  ownershipHint,
  ownershipTag,
  serviceOf,
  shouldWarnConflict
} from "@/tools/supervisor";
import type { SupervisorAction } from "mcsmanager-common";

defineProps<{
  card: LayoutCard;
}>();

const route = useRoute();
const router = useRouter();

const { execute: fetchRepos, state: repoData, isLoading } = repoList();
const { execute: fetchNodes, state: nodes } = remoteNodeList();

// 节点系统信息（CPU/内存用量 + 走势图）：复用概览接口，它自带 3 秒轮询与卸载清理。
// remoteNodeList 只给 available/ip/port/remarks/uuid，没有系统指标，所以两边按 uuid 合并。
const { state: AllDaemonData } = useOverviewInfo();

const daemonId = computed(() => (route.query.node as string) || "");
const repoSlug = computed(() => (route.query.repo as string) || "");
const level = computed<"node" | "repo" | "runner">(() => {
  if (daemonId.value && repoSlug.value) return "runner";
  if (daemonId.value) return "repo";
  return "node";
});

// 已纳管 + 未纳管一起展示，未纳管的打个标记（磁盘上有 runner，注册表里还没有）
const allRepos = computed<Array<RepoSummary & { registered: boolean }>>(() => {
  const d = repoData.value;
  if (!d) return [];
  return [
    ...d.repos.map((r) => ({ ...r, registered: true })),
    ...d.unregistered.map((r) => ({ ...r, registered: false }))
  ];
});

// runner 计数。running/busy/orphaned/conflicted 必须和 total 出自同一批 runner——
// /api/repo/list 返回的 RepoSummary 是「跨所有节点」的汇总，下钻到某个节点后不能沿用它的计数，
// 否则运行数（全部节点）会大于总数（当前节点），显示成 6/5 这种不可能的比值。
function summarizeRunners(
  runners: RepoRunner[]
): Pick<RepoSummary, "total" | "running" | "busy" | "orphaned" | "conflicted"> {
  return {
    total: runners.length,
    running: runners.filter((r) => r.running).length,
    busy: runners.filter((r) => r.busy).length,
    orphaned: runners.filter((r) => shouldWarnConflict(r) && r.runtime?.ownership === "foreign")
      .length,
    conflicted: runners.filter((r) => r.runtime?.ownership === "conflict").length
  };
}

// 每个节点上有哪些仓库、多少 runner。runner 自带 daemonId，按它归堆
const nodeCards = computed(() =>
  (nodes.value || []).map((node) => {
    const runners: RepoRunner[] = [];
    const repos = new Set<string>();
    for (const repo of allRepos.value) {
      const mine = repo.runners.filter((r) => r.daemonId === node.uuid);
      if (mine.length) {
        repos.add(repo.slug);
        runners.push(...mine);
      }
    }
    // 该节点的系统指标（概览接口按 uuid 对上）
    const sys = AllDaemonData.value?.remote?.find((r) => r.uuid === node.uuid);
    const stats = summarizeRunners(runners);
    return {
      node,
      sys,
      repoCount: repos.size,
      ...stats,
      // 空闲 = 在跑但没接 job：CI 场景第一位的问题「现在还能接多少活」
      idle: Math.max(0, stats.running - stats.busy)
    };
  })
);

// 节点已运行时长（秒 → 天/小时/分钟）
function fmtUptime(sec?: number) {
  if (!sec || sec <= 0) return "--";
  const d = Math.floor(sec / 86400);
  if (d >= 1) return `${d} 天`;
  const h = Math.floor(sec / 3600);
  if (h >= 1) return `${h} 小时`;
  return `${Math.floor(sec / 60)} 分钟`;
}

// 1 分钟负载。CI 任务突发，瞬时 CPU% 会骗人（可能采样在空隙），负载更能反映排队/饱和。
// Windows 没有 loadavg（恒为 0），显示 -- 免得误导。
function fmtLoad(sys?: { loadavg?: number[]; platform?: string }) {
  if (!sys || sys.platform === "win32") return "--";
  const v = sys.loadavg?.[0];
  return v == null || Number.isNaN(v) ? "--" : v.toFixed(2);
}

const reposOfNode = computed(() =>
  allRepos.value
    .map((repo) => {
      const runners = repo.runners.filter((r) => r.daemonId === daemonId.value);
      // summarizeRunners 必须放在 ...repo 之后：它要覆盖掉后端那份跨节点的计数
      return { ...repo, runners, ...summarizeRunners(runners) };
    })
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total)
);

const runnersOfRepo = computed<RepoRunner[]>(() => {
  const repo = allRepos.value.find((r) => r.slug === repoSlug.value);
  if (!repo) return [];
  return repo.runners
    .filter((r) => r.daemonId === daemonId.value)
    .sort((a, b) => a.agentName.localeCompare(b.agentName, undefined, { numeric: true }));
});

const currentNodeName = computed(
  () => nodes.value?.find((n) => n.uuid === daemonId.value)?.remarks || daemonId.value
);

// runner 表格分页：受控状态。传字面量给 :pagination 会把 pageSize 钉死，
// 用户在"条/页"下拉里选完立刻被重置回 10，所以这里自己存并在 @change 里回写。
const runnerPagination = ref({
  current: 1,
  pageSize: 10,
  showSizeChanger: true,
  showTotal: (total: number) => `共 ${total} 个`
});

function onRunnerTableChange(pag: { current?: number; pageSize?: number }) {
  runnerPagination.value = {
    ...runnerPagination.value,
    current: pag.current ?? runnerPagination.value.current,
    pageSize: pag.pageSize ?? runnerPagination.value.pageSize
  };
}

// 换仓库、换节点后旧的页码可能超出新数据的总页数，回到第一页。
// 必须连 daemonId 一起看：同名仓库在两个节点上都有 runner 时，只有 node 变、repo 不变
watch([daemonId, repoSlug], () => {
  runnerPagination.value = { ...runnerPagination.value, current: 1 };
});

async function load(silent = false) {
  try {
    await Promise.all([fetchNodes(), fetchRepos()]);
  } catch (err: any) {
    if (!silent) message.error("加载失败：" + (err?.message || err));
  }
}

// job 会来会走，10 秒自动刷一次
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  load();
  timer = setInterval(() => load(true), 10000);
});
onUnmounted(() => clearInterval(timer));

// a-badge 的 status 只认这五个值，与标签那张表的颜色不是同一套，所以这里显式映射，
// 不去复用 ownershipTag 的 color。
type BadgeStatus = "success" | "processing" | "default" | "error" | "warning";

function statusColor(r: RepoRunner): BadgeStatus {
  // busy 优先：正在跑 job 是这一列最要紧的信息，停它会中断 CI
  if (r.busy) return "processing";
  if (r.runtime?.ownership === "conflict") return "error";
  if (shouldWarnConflict(r)) return "warning";
  return r.running ? "success" : "default";
}

function statusLabel(r: RepoRunner) {
  if (r.busy) return t("TXT_CODE_RUNNER_BUSY");
  // 其余一律走归属那张表：托管方式加一种时这里不用改
  return ownershipTag(r).label;
}

// systemd 的时间戳形如 "Fri 2026-07-03 11:52:54 CST"，只留日期和时分
function shortTime(s: string) {
  if (!s) return "—";
  const m = s.match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2})/);
  return m ? m[1] : s;
}

const acting = ref<Record<string, boolean>>({});

async function doControl(r: RepoRunner, action: SupervisorAction) {
  // 与 daemon 侧 assertActionAllowed 同一套规则，理由也由它给出
  const check = canControl(r, action);
  if (!check.ok) return message.error(check.reason);
  acting.value[r.dir] = true;
  try {
    const { execute, state } = controlRunnerService();
    // 过渡期两个字段都发：dir 是新 daemon 的寻址依据，service 留给还没升级的节点
    await execute({
      params: { daemonId: r.daemonId },
      data: { dir: r.dir, service: serviceOf(r), action }
    });
    // settled=false：systemd 收下了 job 但还没跑到位（多半是这个 runner 停不下来）。
    // 不能报"成功"——它可能几分钟后才真的动，10 秒一轮的刷新会把最终状态显示出来。
    if (state.value?.settled === false) {
      message.warning(`${r.agentName} ${action} 已提交，但还没跑到位，状态会在刷新后更新`);
    } else {
      message.success(`${r.agentName} ${action} 成功`);
    }
    await load(true);
  } catch (err: any) {
    message.error(`${action} 失败：` + (err?.message || err));
  } finally {
    acting.value[r.dir] = false;
  }
}

// 停/重启一个正在跑 job 的 runner 会当场中断 CI 任务，必须让人明确知道自己在干什么
function confirmControl(r: RepoRunner, action: "start" | "stop" | "restart") {
  if (action === "start" || !r.busy) return doControl(r, action);
  Modal.confirm({
    title: `${r.agentName} 正在跑 CI 任务`,
    icon: () => h(ExclamationCircleOutlined),
    content: `${action === "stop" ? "停止" : "重启"}它会当场中断正在执行的 job，该 job 会失败。确定继续吗？`,
    okText: "我确定，仍然继续",
    okType: "danger",
    cancelText: "取消",
    onOk: () => doControl(r, action)
  });
}

// 导入弹窗：在节点视图里点开时带上当前节点，省一次选择
const importDialog = ref<InstanceType<typeof ImportRunnerDialog>>();
function openImport() {
  const preset = daemonId.value
    ? { daemonId: daemonId.value, nodeName: currentNodeName.value }
    : undefined;
  importDialog.value?.openDialog(preset);
}

// 进 runner 详情页（实时日志 + 基本信息 + 文件管理/配置）
function goDetail(r: RepoRunner) {
  router.push({ path: "/instances/runner", query: { daemonId: r.daemonId, dir: r.dir } });
}

// ---- 批处理多选模式：勾选/全选（支持跨页保留）→ 删除 / 停止 / 重启，均并行 ----
const batchMode = ref(false);
const selectedDirs = ref<string[]>([]);
// 选中的 dir 映射回 RepoRunner，拿 service / busy / agentName
const selectedRunners = computed(() =>
  runnersOfRepo.value.filter((r) => selectedDirs.value.includes(r.dir))
);
// preserveSelectedRowKeys：翻页/10 秒刷新都不丢已选（跨页保留）
const rowSelection = computed(() => ({
  selectedRowKeys: selectedDirs.value,
  preserveSelectedRowKeys: true,
  onChange: (keys: Array<string | number>) => {
    selectedDirs.value = keys.map((k) => String(k));
  }
}));
function enterBatchMode() {
  batchMode.value = true;
}
function exitBatchMode() {
  batchMode.value = false;
  selectedDirs.value = [];
}
// ant 表头全选框只选当前页；这个按钮直接选中本仓库全部（含未翻到的页）
function selectAllInRepo() {
  selectedDirs.value = runnersOfRepo.value.map((r) => r.dir);
}
function clearSelection() {
  selectedDirs.value = [];
}

// ---- 批量停止 / 重启（并行）----
const batchControlling = ref(false);
function batchControl(action: "stop" | "restart") {
  const sel = selectedRunners.value;
  if (!sel.length) return message.warning("请先勾选 runner");
  // 与单个启停共用同一个判定：按「面板能不能管它」筛，而不是按「有没有 systemd 单元」
  const withSvc = sel.filter((r) => canControl(r, action).ok);
  const skipped = sel.length - withSvc.length;
  if (!withSvc.length) return message.warning(t("TXT_CODE_RUNNER_BATCH_NONE_CONTROLLABLE"));
  const busyCount = withSvc.filter((r) => r.busy).length;
  const label = action === "stop" ? "停止" : "重启";
  const lines = [`将${label}选中的 ${withSvc.length} 个 runner。`];
  if (busyCount > 0) lines.push(`其中 ${busyCount} 个正在跑 job，${label}会当场中断这些 CI 任务！`);
  if (skipped > 0) lines.push(t("TXT_CODE_RUNNER_BATCH_SKIPPED", { count: skipped }));
  Modal.confirm({
    title: `批量${label} ${withSvc.length} 个 runner`,
    icon: () => h(ExclamationCircleOutlined),
    content: lines.join(" "),
    okText: `确认${label}`,
    okType: "danger",
    cancelText: "取消",
    onOk: () => doBatchControl(action, withSvc, label)
  });
}
async function doBatchControl(action: "stop" | "restart", withSvc: RepoRunner[], label: string) {
  batchControlling.value = true;
  try {
    const { execute, state } = controlRunnerServiceBatch();
    await execute({
      params: { daemonId: daemonId.value },
      data: {
        items: withSvc.map((r) => ({ dir: r.dir, service: serviceOf(r) })),
        action
      }
    });
    const results = state.value?.results || [];
    const ok = results.filter((r) => r.ok).length;
    const fail = results.length - ok;
    // settled=false：systemd 已受理但还没跑到位。这些不算失败，但也不能混进"成功"里报——
    // 它们多半就是停不下来的那几个，用户需要知道该去刷新盯着谁。
    const pending = results.filter((r) => r.ok && r.settled === false);
    if (fail === 0 && pending.length === 0) {
      message.success(`${label}完成：成功 ${ok} 个`);
    } else if (fail === 0) {
      const names = pending.map(
        (r) => withSvc.find((x) => x.dir === r.dir)?.agentName || r.dir || r.service
      );
      message.warning(
        `${label}已提交：${ok} 个，其中 ${pending.length} 个还没停下来（${names.join("、")}），` +
          `状态会在刷新后更新`
      );
    } else {
      const failNames = results
        .filter((r) => !r.ok)
        .map((r) => withSvc.find((x) => x.dir === r.dir)?.agentName || r.dir);
      message.warning(`${label}完成：成功 ${ok} 个，失败 ${fail} 个（${failNames.join("、")}）`);
    }
    await load(true);
    clearSelection();
  } catch (err: any) {
    message.error(`批量${label}失败：` + (err?.message || err));
  } finally {
    batchControlling.value = false;
  }
}

// ---- 批量设置环境变量（并行；默认 merge，保留各 runner 已有变量如各自 DEVICE_ID）----
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const envBatchOpen = ref(false);
const envBatchSaving = ref(false);
const envBatchTarget = ref<EnvTarget>("override"); // 写哪个目标：override.conf 或 .env
const envUpsert = ref<RunnerEnvVar[]>([]);
const envRemoveKeys = ref<string[]>([]);
const envBatchLoading = ref(false); // 打开弹窗时拉各 runner 现有变量名（供"删除"下拉选项）
// 各 runner 现有的变量名，按目标分：{ dir: { override: [...], dotenv: [...] } }
const envKeysByDir = ref<Record<string, { override: string[]; dotenv: string[] }>>({});
// 目标能落到哪些 runner：listener 作用域要托管方能写（外部托管的写不了），job 作用域人人都能写。
const envBatchTargets = computed(() =>
  envBatchTarget.value === "override"
    ? // listener 作用域能不能写由托管方式决定，不再看「有没有 systemd 单元」：
      // 进程托管的节点写 daemon 自己的 env 文件，只有「外部托管」那种写不了
      selectedRunners.value.filter((r) => r.supervisor !== "none")
    : selectedRunners.value
);
// "要删除的变量"下拉选项：当前目标下、所有目标 runner 现有变量名的并集（用户只从存在的里选，不手输新建）
const envRemovableKeys = computed(() => {
  const set = new Set<string>();
  for (const r of envBatchTargets.value) {
    const entry = envKeysByDir.value[r.dir];
    if (!entry) continue;
    for (const k of envBatchTarget.value === "override" ? entry.override : entry.dotenv) set.add(k);
  }
  return Array.from(set).sort();
});
// 拉取选中 runner 的现有变量名（两目标都取，切换目标时无需重拉）。并行、逐个失败不影响其余。
async function loadBatchEnvKeys() {
  envBatchLoading.value = true;
  const byDir: Record<string, { override: string[]; dotenv: string[] }> = {};
  try {
    await Promise.all(
      selectedRunners.value.map(async (r) => {
        try {
          const { execute, state } = getRunnerEnv();
          await execute({ params: { daemonId: daemonId.value }, data: { dir: r.dir } });
          byDir[r.dir] = {
            override: (state.value?.override?.vars || []).map((v) => v.key),
            dotenv: (state.value?.dotenv?.vars || []).map((v) => v.key)
          };
        } catch {
          byDir[r.dir] = { override: [], dotenv: [] };
        }
      })
    );
    envKeysByDir.value = byDir;
  } finally {
    envBatchLoading.value = false;
  }
}
// 切目标时，丢掉已选但在新目标下不存在的删除项（避免删一个该目标没有的 key）
watch(envBatchTarget, () => {
  const allowed = new Set(envRemovableKeys.value);
  envRemoveKeys.value = envRemoveKeys.value.filter((k) => allowed.has(k));
});
function openBatchEnv() {
  if (!selectedDirs.value.length) return message.warning("请先勾选 runner");
  envBatchTarget.value = "override";
  envUpsert.value = [{ key: "", value: "" }];
  envRemoveKeys.value = [];
  envKeysByDir.value = {};
  envBatchOpen.value = true;
  void loadBatchEnvKeys();
}
function addEnvUpsertRow() {
  envUpsert.value.push({ key: "", value: "" });
}
function removeEnvUpsertRow(i: number) {
  envUpsert.value.splice(i, 1);
}
async function doBatchEnv() {
  const rows = envUpsert.value
    .map((v) => ({ key: v.key.trim(), value: v.value }))
    .filter((v) => v.key);
  const removeKeys = envRemoveKeys.value.map((k) => k.trim()).filter(Boolean);
  if (!rows.length && !removeKeys.length) return message.warning("没有要增改或删除的变量");
  const bad = [...rows.map((v) => v.key), ...removeKeys].find((k) => !ENV_KEY_RE.test(k));
  if (bad) return message.error(`非法变量名：${bad}（只能字母数字下划线，且不以数字开头）`);
  const keys = rows.map((v) => v.key);
  if (new Set(keys).size !== keys.length) return message.error("有重复的变量名");

  const targets = envBatchTargets.value;
  if (!targets.length)
    return message.warning("没有可写入的 runner（监听进程环境变量需要托管方支持）");
  envBatchSaving.value = true;
  try {
    const { execute, state } = setRunnerEnvBatch();
    await execute({
      params: { daemonId: daemonId.value },
      // merge 语义：只增改 upsert、删除 removeKeys，保留各 runner 其余变量
      data: {
        dirs: targets.map((r) => r.dir),
        target: envBatchTarget.value,
        upsert: rows,
        remove: removeKeys,
        replace: false
      }
    });
    const results = state.value?.results || [];
    const ok = results.filter((r) => r.ok).length;
    const fail = results.length - ok;
    envBatchOpen.value = false;
    if (fail === 0) message.success(`环境变量已写入：成功 ${ok} 个`);
    else {
      const failNames = results
        .filter((r) => !r.ok)
        .map((r) => targets.find((x) => x.dir === r.dir)?.agentName || r.dir);
      message.warning(`写入完成：成功 ${ok} 个，失败 ${fail} 个（${failNames.join("、")}）`);
    }
    // 环境变量需重启单元生效——提示批量重启（正在跑 job 的会中断，二次确认）
    if (ok > 0)
      promptBatchRestart(targets.filter((r) => results.find((x) => x.dir === r.dir && x.ok)));
  } catch (err: any) {
    message.error("批量设置环境变量失败：" + (err?.message || err));
  } finally {
    envBatchSaving.value = false;
  }
}
function promptBatchRestart(written: RepoRunner[]) {
  // 写成功不等于重启得动：foreign / conflict / 观测不完整的那些，面板本来就不该去重启它们。
  // 不筛的话，这里会绕过启停守卫，发一批前端自己都知道会被拒的请求。
  const targets = written.filter((r) => canControl(r, "restart").ok);
  const denied = written.length - targets.length;
  if (!targets.length) {
    if (denied > 0) message.warning(t("TXT_CODE_RUNNER_BATCH_NONE_CONTROLLABLE"));
    return;
  }
  const busyCount = targets.filter((r) => r.busy).length;
  const lines = [`环境变量已写入，需重启才生效。将重启 ${targets.length} 个 runner。`];
  if (busyCount > 0) lines.push(`其中 ${busyCount} 个正在跑 job，重启会当场中断这些 CI 任务！`);
  if (denied > 0) lines.push(t("TXT_CODE_RUNNER_BATCH_SKIPPED", { count: denied }));
  Modal.confirm({
    title: "重启使环境变量生效？",
    icon: () => h(ExclamationCircleOutlined),
    content: lines.join(" "),
    okText: "立即重启",
    okType: busyCount > 0 ? "danger" : "primary",
    cancelText: "稍后手动重启",
    onOk: () => doBatchControl("restart", targets, "重启")
  });
}

// ---- 批量删除选中的 runner（并行；共用一个 GitHub 删除 token）----
const batchOpen = ref(false);
const batchToken = ref(""); // 手输 GitHub 删除 token，留空则用仓库 PAT 自动取
const batchDeleting = ref(false);
const batchBusyCount = computed(() => selectedRunners.value.filter((r) => r.busy).length);
function openBatchDelete() {
  if (!selectedDirs.value.length) return message.warning("请先勾选 runner");
  batchToken.value = "";
  batchOpen.value = true;
}
async function doBatchDelete() {
  const list = selectedRunners.value;
  if (!list.length) return;
  batchDeleting.value = true;
  try {
    const { execute, state } = deleteRunnerBatch();
    await execute({
      params: { daemonId: daemonId.value },
      data: {
        repo: repoSlug.value,
        dirs: list.map((r) => r.dir),
        force: batchBusyCount.value > 0, // 正在跑 job 的也一并删（用户已在弹窗确认）
        removeToken: batchToken.value.trim()
      }
    });
    const results = state.value?.results || [];
    batchOpen.value = false;
    clearSelection();
    // 逐个 runner 的分步结果都摆出来，让用户看到每个删到哪一步、哪步失败、如何手动补做
    batchResults.value = results;
    batchResultOpen.value = true;
  } catch (err: any) {
    message.error("批量删除失败：" + (err?.message || err));
  } finally {
    batchDeleting.value = false;
  }
}
// 批量删除结果分步展示
const batchResultOpen = ref(false);
const batchResults = ref<Array<DeleteRunnerResult & { error?: string }>>([]);
const batchOkCount = computed(() => batchResults.value.filter((r) => r.ok).length);
async function closeBatchResult() {
  batchResultOpen.value = false;
  // 选择性删除后仓库里可能还有 runner，留在 L3 刷新即可，不再跳回节点层
  await load();
}

const goRoot = () => router.push({ path: route.path });
const goNode = (uuid: string) => router.push({ path: route.path, query: { node: uuid } });
const goRepo = (slug: string) =>
  router.push({ path: route.path, query: { node: daemonId.value, repo: slug } });
</script>

<template>
  <div style="min-height: 100%" class="container">
    <a-row :gutter="[24, 24]" style="min-height: 100%">
      <!-- 创建入口（内含「添加 Runner」对话框）。新注册的 runner 立刻会出现在下面的列表里 -->
      <a-col :span="24">
        <CreateInstanceOptions :card="card" @created="load()" />
      </a-col>

      <a-col :span="24">
        <BetweenMenus>
          <template #left>
            <a-typography-title class="mb-0" :level="4">
              <CloudServerOutlined />
              {{ card.title }}
            </a-typography-title>
          </template>
          <template #right>
            <a-space>
              <a-button @click="openImport()"><DatabaseOutlined /> 导入 runner</a-button>
              <a-button :loading="isLoading" @click="load()"> <ReloadOutlined /> 刷新 </a-button>
            </a-space>
          </template>
        </BetweenMenus>
      </a-col>

      <!-- 面包屑：三级下钻的返回路径 -->
      <a-col :span="24">
        <a-breadcrumb>
          <a-breadcrumb-item>
            <a @click="goRoot()">全部节点</a>
          </a-breadcrumb-item>
          <a-breadcrumb-item v-if="level !== 'node'">
            <a @click="goNode(daemonId)">{{ currentNodeName }}</a>
          </a-breadcrumb-item>
          <a-breadcrumb-item v-if="level === 'runner'">{{ repoSlug }}</a-breadcrumb-item>
        </a-breadcrumb>
      </a-col>

      <a-col v-if="repoData?.failedNodes?.length" :span="24">
        <a-alert
          type="warning"
          show-icon
          :message="`有 ${repoData.failedNodes.length} 个节点扫描失败，下面的数据不完整`"
          :description="repoData.failedNodes.map((n) => `${n.nodeName}: ${n.error}`).join('；')"
        />
      </a-col>

      <!-- L1：节点 -->
      <template v-if="level === 'node'">
        <!-- 每行 2 个：和「节点」页 NodeList 一致。CPU/内存是左右并排两张图，
             挤在 1/3 宽的卡片里会糊成一团，给到一半宽才够看 -->
        <a-col v-for="c in nodeCards" :key="c.node.uuid" :span="24" :lg="12">
          <a-card hoverable @click="goNode(c.node.uuid)">
            <template #title>
              <a-badge :status="c.node.available ? 'success' : 'error'" />
              {{ c.node.remarks || `${c.node.ip}:${c.node.port}` }}
            </template>
            <template #extra><RightOutlined /></template>
            <a-row>
              <a-col :span="6"><a-statistic title="仓库" :value="c.repoCount" /></a-col>
              <a-col :span="6">
                <a-statistic
                  title="运行中"
                  :value="c.running"
                  :suffix="`/ ${c.total}`"
                  :value-style="{ color: c.running === c.total ? '#52c41a' : '#faad14' }"
                />
              </a-col>
              <a-col :span="6">
                <a-statistic
                  title="空闲"
                  :value="c.idle"
                  :value-style="{ color: c.idle ? '#52c41a' : '#faad14' }"
                />
              </a-col>
              <a-col :span="6">
                <a-statistic
                  title="跑 job"
                  :value="c.busy"
                  :value-style="{ color: c.busy ? '#1677ff' : undefined }"
                />
              </a-col>
            </a-row>
            <div v-if="c.orphaned || c.conflicted" style="margin-top: 12px">
              <a-tag v-if="c.orphaned" color="warning">
                <WarningOutlined /> {{ c.orphaned }} 个无人托管
              </a-tag>
              <a-tag v-if="c.conflicted" color="error">
                <WarningOutlined /> {{ c.conflicted }} 个托管冲突
              </a-tag>
            </div>

            <!-- 节点系统指标：和「节点」页同款的 CPU/内存走势图 -->
            <template v-if="c.sys">
              <a-divider style="margin: 16px 0 12px" />
              <!-- 刻意不显示 MCSManager 的「实例数」：在句柄实例模型下那些实例只是文件管理的抓手、
                   并不代表在跑，数值≈runner 数，和上面的统计重复且语义误导 -->
              <div
                style="
                  display: flex;
                  justify-content: space-between;
                  gap: 8px;
                  flex-wrap: wrap;
                  font-size: 12px;
                  opacity: 0.65;
                  margin-bottom: 8px;
                "
              >
                <span>{{ c.sys.platformText || "--" }}</span>
                <span>负载 {{ fmtLoad(c.sys.system) }}</span>
                <span>运行 {{ fmtUptime(c.sys.system?.uptime) }}</span>
                <span>v{{ c.sys.version || "--" }}</span>
              </div>
              <NodeSimpleChart
                class="mt-8"
                :cpu-usage="c.sys.cpuInfo ?? ''"
                :mem-usage="c.sys.memText ?? ''"
                :cpu-data="c.sys.cpuChartData ?? []"
                :mem-data="c.sys.memChartData ?? []"
              />
            </template>
          </a-card>
        </a-col>
        <a-col v-if="!nodeCards.length && !isLoading" :span="24">
          <a-empty description="没有节点" />
        </a-col>
      </template>

      <!-- L2：该节点上的仓库 -->
      <template v-else-if="level === 'repo'">
        <a-col v-for="r in reposOfNode" :key="r.slug" :xs="24" :sm="12" :lg="8">
          <a-card hoverable @click="goRepo(r.slug)">
            <template #title><DatabaseOutlined /> {{ r.slug }}</template>
            <template #extra><RightOutlined /></template>
            <a-row>
              <a-col :span="12">
                <a-statistic
                  title="运行中"
                  :value="r.running"
                  :suffix="`/ ${r.total}`"
                  :value-style="{ color: r.running === r.total ? '#52c41a' : '#faad14' }"
                />
              </a-col>
              <a-col :span="12">
                <a-statistic
                  title="正在跑 job"
                  :value="r.busy"
                  :value-style="{ color: r.busy ? '#1677ff' : undefined }"
                />
              </a-col>
            </a-row>
            <div style="margin-top: 12px">
              <a-tag v-if="!r.registered">未纳管</a-tag>
              <a-tag v-if="r.registered && !r.hasToken">未配 PAT</a-tag>
              <a-tag v-if="r.orphaned" color="warning">
                <WarningOutlined /> {{ r.orphaned }} 个无人托管
              </a-tag>
              <a-tag v-if="r.conflicted" color="error">
                <WarningOutlined /> {{ r.conflicted }} 个托管冲突
              </a-tag>
            </div>
          </a-card>
        </a-col>
        <a-col v-if="!reposOfNode.length && !isLoading" :span="24">
          <a-empty description="这个节点上没有扫描到 runner" />
        </a-col>
      </template>

      <!-- L3：该仓库的 runner -->
      <a-col v-else :span="24">
        <div
          style="
            display: flex;
            justify-content: flex-end;
            align-items: center;
            gap: 8px;
            margin-bottom: 12px;
          "
        >
          <!-- 非批处理模式：仅一个入口按钮 -->
          <a-button v-if="!batchMode" :disabled="!runnersOfRepo.length" @click="enterBatchMode">
            <CheckSquareOutlined /> 批处理
          </a-button>

          <!-- 批处理模式：选择工具 + 批处理菜单 + 退出 -->
          <template v-else>
            <a-typography-text type="secondary" style="margin-right: 4px">
              已选 {{ selectedDirs.length }} 个
            </a-typography-text>
            <a-button @click="selectAllInRepo"> 全选全部（{{ runnersOfRepo.length }}）</a-button>
            <a-button :disabled="!selectedDirs.length" @click="clearSelection"> 清空 </a-button>
            <a-dropdown :disabled="!selectedDirs.length">
              <template #overlay>
                <a-menu>
                  <a-menu-item key="stop" @click="batchControl('stop')">
                    <PauseCircleOutlined /> 停止
                  </a-menu-item>
                  <a-menu-item key="restart" @click="batchControl('restart')">
                    <ReloadOutlined /> 重启
                  </a-menu-item>
                  <a-menu-divider />
                  <a-menu-item key="env" @click="openBatchEnv">
                    <SettingOutlined /> 设置环境变量
                  </a-menu-item>
                  <a-menu-divider />
                  <a-menu-item key="delete" danger @click="openBatchDelete">
                    <DeleteOutlined /> 删除
                  </a-menu-item>
                </a-menu>
              </template>
              <a-button
                type="primary"
                :disabled="!selectedDirs.length"
                :loading="batchControlling || batchDeleting"
              >
                批处理菜单 <DownOutlined />
              </a-button>
            </a-dropdown>
            <a-button @click="exitBatchMode">退出批处理</a-button>
          </template>
        </div>
        <a-table
          :data-source="runnersOfRepo"
          row-key="dir"
          :loading="isLoading"
          :row-selection="batchMode ? rowSelection : undefined"
          :pagination="runnerPagination"
          size="middle"
          :scroll="{ x: 900 }"
          @change="onRunnerTableChange"
        >
          <a-table-column key="agentName" title="Runner" :width="170">
            <template #default="{ record }">
              <div style="font-weight: 500">{{ record.agentName }}</div>
              <!-- 目录名和 GitHub 上的名字经常对不上，两个都得显示 -->
              <div v-if="record.dirName !== record.agentName" style="font-size: 12px; opacity: 0.6">
                目录: {{ record.dirName }}
              </div>
            </template>
          </a-table-column>

          <a-table-column key="status" title="状态" :width="130">
            <template #default="{ record }">
              <a-badge :status="statusColor(record)" :text="statusLabel(record)" />
            </template>
          </a-table-column>

          <a-table-column
            key="supervisor"
            :title="t('TXT_CODE_RUNNER_COL_SUPERVISOR')"
            :width="110"
          >
            <template #default="{ record }">
              <a-tag>{{ kindLabel(record.supervisor) }}</a-tag>
            </template>
          </a-table-column>

          <a-table-column key="ownership" :title="t('TXT_CODE_RUNNER_COL_OWNERSHIP')" :width="120">
            <template #default="{ record }">
              <a-tooltip :title="ownershipHint(record)">
                <a-tag :color="ownershipTag(record).color">
                  <WarningOutlined v-if="shouldWarnConflict(record)" />
                  {{ ownershipTag(record).label }}
                </a-tag>
              </a-tooltip>
            </template>
          </a-table-column>

          <a-table-column key="since" title="启动于" :width="140">
            <template #default="{ record }">
              <span style="font-size: 13px">{{ shortTime(record.since) }}</span>
            </template>
          </a-table-column>

          <a-table-column key="dir" title="目录">
            <template #default="{ record }">
              <span style="font-size: 12px; opacity: 0.75">{{ record.dir }}</span>
            </template>
          </a-table-column>

          <a-table-column key="action" title="操作" :width="260" fixed="right">
            <template #default="{ record }">
              <a-space>
                <a-button size="small" type="primary" ghost @click="goDetail(record)">
                  详情
                </a-button>
                <!-- 按钮禁用与否、以及为什么禁用，都由 canControl 说了算：与 daemon 侧那道
                     闸门同一套规则，用户在点下去之前就知道结论和原因 -->
                <a-tooltip v-if="!record.running" :title="canControl(record, 'start').reason">
                  <span>
                    <a-button
                      size="small"
                      type="primary"
                      :loading="acting[record.dir]"
                      :disabled="!canControl(record, 'start').ok"
                      @click="confirmControl(record, 'start')"
                    >
                      启动
                    </a-button>
                  </span>
                </a-tooltip>
                <a-tooltip v-if="record.running" :title="canControl(record, 'stop').reason">
                  <span>
                    <a-button
                      size="small"
                      danger
                      :loading="acting[record.dir]"
                      :disabled="!canControl(record, 'stop').ok"
                      @click="confirmControl(record, 'stop')"
                    >
                      停止
                    </a-button>
                  </span>
                </a-tooltip>
                <a-tooltip :title="canControl(record, 'restart').reason">
                  <span>
                    <a-button
                      size="small"
                      :loading="acting[record.dir]"
                      :disabled="!canControl(record, 'restart').ok"
                      @click="confirmControl(record, 'restart')"
                    >
                      重启
                    </a-button>
                  </span>
                </a-tooltip>
              </a-space>
            </template>
          </a-table-column>
        </a-table>
      </a-col>
    </a-row>

    <!-- 导入既有 runner：扫描节点磁盘 → 勾选 → 写 .cipanel 纳管 -->
    <ImportRunnerDialog ref="importDialog" @imported="load()" />

    <!-- 批量设置环境变量弹窗（merge：增改 upsert、删除 removeKeys，保留各自其余变量）-->
    <a-modal
      v-model:open="envBatchOpen"
      :title="`批量设置环境变量（${envBatchTargets.length} 个 runner）`"
      :width="600"
      ok-text="写入并提示重启"
      :ok-button-props="{ loading: envBatchSaving }"
      cancel-text="取消"
      @ok="doBatchEnv"
    >
      <a-radio-group v-model:value="envBatchTarget" style="margin-bottom: 12px">
        <a-radio-button value="override">
          {{ t("TXT_CODE_RUNNER_ENV_SCOPE_LISTENER") }}
        </a-radio-button>
        <a-radio-button value="dotenv">运行时 .env</a-radio-button>
      </a-radio-group>
      <a-alert
        type="info"
        show-icon
        style="margin-bottom: 12px"
        :message="
          envBatchTarget === 'override'
            ? '合并写入监听进程的环境：只增改下方变量、删除指定变量名，各 runner 其余变量（如各自的 DEVICE_ID）保持不变。代理这类要让 runner 连上 GitHub 的变量必须写在这里。写入后需重启才生效。'
            : '合并写入 runner 目录的 .env（只进 job/step）：只增改下方变量、删除指定变量名，各 runner 其余变量保持不变。设备号、库路径这类放这里。写入后需重启才生效。'
        "
      />
      <a-alert
        v-if="envBatchTarget === 'override' && selectedRunners.length > envBatchTargets.length"
        type="warning"
        show-icon
        style="margin-bottom: 12px"
        :message="`选中的 ${selectedRunners.length} 个里有 ${selectedRunners.length - envBatchTargets.length} 个的托管方式写不了监听进程环境变量，将被跳过。`"
      />
      <a-typography-text strong>增改变量（upsert）</a-typography-text>
      <div style="margin-top: 8px">
        <div v-for="(row, i) in envUpsert" :key="i" class="env-row">
          <a-input v-model:value="row.key" placeholder="变量名，如 HTTP_PROXY" class="env-key" />
          <span class="env-eq">=</span>
          <a-input
            v-model:value="row.value"
            placeholder="值，如 http://127.0.0.1:7890"
            class="env-val"
          />
          <a-button type="text" danger size="small" @click="removeEnvUpsertRow(i)">
            <DeleteOutlined />
          </a-button>
        </div>
        <a-button type="dashed" block size="small" style="margin-top: 4px" @click="addEnvUpsertRow">
          <PlusOutlined /> 添加变量
        </a-button>
      </div>
      <a-form layout="vertical" style="margin-top: 16px">
        <a-form-item label="要删除的变量名（可选）">
          <a-select
            v-model:value="envRemoveKeys"
            mode="multiple"
            style="width: 100%"
            :loading="envBatchLoading"
            :options="envRemovableKeys.map((k) => ({ value: k, label: k }))"
            :placeholder="
              envRemovableKeys.length
                ? '从选中 runner 现有的变量里选择要删除的（输入可过滤）'
                : envBatchLoading
                  ? '正在读取现有变量…'
                  : '选中 runner 在该目标下暂无可删除的变量'
            "
            option-filter-prop="label"
            :not-found-content="envBatchLoading ? '读取中…' : '无匹配变量'"
          />
        </a-form-item>
      </a-form>
    </a-modal>

    <!-- 批量删除选中 runner 确认弹窗 -->
    <a-modal
      v-model:open="batchOpen"
      :title="`删除选中的 ${selectedDirs.length} 个 runner？`"
      :width="560"
      ok-text="确认删除"
      :ok-button-props="{ danger: true, loading: batchDeleting }"
      cancel-text="取消"
      @ok="doBatchDelete"
    >
      <a-alert
        type="error"
        show-icon
        style="margin-bottom: 12px"
        :message="`将彻底删除选中的 ${selectedDirs.length} 个 runner，此操作不可逆`"
      />
      <a-alert
        v-if="batchBusyCount > 0"
        type="warning"
        show-icon
        style="margin-bottom: 12px"
        :message="`其中 ${batchBusyCount} 个正在跑 job，删除会当场中断这些 CI 任务！`"
      />
      <p style="margin-bottom: 8px">
        每个 runner 都会：停止并从托管方收回 · 从 GitHub 注销 · 删除目录。
      </p>
      <a-form layout="vertical">
        <a-form-item label="GitHub 删除 token（可选，整批共用）">
          <a-input
            v-model:value="batchToken"
            placeholder="留空则用该仓库已配置的 PAT 自动获取"
            allow-clear
          />
          <div style="font-size: 12px; opacity: 0.6; margin-top: 4px">
            没配 PAT 或面板连不上 GitHub 时，可从 GitHub 仓库 Settings → Actions → Runners
            里复制删除 token 粘到这里。留空且取不到 token 时，仅本地删除、GitHub 上需手动移除。
          </div>
        </a-form-item>
      </a-form>
    </a-modal>

    <!-- 批量删除结果分步展示 -->
    <a-modal
      v-model:open="batchResultOpen"
      :title="`删除结果：成功 ${batchOkCount} / 共 ${batchResults.length}`"
      :width="640"
      :mask-closable="false"
      ok-text="完成"
      @ok="closeBatchResult"
      @cancel="closeBatchResult"
    >
      <DeleteResultView :results="batchResults" />
    </a-modal>
  </div>
</template>

<style scoped>
.env-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}
.env-key {
  flex: 0 0 40%;
}
.env-eq {
  opacity: 0.5;
}
.env-val {
  flex: 1 1 auto;
}
</style>
