#!/usr/bin/env bash
# 在一台机器上部署 ci-panel。默认只装 daemon —— 也就是给面板加一个 runner 节点。
#
# 三种取包方式，按这个顺序自动判断:
#   1) 已经解包，在包里直接跑（离线场景）:
#        sudo bash install.sh --scan-root /data/ci-runner
#   2) 本地有 tarball:
#        sudo bash install.sh --file ci-panel-1.0.0-linux.tar.gz
#   3) 让脚本自己去 GitHub Release 取（默认 latest）:
#        sudo bash install.sh --version 1.0.0
#
# 重复运行是安全的: shared/ 下的数据、daemon 的身份 key、.env 里已有的值都不会被覆盖。
#
# 装完的目录结构（--root，默认 /opt/ci-panel）:
#   releases/<version>/   每个版本一份，其中 daemon/{data,logs,tmp} 是指向 shared 的软链
#   current -> releases/<version>/    systemd 的 WorkingDirectory 指着它
#   shared/daemon/{data,logs,tmp}     数据唯一真相源，跨版本保留
#   .env                              CIP_* 环境变量，systemd 以 root 读取后注入
#
# 为什么数据必须放 shared: panel 和 daemon 的数据路径全是基于 process.cwd() 拼的
# (daemon/src/service/system_file.ts、panel/src/app/common/storage/jsonl_storage.ts)，
# 直接换目录升级会把用户、节点表和 daemon 身份一起留在旧目录里。
set -euo pipefail

# 公共函数在同级的 lib/common.sh 里。这里还没有 die 可用，只能自己报错。
_self="${BASH_SOURCE[0]:-}"
if [ -z "$_self" ] || [ ! -f "$_self" ]; then
  echo "错误: 本脚本需要同级的 lib/common.sh，没法用 'curl ... | bash' 的方式跑。" >&2
  echo "请下载完整包后再执行：" >&2
  echo "  1) 到 https://github.com/pypto-tools/ci-panel/releases/latest 取 ci-panel-<版本>-linux.tar.gz" >&2
  echo "  2) tar xzf ci-panel-<版本>-linux.tar.gz && cd ci-panel-<版本>" >&2
  echo "  3) sudo bash install.sh" >&2
  exit 1
fi
SELF_DIR="$(cd "$(dirname "$_self")" && pwd)"
if [ ! -f "$SELF_DIR/lib/common.sh" ]; then
  echo "错误: 找不到 $SELF_DIR/lib/common.sh —— 包不完整？" >&2
  exit 1
fi
# shellcheck source=lib/common.sh
. "$SELF_DIR/lib/common.sh"

NODE_MIN_MAJOR=20
NODE_PINNED="20.19.4" # --install-node 时下载的版本

ROLE="daemon"
RUN_USER="ci-runner"
INSTALL_ROOT="/opt/ci-panel"
SCAN_ROOT="/data/ci-runner"
DAEMON_PORT="24444"
WEB_PORT_OPT="23333"
TARBALL=""
WANT_VERSION=""
RUNNER_PKG=""
GITHUB_REPOS=""
RUNNER_PROXY=""
INSTALL_NODE=0
SKIP_PRIVILEGES=0
ASSUME_YES=0

SRC=""     # 解包/包内的源目录
VERSION="" # 从 SRC/VERSION 读出来的版本号
ARCH=""
NODE_BIN=""
RELEASE_DIR=""
TMP=""

