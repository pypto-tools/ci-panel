// 仓库注册表 + runner 归属（自研补充，对应 panel 的 /api/repo 路由）
//
// runner 列表不是面板存的，而是每次去各节点扫磁盘得到的：
// runner 目录下的 .runner 决定它属于哪个仓库，.service 决定它由哪个 systemd 单元托管。
import { useDefineApi } from "@/stores/useDefineApi";

// runner 引用的形状来自 common，与 panel 同一份声明（common/src/runner_protocol.ts）。
// 之前这里手写了一份镜像，而本文件不引 common —— panel 改字段时编译器罩不到它，
// 孤儿/冲突统计会静默归零、状态文案会哑掉。只用 import type：编译期擦除，不进浏览器 bundle。
import type { RepoRunnerRef } from "mcsmanager-common";

export type RepoRunner = RepoRunnerRef;

export interface RepoSummary {
  slug: string;
  url: string;
  remark?: string;
  createdAt?: number;
  hasToken?: boolean;
  runners: RepoRunner[];
  total: number;
  running: number;
  busy: number; // 正在跑 job 的 runner 数
  orphaned: number; // 没人托管，永远接不到任务
  conflicted: number; // systemd 和面板抢同一个目录
}

export interface RepoListResult {
  repos: RepoSummary[];
  unregistered: RepoSummary[]; // 磁盘上有 runner，但注册表里没有
  untaggedRunners: RepoRunner[];
  failedNodes: Array<{ daemonId: string; nodeName: string; error: string }>;
}

export const repoList = useDefineApi<any, RepoListResult>({
  url: "/api/repo/list",
  method: "GET"
});

export const repoAdd = useDefineApi<{ data: { url: string; remark?: string } }, RepoSummary>({
  url: "/api/repo/add",
  method: "POST"
});

export const repoDelete = useDefineApi<{ params: { slug: string } }, boolean>({
  url: "/api/repo/delete",
  method: "DELETE"
});

export const repoSetToken = useDefineApi<{ data: { slug: string; token: string } }, boolean>({
  url: "/api/repo/token",
  method: "POST"
});
