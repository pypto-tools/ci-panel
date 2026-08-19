// CI Panel 扩展路由：一键 provision GitHub Actions runner。
import logger from "../service/log";
import * as protocol from "../service/protocol";
import { routerApp } from "../service/router";
import {
  checkProxyConnectivity,
  previewDefaultDotEnv,
  checkRunnerPackage,
  collectRunners,
  listRepoGroups,
  getRunnerBatchProgress,
  getRunnerDownloadProgress,
  provisionRunner,
  provisionRunnerBatch,
  retryFailedBatch,
  startRunnerBatch,
  startRunnerDownload
} from "../service/runner_provision";
import {
  deleteRunner,
  dirOfSystemdUnit,
  listDirs,
  makeDir,
  registerRunners,
  scanManagedRunners,
  scanOneRunner,
  scanRunners,
  unregisterRunner
} from "../service/runner_scan";
import { controlRunner, isSupervisorAction } from "../service/supervisor/resolve";
import { $t } from "../i18n";
import { readRunnerDiag } from "../service/runner_logs";
import { readRunnerEnv, writeRunnerEnv, type EnvTarget } from "../service/runner_env";

// 扫描磁盘上真实存在的 runner：读 .runner 拿仓库归属，读 .service 查 systemd 状态。
// 只读，不建实例——跟 runner/collect 的区别就在这里。
routerApp.on("runner/scan", async (ctx, data) => {
  try {
    const roots = Array.isArray(data?.roots) ? data.roots.map((v: any) => String(v)) : undefined;
    protocol.msg(ctx, "runner/scan", await scanRunners(roots));
  } catch (err: any) {
    protocol.error(ctx, "runner/scan", { err: err?.message || String(err) });
  }
});

// 只列出已纳管（有 .cipanel）的 runner，供日常展示。membership 以 marker 为准，
// 不像 runner/scan 那样把磁盘上所有 .runner 都算进来。
routerApp.on("runner/managed_list", async (ctx) => {
  try {
    protocol.msg(ctx, "runner/managed_list", await scanManagedRunners());
  } catch (err: any) {
    protocol.error(ctx, "runner/managed_list", { err: err?.message || String(err) });
  }
});

// 纳管：给选中的目录写 .cipanel（只标记，不建实例）。source 缺省为 import
routerApp.on("runner/register", (ctx, data) => {
  try {
    const items = Array.isArray(data?.items) ? data.items : [];
    const source = data?.source === "provision" ? "provision" : "import";
    protocol.msg(ctx, "runner/register", { results: registerRunners(items, source) });
  } catch (err: any) {
    protocol.error(ctx, "runner/register", { err: err?.message || String(err) });
  }
});

// 彻底删除 runner：停+卸 systemd、GitHub 注销、清面板侧、删目录
routerApp.on("runner/delete", async (ctx, data) => {
  try {
    const result = await deleteRunner(String(data?.dir || ""), {
      removeToken: data?.removeToken ? String(data.removeToken) : undefined,
      proxy: data?.proxy ? String(data.proxy) : undefined,
      force: Boolean(data?.force)
    });
    protocol.msg(ctx, "runner/delete", result);
  } catch (err: any) {
    protocol.error(ctx, "runner/delete", { err: err?.message || String(err) });
  }
});

// 取消纳管：删 .cipanel（不动 runner 本身）
routerApp.on("runner/unregister", (ctx, data) => {
  try {
    protocol.msg(ctx, "runner/unregister", unregisterRunner(String(data?.dir || "")));
  } catch (err: any) {
    protocol.error(ctx, "runner/unregister", { err: err?.message || String(err) });
  }
});

// 读 runner 的 _diag 运行日志（只读，免 sudo）——给 systemd runner 也能在网页看控制台。
// 支持增量跟随：带 offset 回来只回读新增段。
routerApp.on("runner/diag_logs", (ctx, data) => {
  try {
    const result = readRunnerDiag(String(data?.dir || ""), {
      file: data?.file,
      lines: data?.lines,
      offset: data?.offset
    });
    protocol.msg(ctx, "runner/diag_logs", result);
  } catch (err: any) {
    protocol.error(ctx, "runner/diag_logs", { err: err?.message || String(err) });
  }
});

// 基目录选择器：列出某路径下的子目录（限扫描根内）
routerApp.on("runner/list_dirs", (ctx, data) => {
  try {
    protocol.msg(ctx, "runner/list_dirs", listDirs(data?.path ? String(data.path) : undefined));
  } catch (err: any) {
    protocol.error(ctx, "runner/list_dirs", { err: err?.message || String(err) });
  }
});

// 基目录选择器：新建目录（限扫描根内）
routerApp.on("runner/mkdir", (ctx, data) => {
  try {
    protocol.msg(ctx, "runner/mkdir", makeDir(String(data?.path || ""), String(data?.name || "")));
  } catch (err: any) {
    protocol.error(ctx, "runner/mkdir", { err: err?.message || String(err) });
  }
});

