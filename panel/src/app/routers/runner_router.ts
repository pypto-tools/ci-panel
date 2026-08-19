// CI Panel 扩展：一键 provision GitHub Actions runner。转发到指定 daemon 执行。
import Router from "@koa/router";
import axios from "axios";
import { ROLE } from "../entity/user";
import permission from "../middleware/permission";
import validator from "../middleware/validator";
import RemoteRequest from "../service/remote_command";
import RemoteServiceSubsystem from "../service/remote_service";
import RepoService from "../service/repo_service";
import { parseRepoSlug } from "../entity/repo";
import { logger } from "../service/log";
import { $t } from "../i18n";
import { errMessage } from "../utils/error";
import { validateProxyArg } from "../utils/proxy";
import { collectRegisteredRepoSlugs } from "mcsmanager-common";

// 创建/导入 runner 时自动把其仓库纳管进注册表（若还没有）。不带 PAT——回退全局 token，用户之后可补填。
// 用面板给某仓库建 runner、或把它的 runner 导进来，显然是要管它，仓库就该自动登记，
// 免得列表里显示误导性的"未纳管"。返回 true 表示这次新增了注册表条目。
function ensureRepoRegistered(repoUrl: string, remark?: string): boolean {
  const note = remark || $t("TXT_CODE_REPO_AUTO_REGISTER_PROVISION");
  try {
    const slug = parseRepoSlug(String(repoUrl || ""));
    if (slug && !RepoService.has(slug)) {
      RepoService.add(slug, "", note);
      logger.info(`自动纳管仓库：${slug}（${note}）`);
      return true;
    }
  } catch (err: unknown) {
    // 自动纳管失败不该阻断建 runner / 导入
    logger.warn(`自动纳管仓库失败：${errMessage(err)}`);
  }
  return false;
}

const router = new Router({ prefix: "/runner" });

// 有界并发：对 items 并行跑 worker，最多 limit 个同时在飞，保序返回结果。
// 批量删除/启停时用，避免一次性对 daemon 和 GitHub 打满请求。
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// 把前端传来的并发数收敛到 [1, 10]，非法值回落到默认 5。
function clampConcurrency(v: unknown, def = 5): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 10) : def;
}

// [Top-level Permission]
// 开始下载最新/指定版本的 runner 安装包
router.post(
  "/download_start",
  permission({ level: ROLE.ADMIN }),
  validator({ query: { daemonId: String } }),
  async (ctx) => {
    try {
      const daemonId = String(ctx.query.daemonId);
      const remoteService = RemoteServiceSubsystem.getInstance(daemonId);
      const result = await new RemoteRequest(remoteService).request(
        "runner/download_start",
        ctx.request.body,
        30000
      );
      ctx.body = result;
    } catch (err) {
      ctx.body = err;
    }
  }
);

// [Top-level Permission]
// 查询下载进度
router.post(
  "/download_progress",
  permission({ level: ROLE.ADMIN }),
  validator({ query: { daemonId: String } }),
  async (ctx) => {
    try {
      const daemonId = String(ctx.query.daemonId);
      const remoteService = RemoteServiceSubsystem.getInstance(daemonId);
      const result = await new RemoteRequest(remoteService).request(
        "runner/download_progress",
        ctx.request.body,
        15000
      );
      ctx.body = result;
    } catch (err) {
      ctx.body = err;
    }
  }
);

// [Top-level Permission]
// 检查安装包：direct 查版本/更新；import 查路径是否存在
router.post(
  "/check",
  permission({ level: ROLE.ADMIN }),
  validator({ query: { daemonId: String } }),
  async (ctx) => {
    try {
      const daemonId = String(ctx.query.daemonId);
      const config = ctx.request.body;
      const remoteService = RemoteServiceSubsystem.getInstance(daemonId);
      const result = await new RemoteRequest(remoteService).request("runner/check", config, 20000);
      ctx.body = result;
    } catch (err) {
      ctx.body = err;
    }
  }
);

