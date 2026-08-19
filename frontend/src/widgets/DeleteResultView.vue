<script setup lang="ts">
// 删除结果分步展示（自研补充）：把 runner 删除的每一步（从托管方收回 / GitHub 注销 / 清面板 / 删目录）
// 以「✓ 成功 / ✗ 失败 / ⊘ 跳过」清单呈现。失败/跳过项给出原因与「可手动执行的命令」，
// 让用户知道卡在哪一步、能自己接着做。单个删除传 1 项，批量删除传多项。
import { message } from "ant-design-vue";
import {
  CheckCircleFilled,
  CloseCircleFilled,
  MinusCircleFilled,
  CopyOutlined
} from "@ant-design/icons-vue";
import type { DeleteRunnerResult } from "@/services/apis/runner";

defineProps<{
  // 批量时每项还可能带 error（整个 runner 请求就失败了，没有 steps）
  results: Array<DeleteRunnerResult & { error?: string }>;
}>();

function iconOf(status: string) {
  if (status === "ok") return CheckCircleFilled;
  if (status === "failed") return CloseCircleFilled;
  return MinusCircleFilled;
}
function colorOf(status: string) {
  if (status === "ok") return "#52c41a";
  if (status === "failed") return "#ff4d4f";
  return "#bfbfbf";
}
async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    message.success("已复制命令");
  } catch {
    message.error("复制失败，请手动选择");
  }
}
function dirName(dir: string) {
  return dir.split("/").filter(Boolean).pop() || dir;
}
</script>

<template>
  <div class="del-result">
    <div v-for="r in results" :key="r.dir" class="runner-block">
      <div class="runner-head">
        <component :is="r.ok ? CheckCircleFilled : CloseCircleFilled" :style="{ color: r.ok ? '#52c41a' : '#ff4d4f' }" />
        <span class="name">{{ dirName(r.dir) }}</span>
        <span class="dir">{{ r.dir }}</span>
      </div>

      <!-- 整个请求就失败了（连不上节点等），没有 steps -->
      <div v-if="r.error" class="step-line failed">
        <CloseCircleFilled :style="{ color: '#ff4d4f' }" />
        <span>请求失败：{{ r.error }}</span>
      </div>

      <div v-for="s in r.steps || []" :key="s.key" class="step-line" :class="s.status">
        <component :is="iconOf(s.status)" :style="{ color: colorOf(s.status) }" />
        <span class="label">{{ s.label }}</span>
        <span class="tag">{{ s.status === "ok" ? "成功" : s.status === "skipped" ? "跳过" : "失败" }}</span>
        <div v-if="s.detail" class="detail">{{ s.detail }}</div>
        <div v-if="s.hint" class="hint">
          <span>手动执行：</span>
          <code>{{ s.hint }}</code>
          <a-button type="link" size="small" @click="copy(s.hint)"><CopyOutlined /> 复制</a-button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.del-result {
  max-height: 60vh;
  overflow: auto;
}
.runner-block + .runner-block {
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px dashed var(--color-gray-4, #eee);
}
.runner-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.runner-head .name {
  font-weight: 600;
}
.runner-head .dir {
  font-size: 12px;
  opacity: 0.55;
  word-break: break-all;
}
.step-line {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 8px;
  padding: 5px 0;
}
.step-line .label {
  font-size: 13px;
}
.step-line .tag {
  font-size: 12px;
  opacity: 0.6;
}
.step-line .detail {
  grid-column: 2 / 4;
  font-size: 12px;
  color: #ff7a45;
  word-break: break-all;
}
.step-line.skipped .detail {
  color: #999;
}
.step-line .hint {
  grid-column: 2 / 4;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 12px;
  margin-top: 2px;
}
.step-line .hint code {
  background: rgba(0, 0, 0, 0.06);
  padding: 2px 6px;
  border-radius: 4px;
  word-break: break-all;
}
</style>