// 探单个 runner 的实时状态（详情页基本信息 + 定时刷新用）
routerApp.on("runner/state", async (ctx, data) => {
  try {
    protocol.msg(ctx, "runner/state", { runner: await scanOneRunner(String(data?.dir || "")) });
  } catch (err: any) {
    protocol.error(ctx, "runner/state", { err: err?.message || String(err) });
  }
});

// 启停一个 runner。按**目录**寻址：单元名只有 systemd 后端才有，而托管方式不止一种。
// 授权依据是目录里的 .cipanel 纳管凭据（此前是「这串字符长得像单元名」）。
// 返回值带 settled：false 表示托管方已受理但还没跑到位（停不掉的单元很常见），
// 不是失败——由前端的状态轮询继续收敛。
routerApp.on("runner/service_control", async (ctx, data) => {
  try {
    // 收窄，不断言：`as SupervisorAction` 会让类型系统以为这个边界证明过了，而请求体里
    // 那串字符从来没被证明过任何事（controlRunner 里还有一道，两道都要）。
    const action = String(data?.action || "");
    if (!isSupervisorAction(action))
      throw new Error($t("TXT_CODE_RUNNER_ACTION_UNSUPPORTED", { action }));
    // dir 优先。只发得出 service 的是还没升级的 panel：反查出目录，让两条路最终汇到同一个
    // 入口，别在这里留一条绕过 marker 授权的旁路。
    const dirRaw = String(data?.dir || "");
    const service = String(data?.service || "");
    // 两个都空要在这里挡掉：落到 dirOfSystemdUnit("") 会报「非法的服务名: 」，那句话和真实
    // 病因（请求根本没说要操作哪个 runner）毫无关系。
    if (!dirRaw && !service) throw new Error($t("TXT_CODE_RUNNER_TARGET_REQUIRED"));
    const dir = dirRaw || dirOfSystemdUnit(service);
    protocol.msg(ctx, "runner/service_control", await controlRunner(dir, action));
  } catch (err: any) {
    protocol.error(ctx, "runner/service_control", { err: err?.message || String(err) });
  }
});

// 读 runner 两个目标的环境变量（override.conf 与 .env）——均只读、免 sudo
routerApp.on("runner/env_get", (ctx, data) => {
  try {
    protocol.msg(ctx, "runner/env_get", readRunnerEnv(String(data?.dir || "")));
  } catch (err: any) {
    protocol.error(ctx, "runner/env_get", { err: err?.message || String(err) });
  }
});

// 设置 runner 某目标的环境变量。target=override 写 systemd drop-in（走特权助手 + daemon-reload）；
// target=dotenv 直接写 <dir>/.env。两者都不重启；生效由面板另走 service_control 的 restart。
routerApp.on("runner/env_set", async (ctx, data) => {
  try {
    const target: EnvTarget = data?.target === "dotenv" ? "dotenv" : "override";
    const result = await writeRunnerEnv(String(data?.dir || ""), target, {
      upsert: data?.upsert,
      remove: data?.remove,
      replace: Boolean(data?.replace)
    });
    protocol.msg(ctx, "runner/env_set", result);
  } catch (err: any) {
    protocol.error(ctx, "runner/env_set", { err: err?.message || String(err) });
  }
});

// 开始下载最新/指定版本的 runner 安装包，返回 downloadId
routerApp.on("runner/download_start", async (ctx, data) => {
  try {
    const result = await startRunnerDownload({
      version: data?.version,
      proxy: data?.proxy,
      force: data?.force
    });
    protocol.msg(ctx, "runner/download_start", result);
  } catch (err: any) {
    protocol.error(ctx, "runner/download_start", { err: err?.message || String(err) });
  }
});

// 查询下载进度 + 速度
routerApp.on("runner/download_progress", (ctx, data) => {
  try {
    const result = getRunnerDownloadProgress(data?.downloadId);
    protocol.msg(ctx, "runner/download_progress", result);
  } catch (err: any) {
    protocol.error(ctx, "runner/download_progress", { err: err?.message || String(err) });
  }
});

// 检查：direct 查内置包版本/更新；import 查压缩包路径是否存在
routerApp.on("runner/check", async (ctx, data) => {
  try {
    const result = await checkRunnerPackage({
      mode: data?.mode,
      packagePath: data?.packagePath,
      proxy: data?.proxy
    });
    protocol.msg(ctx, "runner/check", result);
  } catch (err: any) {
    protocol.error(ctx, "runner/check", { err: err?.message || String(err) });
  }
});

// 检测代理连通性：用当前代理探测 GitHub / Google 等目标
routerApp.on("runner/proxy_check", async (ctx, data) => {
  try {
    const proxy = data?.proxy;
    // panel↔daemon 也是不可信边界，再校验一次 proxy 类型
    if (proxy !== undefined && typeof proxy !== "string") {
      throw new Error("proxy must be a string");
    }
    const result = await checkProxyConnectivity(proxy);
    protocol.msg(ctx, "runner/proxy_check", result);
  } catch (err: any) {
    protocol.error(ctx, "runner/proxy_check", { err: err?.message || String(err) });
  }
});