usage() {
  cat <<'EOF'
用法: sudo bash install.sh [选项]

取包（不指定则优先用当前目录里的包，否则取 GitHub latest release）
  --file <tarball>        用本地 tarball
  --version <v>           从 GitHub Release 取指定版本，如 1.0.0

部署
  --role daemon|web|all   daemon=只装节点(默认)；web=只装面板，不装 daemon 也不配特权；
                          all=同机既是面板又是节点
  --user <name>           daemon 的运行用户，也是 runner 目录属主（默认 ci-runner）
  --root <path>           安装根目录（默认 /opt/ci-panel）
  --scan-root <path>      runner 根目录，写进特权助手的 ALLOWED_ROOT（默认 /data/ci-runner）
  --daemon-port <n>       daemon 端口，仅首次安装时写入配置（默认 24444）
  --web-port <n>          面板端口，仅首次安装时写入配置（默认 23333，--role web/all 有效）
  --runner-pkg <path>     预置 GitHub runner 安装包，省掉首次创建时现场下载约 130MB
  --runner-proxy <url>    写入 .env 的 CIP_RUNNER_PROXY —— daemon 拉 runner 包和注册时的代理兜底
  --github-repos <a/b,c/d>  写入 .env 的 CIP_GITHUB_REPOS。这是 panel 的配置（daemon 不读），
                          所以只有 --role all 用得上；而且它只在面板仓库列表还是空的时候
                          导入一次，之后仓库由面板 UI 管理
  --install-node          系统没有 node>=20 时，下载官方运行时到 <root>/runtime/
  --skip-privileges       跳过特权配置（不推荐：创建 runner 会在注册到 GitHub 之后才失败）
  --yes                   不做交互确认
EOF
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --role) ROLE="${2:?--role 需要参数}" && shift 2 ;;
      --user) RUN_USER="${2:?--user 需要参数}" && shift 2 ;;
      --root) INSTALL_ROOT="${2:?--root 需要参数}" && shift 2 ;;
      --scan-root) SCAN_ROOT="${2:?--scan-root 需要参数}" && shift 2 ;;
      --daemon-port) DAEMON_PORT="${2:?--daemon-port 需要参数}" && shift 2 ;;
      --web-port) WEB_PORT_OPT="${2:?--web-port 需要参数}" && shift 2 ;;
      --file) TARBALL="${2:?--file 需要参数}" && shift 2 ;;
      --version) WANT_VERSION="${2:?--version 需要参数}" && shift 2 ;;
      --runner-pkg) RUNNER_PKG="${2:?--runner-pkg 需要参数}" && shift 2 ;;
      --github-repos) GITHUB_REPOS="${2:?--github-repos 需要参数}" && shift 2 ;;
      --runner-proxy) RUNNER_PROXY="${2:?--runner-proxy 需要参数}" && shift 2 ;;
      --install-node) INSTALL_NODE=1 && shift ;;
      --skip-privileges) SKIP_PRIVILEGES=1 && shift ;;
      --yes | -y) ASSUME_YES=1 && shift ;;
      -h | --help)
        usage
        exit 0
        ;;
      *) die "未知参数: $1（-h 看用法）" ;;
    esac
  done

  case "$ROLE" in
    daemon | web | all) ;;
    *) die "--role 只能是 daemon、web 或 all，收到: $ROLE" ;;
  esac

  local port
  for port in "$DAEMON_PORT" "$WEB_PORT_OPT"; do
    if ! printf '%s' "$port" | grep -Eq '^[0-9]{1,5}$' || [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
      die "不是合法端口: $port"
    fi
  done

  # --role web 是纯管理机：它不装 daemon，这些参数无处可用，静默忽略会让人以为生效了
  if [ "$ROLE" = "web" ] && [ -n "$RUNNER_PKG" ]; then
    die "--role web 不装 daemon，用不上 --runner-pkg（runner 包要放到实际跑 runner 的节点上）"
  fi

  if [ -n "$WANT_VERSION" ]; then validate_version "$WANT_VERSION"; fi

  # 代理地址写错的话，daemon 拉 runner 包和注册会全部失败，而且只能从日志里看出来
  if [ -n "$RUNNER_PROXY" ]; then
    case "$RUNNER_PROXY" in
      http://* | https://* | socks5://* | socks5h://*) ;;
      *) die "--runner-proxy 需要带协议前缀（http:// https:// socks5://），收到: $RUNNER_PROXY" ;;
    esac
  fi

  validate_path_for_sed "$INSTALL_ROOT" "--root"
  validate_path_for_sed "$RUN_USER" "--user"

  INSTALL_ROOT="$(readlink -m "$INSTALL_ROOT")"
  # 再验一遍：readlink -m 会跟随符号链接，解析出来的真实路径可能含有上面那次
  # 校验时根本看不到的元字符（/tmp/link → /tmp/unsafe|root 这种）。
  validate_path_for_sed "$INSTALL_ROOT" "--root（解析软链后）"
  case "$INSTALL_ROOT" in
    / | /usr | /etc | /var | /home | /opt) die "--root 太宽: $INSTALL_ROOT" ;;
  esac

  # CIP_GITHUB_REPOS 是 panel 读的（panel/src/app/service/repo_service.ts），
  # 只装 daemon 的机器上没有进程会看它。仍然写进 .env（不静默丢掉用户给的值，
  # 将来这台机器升成 --role all 就生效），但要说清楚现在不起作用。
  if [ "$ROLE" = "daemon" ] && [ -n "$GITHUB_REPOS" ]; then
    warn "--github-repos 是 panel 的配置，--role daemon 下没有进程读它；值仍会写入 .env 备用"
  fi
}