// [Top-level Permission]
// 创建 runner 时「不填也会进 .env 的东西」：面板按代理写的那几条，加上 runner 自己在注册末尾
// （config.sh → env.sh）从 daemon 进程环境快照的那几条。只读，给添加对话框做创建前提示。
router.post(
  "/default_env",
  permission({ level: ROLE.ADMIN }),
  validator({ query: { daemonId: String } }),
  async (ctx) => {
    try {
      const daemonId = String(ctx.query.daemonId);
      // 类型、长度、空白三样都在边界上查掉：这个值会被原样转发过 daemon socket，
      // 再作为环境变量预览的一部分回到页面上（校验规则与理由见 utils/proxy）。
      const checked = validateProxyArg((ctx.request.body as { proxy?: unknown })?.proxy);
      if (!checked.ok) {
        ctx.status = 400;
        ctx.body = { err: checked.err };
        return;
      }
      const remoteService = RemoteServiceSubsystem.getInstance(daemonId);
      const result = await new RemoteRequest(remoteService).request(
        "runner/default_env",
        { proxy: checked.proxy },
        15000
      );
      ctx.body = result;
    } catch (err: any) {
      // 不能把 Error 直接塞进 body：会序列化成 {} 且仍是 200，掩盖 daemon 失败
      ctx.status = 500;
      ctx.body = { err: err?.message || String(err) };
    }
  }
);

// [Top-level Permission]
// 检测代理连通性：透传给 daemon，用当前代理探测 GitHub / Google 等
router.post(
  "/proxy_check",
  permission({ level: ROLE.ADMIN }),
  validator({ query: { daemonId: String } }),
  async (ctx) => {
    try {
      const daemonId = String(ctx.query.daemonId);
      // 前端类型可被绕过，边界处校验 proxy：只接受缺省或字符串
      const body = (ctx.request.body ?? {}) as { proxy?: unknown };
      if (body.proxy !== undefined && typeof body.proxy !== "string") {
        ctx.status = 400;
        ctx.body = { err: "proxy must be a string" };
        return;
      }
      const remoteService = RemoteServiceSubsystem.getInstance(daemonId);
      const result = await new RemoteRequest(remoteService).request(
        "runner/proxy_check",
        { proxy: body.proxy },
        30000
      );
      ctx.body = result;
    } catch (err: any) {
      // 不能把 Error 直接塞进 body：会序列化成 {} 且仍是 200，掩盖 daemon 失败
      ctx.status = 500;
      ctx.body = { err: err?.message || String(err) };
    }
  }
);

// [Top-level Permission]
// 在指定节点上准备并注册一个 runner，然后创建对应实例（不自动启动）
router.post(
  "/provision",
  permission({ level: ROLE.ADMIN }),
  validator({ query: { daemonId: String } }),
  async (ctx) => {
    try {
      const daemonId = String(ctx.query.daemonId);
      const config = ctx.request.body;
      ensureRepoRegistered((config as any)?.repoUrl);
      const remoteService = RemoteServiceSubsystem.getInstance(daemonId);
      // config.sh 注册可能耗时数十秒，给足超时
      const result = await new RemoteRequest(remoteService).request(
        "runner/provision",
        config,
        180000
      );
      ctx.body = result;
    } catch (err) {
      ctx.body = err;
    }
  }
);

// [Top-level Permission]
// 批量：多组标签，每组 <基础名>-1..-N，逐个注册并建实例
router.post(
  "/provision_batch",
  permission({ level: ROLE.ADMIN }),
  validator({ query: { daemonId: String } }),
  async (ctx) => {
    try {
      const daemonId = String(ctx.query.daemonId);
      const config = ctx.request.body;
      ensureRepoRegistered((config as any)?.repoUrl);
      const remoteService = RemoteServiceSubsystem.getInstance(daemonId);
      // 批量可能几分钟，给足超时（10 分钟）
      const result = await new RemoteRequest(remoteService).request(
        "runner/provision_batch",
        config,
        600000
      );
      ctx.body = result;
    } catch (err) {
      ctx.body = err;
    }
  }
);

// [Top-level Permission]
// 批量（异步）：启动后台任务，立刻返回 batchId
router.post(
  "/batch_start",
  permission({ level: ROLE.ADMIN }),
  validator({ query: { daemonId: String } }),
  async (ctx) => {
    try {
      const daemonId = String(ctx.query.daemonId);
      ensureRepoRegistered((ctx.request.body as any)?.repoUrl);
      const remoteService = RemoteServiceSubsystem.getInstance(daemonId);
      const result = await new RemoteRequest(remoteService).request(
        "runner/batch_start",
        ctx.request.body,
        30000
      );
      ctx.body = result;
    } catch (err) {
      ctx.body = err;
    }
  }
);

