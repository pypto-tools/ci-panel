# 部署与更新

面向运维：把 ci-panel 装到一台新机器上，以及后续怎么更新、怎么回滚。
开发环境搭建见 [DEVELOPMENT.md](DEVELOPMENT.md)。

## 结构与前提

ci-panel 是 **一个 panel + 多个 daemon 节点**。panel 只是控制面，实际干活的是各台机器上的
daemon。加机器就是加节点，panel 和已有 runner 全程不用动。

一台机器装成什么由 `--role` 决定：

| role | 装什么 | 用在哪 |
| --- | --- | --- |
| `daemon`（默认） | 只有 daemon | 跑 runner 的机器。**最常用** |
| `web` | 只有面板，不装 daemon、不配特权助手 | 专职的管理机 |
| `all` | 面板 + 本机 daemon | 面板机自己也要跑 runner |

包里始终带着 `web/`（约 64MB），但 `--role daemon` 时它只是躺在磁盘上——不渲染单元、
不启动、不占端口。这是"单一 tarball"的取舍：同一个包发布能保证面板和节点的版本不漂移
（面板会拿 `daemonVersion` 比对各节点上报的版本），代价是每台纯节点多占些磁盘。

一个发布包同时含 x64 与 arm64 的二进制，一个包通用。四个 npm 包里没有原生模块，
按架构分文件的只有 `daemon/lib/` 下的 pty / 7z / file_zip，运行时自己挑。

目标机需要：

| 项 | 说明 |
| --- | --- |
| Linux + systemd | 装的是 systemd 单元；daemon 托管 runner 也依赖 systemd |
| node ≥ 20 | 没有就加 `--install-node`，脚本会把官方运行时放到 `<root>/runtime/` |
| root | 要装单元、配 sudoers 白名单 |
| 防火墙放开 daemon 端口 | 默认 24444，**节点连不上最常见的原因就是这个** |

## 发版（维护者）

打一个 `cip-v*` 的 tag，[release workflow](.github/workflows/release.yml) 会构建、
smoke-test、然后发布 Release：

```bash
git tag cip-v1.0.0 && git push origin cip-v1.0.0
```

前缀是 `cip-v` 而不是裸的 `v`——仓库里有一百多个从上游 MCSManager 继承的 `v9.x`/`v10.x`
tag，共用命名空间会让版本语义混乱。也可以在 Actions 页面手动触发（`workflow_dispatch`）。

本地打包（内网发布、或想先验证）：

```bash
bash scripts/release/pack.sh 1.0.0
bash scripts/release/smoke-test.sh dist-release/ci-panel-1.0.0-linux.tar.gz
```

`pack.sh` 不会影响本机在跑的服务：`build.sh` 会把 `daemon/production/app.js` 移走，
脚本退出前会把**打包前那一份**原样放回。

## 装一个 runner 节点

### 1. 取包

```bash
TAG=$(curl -fsSL https://api.github.com/repos/pypto-tools/ci-panel/releases/latest \
      | grep -o '"tag_name": *"[^"]*"' | cut -d'"' -f4)
VER=${TAG#cip-v}
curl -fLO "https://github.com/pypto-tools/ci-panel/releases/download/$TAG/ci-panel-$VER-linux.tar.gz"
curl -fLO "https://github.com/pypto-tools/ci-panel/releases/download/$TAG/ci-panel-$VER-linux.tar.gz.sha256"
sha256sum -c "ci-panel-$VER-linux.tar.gz.sha256"
tar xzf "ci-panel-$VER-linux.tar.gz" && cd "ci-panel-$VER"
```

### 2. 安装

```bash
sudo bash install.sh --scan-root /data/ci-runner
```