cleanup() {
  if [ -n "$TMP" ]; then rm -rf "$TMP"; fi
}

wants_daemon() { [ "$ROLE" = "daemon" ] || [ "$ROLE" = "all" ]; }
wants_web() { [ "$ROLE" = "web" ] || [ "$ROLE" = "all" ]; }

preflight() {
  need_root
  need_cmd systemctl
  need_cmd tar
  if [ ! -d /run/systemd/system ]; then
    die "这台机器不是 systemd 引导的，本脚本装的是 systemd 单元"
  fi
  # --scan-root 只有装 daemon 时才有意义，不装就别拿它去比盘。
  if wants_daemon; then
    check_disk_space "$INSTALL_ROOT" "$SCAN_ROOT"
  else
    check_disk_space "$INSTALL_ROOT"
  fi
  TMP="$(mktemp -d)"
  trap cleanup EXIT
  check_tmp_space "$TMP"
}

resolve_source() {
  if [ -z "$TARBALL" ] && [ -f "$SELF_DIR/VERSION" ] && [ -d "$SELF_DIR/daemon" ]; then
    SRC="$SELF_DIR"
    log "用当前目录里已解包的版本: $SRC"
    return
  fi
  if [ -n "$TARBALL" ]; then
    if [ ! -f "$TARBALL" ]; then die "找不到包文件: $TARBALL"; fi
    TARBALL="$(readlink -m "$TARBALL")"
    verify_checksum "$TARBALL"
    unpack "$TARBALL"
    return
  fi
  need_cmd curl
  if [ -z "$WANT_VERSION" ]; then
    log "查询 $REPO 的 latest release …"
    local tag
    tag="$(resolve_latest_tag)"
    if [ -z "$tag" ]; then
      die "取不到 latest release。用 --version <v> 指定，或 --file 用本地包（也可能要设 https_proxy）"
    fi
    WANT_VERSION="${tag#"$TAG_PREFIX"}"
    log "latest = $tag → 版本 $WANT_VERSION"
  fi
  download_release "$WANT_VERSION"
}

read_version() {
  if ! VERSION="$(read_version_file "$SRC")" || [ -z "$VERSION" ]; then
    die "包里没有 VERSION 文件或缺 version= 行: $SRC"
  fi
}

detect_arch() {
  local machine
  machine="$(uname -m)"
  case "$machine" in
    x86_64 | amd64) ARCH="x64" ;;
    aarch64 | arm64) ARCH="arm64" ;;
    *) die "不支持的架构: $machine（包里只带了 x64 与 arm64 的 pty/7z/file_zip）" ;;
  esac
  if ! wants_daemon; then
    log "架构 $ARCH（--role web 不跑 daemon，不检查它的 lib 二进制）"
    return
  fi
  # daemon 启动时 checkDependencies() 找不到 file_zip 会直接抛错退出，先在这里拦住
  local f
  for f in "pty_linux_$ARCH" "file_zip_linux_$ARCH" "7z_linux_$ARCH"; do
    if [ ! -f "$SRC/daemon/lib/$f" ]; then
      die "包里缺 daemon/lib/$f，这个包没法在 $ARCH 上跑（是用 --skip-lib 打的？）"
    fi
  done
  log "架构 $ARCH，lib 二进制齐全"
}

# 服务是以 RUN_USER 跑的，所以"这个 node 能不能用"要以那个用户的身份回答。
# /usr/local/bin/node 这种看着像系统路径、实则软链到某个用户 home 的情况很常见，
# 光看版本号判断不出来。
node_usable_by_user() { # path
  if [ "$RUN_USER" = "root" ]; then return 0; fi
  su -s /bin/sh -c "$(printf '%q' "$1") -v" "$RUN_USER" >/dev/null 2>&1
}

# 报错时把软链的真身指出来，否则"/usr/local/bin/node 用不了"看着莫名其妙
node_link_hint() { # path
  local target
  target="$(readlink "$1" 2>/dev/null || true)"
  if [ -n "$target" ]; then printf '（软链指向 %s）' "$target"; fi
}