// [Top-level Permission]
// 查询批量进度
router.post(
  "/batch_progress",
  permission({ level: ROLE.ADMIN }),
  validator({ query: { daemonId: String } }),
  async (ctx) => {
    try {
      const daemonId = String(ctx.query.daemonId);
      const remoteService = RemoteServiceSubsystem.getInstance(daemonId);
      const result = await new RemoteRequest(remoteService).request(
        "runner/batch_progress",
        ctx.request.body,
        15000
      );
      ctx.body = result;
    } catch (err) {
      ctx.body = err;
    }
  }
);

// [Top-level Permission]
// 重试某批的失败项
router.post(
  "/batch_retry",
  permission({ level: ROLE.ADMIN }),
  validator({ query: { daemonId: String } }),
  async (ctx) => {
    try {
      const daemonId = String(ctx.query.daemonId);
      const remoteService = RemoteServiceSubsystem.getInstance(daemonId);
      const result = await new RemoteRequest(remoteService).request(
        "runner/batch_retry",
        ctx.request.body,
        30000
      );
      ctx.body = result;
    } catch (err) {
      ctx.body = err;
    }
  }
);

// [Top-level Permission]
// 收集：扫描基目录纳入未看护的已注册 runner
router.post(
  "/collect",
  permission({ level: ROLE.ADMIN }),
  validator({ query: { daemonId: String } }),
  async (ctx) => {
    try {
      const daemonId = String(ctx.query.daemonId);
      const remoteService = RemoteServiceSubsystem.getInstance(daemonId);
      const result = await new RemoteRequest(remoteService).request(
        "runner/collect",
        ctx.request.body,
        60000
      );
      ctx.body = result;
    } catch (err) {
      ctx.body = err;
    }
  }
);

// [Top-level Permission]
// 只读：列出某仓库在基目录下已有的 label 组（供前端复用标签、锁定命名）
router.post(
  "/repo_groups",
  permission({ level: ROLE.ADMIN }),
  validator({ query: { daemonId: String } }),
  async (ctx) => {
    try {
      const daemonId = String(ctx.query.daemonId);
      const remoteService = RemoteServiceSubsystem.getInstance(daemonId);
      const result = await new RemoteRequest(remoteService).request(
        "runner/repo_groups",
        ctx.request.body,
        30000
      );
      ctx.body = result;
    } catch (err) {
      ctx.body = err;
    }
  }
);

// [Top-level Permission]
// 扫描节点磁盘上真实存在的 runner（只读，不建实例）
router.post(
  "/scan",
  permission({ level: ROLE.ADMIN }),
  validator({ query: { daemonId: String } }),
  async (ctx) => {
    try {
      const daemonId = String(ctx.query.daemonId);
      const remoteService = RemoteServiceSubsystem.getInstance(daemonId);
      const result = await new RemoteRequest(remoteService).request(
        "runner/scan",
        ctx.request.body,
        30000
      );
      ctx.body = result;
    } catch (err) {
      ctx.body = err;
    }
  }
);

// [Top-level Permission]
// 纳管：给选中的 runner 目录写 .cipanel（只标记，不建实例）
router.post(
  "/register",
  permission({ level: ROLE.ADMIN }),
  validator({ query: { daemonId: String } }),
  async (ctx) => {
    try {
      const daemonId = String(ctx.query.daemonId);
      const remoteService = RemoteServiceSubsystem.getInstance(daemonId);
      const result = await new RemoteRequest(remoteService).request(
        "runner/register",
        ctx.request.body,
        30000
      );
      // 导入即纳管其仓库，和 provision 路径一致。用 daemon 回传的 repo 而非请求体里的：
      // 那是 daemon 从 .runner 读出来的，与之后 managed_list 归堆用的 slug 同源，
      // 否则注册表的 key 可能对不上，仓库列表里照样显示"未纳管"。
      //
      // 提取字段的活交给 common 里的 collectRegisteredRepoSlugs：这里原本是一句不受检查的
      // `result as { results?: RegisterRunnerResult[] }`，daemon 改字段名编译期没有任何动静。
      // 现在那段窄化和协议声明住在同一个文件里，并且有测试盯着。
      const registeredRepos = collectRegisteredRepoSlugs(result).filter((slug) =>
        ensureRepoRegistered(slug, $t("TXT_CODE_REPO_AUTO_REGISTER_IMPORT"))
      );
      ctx.body = { ...(result as object), registeredRepos };
    } catch (err) {
      ctx.body = err;
    }
  }
);

