#!/usr/bin/env bash
# 解包并把 web + daemon 真的跑起来，确认这个 tarball 能用。
#
# 用法: bash scripts/release/smoke-test.sh dist-release/ci-panel-1.0.0-linux.tar.gz
#
# 为什么非得真跑一次: panel/package.json 把 mcsmanager-common 声明成 optionalDependencies
# 的 "file:../common"，而在 production-code/web 里这个相对路径不存在，npm install 会静默
# 跳过它 —— 能跑全靠 webpack 把 common 内联进 app.js。这类"装不上也不报错"的依赖问题，
# 只有启动一次才会暴露。
#
# 判定为什么不看退出码: panel 的 main().catch 是 process.exit(0)(panel/src/app.ts)，
# 启动失败也返回 0。所以只认"端口真的在听 + 首页拿得到 + 日志里没有致命错误"。
#
# 与本机现网的关系: 端口随机、只监听 127.0.0.1、数据目录在临时目录，所以不会碰现网的
# panel/daemon 数据。唯一的例外是 runner 扫描 —— daemon 启动时会调
# `sudo -n ci-panel-runner-svc preflight` 拿 ALLOWED_ROOT，在已部署特权助手的机器上
# 这个值会覆盖下面设的 CIP_SCAN_ROOTS，于是它会只读扫描真实的 runner 根目录。
# 扫描不写任何东西，但这也是为什么正式发包应该在 CI 的干净环境里跑。
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

TARBALL="${1:-}"
if [ -z "$TARBALL" ] || [ ! -f "$TARBALL" ]; then
  echo "用法: bash scripts/release/smoke-test.sh <tarball>" >&2
  exit 2
fi
TARBALL="$(cd "$(dirname "$TARBALL")" && pwd)/$(basename "$TARBALL")"

WORK="$(mktemp -d)"
APP=""
DAEMON_PID=""
WEB_PID=""

cleanup() {
  local pid
  for pid in "$DAEMON_PID" "$WEB_PID"; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true # 收割掉，否则 bash 退出时会打一行 "Killed"
    fi
  done
  rm -rf "$WORK"
}
trap cleanup EXIT

free_port() {
  node -e 'const s = require("net").createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => console.log(p)); });'
}

tcp_open() { # host port
  node -e '
const net = require("net");
const socket = net.connect(Number(process.argv[2]), process.argv[1]);
socket.on("connect", () => { socket.destroy(); process.exit(0); });
socket.on("error", () => process.exit(1));
socket.setTimeout(2000, () => { socket.destroy(); process.exit(1); });
' "$1" "$2" 2>/dev/null
}

wait_tcp() { # host port timeout_seconds
  local waited=0
  while [ "$waited" -lt "$3" ]; do
    if tcp_open "$1" "$2"; then return 0; fi
    sleep 1
    waited=$((waited + 1))
  done
  return 1
}

http_get() { # url → 打印响应体；非 200 返回 1
  node -e '
require("http").get(process.argv[1], (res) => {
  let body = "";
  res.on("data", (chunk) => (body += chunk));
  res.on("end", () => {
    if (res.statusCode !== 200) { console.error(`HTTP ${res.statusCode}`); process.exit(1); }
    process.stdout.write(body);
  });
}).on("error", (err) => { console.error(err.message); process.exit(1); });
' "$1"
}

# 启动失败时把日志尾部打出来，顺带认一下几种已知的失败形态
dump_log() { # name
  local log="$WORK/$1.log"
  echo "---- $1.log (尾部 40 行) ----" >&2
  tail -n 40 "$log" >&2 || true
  echo "-----------------------------" >&2
  if grep -q "requires additional dependencies" "$log" 2>/dev/null; then
    echo "诊断: 包里缺 daemon/lib 二进制。--skip-lib 打出来的包过不了 smoke test，重新打一个完整包。" >&2
  fi
  if grep -qE "Cannot find module|MODULE_NOT_FOUND" "$log" 2>/dev/null; then
    echo "诊断: 有依赖没进包。检查 build.sh 在 production-code/ 里的 npm install --production 是否成功。" >&2
  fi
}

echo "[1/7] 解包到 $WORK …"
tar -C "$WORK" -xzf "$TARBALL"
APP="$(find "$WORK" -mindepth 1 -maxdepth 1 -type d -name 'ci-panel-*' | head -n 1)"
if [ -z "$APP" ]; then
  echo "包里没有 ci-panel-<version>/ 顶层目录" >&2
  exit 1
fi
if [ -f "$APP/VERSION" ]; then
  echo "      $(tr '\n' ' ' <"$APP/VERSION")"
else
  echo "包里没有 VERSION 文件" >&2
  exit 1
fi

DAEMON_PORT="$(free_port)"
WEB_PORT="$(free_port)"

echo "[2/7] 写隔离配置（只监听 127.0.0.1，daemon=$DAEMON_PORT web=$WEB_PORT）…"
# 只写这几个字段就够: StorageSubsystem.load 会把 JSON 深合并到类默认值上
# (common/src/system_storage.ts)。关掉 soft shutdown 是为了收尾不用等 30 秒。
mkdir -p "$APP/daemon/data/Config" "$APP/web/data/SystemConfig"
cat >"$APP/daemon/data/Config/global.json" <<EOF
{
  "ip": "127.0.0.1",
  "port": $DAEMON_PORT,
  "key": "$(node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))')",
  "enableSoftShutdown": false
}
EOF
cat >"$APP/web/data/SystemConfig/config.json" <<EOF
{
  "httpIp": "127.0.0.1",
  "httpPort": $WEB_PORT
}
EOF