ensure_node() {
  local pinned_dir="$INSTALL_ROOT/runtime/node-v$NODE_PINNED-linux-$ARCH"

  # --install-node 是明确指令，不该被"系统上恰好有个够新的 node"抢先 ——
  # 之前正是这个顺序导致加了这个参数也照样去用系统 node，然后才发现它不可用。
  if [ "$INSTALL_NODE" -ne 1 ]; then
    local candidate major
    candidate="$(command -v node 2>/dev/null || true)"
    if [ -n "$candidate" ]; then
      major="$("$candidate" -e 'process.stdout.write(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
      if [ "$major" -lt "$NODE_MIN_MAJOR" ] 2>/dev/null; then
        warn "系统 node 版本过低: $("$candidate" -v)（需要 >= v$NODE_MIN_MAJOR）"
      elif ! node_usable_by_user "$candidate"; then
        # 版本够 ≠ 能用：服务用户执行不了的话，装出来的单元一拉起就失败
        warn "系统 node $candidate 版本够，但 $RUN_USER 执行不了$(node_link_hint "$candidate")"
      else
        NODE_BIN="$candidate"
        log "用系统 node: $NODE_BIN ($("$NODE_BIN" -v))"
        return
      fi
    fi

    if [ -x "$pinned_dir/bin/node" ] && node_usable_by_user "$pinned_dir/bin/node"; then
      NODE_BIN="$pinned_dir/bin/node"
      log "用之前装好的运行时: $NODE_BIN"
      return
    fi
    die "没有 $RUN_USER 能用的 node >= v$NODE_MIN_MAJOR$(node_link_hint "$(command -v node 2>/dev/null || true)")。装一个系统级的，或者加 --install-node 把官方运行时放到 $INSTALL_ROOT/runtime/"
  fi

  if [ -x "$pinned_dir/bin/node" ] && node_usable_by_user "$pinned_dir/bin/node"; then
    NODE_BIN="$pinned_dir/bin/node"
    log "用之前装好的运行时: $NODE_BIN"
    return
  fi

  need_cmd curl
  local tarball="node-v$NODE_PINNED-linux-$ARCH.tar.xz"
  log "下载 node v$NODE_PINNED ($ARCH) …"
  if ! curl -fL --retry 3 -o "$TMP/$tarball" "https://nodejs.org/dist/v$NODE_PINNED/$tarball"; then
    die "node 下载失败（需要设 https_proxy？）"
  fi
  mkdir -p "$INSTALL_ROOT/runtime"
  # --no-same-owner + chown root: 否则归档里的 uid 会被保留，万一正好落到 RUN_USER 头上，
  # 服务用户就能改写自己的 node 二进制 —— 而这个 daemon 持有 sudo -n 免密权限。
  if ! tar --no-same-owner -C "$INSTALL_ROOT/runtime" -xJf "$TMP/$tarball"; then
    die "node 解包失败（缺 xz？装一下 xz-utils / xz）"
  fi
  chown -R root:root "$INSTALL_ROOT/runtime"
  if [ ! -x "$pinned_dir/bin/node" ]; then die "node 解包后没找到 $pinned_dir/bin/node"; fi
  if ! node_usable_by_user "$pinned_dir/bin/node"; then
    die "装好的运行时 $pinned_dir/bin/node$(node_link_hint "$pinned_dir/bin/node") 仍然不能被 $RUN_USER 执行（$INSTALL_ROOT 的权限？）"
  fi
  NODE_BIN="$pinned_dir/bin/node"
  log "运行时就绪: $NODE_BIN"
}

# NODE_BIN 也会被 sed 塞进单元模板，和 --root/--user 一样要挡掉元字符
check_node_bin() {
  case "$NODE_BIN" in
    *'|'* | *'&'* | *'\'*) die "node 路径里含 | & \\，无法安全渲染 systemd 单元: $NODE_BIN" ;;
  esac
}