// [Top-level Permission]
// 取消纳管：删 .cipanel（不动 runner 本身）
router.post(
  "/unregister",
  permission({ level: ROLE.ADMIN }),
  validator({ query: { daemonId: String } }),
  async (ctx) => {
    try {
      const daemonId = String(ctx.query.daemonId);
      const remoteService = RemoteServiceSubsystem.getInstance(daemonId);
      const result = await new RemoteRequest(remoteService).request(
        "runner/unregister",
        ctx.request.body,
        30000
      );
      ctx.body = result;
    } catch (err) {
      ctx.body = err;
    }
  }
);

// 取仓库的 GitHub「删除 token」：手输优先，留空则用仓库 PAT 自动取；都没有返回空串
// （空串时 daemon 会跳过 GitHub 注销并回报警告，不阻断本地删除）。删除 token 仓库级、
// 一小时内可复用，所以批量删除整批共用一个。
async function resolveRemoveToken(repo: string, manual?: string): Promise<string> {
  const token = String(manual || "").trim();
  if (token) return token;
  if (!repo) return "";
  const pat = RepoService.tokenOf(repo);
  if (!pat) return "";
  try {
    const { data } = await axios.post(
      `https://api.github.com/repos/${repo}/actions/runners/remove-token`,
      {},
      {
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          Authorization: `Bearer ${pat}`,
          "User-Agent": "ci-panel"
        },
        proxy: false,
        timeout: 15000
      }
    );
    return data?.token || "";
  } catch {
    return "";
  }
}

// [Top-level Permission]
// 彻底删除一个 runner。先取 GitHub「删除 token」交给 daemon 走 config.sh remove 注销；
// 取不到 token 不阻断，daemon 会跳过 GitHub 注销并回报警告。
router.post(
  "/delete",
  permission({ level: ROLE.ADMIN }),
  validator({ query: { daemonId: String } }),
  async (ctx) => {
    try {
      const daemonId = String(ctx.query.daemonId);
      const body = (ctx.request.body || {}) as {
        dir?: string;
        repo?: string;
        force?: boolean;
        removeToken?: string;
      };
      const removeToken = await resolveRemoveToken(String(body.repo || ""), body.removeToken);

      const remoteService = RemoteServiceSubsystem.getInstance(daemonId);
      const result = await new RemoteRequest(remoteService).request(
        "runner/delete",
        { dir: body.dir, removeToken, force: Boolean(body.force) },
        // daemon 侧单次删除的预算是逐段叠加的：停 systemd 最长等 DELETE_SETTLE_MS(60s)，再
        // config.sh 注销、rm -rf。60 秒在这里恰好卡在第一段的边界上——「等了 60 秒还没停」
        // 这个结论本身就要 60 秒才得出，panel 先超时的话它永远送不到浏览器。取 600s 与
        // runner/provision_batch 及前端的 deleteRunner 对齐：客户端不能比服务端先放弃。
        600000
      );
      ctx.body = result;
    } catch (err) {
      ctx.body = err;
    }
  }
);

// [Top-level Permission]
// 批量删除一个仓库（在某节点上）的全部 runner。整批共用一个删除 token；逐个删，互不影响，
// 汇总每个的结果（含正在跑 job 而被拦下的）。
router.post(
  "/delete_batch",
  permission({ level: ROLE.ADMIN }),
  validator({ query: { daemonId: String } }),
  async (ctx) => {
    try {
      const daemonId = String(ctx.query.daemonId);
      const body = (ctx.request.body || {}) as {
        repo?: string;
        dirs?: string[];
        force?: boolean;
        removeToken?: string;
        concurrency?: number;
      };
      const dirs = Array.isArray(body.dirs) ? body.dirs.map((d) => String(d)) : [];
      if (dirs.length === 0) {
        ctx.body = { results: [] };
        return;
      }
      const removeToken = await resolveRemoveToken(String(body.repo || ""), body.removeToken);
      const remoteService = RemoteServiceSubsystem.getInstance(daemonId);

      // 每个删除互不影响，有界并发跑；removeToken 已在池外解析一次共用，并行安全。
      const results = await mapWithConcurrency(
        dirs,
        clampConcurrency(body.concurrency),
        async (dir) => {
          try {
            const r = await new RemoteRequest(remoteService).request(
              "runner/delete",
              { dir, removeToken, force: Boolean(body.force) },
              // 同上，且这里是每项各自的预算，不是整批的
              600000
            );
            return { dir, ...r };
          } catch (err: any) {
            return { dir, ok: false, error: err?.message || String(err) };
          }
        }
      );
      ctx.body = { results };
    } catch (err) {
      ctx.body = err;
    }
  }
);

