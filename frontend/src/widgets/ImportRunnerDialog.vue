<script setup lang="ts">
// 「导入 runner」对话框（自研补充）：
// 扫描某个节点磁盘上真实存在的全部 runner（含 systemd 手装、面板没建实例的），
// 勾选后写 .cipanel 标记纳入面板管理。已纳管的置灰不可选，避免重复纳管。
//
// 与「添加 Runner」的区别：添加是新建 runner；导入是把既有 runner 收编进日常展示，
// 只写标记、不建实例（导入的多由 systemd 托管，再建实例会变成 both 危险态）。
import { ref, computed } from "vue";
import { message } from "ant-design-vue";
import { WarningOutlined, FolderOpenOutlined } from "@ant-design/icons-vue";
import { openNodeSelectDialog } from "@/components/fc/index";
import { scanRunners, registerRunners, type ScannedRunner } from "@/services/apis/runner";
import { t } from "@/lang/i18n";
import { ownershipHint, ownershipTag } from "@/tools/supervisor";
import SelectDirDialog from "./SelectDirDialog.vue";

const emit = defineEmits<{ (e: "imported"): void }>();

const open = ref(false);
const daemonId = ref("");
const nodeName = ref("");
const scanning = ref(false);
const submitting = ref(false);
const runners = ref<ScannedRunner[]>([]);
const selectedKeys = ref<string[]>([]);
// 要扫描的目录：留空则用 daemon 侧默认扫描根(CIP_SCAN_ROOTS)。填了就扫指定目录，
// 这样能搜任意位置的未纳管 runner，不用改 env。
const scanPath = ref("");
const dirDialog = ref<InstanceType<typeof SelectDirDialog>>();
function openDirPicker() {
  if (!daemonId.value) return message.error("请先选择节点");
  dirDialog.value?.openDialog(daemonId.value, scanPath.value.trim() || undefined);
}

// 可纳管的行 = 还没纳管、且目录完好（有 .runner）
const selectable = computed(() => runners.value.filter((r) => !r.managed && r.exists));
const managedCount = computed(() => runners.value.filter((r) => r.managed).length);

async function doScan() {
  if (!daemonId.value) return;
  scanning.value = true;
  runners.value = [];
  selectedKeys.value = [];
  try {
    const { execute, state } = scanRunners();
    const dir = scanPath.value.trim();
    await execute({
      params: { daemonId: daemonId.value },
      data: dir ? { roots: [dir] } : {}
    });
    runners.value = (state.value?.runners as ScannedRunner[]) || [];
    const errs = state.value?.errors || [];
    if (errs.length) {
      message.warning(`部分扫描根有问题：${errs.map((e) => `${e.dir}(${e.error})`).join("；")}`);
    }
  } catch (err: any) {
    message.error("扫描失败：" + (err?.message || err));
  } finally {
    scanning.value = false;
  }
}

// 外部调用：可带上当前节点，省一次选择
async function openDialog(preset?: { daemonId: string; nodeName?: string }) {
  runners.value = [];
  selectedKeys.value = [];
  if (preset?.daemonId) {
    daemonId.value = preset.daemonId;
    nodeName.value = preset.nodeName || preset.daemonId;
  } else {
    const node = await openNodeSelectDialog();
    if (!node) return;
    daemonId.value = node.uuid;
    nodeName.value = node.remarks || node.uuid;
  }
  open.value = true;
  await doScan();
}

// 换个节点重新扫
async function pickNode() {
  const node = await openNodeSelectDialog();
  if (!node) return;
  daemonId.value = node.uuid;
  nodeName.value = node.remarks || node.uuid;
  await doScan();
}

const selectAll = () => (selectedKeys.value = selectable.value.map((r) => r.dir));
const clearAll = () => (selectedKeys.value = []);

const rowSelection = computed(() => ({
  selectedRowKeys: selectedKeys.value,
  onChange: (keys: (string | number)[]) => (selectedKeys.value = keys.map(String)),
  // 已纳管 / 目录损坏的不给选
  getCheckboxProps: (record: ScannedRunner) => ({
    disabled: record.managed || !record.exists
  })
}));

async function submit() {
  if (!selectedKeys.value.length) return message.warning("请先勾选要纳管的 runner");
  const picked = runners.value.filter((r) => selectedKeys.value.includes(r.dir));
  submitting.value = true;
  try {
    const { execute, state } = registerRunners();
    await execute({
      params: { daemonId: daemonId.value },
      data: {
        items: picked.map((r) => ({ dir: r.dir, repo: r.repo, group: r.group })),
        source: "import" as const
      }
    });
    const results = state.value?.results || [];
    const ok = results.filter((r) => r.ok).length;
    const fail = results.filter((r) => !r.ok);
    // 面板顺带把这些 runner 的仓库登记进了注册表，说一声，免得用户以为哪里多了东西
    const repos = state.value?.registeredRepos || [];
    if (ok) emit("imported");
    if (fail.length) {
      message.warning(
        `纳管 ${ok} 个，失败 ${fail.length} 个：${fail.map((f) => f.error).join("；")}`
      );
    } else {
      message.success(
        repos.length
          ? t("TXT_CODE_RUNNER_IMPORT_OK_WITH_REPOS", { count: ok, repos: repos.join("、") })
          : t("TXT_CODE_RUNNER_IMPORT_OK", { count: ok })
      );
    }
    await doScan(); // 刷新，把刚纳管的置灰
  } catch (err: any) {
    message.error("纳管失败：" + (err?.message || err));
  } finally {
    submitting.value = false;
  }
}