ensure_user() {
  # root 的检查必须排在"用户是否已存在"前面: root 永远存在，放在后面这一句就永远执行不到，
  # --user root 会一路装出 User=root 的单元 —— 而特权助手那套设计的前提正是 daemon 不是
  # root（见 prod-scripts/README.md）。以 root 跑 daemon 等于把整个授权边界作废。
  if [ "$RUN_USER" = "root" ]; then
    die "daemon 不能以 root 运行：特权助手的整套边界都建立在它是普通用户之上（见 prod-scripts/README.md）"
  fi
  if id "$RUN_USER" >/dev/null 2>&1; then return; fi
  if ! confirm "用户 $RUN_USER 不存在，创建它？"; then die "已取消"; fi
  useradd --create-home --shell /bin/bash "$RUN_USER"
  log "已创建用户 $RUN_USER"
}

install_release() {
  RELEASE_DIR="$INSTALL_ROOT/releases/$VERSION"
  if [ -d "$RELEASE_DIR" ]; then
    if ! confirm "$VERSION 已经装过（$RELEASE_DIR），重新覆盖这个版本的代码？（shared/ 里的数据不动）"; then
      die "已取消"
    fi
  fi
  log "安装到 $RELEASE_DIR …"
  deploy_release_dir
}

seed_daemon_config() {
  local cfg="$INSTALL_ROOT/shared/daemon/data/Config/global.json"
  if [ -f "$cfg" ]; then
    log "daemon 配置已存在，保留不动（里面的 key 是这个节点的身份）"
    if [ "$DAEMON_PORT" != "24444" ]; then
      warn "--daemon-port 本次忽略：端口改动请直接编辑 $cfg 后重启服务"
    fi
    return
  fi
  log "写 daemon 初始配置（端口 $DAEMON_PORT）…"
  mkdir -p "$(dirname "$cfg")"
  # 只写 port 就够: StorageSubsystem.load 会把 JSON 深合并到 Config 类默认值上，
  # key 由类默认值现场随机生成并落盘（daemon/src/entity/config.ts）。
  printf '{\n  "port": %s\n}\n' "$DAEMON_PORT" >"$cfg"
  chmod 640 "$cfg" # 里面马上会有节点密钥（daemon 首次 load 时生成）
  chown -R "$RUN_USER:$RUN_USER" "$INSTALL_ROOT/shared/daemon/data"
}

seed_web_config() {
  local cfg="$INSTALL_ROOT/shared/web/data/SystemConfig/config.json"
  if [ -f "$cfg" ]; then
    log "面板配置已存在，保留不动"
    if [ "$WEB_PORT_OPT" != "23333" ]; then
      warn "--web-port 本次忽略：端口改动请直接编辑 $cfg 后重启服务"
    fi
    return
  fi
  log "写面板初始配置（端口 $WEB_PORT_OPT）…"
  mkdir -p "$(dirname "$cfg")"
  # 同 seed_daemon_config: StorageSystem.load 会把 JSON 深合并到 SystemConfig 类默认值上
  # （panel/src/app/setting.ts），所以只写端口就够。
  printf '{\n  "httpPort": %s\n}\n' "$WEB_PORT_OPT" >"$cfg"
  chown -R "$RUN_USER:$RUN_USER" "$INSTALL_ROOT/shared/web/data"
}

place_runner_pkg() {
  if [ -z "$RUNNER_PKG" ]; then return; fi
  if [ ! -f "$RUNNER_PKG" ]; then die "找不到 runner 安装包: $RUNNER_PKG"; fi
  case "$(basename "$RUNNER_PKG")" in
    *"linux-$ARCH"*) ;;
    *) die "runner 包架构和本机不符: $(basename "$RUNNER_PKG") 不含 linux-$ARCH。arm64 的包在 x64 上解出来跑不了" ;;
  esac
  local dest="$INSTALL_ROOT/shared/daemon/data/runner-pkg"
  mkdir -p "$dest"
  cp -f "$RUNNER_PKG" "$dest/"
  chown -R "$RUN_USER:$RUN_USER" "$dest"
  log "已放置 runner 安装包: $(basename "$RUNNER_PKG")"
}

env_set() { # file key value
  local file="$1" key="$2" value="$3" escaped
  case "$value" in
    *$'\n'*) die "$key 的值里不能有换行" ;;
  esac
  if grep -qE "^$key=" "$file" 2>/dev/null; then
    # 转义 sed 替换串里的元字符: & 会被展开成整个匹配，| 是这里的分隔符
    escaped="$(printf '%s' "$value" | sed -e 's/[&|\\]/\\&/g')"
    sed -i "s|^$key=.*|$key=$escaped|" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >>"$file"
  fi
}