// [Top-level Permission]
// 基目录选择器：列目录 / 新建目录（daemon 侧限扫描根内）
for (const op of ["list_dirs", "mkdir"] as const) {
  router.post(
    `/${op}`,
    permission({ level: ROLE.ADMIN }),
    validator({ query: { daemonId: String } }),
    async (ctx) => {
      try {
        const daemonId = String(ctx.query.daemonId);
        const remoteService = RemoteServiceSubsystem.getInstance(daemonId);
        ctx.body = await new RemoteRequest(remoteService).request(
          `runner/${op}`,
          ctx.request.body,
          15000
        );
      } catch (err) {
        ctx.body = err;
      }
    }
  );
}

// [Top-level Permission]
// 探单个 runner 的实时状态（详情页用）
router.post(
  "/state",
  permission({ level: ROLE.ADMIN }),
  validator({ query: { daemonId: String } }),
  async (ctx) => {
    try {
      const daemonId = String(ctx.query.daemonId);
      const remoteService = RemoteServiceSubsystem.getInstance(daemonId);
      const result = await new RemoteRequest(remoteService).request(
        "runner/state",
        ctx.request.body,
        30000
      );
      ctx.body = result;
    } catch (err) {
      ctx.body = err;
    }
  }
);

// [Top-level Permission]
// 读 runner 的 _diag 运行日志（看控制台，只读）
router.post(
  "/diag_logs",
  permission({ level: ROLE.ADMIN }),
  validator({ query: { daemonId: String } }),
  async (ctx) => {
    try {
      const daemonId = String(ctx.query.daemonId);
      const remoteService = RemoteServiceSubsystem.getInstance(daemonId);
      const result = await new RemoteRequest(remoteService).request(
        "runner/diag_logs",
        ctx.request.body,
        30000
      );
      ctx.body = result;
    } catch (err) {
      ctx.body = err;
    }
  }
);

// [Top-level Permission]
// 读某 runner 当前托管的环境变量（override.conf）
router.post(
  "/env_get",
  permission({ level: ROLE.ADMIN }),
  validator({ query: { daemonId: String } }),
  async (ctx) => {
    try {
      const daemonId = String(ctx.query.daemonId);
      const remoteService = RemoteServiceSubsystem.getInstance(daemonId);
      const result = await new RemoteRequest(remoteService).request(
        "runner/env_get",
        ctx.request.body,
        30000
      );
      ctx.body = result;
    } catch (err) {
      ctx.body = err;
    }
  }
);

// [Top-level Permission]
// 设置某 runner 的环境变量（写 systemd drop-in + daemon-reload；不重启）
router.post(
  "/env_set",
  permission({ level: ROLE.ADMIN }),
  validator({ query: { daemonId: String } }),
  async (ctx) => {
    try {
      const daemonId = String(ctx.query.daemonId);
      const remoteService = RemoteServiceSubsystem.getInstance(daemonId);
      const result = await new RemoteRequest(remoteService).request(
        "runner/env_set",
        ctx.request.body,
        90000
      );
      ctx.body = result;
    } catch (err) {
      ctx.body = err;
    }
  }
);

