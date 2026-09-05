# JM Web —— 自部署网页版漫画阅读站

[![LINUX DO](https://img.shields.io/badge/LINUX%20DO-%E7%A4%BE%E5%8C%BA%E8%AE%A4%E5%8F%AF-FFB003?style=for-the-badge&logo=discourse&logoColor=white)](https://linux.do/)

参照 [jmcomic-next](https://github.com/HongShi2333/jmcomic-next) 与 [jm-mobile](https://github.com/Dedicatus546/jm-mobile)
两个安卓客户端的通信协议，实现的**网页版本**。电脑、手机浏览器均可使用（响应式布局）。

> ⚠️ NSFW 警告：本项目可能包含不适宜公共场合的内容，未成年人请勿使用。
> 本项目仅供学习、研究和技术交流使用，与任何第三方服务无关；请自行遵守当地法律法规，使用产生的一切风险由使用者自行承担。

## 功能

- **发现内容**：首页轮播及多区块推荐、个性化继续阅读、主/子分类、总/月/周/日排行、热门标签、每周必看。
- **搜索**：关键词、作者、标签或 JM 编号；四种排序、无限滚动、搜索历史、`-标签` 排除语法和可复用排除模板。
- **漫画详情与社交**：封面、标签、简介、章节、相关漫画、复制 JM 号、点赞、收藏；评论、嵌套回复、点赞和发表评论。
- **账号数据**：登录/自动登录、签到日历、收藏列表及浏览器本地收藏夹（新建、改名、删除、批量移动）、云端阅读历史、评论历史。
- **完整阅读器**：连续滚动、正序/RTL 单页、点击翻页四种模式；前后预解码、章节跳转、进度恢复、页码、亮度、Wake Lock、1–4x 缩放、工具栏自动隐藏、点击区域、内存优化和解码并发设置；阅读中可热切换主题、图片线路和预加载，并提供一次性操作引导。
- **图片还原**：使用与安卓客户端相同的扰乱规则在浏览器模块 Worker + OffscreenCanvas 解码；不支持时自动回退主线程 Canvas，下载时保存解扰后的图片。
- **下载与离线**：IndexedDB 离线资料库、可批量暂停/继续/重试/移除的持久下载队列、断点补页、完整性检查、存储统计/清理和离线阅读；恢复备份时可按原整本/选章意图重建下载任务。
- **导出与 PWA**：整本/单章 ZIP、浏览器打印为 PDF、Service Worker、Web App Manifest 和可安装 PWA 外壳。
- **外观与过滤**：浅色/深色/跟随系统、五套调色板与自定义四色、各页面网格列数、全局/首页标签过滤。
- **隐私与迁移**：PIN/口令、图案锁、WebAuthn 设备验证、任一/全部验证规则、失焦伪装；JSON 或 PBKDF2 + AES-GCM 加密备份恢复。
- **AI 与工具**：可选 OpenAI-compatible 流式对话、多会话、人格、停止/编辑/重试/详细/精简、Tavily 联网搜索；漫画编号提取及剪贴板检测。
- **章节 AI 分析（可选）**：复用上述 AI 配置，按热门/访问候选在后台自动排队分析章节，生成标题、详细剧情和简洁总结。上游已有章节名优先保留，缺失章节名时才使用 AI 标题；完整结果持久化并可通过 `/api/chapter-ai` 查询，详细剧情和简洁总结当前不直接显示。
- **运维**：API/图片多线路故障切换、可选 DoH 预解析与测速、运行日志、缓存维护、健康检查和 GitHub Release 更新检查。
- **响应式体验**：手机列表支持下拉刷新与首屏骨架；桌面搜索新页面自动聚焦，触屏端等待用户主动点按以避免系统编辑浮层；桌面和手机返回/前进时均按独立路由记录恢复滚动位置。

> Web 与 Android 平台能力不同：Android WorkManager 对应为浏览器内持久下载队列（关闭页面后暂停、下次进入续传）；Android 系统 PDF 写入对应为浏览器打印“另存为 PDF”；桌面图标伪装对应为失焦隐私遮罩。浏览器本地收藏夹与历史删除是当前浏览器会话视图，不会改动不支持这些操作的上游账号数据。

### 章节 AI 分析

章节分析是服务端后台任务，不会阻塞阅读。配置 `AI_API_KEY` 后启用，默认使用 `grok-4.6`，也可以通过 `AI_MODEL` 更换其他 OpenAI-compatible 视觉模型。系统会按热门内容和用户访问记录选择候选章节，顺序读取并解扰整章图片后一次生成章节标题、详细剧情和简洁总结。

上游已有章节名时会优先保留；只有章节名缺失时才用生成标题补全。分析结果保存在服务端，当前章节列表只使用补全后的标题，详细剧情和简洁总结暂不直接展示；完整记录可通过 `GET /api/chapter-ai?aid=<漫画 ID>&photoId=<章节 ID>` 查询。

## 部署

### 方式一：直接运行（推荐）

服务器需有 Node.js **20.0.0 或更高**版本（零运行时依赖，无需 `npm install`）。生产环境建议使用仍在安全维护期内的 LTS 版本；项目 Docker 构建基线固定为 `node:22.23.2-alpine3.24`，升级需经过显式评审与回归：

```bash
git clone <本项目目录> jm-web   # 或直接上传 jm-web 文件夹
cd jm-web
node server.js                 # 默认仅监听 127.0.0.1:3210
```

启用访问口令或修改端口时，按当前 Shell 设置环境变量：

```bash
# Linux / macOS
ACCESS_PASSWORD='请替换为独立的长随机口令' HOST=127.0.0.1 PORT=3210 node server.js
```

```powershell
# Windows PowerShell
$env:ACCESS_PASSWORD = '请替换为独立的长随机口令'
$env:HOST = '127.0.0.1'
$env:PORT = '3210'
node .\server.js
```

直接运行默认使用 `HOST=127.0.0.1`。需要经同机反向代理或直接接受其他机器连接时再使用 `0.0.0.0`，并同时启用访问口令与 HTTPS。`PORT` 必须是 `1`–`65535` 的十进制整数。

从其他机器迁移代码时不要一并分发现有 `data/`：其中包含服务器密钥、设置和登录会话。直接运行时程序可自动创建该目录；Compose 部署需按下文先创建并授权。只有明确进行同一实例的数据迁移时才应停服后单独、安全地复制它。`data/` 和本地 `.env` 均已从 Git 与 Docker 构建上下文排除。

升级到包含会话安全修复的版本前，先备份同一实例的 `data/.secret`、`data/sessions/`、`data/settings.json` 和生产 `.env`。服务首次启动会在会话目录创建短时 `.sanitize.lock`，扫描并原子脱敏旧用户资料中的认证字段；损坏、过大或扫描期间发生变化的文件不会被覆盖。迁移统计只写入启动日志，不包含会话内容。

生产环境建议用 systemd / pm2 守护：

```bash
pm2 start server.js --name jm-web
```

### 方式二：Docker

推荐使用 Compose 和本地 `.env`：

```bash
cd jm-web
cp .env.example .env           # Linux / macOS
# 仅原生 Linux Docker 需要把 bind mount 授权给镜像内的非 root 用户。
mkdir -p data
sudo chown -R 1000:1000 data
chmod 700 data
```

```powershell
cd jm-web
Copy-Item .env.example .env    # Windows PowerShell
New-Item -ItemType Directory -Force data | Out-Null
```

编辑 `.env` 并设置高强度 `ACCESS_PASSWORD`，然后执行：

```bash
docker compose --env-file .env config --quiet  # 仅校验，不把口令/密钥展开到终端或日志
docker compose up -d
```

Compose 默认只将 `127.0.0.1:3210` 发布到宿主机，适合同机 Nginx/Caddy 反向代理，不会绕过 HTTPS 直接暴露后端。需要从其他机器直连时，在 `.env` 中设置 `JMW_PUBLISH_HOST=0.0.0.0`；宿主机端口由 `JMW_PUBLISH_PORT` 控制，容器内端口由 `PORT` 控制，两者可不同。这两个端口都必须位于 `1`–`65535`，发布地址必须是宿主机可绑定的 IP。

无口令运维模式只信任**无任何代理头的直接 TCP 回环连接**，并校验回环 `Host`、同源浏览器元数据和 JSON 媒体类型；它刻意不信任 Docker 端口 NAT 或反向代理。因此 Compose/Nginx/Caddy 部署即使仅发布到宿主机回环，也应设置 `ACCESS_PASSWORD`，否则普通浏览功能仍可用，但日志、DoH 修改/测速等运维功能会 fail closed。不要让代理删除来源标识后把远端伪装成本机。

默认 Compose 配置以 uid/gid `1000:1000` 的非 root 用户运行，同时启用只读根文件系统、移除 Linux capabilities、禁止提权，并仅让 `/app/data` 持久化可写；运行数据不会写入镜像。为避免 Docker 用 root 身份静默创建目录，Compose 要求 `JMW_HOST_DATA_DIR` 在启动前已经存在；原生 Linux 上该目录必须可由 `1000:1000` 写入。它可以改为仓库外的绝对路径，目录及其备份应按敏感凭据管理。

单实例默认限制为 `1.0` CPU、`512m` 内存和 `256` 个进程，Docker `json-file` 日志按 `10m × 3` 轮转；图片代理默认最多同时处理 `12` 个请求，单个客户端最多 `6` 个，另有 `96` 个等待队列（单请求最多等待 3 秒）。可通过 `.env` 中的 `JMW_CPU_LIMIT`、`JMW_MEMORY_LIMIT`、`JMW_PIDS_LIMIT`、`JMW_LOG_MAX_SIZE`、`JMW_LOG_MAX_FILE`、`JMW_MAX_IMAGE_CONCURRENCY`、`JMW_MAX_IMAGE_CONCURRENCY_PER_IP`、`JMW_IMAGE_QUEUE_LIMIT`、`JMW_IMAGE_QUEUE_TIMEOUT` 调整。调整前应基于容量测试确定水位，不能直接删除上限。

图片代理只做白名单校验、并发控制和流式转发，不在服务端把整章下载到内存或执行解扰；封面/缩略图会进入有界的进程内 LRU 缓存（默认总计 64 MiB、单张 2 MiB、保存 24 小时），章节正文仍保持流式转发，重启后缓存自动清空。上游暂时超时或 5xx 时，前端会以退避方式有限重试，后端也会短暂跳过故障线路。解扰在浏览器中进行。支持的浏览器会把解扰放入模块 Worker/OffscreenCanvas，减少阅读器主线程卡顿；旧 Safari/WebView 自动回退主线程 Canvas。阅读器会按设备内存以字节预算回收原图缓存，并在创建 Canvas 前拒绝超大或单轴过长的条漫图片。公网部署仍建议保持访问口令、反向代理和单实例资源上限，不要把它当作多人共享的无认证图片代理。

基础镜像默认固定 Node 与 Alpine 的补丁版本；生产发布还应将多架构 manifest digest 纳入制品清单。先用 `docker buildx imagetools inspect node:22.23.2-alpine3.24` 从可信仓库核验摘要，再把 `.env` 的 `JMW_NODE_IMAGE` 设置为 `node:22.23.2-alpine3.24@sha256:<核验得到的摘要>`。摘要与平台有关且会随版本升级，本仓库不写入未经当前构建环境验证的值。

不使用 Compose 时可用 Docker 命名卷，该写法在 Linux、macOS 和 PowerShell 中一致：

```bash
docker build -t jm-web .
docker volume create jm-web-data
docker run -d --name jm-web --restart unless-stopped --user 1000:1000 --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m --cap-drop=ALL --security-opt=no-new-privileges=true --cpus=1 --memory=512m --pids-limit=256 --log-opt max-size=10m --log-opt max-file=3 -p 127.0.0.1:3210:3210 --mount type=volume,source=jm-web-data,target=/app/data --env-file .env -e PORT=3210 -e HOST=0.0.0.0 -e JMW_DATA_DIR=/app/data jm-web
```

#### 使用 GitHub Actions 发布的预构建镜像

仓库内的 `.github/workflows/docker-publish.yml` 会在测试通过后，使用 GitHub Actions
构建并发布 `linux/amd64`（x86_64）和 `linux/arm64`（64 位 ARM）镜像到 GHCR，
不需要维护者准备 ARM 机器。推送 `v1.2.3` 这样的版本标签时会生成 `latest`、
`1.2.3`、`1.2` 和 `1` 标签；`main` 分支会生成 `latest` 与 `edge`，其中 `edge`
适合测试最新代码。生产环境建议在版本标签生成后固定到具体版本或 digest。

维护者首次发布后，需要在 GitHub 的 **Packages → jm-web → Package settings** 中确认包的
可见性。个人或小范围部署建议保持 **Private**，只向需要部署的账号授予 read:packages；
公开包虽然部署最方便，但镜像层仍包含 `server.js`、`lib/` 和前端资源，能拉取镜像的人
可以解出这些文件，不能把“公开镜像”当作源码保密方案。无论可见性如何，生产环境都应
使用具体版本或 digest，而不是长期跟随 `latest`。

只部署镜像的用户可以先准备配置和持久化目录，再用 Compose 覆盖文件跳过本地构建
（需要 Docker Compose v2.24 或更高版本，以支持 `!reset`）：

```bash
git clone https://github.com/shixian64/jm-web.git
cd jm-web
cp .env.example .env
mkdir -p data
sudo chown -R 1000:1000 data
# 编辑 .env，至少设置高强度 ACCESS_PASSWORD

docker compose --env-file .env \
  -f docker-compose.yml -f docker-compose.ghcr.yml config --quiet
docker compose --env-file .env \
  -f docker-compose.yml -f docker-compose.ghcr.yml up -d --pull always --no-build
```

`docker-compose.ghcr.yml` 默认使用 `ghcr.io/shixian64/jm-web:latest`；Fork 本仓库或
使用自己的构建时，在 `.env` 中设置 `JMW_IMAGE=ghcr.io/<owner>/jm-web:<tag>`。
公开包无需登录 GHCR；私有包则先执行 `docker login ghcr.io`。升级时重复执行
`up -d --pull always --no-build` 即可，`data/` 目录不要删除。Compose 的安全限制、
端口发布和反向代理要求与本地构建方式相同。

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `JMW_NODE_IMAGE` | `node:22.23.2-alpine3.24` | 仅容器构建：固定基础镜像；正式制品建议附加已核验的 manifest digest |
| `JMW_IMAGE` | （GHCR 覆盖文件默认为 `ghcr.io/shixian64/jm-web:latest`） | 仅 `docker-compose.ghcr.yml`：预构建镜像地址，可指定版本或 digest |
| `JMW_CPU_LIMIT` | `1.0` | 仅 Compose：容器 CPU 上限 |
| `JMW_MEMORY_LIMIT` | `512m` | 仅 Compose：容器内存上限 |
| `JMW_PIDS_LIMIT` | `256` | 仅 Compose：容器进程数上限 |
| `JMW_LOG_MAX_SIZE` | `10m` | 仅 Compose：单个 Docker `json-file` 日志文件上限 |
| `JMW_LOG_MAX_FILE` | `3` | 仅 Compose：Docker 日志轮转保留文件数 |
| `PORT` | `3210` | 监听端口（`1`–`65535`）；Compose 同时用它作为容器端口映射目标 |
| `HOST` | `127.0.0.1` | 直接运行的监听地址；Compose 内显式固定为 `0.0.0.0`，宿主机暴露地址改用 `JMW_PUBLISH_HOST` |
| `JMW_PUBLISH_HOST` | `127.0.0.1` | 仅 Compose：宿主机发布地址；改为 `0.0.0.0` 才会接受外部直连 |
| `JMW_PUBLISH_PORT` | `3210` | 仅 Compose：宿主机发布端口（`1`–`65535`） |
| `ACCESS_PASSWORD` | 空 | 设置后打开网页需要输入口令（容器/反代部署必须设置；至少 16 字节高熵随机值；口令错误有 5 分钟限流） |
| `JM_API_BASE` | 空 | 覆盖 API 域名，逗号分隔多个候选；**设置后锁定**，网页设置页不可再切换 |
| `JM_UA` | `okhttp/4.9.3` | 请求上游使用的 UA |
| `JM_TIMEOUT` | `20000` | 上游单域名超时（毫秒） |
| `JM_TOTAL_TIMEOUT` | `35000` | 上游全部域名轮询总时间预算（毫秒） |
| `JMW_DATA_DIR` | `./data` | 会话与设置持久化目录；Compose 内固定为 `/app/data` |
| `JMW_HOST_DATA_DIR` | `./data` | 仅 Compose：挂载到 `/app/data` 的已存在宿主机目录；原生 Linux 上须可由 `1000:1000` 写入 |
| `JMW_MAX_CHAPTER_IMAGES` | `2000` | 单章节允许解析的图片数量上限（范围 1–10000，防止异常响应耗尽浏览器/内存） |
| `JMW_MAX_IMAGE_BYTES` | `26214400` | 图片代理单文件大小上限（字节，范围 1–100 MiB） |
| `JMW_MAX_IMAGE_CONCURRENCY` | `12` | 图片代理全局最大并发数（范围 1–100） |
| `JMW_MAX_IMAGE_CONCURRENCY_PER_IP` | `6` | 单客户端图片代理最大并发数（范围 1–全局上限） |
| `JMW_IMAGE_CACHE_BYTES` | `67108864` | 封面进程内缓存总上限（字节；设为 0 可关闭） |
| `JMW_IMAGE_CACHE_ENTRY_BYTES` | `2097152` | 单张封面缓存上限（字节，代码上限 4 MiB；超过后仍正常流式转发） |
| `JMW_IMAGE_CACHE_TTL` | `86400` | 封面缓存有效期（秒，最短 60 秒） |
| `JMW_IMAGE_QUEUE_LIMIT` | `96` | 图片代理等待队列上限（范围 0–512） |
| `JMW_IMAGE_QUEUE_TIMEOUT` | `3000` | 单个图片请求排队最长时间（毫秒） |
| `JMW_MAX_API_RESPONSE_BYTES` | `16777216` | 上游 API 单响应大小上限（字节，范围 1–32 MiB） |
| `JMW_MAX_AI_STREAM_BYTES` | `16777216` | 单次 AI 流式响应大小上限（字节，范围 1–64 MiB） |
| `JMW_MAX_AI_CONCURRENCY` | `4` | AI 流式请求并发上限（范围 1–20） |
| `JMW_MAX_SEARCH_CONCURRENCY` | `8` | 联网搜索请求并发上限（范围 1–40） |
| `JMW_TRUST_PROXY` | 空（回环默认可信） | 额外可信反向代理的精确 IP/CIDR，逗号分隔；仅用于安全解析 `X-Forwarded-For` |
| `AI_API_KEY` | 空 | 可选：OpenAI-compatible AI Key；留空时禁用 AI 发送，不会下发浏览器 |
| `AI_BASE_URL` | `https://newapi.shixian.me/v1` | AI 服务基址，必须为 HTTPS；后端追加 `/chat/completions` |
| `AI_MODEL` | `grok-4.6` | AI 请求使用的模型名 |
| `AI_TIMEOUT` | `120000` | 单次 AI 流式请求超时（正整数毫秒，最大 10 分钟） |
| `CHAPTER_AI_INTERVAL_MS` | `30000` | 后台章节视觉分析轮询间隔；与用户无关 |
| `CHAPTER_AI_CONCURRENCY` | `1` | 后台章节视觉分析全局模型并发（部署时可调，默认 1） |
| `CHAPTER_AI_MAX_RETRIES` | `3` | 章节视觉分析失败后的最大重试次数（指数退避） |
| `TAVILY_API_KEY` | 空 | 可选：启用 Tavily 搜索提供商；Key 仅保存在服务器 |
| `SEARXNG_BASE_URL` | 空 | 可选：自建 SearXNG 的 HTTPS 基址，不含 `/search`；必须通过后端公网地址安全检查 |
| `SEARCH_TIMEOUT` | `35000` | 联网搜索总时间预算（正整数毫秒，最大 60000） |
| `JMW_UPDATE_REPO` | 空 | 可选：用于更新检查的 GitHub `owner/repo` |

容器及反向代理可使用 `GET`/`HEAD /healthz` 做健康检查。该接口不需要访问口令、不会创建会话，也不会请求上游服务；镜像已内置健康检查。启动后可用 `docker compose ps` 查看状态，或执行 `curl -fsS http://127.0.0.1:3210/healthz` 验证。

### 反向代理（可选）

用 Nginx 托管域名 + HTTPS：

```nginx
server {
    listen 443 ssl http2;
    server_name your.domain.com;
    location / {
        proxy_pass http://127.0.0.1:3210;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
    }
}
```

`X-Forwarded-For` 只会在 TCP 对端是可信代理时生效，避免访客伪造 IP 绕过限流。同机直接运行且 Nginx 连接 `127.0.0.1`/`::1` 时无需配置；如果代理经 Docker 网桥或独立容器访问，应在 `.env` 的 `JMW_TRUST_PROXY` 中填入其**实际、可控的** IP 或固定网段 CIDR，然后重建容器。例如：

```dotenv
JMW_TRUST_PROXY=172.18.0.5,172.19.0.0/24
```

不要填写 `1`、`true` 或 `*`，也不要信任不受你控制的广泛网段。使用可信代理时，后端端口应继续绑定在回环/内部网络，不要同时绕过代理公开。

## 使用说明

1. 浏览器打开你配置的 HTTPS 域名；直接运行或已将 Compose 的 `JMW_PUBLISH_HOST` 改为 `0.0.0.0` 时，也可访问 `http://服务器IP:3210`。
2. 搜索、阅读无需登录；如需**收藏 / 评论 / 签到**，在「我的」页面用 JM 官网账号登录
   （登录凭据仅保存在你自己的服务器 `data/sessions/` 中）。
3. 设置页可切换：主题（浅色/深色/跟随系统）、阅读模式、翻页适配、预加载数量、图片分流线路；更多能力位于「完整功能中心」。
   「API 域名」只能在服务器内置候选中切换，且仅对**当前浏览器**生效；若服务器设置了 `JM_API_BASE`，该项由管理员锁定。

## 技术实现

| 层 | 说明 |
| --- | --- |
| 后端 | 零依赖 Node.js（≥20），`server.js` + `lib/` |
| API 协议 | 与 jm-mobile 一致：`token` / `tokenparam` 请求头签名，响应 `data` 字段 AES-256-ECB 解密 |
| 会话 | 每个浏览器一个 Cookie Jar（AVS 等），持久化到 `data/sessions/`，重启不丢登录态；空会话 7 天、登录会话 90 天自动清理 |
| 图片 | 服务端按 HTTPS 域名白名单逐跳流式代理并限制大小/并发；解扰由浏览器 Worker/Canvas 完成 |
| 前端 | 原生 ES Module 单页应用，无构建步骤；Hash 路由；响应式（手机底部 Tab + 桌面顶部导航） |
| 图片还原 | 浏览器模块 Worker/OffscreenCanvas（不支持时回退主线程 Canvas）；`seed = seedMap[md5(id+page)]`，按漫画 ID 区间取模，纵向分片反序重排 |

## 目录结构

```text
jm-web/
├── server.js            零依赖 HTTP 服务器（API 代理 + 静态文件）
├── lib/
│   ├── jm-api.js        上游 API 客户端（签名 / AES 解密 / 域名故障切换）
│   ├── photo.js         chapter_view_template HTML 解析
│   ├── sessions.js      会话（Cookie Jar）持久化
│   └── settings.js      服务器设置持久化
├── public/              前端（无构建，直接静态服务）
│   ├── index.html
│   ├── css/app.css
│   └── js/              app.js 路由外壳 / views.js 页面 / reader.js 阅读器
│                        user.js 用户页 / descramble*.js 图片解扰 / md5.js
├── data/                运行时生成（会话、设置，已被 Git/Docker 构建上下文排除）
├── test/                单元/后端回归测试与静态检查（npm test / npm run check）
├── .env.example         Docker Compose 环境变量安全示例
├── .github/workflows/   GitHub Actions 多架构镜像发布
├── Dockerfile / docker-compose*.yml
├── LICENSE
└── README.md
```

## 验证

```bash
npm test   # 解析/MD5 单元测试 + 后端路由、会话、故障切换与图片代理回归测试
npm run check
node test/deployment.test.js
docker compose config --quiet
docker compose --env-file .env.example config --quiet
docker compose --env-file .env.example \
  -f docker-compose.yml -f docker-compose.ghcr.yml config --quiet
```

发布不可变制品时，先完成构建，再对不含 `.git/`、`data/`、`test/`、`.env` 和日志/秘密文件的制品目录执行：

```bash
RELEASE_BUILD_STATUS=PASS npm run validate:artifact -- /path/to/release-artifact
```

校验脚本会递归检查禁止内容、Dockerfile 的运行文件清单和生产路径；未明确传入构建成功标志不会输出 `RELEASE-MANIFEST: PASS`。生产切换仍应遵循备份、隔离候选验证、健康检查、原子更新 `current` 和保留旧版本回滚的顺序。

## License

GPL-3.0（与参照项目一致），完整条款见 `LICENSE`。仅供学习研究使用。