write_env() {
  local env_file="$INSTALL_ROOT/.env"
  if [ ! -f "$env_file" ]; then
    log "创建 $env_file …"
    cat >"$env_file" <<'EOF'
# ci-panel 的部署环境变量。systemd 以 root 读取后注入服务进程（EnvironmentFile）。
# 改完要 systemctl restart ci-panel-daemon（和 ci-panel-web，如果装了）才生效。
#
# 注意下面两组的归属不同：只装了 daemon 的机器上，panel 那组没有进程会读。

# ---- daemon 读的 ----
# 拉 runner 安装包和跑 config.sh 注册都要连 GitHub。前端表单没填代理时用这个兜底。
# CIP_RUNNER_PROXY=http://127.0.0.1:7890

# runner 的托管方式。不设 = 自动探测(有 systemd + 特权助手 → systemd，否则 → process)。
# 只影响此后新建的 runner：已有 runner 认自己 .cipanel 里记的那个。填了但该后端在本节点
# 不可用时会被忽略并退回自动探测，daemon 启动日志里能看到原因。改完要重启 daemon。
# CIP_RUNNER_SUPERVISOR=process

# process 托管拉起 runner 的命令，JSON 字符串数组。默认 ["./run.sh"]。
# 非法 JSON 或非字符串数组会回退默认并告警，不会让 daemon 起不来。
# 硬约束：必须原地 exec，不能把进程送到别的容器或主机(否则记录的进程组对不上，
# 面板会把它判成「不受托管」并拒绝启停)。
# CIP_RUNNER_START=["./run.sh"]

# ---- panel(web) 读的 ----
# CI Job 看板的仓库列表，逗号分隔。只在面板仓库列表还是空的时候导入一次，
# 之后仓库由面板 UI 管理（见 panel/src/app/service/repo_service.ts 的 migrateFromEnv）。
# CIP_GITHUB_REPOS=owner/repo

# 各仓库没配专用 PAT 时的全局兜底 token。这个文件是 600 root:root，
# 但它终究是明文 —— 不要复制到别处，也不要提交进任何仓库。
# CIP_GITHUB_TOKEN=
EOF
  fi
  chmod 600 "$env_file"
  chown root:root "$env_file"
  if [ -n "$GITHUB_REPOS" ]; then env_set "$env_file" CIP_GITHUB_REPOS "$GITHUB_REPOS"; fi
  if [ -n "$RUNNER_PROXY" ]; then env_set "$env_file" CIP_RUNNER_PROXY "$RUNNER_PROXY"; fi
}

install_privileges() {
  if ! wants_daemon; then
    log "--role web 不跑 runner，跳过特权配置（不给纯管理机加多余的 sudo 授权面）"
    return
  fi
  if [ "$SKIP_PRIVILEGES" -eq 1 ]; then
    warn "按要求跳过特权配置。在补上之前，创建 runner 会在它已经注册到 GitHub 之后才失败，"
    warn "并在 GitHub 上留下一个永远不上线的 runner。补的方法："
    warn "  sudo bash $RELEASE_DIR/prod-scripts/install-runner-privileges.sh --user $RUN_USER --root $SCAN_ROOT"
    return
  fi
  log "配置 systemd 特权助手（scan-root $SCAN_ROOT）…"
  if ! bash "$RELEASE_DIR/prod-scripts/install-runner-privileges.sh" \
    --user "$RUN_USER" --root "$SCAN_ROOT"; then
    die "特权配置失败（上面有原因）。修好后重跑本脚本即可，装过的部分不会重复做"
  fi
}

install_units() {
  log "安装 systemd 单元 …"
  local roles=""
  if wants_daemon; then roles="daemon"; fi
  if wants_web; then roles="$roles web"; fi
  # shellcheck disable=SC2086  # 这里要的就是把角色列表按空格拆开
  render_units_for_roles "$RELEASE_DIR" $roles
}

install_ctl() {
  local dest="/usr/local/bin/ci-panel-ctl"
  if [ ! -f "$RELEASE_DIR/ci-panel-ctl" ]; then
    warn "包里没有 ci-panel-ctl，跳过"
    return
  fi
  sed -e "s|__ROOT__|$INSTALL_ROOT|g" "$RELEASE_DIR/ci-panel-ctl" >"$dest.new"
  chmod 755 "$dest.new"
  chown root:root "$dest.new"
  mv -T "$dest.new" "$dest" # 原地覆盖会让此刻正在跑的 ctl 读到半截脚本
  log "已安装运维入口: $dest"
}