// 「不填也会进 .env 的东西」：面板按代理写的那几条 + runner 注册时从 daemon 进程环境快照的那几条。
// 只读 process.env，无副作用。
routerApp.on("runner/default_env", (ctx, data) => {
  try {
    const proxy = data?.proxy;
    if (proxy !== undefined && typeof proxy !== "string") {
      throw new Error("proxy must be a string");
    }
    protocol.msg(ctx, "runner/default_env", previewDefaultDotEnv(proxy));
  } catch (err: any) {
    protocol.error(ctx, "runner/default_env", { err: err?.message || String(err) });
  }
});

routerApp.on("runner/provision", async (ctx, data) => {
  try {
    const result = await provisionRunner({
      repoUrl: data?.repoUrl,
      token: data?.token,
      name: data?.name,
      labels: data?.labels,
      targetDir: data?.targetDir,
      proxy: data?.proxy
    });
    protocol.msg(ctx, "runner/provision", result);
  } catch (err: any) {
    logger.error(`[runner-provision] 失败: ${err?.message}`);
    protocol.error(ctx, "runner/provision", { err: err?.message || String(err) });
  }
});

// 批量：多组标签，每组 <基础名>-1..-N（同步，一次性返回全部结果）
routerApp.on("runner/provision_batch", async (ctx, data) => {
  try {
    const result = await provisionRunnerBatch({
      repoUrl: data?.repoUrl,
      token: data?.token,
      proxy: data?.proxy,
      baseDir: data?.baseDir,
      groups: data?.groups,
      packagePath: data?.packagePath
    });
    protocol.msg(ctx, "runner/provision_batch", result);
  } catch (err: any) {
    logger.error(`[runner-provision] 批量失败: ${err?.message}`);
    protocol.error(ctx, "runner/provision_batch", { err: err?.message || String(err) });
  }
});

// 批量（异步）：启动后台任务，立刻返回 batchId + 初始清单
routerApp.on("runner/batch_start", (ctx, data) => {
  try {
    // concurrency 在这里就得挡住非数字：clampConcurrency 用的是 Number(n) || 0，会把 "4" 收成 4、
    // 把 true 收成 1，于是一个明显传错的类型会被悄悄当成一个合法并发度跑起来。panel↔daemon 同样
    // 是不可信边界（与本文件 proxy_check 的处理一致）。
    if (data?.concurrency !== undefined && !Number.isFinite(data.concurrency)) {
      throw new Error("concurrency must be a finite number");
    }
    const result = startRunnerBatch({
      repoUrl: data?.repoUrl,
      token: data?.token,
      proxy: data?.proxy,
      baseDir: data?.baseDir,
      // groups 里带着每组的初始环境变量（env.override / env.dotenv），由 startRunnerBatch
      // 在展开成 spec 时逐个校验并展开占位符
      groups: data?.groups,
      packagePath: data?.packagePath,
      // 面板上「并发数」那个框此前一直没生效：这里漏了透传，clampConcurrency 拿到 undefined
      // 就永远回落到默认 3。
      concurrency: data?.concurrency
    });
    protocol.msg(ctx, "runner/batch_start", result);
  } catch (err: any) {
    logger.error(`[runner-provision] 批量启动失败: ${err?.message}`);
    protocol.error(ctx, "runner/batch_start", { err: err?.message || String(err) });
  }
});

// 查询批量进度（每个 runner 的状态 + 当前步骤）
routerApp.on("runner/batch_progress", (ctx, data) => {
  try {
    const result = getRunnerBatchProgress(data?.batchId);
    protocol.msg(ctx, "runner/batch_progress", result);
  } catch (err: any) {
    protocol.error(ctx, "runner/batch_progress", { err: err?.message || String(err) });
  }
});

// 重试某批的失败项（用新 token 重跑，复用同一 batchId 的进度轮询）
routerApp.on("runner/batch_retry", (ctx, data) => {
  try {
    const result = retryFailedBatch(data?.batchId, data?.token, data?.proxy);
    protocol.msg(ctx, "runner/batch_retry", result);
  } catch (err: any) {
    protocol.error(ctx, "runner/batch_retry", { err: err?.message || String(err) });
  }
});

// 收集：扫描基目录，把已注册但未建实例的 runner 纳入看护
routerApp.on("runner/collect", (ctx, data) => {
  try {
    const result = collectRunners(data?.baseDir);
    protocol.msg(ctx, "runner/collect", result);
  } catch (err: any) {
    protocol.error(ctx, "runner/collect", { err: err?.message || String(err) });
  }
});

// 只读：列出某仓库在基目录下已有的 label 组，供前端复用标签、锁定命名
routerApp.on("runner/repo_groups", (ctx, data) => {
  try {
    const result = { groups: listRepoGroups(data?.baseDir, data?.repoUrl) };
    protocol.msg(ctx, "runner/repo_groups", result);
  } catch (err: any) {
    protocol.error(ctx, "runner/repo_groups", { err: err?.message || String(err) });
  }
});
