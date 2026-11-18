#!/usr/bin/env bash
# 打包 ci-panel 发布 tarball。
#
# 用法:
#   bash scripts/release/pack.sh 1.0.0
#   bash scripts/release/pack.sh 1.0.0 --skip-lib     # 无外网时跳过 lib 二进制下载
#   bash scripts/release/pack.sh 1.0.0 --skip-build   # 复用上一次的 production-code/
#
# 产物: dist-release/ci-panel-<version>-linux.tar.gz 与同名 .sha256
#
# 一个包同时适用 x64 与 arm64: 四个包里没有任何原生模块(node_modules 下无 .node)，
# 唯一按架构分文件的是 daemon/lib 下的 pty / 7z / file_zip，运行时由 daemon/src/const.ts
# 按 os.arch() 自己挑，所以全架构一起打进去即可。
#
# 版本号为什么要写进三个字段: 概览页显示的版本取自 web/package.json 的 version，
# 而节点列表上"该 daemon 待更新"的告警是拿 web/package.json 的 daemonVersion 去比
# daemon 上报的 version(frontend/src/tools/version.ts 只比 major.minor)。三者写成同一个
# 值，告警才只在节点真的落后时才亮。改动只落在 stage 副本上，源码树保持干净。
#
# 打包对本机零影响: build.sh 会把 daemon/production/app.js 和 panel/production/app.js
# mv 进 production-code/ 再删掉 production/ 目录，而本机的 daemon/panel 正是用这两个文件
# 启动的(start-cipanel.sh)。本脚本退出前把**打包前那一份**原样放回（不是新构建的产物），
# 构建中途失败也还原 —— 打包不该顺手把现网服务的代码换成当前分支的版本，
# 要更新本机服务请走部署/更新流程。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/dist-release"

usage() {
  cat <<'EOF'
用法: bash scripts/release/pack.sh <version> [--skip-build] [--skip-lib]

  <version>      语义化版本号，如 1.0.0 或 1.0.0-rc1
  --skip-build   复用上一次的 production-code/（迭代脚本时省时间）
  --skip-lib     跳过 daemon/lib 二进制下载。注意这样的包不能部署也过不了 smoke test：
                 daemon 启动时 checkDependencies() 找不到 file_zip 会直接抛错退出
  --refresh-lib-checksums
                 重新生成 lib-checksums.txt 而不是校验它。上游发布新二进制后才用，
                 生成完必须人工 review diff —— 这是唯一一道防线
EOF
}

VERSION=""
SKIP_BUILD=0
SKIP_LIB=0
REFRESH_LIB=0
while [ $# -gt 0 ]; do
  case "$1" in
    --skip-build) SKIP_BUILD=1 ;;
    --skip-lib) SKIP_LIB=1 ;;
    --refresh-lib-checksums) REFRESH_LIB=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*)
      echo "未知参数: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      if [ -n "$VERSION" ]; then
        echo "只能给一个版本号（多余的: $1）" >&2
        exit 2
      fi
      VERSION="$1"
      ;;
  esac
  shift
done

if [ -z "$VERSION" ]; then
  usage >&2
  exit 2
fi

# major.minor 要能被 frontend/src/tools/version.ts 的 split(".") 取到，格式必须是 semver
if ! printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$'; then
  echo "版本号格式不对: $VERSION（应形如 1.0.0 或 1.0.0-rc1）" >&2
  exit 2
fi

STAGE="$OUT/ci-panel-$VERSION"
TARBALL="$OUT/ci-panel-$VERSION-linux.tar.gz"

# ---- 保护本机现网的 production/app.js（见文件头说明）----
BACKUP_DIR=""

backup_local_production() {
  BACKUP_DIR="$(mktemp -d)"
  local pkg artifact
  for pkg in daemon panel; do
    if [ -f "$ROOT/$pkg/production/app.js" ]; then
      mkdir -p "$BACKUP_DIR/$pkg"
      for artifact in app.js app.js.map proc_scan_worker.js proc_scan_worker.js.map; do
        if [ -f "$ROOT/$pkg/production/$artifact" ]; then
          cp -f "$ROOT/$pkg/production/$artifact" "$BACKUP_DIR/$pkg/$artifact"
        fi
      done
    fi
  done
}

