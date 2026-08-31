# JM Web —— 自部署网页版漫画阅读站

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
- **图片还原**：使用与安卓客户端相同的扰乱规则在浏览器 Canvas 解码；下载时保存解扰后的图片。
- **下载与离线**：IndexedDB 离线资料库、可批量暂停/继续/重试/移除的持久下载队列、断点补页、完整性检查、存储统计/清理和离线阅读；恢复备份时可按原整本/选章意图重建下载任务。
- **导出与 PWA**：整本/单章 ZIP、浏览器打印为 PDF、Service Worker、Web App Manifest 和可安装 PWA 外壳。
- **外观与过滤**：浅色/深色/跟随系统、五套调色板与自定义四色、各页面网格列数、全局/首页标签过滤。
- **隐私与迁移**：PIN/口令、图案锁、WebAuthn 设备验证、任一/全部验证规则、失焦伪装；JSON 或 PBKDF2 + AES-GCM 加密备份恢复。
- **AI 与工具**：可选 OpenAI-compatible 流式对话、多会话、人格、停止/编辑/重试/详细/精简、Tavily 联网搜索；漫画编号提取及剪贴板检测。
- **运维**：API/图片多线路故障切换、可选 DoH 预解析与测速、运行日志、缓存维护、健康检查和 GitHub Release 更新检查。
- **响应式体验**：手机列表支持下拉刷新与首屏骨架，搜索新页面自动聚焦；桌面和手机返回/前进时均按独立路由记录恢复滚动位置。

> Web 与 Android 平台能力不同：Android WorkManager 对应为浏览器内持久下载队列（关闭页面后暂停、下次进入续传）；Android 系统 PDF 写入对应为浏览器打印“另存为 PDF”；桌面图标伪装对应为失焦隐私遮罩。浏览器本地收藏夹与历史删除是当前浏览器会话视图，不会改动不支持这些操作的上游账号数据。

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

单实例默认限制为 `1.0` CPU、`512m` 内存和 `256` 个进程，Docker `json-file` 日志按 `10m × 3` 轮转；可通过 `.env` 中的 `JMW_CPU_LIMIT`、`JMW_MEMORY_LIMIT`、`JMW_PIDS_LIMIT`、`JMW_LOG_MAX_SIZE`、`JMW_LOG_MAX_FILE` 调整。调整前应基于容量测试确定水位，不能直接删除上限。

基础镜像默认固定 Node 与 Alpine 的补丁版本；生产发布还应将多架构 manifest digest 纳入制品清单。先用 `docker buildx imagetools inspect node:22.23.2-alpine3.24` 从可信仓库核验摘要，再把 `.env` 的 `JMW_NODE_IMAGE` 设置为 `node:22.23.2-alpine3.24@sha256:<核验得到的摘要>`。摘要与平台有关且会随版本升级，本仓库不写入未经当前构建环境验证的值。

不使用 Compose 时可用 Docker 命名卷，该写法在 Linux、macOS 和 PowerShell 中一致：