常用参数（全部见 `bash install.sh --help`）：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--scan-root <path>` | `/data/ci-runner` | runner 根目录，写进特权助手的 `ALLOWED_ROOT` |
| `--user <name>` | `ci-runner` | daemon 运行用户，也是 runner 目录属主；不存在会问你是否创建 |
| `--root <path>` | `/opt/ci-panel` | 安装根目录。**若 `/data` 是单独挂载的，它和 `--scan-root` 的默认值就不在同一块盘上** —— 见下方"装在哪块盘上" |
| `--daemon-port <n>` | `24444` | 只在首次安装写入配置 |
| `--runner-pkg <path>` | — | 预置 GitHub runner 安装包，省掉首次创建时现场下载约 130MB |
| `--install-node` | — | 没有 node ≥ 20 时下载官方运行时 |
| `--role web\|all` | `daemon` | `web`=只装面板；`all`=面板加本机 daemon |
| `--web-port <n>` | `23333` | 面板端口，只在首次安装写入配置 |
| `--yes` | — | 不做交互确认 |

脚本做完这些事：解包到 `releases/<版本>/`、把 `data`/`logs`/`tmp` 软链到 `shared/`、
写初始配置、跑 [prod-scripts/install-runner-privileges.sh](prod-scripts/README.md)
配好 sudo 白名单、装 systemd 单元、切 `current` 软链、启动并探活。

**重复运行是安全的**：`shared/` 里的数据、daemon 的身份密钥、`.env` 里已有的值都不会被覆盖。

### 装在哪块盘上

daemon 的配置（含它的身份密钥）和日志都写在 `--root` 下的 `shared/`。**那块盘一旦被写满，
节点就会失联** —— 面板发过去的请求写盘失败，而 runner 那侧可能一切正常。

`--root` 和 `--scan-root` 的默认值只是两个目录路径，**是不是落在不同的盘上取决于这台机器怎么
分区** —— `/data` 单独挂载时才是两块盘，单根文件系统的机器上两者同盘，下面说的问题不存在。
先 `df -h /opt /data` 看一眼。真正要小心的是这种典型配置：系统盘几百 G 且被家目录、构建缓存
共用，数据盘几 T 专供 runner —— 此时默认值会把管控面放在小的那块上。

脚本会检查 `--root` 所在文件系统，不足 2GB 直接拒绝（装机和升级都做），解包用的临时目录另外
检查。**跨盘提示只在装机时给** —— 升级路径读不到 `--scan-root`，它不写进 `.env`。提示的内容是
改用 `--root <数据盘挂载点>/ci-panel`。

已经装好的机器要迁移，把 `shared/` 挪过去再软链回来即可（`releases/*/daemon/{data,logs,tmp}`
指的是 `$ROOT/shared/...`，会穿过这层软链）：

```bash
sudo systemctl stop ci-panel-daemon
sudo mkdir -p /data/ci-panel
# 目标不能已存在，否则 mv 会把 shared/ 塞进它里面变成 shared/shared。
# 用 && 串起来而不是 exit：这段是给人整段贴进 root shell 的，此时 daemon 已经停了，
# 一个 exit 会把这个 shell 一起带走。
[ ! -e /data/ci-panel/shared ] \
  && sudo mv /opt/ci-panel/shared /data/ci-panel/shared \
  && sudo ln -s /data/ci-panel/shared /opt/ci-panel/shared \
  && sudo systemctl start ci-panel-daemon
```

搬完确认一下软链和落盘位置：

```bash
ls -l /opt/ci-panel/shared
df -h /opt/ci-panel/current/daemon/data
```

### 3. 在面板里添加节点

装完会直接打印接入信息：

```
在面板里添加这个节点：
  地址   10.x.x.x
  端口   24444
  密钥   <该节点的准入凭据>
```

拿这三个值在面板的节点页面添加即可。密钥等同凭据，只填到面板里。之后随时可以
`sudo ci-panel-ctl node-key` 再看一次。

**不要跨机器拷贝 `daemon/data/Config/global.json`**——里面的 `key` 是这个节点的身份，
两台机器用同一份会互相顶掉。新机器首次启动会自己生成。

## 装面板服务器

面板专机（自己不跑 runner）：

```bash
sudo bash install.sh --role web
```

它只装 `ci-panel-web.service`，**不装 daemon，也不跑特权配置**——纯管理机不需要那套
sudo 授权和 runner 根目录。装完打开 `http://<面板机>:23333` 走安装向导创建管理员账号，
然后把各节点逐台加进来。

启动初期日志里会有"找不到本机守护进程"的告警：panel 启动时会去找同级的 daemon 自动登记
（`remote_service.ts` 的 `initConnectLocalhost`），纯面板机上找不到是正常的，它每 5 秒
重试一次，等你在面板里添加了第一个节点就不再出现。

面板机自己也要跑 runner 的话用 `--role all`，那就还需要 `--scan-root` 等 daemon 侧参数。

## 更新与回滚

```bash
ci-panel-ctl check                  # 当前版本 vs 最新版本
sudo ci-panel-ctl update            # 更新到 latest release
sudo ci-panel-ctl update --version 1.1.0
sudo ci-panel-ctl update --file ./ci-panel-1.1.0-linux.tar.gz   # 离线
sudo ci-panel-ctl rollback          # 切回上一个版本
```

更新是这样保证安全的：

1. 新版本先完整铺到 `releases/<新版本>/`，此时线上还跑着旧的
2. 数据不动——`data`/`logs`/`tmp` 都是指向 `shared/` 的软链
3. 升级前把 `shared/*/data` 备份到 `backups/<时间戳>/`（跳过 `InstanceData`、`runner-pkg` 这类大目录）
4. 切换只是把 `current` 软链原子替换掉
5. 切完重启并探活，**起不来就自动切回旧版本**并以非零退出
6. 最后单独处理特权助手——它装在 `/usr/local/sbin/`，不在 `releases/` 下，切软链带不动它。
   更新会比对助手版本，落后就重装一遍；`ALLOWED_ROOT` 从助手自己的 `preflight` 读回来，
   不用你重传 `--scan-root`

第 6 步失败不会触发回滚：服务本身是好的，只是 runner 管理能力没跟上，脚本会把手动
补救的命令打出来。

**更新不需要重传安装时的参数**。它不"记住"参数，而是从已安装状态反推：`--role` 看装了
哪些 systemd 单元，`--user` 和 node 路径从单元的 `User=` / `ExecStart=` 读，端口在
`shared/daemon/data/Config/global.json`，代理和仓库列表在 `.env`，`--scan-root` 由特权
助手自己保管。这样就算有人装完之后手工改过配置，更新也不会拿旧参数把改动覆盖掉。
唯一例外是 `--root`：直接跑 `bash update.sh` 时默认 `/opt/ci-panel`，装在别处要显式传——
用 `ci-panel-ctl` 则不用管，它记着安装时的根目录。

**对正在跑的 CI job 没有影响**：runner 跑在自己的 `actions.runner.*.service` 单元里，
有独立 cgroup，不是 daemon 的子进程。但**正在进行的 runner 创建/删除会被打断**——
那个流程中途会把 runner 注册到 GitHub，中断可能在 GitHub 上留下一个不上线的 runner。

多节点逐台更新即可。panel 的节点列表会用 `daemonVersion` 比对各节点上报的版本，
落后的节点会亮黄色标记，据此判断哪些还没升。

## 目录布局

```
/opt/ci-panel/
├── releases/<版本>/        每个版本一份；其中 data/logs/tmp 是指向 shared 的软链
├── current -> releases/…   systemd 的 WorkingDirectory 指着它，回滚就是切它
├── shared/daemon/data      节点身份、runner 安装包、实例数据 —— 数据唯一真相源
├── shared/daemon/logs      daemon 自己写的日志（current.log）
├── shared/web/…            --role web / all 时才有
├── backups/<时间戳>/       更新前的数据快照
├── runtime/                --install-node 下载的 node
└── .env                    CIP_* 环境变量，600 root:root
```

数据必须放在 `shared/` 而不是跟着 release 走，是因为 panel 和 daemon 的数据路径全部基于
`process.cwd()` 拼出来（`daemon/src/service/system_file.ts`、
`panel/src/app/common/storage/jsonl_storage.ts`）。换 release 目录升级会把用户、
节点表和 daemon 身份一起留在旧目录里。

## 环境变量（`.env`）

两组变量的归属不同，**只装了 daemon 的机器上，panel 那组没有进程会读**：

| 变量 | 谁读 | 作用 |
| --- | --- | --- |
| `CIP_RUNNER_PROXY` | daemon | 拉 runner 安装包和跑 `config.sh` 注册时的代理兜底；前端表单填了就用表单的 |
| `CIP_GITHUB_REPOS` | panel | CI Job 看板的仓库列表。**只在面板仓库列表为空时导入一次**，之后由面板 UI 管理 |
| `CIP_GITHUB_TOKEN` | panel | 各仓库没配专用 PAT 时的全局兜底 |

改完要 `sudo ci-panel-ctl restart` 才生效。这个文件是 600 root:root，但终究是明文，
不要复制到别处。

## 离线 / 内网部署

目标机连不上 GitHub 时：

```bash
# 有网的机器上打包（或从 Release 下载），然后拷过去
scp ci-panel-1.0.0-linux.tar.gz* 目标机:~/
# 目标机上
tar xzf ci-panel-1.0.0-linux.tar.gz && cd ci-panel-1.0.0
sudo bash install.sh --scan-root /data/ci-runner \
     --runner-pkg ~/actions-runner-linux-arm64-2.331.0.tar.gz