restore_local_production() {
  local pkg sub dst src origin artifact
  for pkg in daemon panel; do
    if [ "$pkg" = panel ]; then sub=web; else sub=daemon; fi
    dst="$ROOT/$pkg/production"
    if [ -f "$dst/app.js" ] && { [ "$pkg" != daemon ] || [ -f "$dst/proc_scan_worker.js" ]; }; then continue; fi # 还在原地，不用管
    if [ -n "$BACKUP_DIR" ] && [ -f "$BACKUP_DIR/$pkg/app.js" ]; then
      src="$BACKUP_DIR/$pkg" # 打包前在跑的那一份，原样放回
      origin="打包前的备份"
    elif [ -f "$ROOT/production-code/$sub/app.js" ]; then
      src="$ROOT/production-code/$sub" # 本机从没构建过，放一份新的总比没有好
      origin="本次构建产物"
    else
      continue
    fi
    mkdir -p "$dst"
    for artifact in app.js app.js.map proc_scan_worker.js proc_scan_worker.js.map; do
      if [ -f "$src/$artifact" ]; then cp -f "$src/$artifact" "$dst/$artifact"; fi
    done
    echo "[还原] $pkg/production/app.js ← $origin（本机服务保持可重启）"
  done
  if [ -n "$BACKUP_DIR" ]; then rm -rf "$BACKUP_DIR"; fi
}

echo "== 打包 ci-panel $VERSION =="

backup_local_production
trap restore_local_production EXIT

if [ "$SKIP_BUILD" -eq 0 ]; then
  echo "[1/8] 构建（build.sh: common → daemon → panel → frontend，并装生产依赖）…"
  bash "$ROOT/build.sh"
else
  echo "[1/8] 跳过构建，复用 production-code/"
  for sub in web daemon; do
    if [ ! -f "$ROOT/production-code/$sub/app.js" ]; then
      echo "production-code/$sub/app.js 不存在，--skip-build 无从复用；先跑一次不带该参数的打包" >&2
      exit 1
    fi
  done
fi

echo "[2/8] 装配 ${STAGE#"$ROOT"/} …"
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -r "$ROOT/production-code/web" "$STAGE/web"
cp -r "$ROOT/production-code/daemon" "$STAGE/daemon"

# rollup-plugin-visualizer 在 frontend/vite.config.ts 里是无条件启用的，每次构建都会产出
# 一个 2.5MB 的 stats.html。它会被 panel 的 koa-static 照常对外服务
# (http://<panel>:23333/stats.html)，把整个前端模块结构和源码路径公开出去，所以不进发布包。
rm -f "$STAGE/web/public/stats.html"

echo "[3/8] 写版本号: web/package.json(version, daemonVersion) 与 daemon/package.json(version)…"
node -e '
const fs = require("fs");
const [stage, version] = process.argv.slice(1);
const stamp = (file, keys) => {
  const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const key of keys) pkg[key] = version;
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
};
stamp(`${stage}/web/package.json`, ["version", "daemonVersion"]);
stamp(`${stage}/daemon/package.json`, ["version"]);
' "$STAGE" "$VERSION"