```bash
docker build -t jm-web .
docker volume create jm-web-data
docker run -d --name jm-web --restart unless-stopped --user 1000:1000 --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m --cap-drop=ALL --security-opt=no-new-privileges=true --cpus=1 --memory=512m --pids-limit=256 --log-opt max-size=10m --log-opt max-file=3 -p 127.0.0.1:3210:3210 --mount type=volume,source=jm-web-data,target=/app/data --env-file .env -e PORT=3210 -e HOST=0.0.0.0 -e JMW_DATA_DIR=/app/data jm-web
```

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `JMW_NODE_IMAGE` | `node:22.23.2-alpine3.24` | 仅容器构建：固定基础镜像；正式制品建议附加已核验的 manifest digest |
| `JMW_CPU_LIMIT` | `1.0` | 仅 Compose：容器 CPU 上限 |
| `JMW_MEMORY_LIMIT` | `512m` | 仅 Compose：容器内存上限 |
| `JMW_PIDS_LIMIT` | `256` | 仅 Compose：容器进程数上限 |
| `JMW_LOG_MAX_SIZE` | `10m` | 仅 Compose：单个 Docker `json-file` 日志文件上限 |
| `JMW_LOG_MAX_FILE` | `3` | 仅 Compose：Docker 日志轮转保留文件数 |
| `PORT` | `3210` | 监听端口（`1`–`65535`）；Compose 同时用它作为容器端口映射目标 |
| `HOST` | `127.0.0.1` | 直接运行的监听地址；Compose 内显式固定为 `0.0.0.0`，宿主机暴露地址改用 `JMW_PUBLISH_HOST` |
| `JMW_PUBLISH_HOST` | `127.0.0.1` | 仅 Compose：宿主机发布地址；改为 `0.0.0.0` 才会接受外部直连 |
| `JMW_PUBLISH_PORT` | `3210` | 仅 Compose：宿主机发布端口（`1`–`65535`） |
| `ACCESS_PASSWORD` | 空 | 设置后打开网页需要输入口令（容器/反代部署必须设置；口令错误有 5 分钟限流） |
| `JM_API_BASE` | 空 | 覆盖 API 域名，逗号分隔多个候选；**设置后锁定**，网页设置页不可再切换 |
| `JM_UA` | `okhttp/4.9.3` | 请求上游使用的 UA |
| `JM_TIMEOUT` | `20000` | 上游单域名超时（毫秒） |
| `JM_TOTAL_TIMEOUT` | `35000` | 上游全部域名轮询总时间预算（毫秒） |
| `JMW_DATA_DIR` | `./data` | 会话与设置持久化目录；Compose 内固定为 `/app/data` |
| `JMW_HOST_DATA_DIR` | `./data` | 仅 Compose：挂载到 `/app/data` 的已存在宿主机目录；原生 Linux 上须可由 `1000:1000` 写入 |
| `JMW_MAX_IMAGE_BYTES` | `26214400` | 图片代理单文件大小上限（字节，范围 1–100 MiB） |
| `JMW_MAX_IMAGE_CONCURRENCY` | `24` | 图片代理最大并发数（范围 1–100） |
| `JMW_MAX_API_RESPONSE_BYTES` | `16777216` | 上游 API 单响应大小上限（字节，范围 1–32 MiB） |
| `JMW_MAX_AI_STREAM_BYTES` | `16777216` | 单次 AI 流式响应大小上限（字节，范围 1–64 MiB） |
| `JMW_MAX_AI_CONCURRENCY` | `4` | AI 流式请求并发上限（范围 1–20） |
| `JMW_MAX_SEARCH_CONCURRENCY` | `8` | 联网搜索请求并发上限（范围 1–40） |
| `JMW_TRUST_PROXY` | 空（回环默认可信） | 额外可信反向代理的精确 IP/CIDR，逗号分隔；仅用于安全解析 `X-Forwarded-For` |
| `AI_API_KEY` | 空 | 可选：OpenAI-compatible AI Key；留空时禁用 AI 发送，不会下发浏览器 |
| `AI_BASE_URL` | `https://api.openai.com/v1` | AI 服务基址，必须为 HTTPS；后端追加 `/chat/completions` |
| `AI_MODEL` | `gpt-5-mini` | AI 请求使用的模型名 |
| `AI_TIMEOUT` | `120000` | 单次 AI 流式请求超时（正整数毫秒，最大 10 分钟） |
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
| 图片 | 服务端按 HTTPS 域名白名单逐跳代理安全栅格图片，并限制大小/并发；解扰由浏览器 Canvas 完成 |
| 前端 | 原生 ES Module 单页应用，无构建步骤；Hash 路由；响应式（手机底部 Tab + 桌面顶部导航） |
| 图片还原 | `seed = seedMap[md5(id+page)]`，按漫画 ID 区间取模，纵向分片反序重排 |

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
│                        user.js 用户页 / descramble.js 图片解扰 / md5.js
├── data/                运行时生成（会话、设置，已被 Git/Docker 构建上下文排除）
├── test/                单元/后端回归测试与静态检查（npm test / npm run check）
├── .env.example         Docker Compose 环境变量安全示例
├── Dockerfile / docker-compose.yml
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
```

## License

GPL-3.0（与参照项目一致），完整条款见 `LICENSE`。仅供学习研究使用。