// [Top-level Permission]
// 批量设置多个 runner 的环境变量。panel 侧有界并发扇出到单个 env_set；默认 merge（保留各自
// 已有变量，只增改 upsert、删除 remove），避免把每台不同的 DEVICE_ID 抹平。逐个 catch 汇总结果。
router.post(
  "/env_set_batch",
  permission({ level: ROLE.ADMIN }),
  validator({ query: { daemonId: String } }),
  async (ctx) => {
    try {
      const daemonId = String(ctx.query.daemonId);
      const body = (ctx.request.body || {}) as {
        dirs?: string[];
        target?: "override" | "dotenv";
        upsert?: Array<{ key: string; value: string }>;
        remove?: string[];
        replace?: boolean;
        concurrency?: number;
      };
      const dirs = (Array.isArray(body.dirs) ? body.dirs : [])
        .map((d) => String(d))
        .filter(Boolean);
      const remoteService = RemoteServiceSubsystem.getInstance(daemonId);

      const results = await mapWithConcurrency(
        dirs,
        clampConcurrency(body.concurrency),
        async (dir) => {
          try {
            const r = await new RemoteRequest(remoteService).request(
              "runner/env_set",
              {
                dir,
                target: body.target,
                upsert: body.upsert,
                remove: body.remove,
                replace: body.replace
              },
              90000
            );
            // ...r 在前：RunnerEnvResult 自带规范化过的 dir，展开在后会覆盖请求用的 dir，
            // 前端靠 dir 回连结果（失败项名称、重启目标），键必须保持与请求一致。
            return { ...r, dir, ok: true };
          } catch (err: any) {
            return { dir, ok: false, error: err?.message || String(err) };
          }
        }
      );
      ctx.body = { results };
    } catch (err: unknown) {
      // 保持批量接口的 { results } 契约：前端读 results，不能静默返回空对象而误报成功
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(msg);
      ctx.body = { results: [], error: msg };
    }
  }
);

// [Top-level Permission]
// 启停 systemd 托管的 runner
router.post(
  "/service_control",
  permission({ level: ROLE.ADMIN }),
  validator({ query: { daemonId: String } }),
  async (ctx) => {
    try {
      const daemonId = String(ctx.query.daemonId);
      const remoteService = RemoteServiceSubsystem.getInstance(daemonId);
      const result = await new RemoteRequest(remoteService).request(
        "runner/service_control",
        ctx.request.body,
        90000
      );
      ctx.body = result;
    } catch (err) {
      ctx.body = err;
    }
  }
);

// [Top-level Permission]
// 批量启停/重启 runner。每个独立、无共享锁，panel 侧有界并发扇出到单个 service_control；
// 没有目录的项直接跳过。逐个 catch 汇总结果，互不影响。
router.post(
  "/service_control_batch",
  permission({ level: ROLE.ADMIN }),
  validator({ query: { daemonId: String } }),
  async (ctx) => {
    try {
      const daemonId = String(ctx.query.daemonId);
      const body = (ctx.request.body || {}) as {
        items?: Array<{ dir?: string; service?: string }>;
        action?: string;
        concurrency?: number;
      };
      const action = String(body.action || "");
      if (!["start", "stop", "restart"].includes(action)) {
        ctx.body = { results: [], error: "invalid action" };
        return;
      }
      // 按目录过滤，不按单元名：单元名是 systemd 的实现细节，别的托管方式没有它却照样能启停。
      // 按 service 过滤会把那些项静默丢掉 —— 用户点了批量启动，既没反应也没有错误。
      const items = (Array.isArray(body.items) ? body.items : []).filter((it) => it && it.dir);
      const remoteService = RemoteServiceSubsystem.getInstance(daemonId);

      const results = await mapWithConcurrency(
        items,
        clampConcurrency(body.concurrency),
        async (it) => {
          try {
            const r = await new RemoteRequest(remoteService).request(
              "runner/service_control",
              // 两个字段都发：dir 是新 daemon 的寻址依据，service 留给还没升级的节点。
              // 只翻外层过滤器而不翻这里的话，放行的项会带着一个空单元名过去，daemon 在
              // 「目录必须是绝对路径」那一句抛错，逐项失败且失败原因看起来毫无道理。
              { dir: it.dir, service: it.service, action },
              90000
            );
            return { dir: it.dir, service: it.service, ok: true, ...r };
          } catch (err: any) {
            return {
              dir: it.dir,
              service: it.service,
              ok: false,
              error: err?.message || String(err)
            };
          }
        }
      );
      ctx.body = { results };
    } catch (err: unknown) {
      // 保持批量接口的 { results } 契约：前端读 results，不能静默返回空对象而误报成功
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(msg);
      ctx.body = { results: [], error: msg };
    }
  }
);

export default router;