# daemon 的扫描根默认是 /data/ci-runner(daemon/src/service/runner_scan.ts 的 FALLBACK_ROOTS)，
# 那正是本机现网的 runner 根目录。显式指向一个空目录，让没装特权助手的机器上不会去翻它。
export CIP_SCAN_ROOTS="$WORK/scan-root"
mkdir -p "$CIP_SCAN_ROOTS"
unset CIP_GITHUB_REPOS CIP_GITHUB_TOKEN CIP_RUNNER_PROXY

echo "[3/7] 启动 daemon 与 web …"
# Verify the separately bundled scanner before starting either service.
node "$SELF_DIR/check-proc-worker.cjs" "$APP/daemon"

(cd "$APP/daemon" && exec node --enable-source-maps app.js) >"$WORK/daemon.log" 2>&1 &
DAEMON_PID=$!
(cd "$APP/web" && exec node --enable-source-maps app.js) >"$WORK/web.log" 2>&1 &
WEB_PID=$!

if ! wait_tcp 127.0.0.1 "$DAEMON_PORT" 30; then
  echo "daemon 30 秒内没有监听 $DAEMON_PORT" >&2
  dump_log daemon
  exit 1
fi
echo "      daemon 已监听 $DAEMON_PORT"

if ! wait_tcp 127.0.0.1 "$WEB_PORT" 30; then
  echo "web 30 秒内没有监听 $WEB_PORT" >&2
  dump_log web
  exit 1
fi
echo "      web 已监听 $WEB_PORT"

echo "[4/7] 取首页，确认前端产物与静态服务都在位…"
if ! html="$(http_get "http://127.0.0.1:$WEB_PORT/")"; then
  echo "首页请求失败" >&2
  dump_log web
  exit 1
fi
if ! printf '%s' "$html" | grep -q 'id="app-mount-point"'; then
  echo '首页里没有 id="app-mount-point"，前端产物可能没进 web/public' >&2
  exit 1
fi
echo "      首页 200，挂载点在"

echo "[5/7] 确认 panel 找到了同级的 daemon …"
# initConnectLocalhost 读的是 cwd/../daemon/data/Config/global.json
# (panel/src/app/service/remote_service.ts)，注册成功后会落一份 RemoteServiceConfig。
# 这条断言同时守住了"web 与 daemon 必须同级"这个布局约束。
found_remote=0
waited=0
while [ "$waited" -lt 20 ]; do
  if ls "$APP/web/data/RemoteServiceConfig/"*.json >/dev/null 2>&1; then
    found_remote=1
    break
  fi
  sleep 1
  waited=$((waited + 1))
done
if [ "$found_remote" -ne 1 ]; then
  echo "panel 没有注册本机 daemon（web/data/RemoteServiceConfig/ 是空的）" >&2
  dump_log web
  exit 1
fi
echo "      已注册本机 daemon 节点"

echo "[6/7] 扫日志里的致命错误…"
for name in daemon web; do
  if grep -nE "uncaughtException|unhandledRejection|Cannot find module|MODULE_NOT_FOUND" "$WORK/$name.log"; then
    echo "$name 日志里有致命错误（见上）" >&2
    dump_log "$name"
    exit 1
  fi
done

for pid_name in "daemon:$DAEMON_PID" "web:$WEB_PID"; do
  if ! kill -0 "${pid_name##*:}" 2>/dev/null; then
    echo "${pid_name%%:*} 进程已经退出" >&2
    dump_log "${pid_name%%:*}"
    exit 1
  fi
done

echo "[7/7] 用无头浏览器确认前端真的能挂载…"
# 前面那些 HTTP 检查只能证明资源在位。这一步才真的把 JS 跑起来 ——
# echarts/zrender 那次就是首页 200、挂载点也在，但 initApp 一执行就死，
# 而当时的 smoke test 全程亮绿灯。
browser_rc=0
node "$SELF_DIR/browser-check.mjs" "http://127.0.0.1:$WEB_PORT" || browser_rc=$?
case "$browser_rc" in
  0) ;;
  3)
    # 3 = 没装 playwright。本地图快可以这样，但别让人以为验过了。
    # 发布流程设 REQUIRE_BROWSER_CHECK=1，这样即便浏览器装挂了也是硬失败，
    # 不会悄悄退化成"跳过"然后照样发包。
    if [ "${REQUIRE_BROWSER_CHECK:-0}" = "1" ]; then
      echo "REQUIRE_BROWSER_CHECK=1，但 playwright 用不了（见上），拒绝在没验过前端的情况下放行" >&2
      exit 1
    fi
    echo "      跳过：这台机器上没有 playwright（装它要连浏览器一起下）。"
    echo "      本地快速验证可以跳过，发布流程不行 —— release.yml 里会装上并强制要求。"
    ;;
  *)
    # 这里不 dump web.log：前端挂了跟后端日志无关，40 行启动横幅只会把上面的诊断挤走
    echo "前端启动检查未通过（详情见上）" >&2
    exit 1
    ;;
esac

echo
echo "smoke test 通过: $(basename "$TARBALL")"