enable_and_start() { # unit
  # 不要把 stderr 也丢掉：enable 失败时 set -e 会让脚本直接退出，
  # 吞掉 stderr 的话用户只看到"无声中断"
  if ! systemctl enable "$1" >/dev/null; then die "systemctl enable $1 失败"; fi
  systemctl restart "$1"
}

activate() {
  log "切换 current -> releases/$VERSION 并启动 …"
  ln -sfnT "$RELEASE_DIR" "$INSTALL_ROOT/current"
  if wants_daemon; then enable_and_start "$DAEMON_UNIT"; fi
  if wants_web; then enable_and_start "$WEB_UNIT"; fi
}

print_summary() {
  local host
  host="$(detect_ip)"
  if [ -z "$host" ]; then host="<这台机器的 IP>"; fi

  printf '\n'
  log "ci-panel $VERSION 部署完成（role=$ROLE）"

  if wants_daemon; then
    local port key
    port="$(daemon_port)"
    key="$(read_json_field "$INSTALL_ROOT/shared/daemon/data/Config/global.json" key)"
    printf '\n在面板里添加这个节点：\n'
    printf '  地址   %s\n' "$host"
    printf '  端口   %s\n' "$port"
    printf '  密钥   %s\n' "$key"
    printf '\n这个密钥等同于该节点的准入凭据，只在面板里填，不要贴到聊天或工单里。\n'
    printf '别忘了放开防火墙上的 %s 端口 —— 节点连不上最常见的原因就是这个。\n' "$port"
    if [ -z "$RUNNER_PKG" ] && [ ! -d "$INSTALL_ROOT/shared/daemon/data/runner-pkg" ]; then
      printf '\n没有预置 runner 安装包，首次创建 runner 时 daemon 会现场下载（约 130MB，走代理会很慢）。\n'
      printf '想省这一步：install.sh --runner-pkg actions-runner-linux-%s-<版本>.tar.gz\n' "$ARCH"
    fi
  fi

  if wants_web; then
    printf '\n面板地址 http://%s:%s —— 首次打开会进安装向导，在那里创建管理员账号。\n' "$host" "$(web_port)"
    if ! wants_daemon; then
      # panel 启动时会去找同级的 daemon 自动登记（remote_service.ts 的 initConnectLocalhost），
      # 纯面板机上找不到是正常的：它每 5 秒重试一次，等你在面板里加了第一个节点就停。
      # 不说明的话，日志里那几行告警看着像是装坏了。
      printf '\n这台是纯面板机，没有本机 daemon。启动初期日志里会有"找不到本机守护进程"的告警，\n'
      printf '在面板里添加第一个节点之后就不再出现，属正常现象。\n'
      printf '各节点用 install.sh（默认 --role daemon）单独部署，然后在面板里逐台添加。\n'
    fi
  fi

  printf '\n常用命令：\n'
  printf '  ci-panel-ctl status                   # 状态与版本\n'
  printf '  ci-panel-ctl logs                     # 跟踪日志\n'
  printf '  ci-panel-ctl update                   # 更新到 latest release\n'
  printf '\n'
}

main() {
  parse_args "$@"
  preflight
  resolve_source
  read_version
  detect_arch
  # 先建用户：选 node 时要以它的身份验证可执行性
  ensure_user
  ensure_node
  check_node_bin
  install_release

  if wants_daemon; then
    link_shared daemon
    seed_daemon_config
    place_runner_pkg
  fi
  if wants_web; then
    link_shared web
    seed_web_config
  fi

  write_env
  install_privileges
  install_units
  install_ctl
  activate

  if wants_daemon && ! probe_service "$DAEMON_UNIT" "$(daemon_port)" daemon "$(daemon_addr)"; then
    die "daemon 起不来。日志: journalctl -u $DAEMON_UNIT -n 50"
  fi
  if wants_web && ! probe_service "$WEB_UNIT" "$(web_port)" web "$(web_addr)"; then
    die "web 起不来。日志: journalctl -u $WEB_UNIT -n 50"
  fi
  print_summary
}

# 直接执行才跑 main；被 source 时只加载函数，方便单独验证渲染、配置写入这些逻辑
if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