if [ "$SKIP_LIB" -eq 0 ]; then
  echo "[4/8] 准备 daemon/lib 二进制（pty / 7z / file_zip，全架构；走 http_proxy 环境变量）…"
  LIB_CACHE="$OUT/.lib-cache"
  mkdir -p "$LIB_CACHE" "$STAGE/daemon/lib"
  # 清单与 dockerfile/daemon.dockerfile 共用。缓存在 dist-release/.lib-cache/，
  # 重复打包就不必再下一遍（-nc 跳过已存在的文件）。
  find "$LIB_CACHE" -type f -empty -delete # 上次下载中断留下的 0 字节文件，-nc 不会重下
  wget -q -nc --tries=3 --timeout=60 --input-file="$ROOT/lib-urls.txt" \
    --directory-prefix="$LIB_CACHE"
  # 这些二进制会在每台 daemon 主机上以真实权限运行，而上游既不签名也不发布校验和。
  # lib-checksums.txt 是我们自己钉下来的一份，能挡住上游被改、传输被劫、本地缓存被
  # 投毒这几种情况 —— 首次信任仍然是盲的（TOFU），但之后的任何变动都会在这里暴露。
  if [ "$REFRESH_LIB" -eq 1 ]; then
    cp -f "$LIB_CACHE"/* "$STAGE/daemon/lib/"
    # 文件名走 find -print0 而不是 $(ls)：缓存里要是有个叫 --status 的文件，
    # 展开后会被 sha256sum 当成选项；带空格的名字也会被词分割拆散。
    (
      cd "$STAGE/daemon/lib"
      find . -maxdepth 1 -mindepth 1 -type f -printf '%f\0' |
        LC_ALL=C sort -z | xargs -0r sha256sum -- >"$ROOT/lib-checksums.txt"
    )
    echo "      已刷新 lib-checksums.txt —— 提交前请人工核对 git diff"
  else
    if [ ! -f "$ROOT/lib-checksums.txt" ]; then
      echo "缺少 lib-checksums.txt。确认来源可信后用 --refresh-lib-checksums 生成一份" >&2
      exit 1
    fi
    # 条目数要和 URL 数对得上：清单被截断或清空时，下面的 sha256sum -c 只会"没什么可查"，
    # 不会报错，校验就悄悄失效了。
    url_count="$(grep -cE '^https?://' "$ROOT/lib-urls.txt")"
    sum_count="$(grep -c . "$ROOT/lib-checksums.txt")"
    if [ "$sum_count" -ne "$url_count" ]; then
      echo "lib-checksums.txt 有 $sum_count 条，lib-urls.txt 有 $url_count 个 URL —— 对不上，清单可能被改过" >&2
      exit 1
    fi
    # 只拷清单里列出的文件。`cp "$LIB_CACHE"/*` 会把缓存里多出来的任何东西一并带进
    # 发布包，而 sha256sum -c 只核对清单内的条目，那个多出来的文件不会被任何一步发现。
    while IFS= read -r libname; do
      if [ -z "$libname" ]; then continue; fi
      if [ ! -f "$LIB_CACHE/$libname" ]; then
        echo "缓存里没有 $libname（lib-checksums.txt 里列着它）" >&2
        exit 1
      fi
      cp -f "$LIB_CACHE/$libname" "$STAGE/daemon/lib/$libname"
    done < <(sed 's/^[0-9a-f]\{64\}[[:space:]][[:space:]]*//' "$ROOT/lib-checksums.txt")
    if ! (cd "$STAGE/daemon/lib" && sha256sum -c --quiet "$ROOT/lib-checksums.txt"); then
      echo "" >&2
      echo "lib 二进制的校验和对不上（上面列出了具体文件）。" >&2
      echo "可能是上游发了新版本，也可能内容被动过手脚 —— 别直接跳过。" >&2
      echo "核实无误后：bash scripts/release/pack.sh <版本> --refresh-lib-checksums" >&2
      echo "然后人工 review lib-checksums.txt 的 diff 再提交。" >&2
      exit 1
    fi
    echo "      lib 二进制校验和通过（$sum_count 个文件）"
  fi
  chmod a+x "$STAGE/daemon/lib"/*
else
  echo "[4/8] 跳过 lib 二进制下载 —— 这个包不能部署（daemon 启动会因缺 file_zip 直接退出），仅用于验证打包流程"
fi

echo "[5/8] 收集部署脚本与特权配置…"
cp -r "$ROOT/prod-scripts" "$STAGE/prod-scripts"
if [ ! -d "$ROOT/deploy" ]; then
  echo "deploy/ 不存在 —— 没有 install.sh 的包装不上，不产出这种包" >&2
  exit 1
fi
# deploy/ 的内容摊到包根，install.sh 就和 VERSION、daemon/、web/ 同级，
# 于是解包后直接 `sudo bash install.sh` 即可（它以此判断自己在包内运行）。
cp -r "$ROOT/deploy/." "$STAGE/"

echo "[6/8] 写 VERSION …"
{
  printf 'version=%s\n' "$VERSION"
  printf 'commit=%s\n' "$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  printf 'built_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'node_required=20\n'
  printf 'arch=x64,arm64\n'
} >"$STAGE/VERSION"

echo "[7/8] 校验包内清单…"
missing=0
check() {
  if [ ! -e "$STAGE/$1" ]; then
    echo "      缺失: $1" >&2
    missing=1
  fi
}

for entry in \
  VERSION \
  web/app.js web/package.json web/public/index.html \
  web/node_modules/koa/package.json \
  daemon/app.js daemon/proc_scan_worker.js daemon/package.json \
  daemon/node_modules/koa/package.json \
  prod-scripts/ci-panel-runner-svc \
  prod-scripts/install-runner-privileges.sh \
  install.sh \
  update.sh \
  ci-panel-ctl \
  lib/common.sh \
  systemd/ci-panel-daemon.service.tmpl \
  systemd/ci-panel-web.service.tmpl; do
  check "$entry"
done

# 占位符必须还在 —— 渲染是 install.sh / update.sh 在目标机上做的
for tmpl in "$STAGE"/systemd/*.service.tmpl; do
  # systemd/ 不存在时 glob 不展开，$tmpl 会是字面量，报出来的三条 "没有 __USER__"
  # 会盖过真正的原因（上面的 check 已经报过"缺失 systemd/..."）
  if [ ! -f "$tmpl" ]; then continue; fi
  for token in __USER__ __ROOT__ __NODE__; do
    if ! grep -q "$token" "$tmpl"; then
      echo "      ${tmpl#"$STAGE"/} 里没有 $token —— 模板被改坏了？" >&2
      missing=1
    fi
  done
done
if [ -f "$STAGE/ci-panel-ctl" ] && ! grep -q '__ROOT__' "$STAGE/ci-panel-ctl"; then
  echo "      ci-panel-ctl 里没有 __ROOT__ —— 渲染占位符被改坏了？" >&2
  missing=1
fi

if [ "$SKIP_LIB" -eq 0 ]; then
  for arch in x64 arm64; do
    check "daemon/lib/pty_linux_$arch"
    check "daemon/lib/7z_linux_$arch"
    check "daemon/lib/file_zip_linux_$arch"
  done
fi

# 版本号必须真的落到那三个字段上，否则节点"待更新"告警会常亮或永不亮
if ! node -e '
const fs = require("fs");
const [stage, want] = process.argv.slice(1);
const web = JSON.parse(fs.readFileSync(`${stage}/web/package.json`, "utf8"));
const daemon = JSON.parse(fs.readFileSync(`${stage}/daemon/package.json`, "utf8"));
const got = {
  "web.version": web.version,
  "web.daemonVersion": web.daemonVersion,
  "daemon.version": daemon.version
};
const bad = Object.entries(got).filter(([, value]) => value !== want);
if (bad.length) {
  console.error("      版本号未写入: " + bad.map(([k, v]) => `${k}=${v}`).join(", "));
  process.exit(1);
}
' "$STAGE" "$VERSION"; then
  missing=1
fi

if [ "$missing" -ne 0 ]; then
  echo "包内容不完整，已中止（stage 保留在 ${STAGE#"$ROOT"/} 便于排查）" >&2
  exit 1
fi

echo "[8/8] 打包与校验和…"
rm -f "$TARBALL" "$TARBALL.sha256"
tar -C "$OUT" --owner=0 --group=0 --numeric-owner -czf "$TARBALL" "ci-panel-$VERSION"
(cd "$OUT" && sha256sum "$(basename "$TARBALL")" >"$(basename "$TARBALL").sha256")

echo
echo "完成: ${TARBALL#"$ROOT"/}"
echo "      大小 $(du -h "$TARBALL" | cut -f1)   sha256 $(cut -d' ' -f1 "$TARBALL.sha256")"
echo "下一步: bash scripts/release/smoke-test.sh ${TARBALL#"$ROOT"/}"
