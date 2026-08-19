// 把整个套件关进一个临时沙箱。没有这一段,跑一次测试就会脏掉开发者的工作区:
// service/log.ts 在模块加载时就重命名 logs/current.log 并挂一个 cwd 相对的 log4js appender,
// system_instance.ts 则直接 fs.mkdirsSync('data/InstanceData')。
//
// 顺序很重要:CIP_SCAN_ROOTS 与 CIP_RUNNER_SVC_HELPER 都必须在任何 daemon 模块被 import
// 之前设好 —— runner_scan.ts 与 runner_provision.ts 都在模块作用域就把它们读走(前者定扫描根,
// 后者定助手路径),晚一步就来不及了。setupFiles 整体先于 spec 的 import 求值,所以放在本文件里
// 就够;但值若派生自 sandbox,就必须晚于下面那行 mkdtempSync。
import fs from "fs-extra";
import os from "os";
import path from "path";

// 仓库位置由 vitest.config.mts 经 env 注入,不能用 process.cwd() 推:本文件对每个测试文件
// 都会重跑一遍,而下面的 chdir 会把 cwd 换成沙箱 —— 第二个文件起就推不回来了。
// 也不用 import.meta.url:tsconfig 的 module 是 commonjs,type-check 会直接拒绝它。
export const DAEMON_ROOT = process.env.CIP_TEST_DAEMON_ROOT || process.cwd();
export const REPO_ROOT = path.resolve(DAEMON_ROOT, "..");

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "ci-panel-daemon-test-"));
fs.mkdirsSync(path.join(sandbox, "logs"));
fs.mkdirsSync(path.join(sandbox, "data"));
process.chdir(sandbox);

// 扫描根固定成沙箱下的一个目录。本文件对每个测试文件跑一遍,每遍都是全新的沙箱和全新的
// 模块注册表 —— 所以每个 spec 文件拿到的是自己的 runnerRoots,文件之间不共享,也不会互相干扰。
// (threads: false 只保证同一个进程,不等于同一份模块状态。)
const scanRoot = path.join(sandbox, "runners");
process.env.CIP_SCAN_ROOTS = scanRoot;
fs.mkdirsSync(scanRoot);

// 特权助手指向一个不存在的路径,理由和 CIP_SCAN_ROOTS 是同一条:runner_provision.ts 在模块作用域
// 就把它读走了(`export const RUNNER_SVC_HELPER = process.env.CIP_RUNNER_SVC_HELPER || "/usr/local/…"`),
// 晚一步就来不及。值与 scripts/dev-lib.sh 的隔离约定保持一致。
//
// 挡的不是「测试会不会 spawn sudo」——它照样会 spawn,只是拿不到合法 preflight。挡的是
// 开发机上真装了助手 + 配了免密 sudo 时,某条用例把宿主机的真单元操作掉:助手的
// start|stop|restart 分支在目录校验(ALLOWED_ROOT / .runner)**之前**就 systemctl 并 exit,
// root 那侧没有任何目录围栏能拦。而这台仓库的开发机上恰好跑着本项目自己的 runner 单元。
process.env.CIP_RUNNER_SVC_HELPER = "/nonexistent/ci-panel-runner-svc";

// 给用例用:拿扫描根,以及在根外造一个"根本够不着"的目录。
export const SCAN_ROOT = scanRoot;
export const OUTSIDE_ROOT = path.join(sandbox, "outside");
fs.mkdirsSync(OUTSIDE_ROOT);

// 收尾:把沙箱删掉。一次跑五个测试文件就是五个 mkdtemp,不清理的话开发机上的
// /tmp/ci-panel-daemon-test-* 会一直累积。必须先 chdir 出去 —— 当前工作目录正是要删的那个。
process.on("exit", () => {
  try {
    process.chdir(os.tmpdir());
    fs.removeSync(sandbox);
  } catch (err: unknown) {
    // 不重抛:此时测试结论已经出来了,让收尾问题改写退出码只会把真实结果盖掉。
    // 但也不能咽下去 —— 悄悄失败的话,累积的沙箱是唯一线索,而那要等到有人翻 /tmp 才发现。
    // 这里用 console 而非项目 logger:logger 是 cwd 相对的 log4js,而我们刚 chdir 走了,
    // 何况进程已在退出中,异步 appender 未必还能落盘。
    console.error(`[daemon-test] 沙箱清理失败,请手动删除 ${sandbox}:`, err);
  }
});