defineExpose({ openDialog });
</script>

<template>
  <a-modal v-model:open="open" title="导入已有 Runner" :width="900" :footer="null">
    <a-space style="margin-bottom: 12px" wrap>
      <span>节点：<b>{{ nodeName }}</b></span>
      <a-button size="small" @click="pickNode">切换节点</a-button>
      <a-button size="small" :loading="scanning" @click="doScan">重新扫描</a-button>
      <a-divider type="vertical" />
      <a-button size="small" :disabled="!selectable.length" @click="selectAll">全选可纳管</a-button>
      <a-button size="small" :disabled="!selectedKeys.length" @click="clearAll">清空</a-button>
    </a-space>

    <!-- 扫描目录：留空用默认扫描根，填了就扫指定目录（可搜任意位置的未纳管 runner）-->
    <a-input-group compact style="margin-bottom: 12px; display: flex">
      <a-input
        v-model:value="scanPath"
        style="flex: 1"
        placeholder="扫描目录（留空 = 默认扫描根 CIP_SCAN_ROOTS）"
        allow-clear
        @press-enter="doScan"
      />
      <a-button style="width: 80px" @click="openDirPicker"><FolderOpenOutlined /> 浏览</a-button>
      <a-button type="primary" style="width: 80px" :loading="scanning" @click="doScan">
        扫描
      </a-button>
    </a-input-group>

    <a-alert
      type="info"
      show-icon
      style="margin-bottom: 12px"
      :message="`扫描到 ${runners.length} 个 runner，其中 ${managedCount} 个已纳管（置灰）、${selectable.length} 个可导入`"
      description="导入只写 .cipanel 标记纳入面板日常展示，不会新建面板实例、也不改动 runner 本身。"
    />

    <a-table
      :data-source="runners"
      row-key="dir"
      :loading="scanning"
      :pagination="false"
      size="small"
      :scroll="{ x: 760, y: 380 }"
      :row-selection="rowSelection"
    >
      <a-table-column key="agentName" title="Runner" :width="180">
        <template #default="{ record }">
          <div style="font-weight: 500">
            {{ record.agentName }}
            <a-tag v-if="record.managed" color="green" style="margin-left: 4px">已纳管</a-tag>
          </div>
          <div v-if="record.dirName !== record.agentName" style="font-size: 12px; opacity: 0.6">
            目录: {{ record.dirName }}
          </div>
          <div v-if="record.broken" style="font-size: 12px; color: #ff4d4f">
            <WarningOutlined /> {{ record.broken }}
          </div>
        </template>
      </a-table-column>

      <a-table-column key="repo" title="仓库" :width="180">
        <template #default="{ record }">
          <span style="font-size: 13px">{{ record.repo || "—" }}</span>
        </template>
      </a-table-column>

      <a-table-column key="ownership" :title="t('TXT_CODE_RUNNER_COL_OWNERSHIP')" :width="110">
        <template #default="{ record }">
          <a-tooltip :title="ownershipHint(record)">
            <a-tag :color="ownershipTag(record).color">{{ ownershipTag(record).label }}</a-tag>
          </a-tooltip>
        </template>
      </a-table-column>

      <a-table-column key="source" title="来源" :width="90">
        <template #default="{ record }">
          <span v-if="record.source === 'provision'">面板创建</span>
          <span v-else-if="record.source === 'import'">导入</span>
          <span v-else style="opacity: 0.45">—</span>
        </template>
      </a-table-column>

      <a-table-column key="dir" title="目录">
        <template #default="{ record }">
          <span style="font-size: 12px; opacity: 0.75">{{ record.dir }}</span>
        </template>
      </a-table-column>
    </a-table>

    <div style="margin-top: 16px; text-align: right">
      <a-space>
        <a-button @click="open = false">关闭</a-button>
        <a-button
          type="primary"
          :loading="submitting"
          :disabled="!selectedKeys.length"
          @click="submit"
        >
          导入选中（{{ selectedKeys.length }}）
        </a-button>
      </a-space>
    </div>

    <!-- 扫描目录选择器 -->
    <SelectDirDialog ref="dirDialog" @select="(p: string) => (scanPath = p)" />
  </a-modal>
</template>