```

包里已经含全部生产依赖（`node_modules` 打包在内），装的时候不碰 npm registry。
后续更新用 `sudo ci-panel-ctl update --file <新包>`。

`--runner-pkg` 的**架构必须和目标机一致**（脚本会校验文件名里的 `linux-<arch>`），
arm64 的包在 x64 上解出来跑不了。不给这个参数的话，首次创建 runner 时 daemon 会现场下载。

## 接管已被纳管的 runner

装 daemon 的机器上，如果 runner 早先被**另一个 daemon 实例**纳管过（常见于原本用开发实例
管理、后来改成 systemd 部署），新 daemon 会陷入一个自相矛盾的状态：导入页面把它们置灰说
"已纳管"，runner 列表却是空的，两边都没有入口。

原因是纳管关系记在两个地方，而它们的生命周期不同：

| 记在哪 | 跟着谁 | 换 daemon 时 |
| --- | --- | --- |
| `<runner 目录>/.cipanel` | runner 目录 | 留在原地 |
| `<data>/InstanceConfig/<uuid>.json` | daemon 的 data 目录 | 新装的是空的 |

`.cipanel` 是纳管关系的唯一真相源（见 `daemon/src/service/runner_marker.ts`），所以新
daemon 认得出"已被纳管"，但它自己没有对应的实例记录，于是列不出来。

把旧实例配置搬过去即可，它们只认 `cwd` 里的绝对路径，不跟任何 daemon 绑定：

整段都要 root —— 要写 `/opt/ci-panel` 下的文件并改属主：

```bash
OLD=<旧 daemon>/data/InstanceConfig
NEW=/opt/ci-panel/shared/daemon/data/InstanceConfig
sudo cp -a "$NEW" /tmp/instconf-backup                 # 先留个底
for f in "$OLD"/*.json; do
  # global0001 是 daemon 内建的全局实例，新 daemon 自己有一份，别覆盖
  [ "$(basename "$f")" = global0001.json ] && continue
  sudo cp -p "$f" "$NEW/"
done
sudo chown -R <运行用户>: "$NEW"
sudo systemctl restart ci-panel-daemon
```

daemon 只在**启动时**加载实例，所以必须重启才生效。日志里
`[runner-scan] 已纳管（经句柄实例发现）：N 个` 应该从 0 变成实际数量。

彻底重来也是一个选择：删掉各 runner 目录下的 `.cipanel`，再从面板重新导入 —— 代价是
marker 里记的 group 和注册标签会丢。

## 给节点控制面预留 CPU

节点机器把 CPU 吃到 100% 是常态。单元模板里已经带了三条设置，装完即生效：
`Nice=-10`（约 9 倍于普通任务的 CFS 权重）、`CPUWeight=1000`、`OOMScoreAdjust=-800`。
对一个稳态用不到一个核的控制面，这通常就够了。

这三个值会被子进程继承。systemd 托管的 runner 在自己的单元里，不受影响。process 托管
（`CIP_RUNNER_SUPERVISOR=process`，或特权助手不可用时自动退到它）下 run.sh 是 daemon 的
子进程：daemon 会在 spawn 之后立刻把它调回 nice 0 / oom_score_adj 0，但**调不回 cgroup**——
这些 runner 与 daemon 同在一个 cgroup 里，共享那份 `CPUWeight=1000`。

**先确认 daemon 慢是不是真的因为抢不到 CPU。** 面板显示节点不可用，更常见的原因是
daemon 自己在做阻塞的活儿，而不是被饿着。先看 `daemon/logs/current.log` 里的资源报告和
`systemd-cgtop`，再考虑下面这些。

真要做硬预留（把若干个核只留给 ci-panel），**必须两边一起配**：只把 daemon 钉在 0-1 号核、
却不把负载从这两个核上赶走，等于让它从「和 320 个核的负载竞争」变成「在 2 个核上和同样的
负载竞争」——比不配更糟。

先看这台机器是 cgroup v1 还是 v2：

```bash
stat -fc %T /sys/fs/cgroup     # cgroup2fs = v2；tmpfs = v1
```

### cgroup v2（systemd 244+）

控制面侧，加 drop-in（不要改模板：核数因机器而异）：

```bash
sudo systemctl edit ci-panel-daemon.service
```

```ini
[Service]
AllowedCPUs=0-1
```

负载侧，把这两个核排除掉，按你的负载管理方式选一种：

```ini
# runner 的 systemd 单元（对 actions.runner-.slice 或逐个单元加 drop-in）
[Service]
AllowedCPUs=2-319
```

```bash
docker run --cpuset-cpus=2-319 …            # docker
kubelet --reserved-cpus=0,1                  # kubernetes，配 cpuManagerPolicy=static
```

### cgroup v1

systemd 的 `AllowedCPUs=` 在 v1 上**会被静默忽略**（它要 v2 的 cpuset 控制器）。用
`taskset` 代替：

```ini
[Service]
ExecStart=
ExecStart=/usr/bin/taskset -c 0-1 /path/to/node --enable-source-maps --max-old-space-size=8192 app.js
```

（`ExecStart=` 空行是必须的：drop-in 里不清空就变成追加第二条启动命令。路径要和
`/etc/systemd/system/ci-panel-daemon.service` 里那条一致。）

负载侧同样用 `--cpuset-cpus`（docker）或给它们的启动命令套 `taskset -c 2-319`。

### 不建议：实时调度

`CPUSchedulingPolicy=fifo` 确实能抢在所有普通任务之前，但它作用于进程的**全部线程**，包括
`UV_THREADPOOL_SIZE` 那 32 个正在扫 `/proc` 的线程。任何一个线程忙等都会拖住整台机器
（内核默认只留 5% 给非实时任务兜底）。对一个 I/O 密集的控制面，它比 `Nice=-10` 多不了多少
收益，炸的范围却是整台机器。

## 排障

| 现象 | 先查这里 |
| --- | --- |
| 面板里节点连不上 | 防火墙有没有放开 daemon 端口；`ci-panel-ctl status` 看服务是否 active |
| daemon 起不来 | `ci-panel-ctl logs`（systemd 日志）与 `ci-panel-ctl applog`（应用日志） |
| 安装时报"用户 X 跑不了 node" | 那个 node 装在别的用户 home 里；换系统级 node，或加 `--install-node` |
| 创建 runner 失败，GitHub 上留下不上线的 runner | 特权没配好：`sudo bash <root>/current/prod-scripts/install-runner-privileges.sh --check` |
| 拉 runner 安装包很慢或失败 | `.env` 里设 `CIP_RUNNER_PROXY`，或用 `--runner-pkg` 预置 |
| 更新后服务异常 | `sudo ci-panel-ctl rollback`；数据快照在 `backups/` |
| 面板上 runner 显示"已纳管"却加不进列表 | 这台机器的 runner 曾被另一个 daemon 纳管过，实例记录没跟过来。见上方"接管已被纳管的 runner" |

`ci-panel-ctl` 的完整命令见 `ci-panel-ctl --help`。特权助手的授权边界、为什么启停也要走
助手，见 [prod-scripts/README.md](prod-scripts/README.md)。
