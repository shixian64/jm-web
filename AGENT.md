# JM Web 项目协作与生产运行说明

本文是 `jm-web` 的项目级工作约定，供后续开发者、自动化 Agent、审计和发布人员使用。执行任务前先阅读本文；运行态证据与本文冲突时，以运行态为准，并在确认后更新本文。

## 1. 范围与基本原则

- 本仓库只处理 `jm-web`。不要顺手修改同级的移动端、Next、Java API 或参考源码项目。
- 开发仓库和 GitHub `main` 是代码事实来源；生产 Release 目录不是开发工作区。
- 排查顺序：运行行为 → 网络流量 → 实际静态资源 → 容器/进程配置 → 持久化状态 → 当前源码 → 注释。
- 先建立可复现基线，再一次只改一个问题；修复必须有测试或明确验收证据。
- 不提交 `.env`、`data/`、Cookie、SSH 密码、API Key、上游 Session、临时响应或审计凭据。
- 不在日志、提交信息、部署报告或本文中记录任何真实秘密。
- 生产修改优先采用候选验证、原子切换和可回滚发布，不直接编辑运行中的 `current`。

## 2. 技术架构

```text
浏览器（原生 ES Module SPA / PWA）
  ├─ Hash 路由、响应式页面、阅读器、下载与 IndexedDB
  └─ 同源 /api/* 和 /api/img
             │
             ▼
server.js（零第三方运行依赖的 Node.js HTTP 服务）
  ├─ 访问门禁、JM 会话、API 方法白名单、静态文件
  ├─ 上游 JM API 签名、解密及多线路切换
  ├─ 章节 HTML 解析
  ├─ HTTPS 图片白名单代理、限流、字节上限和背压
  └─ AI、联网搜索、DoH、日志、更新检查
             │
             ▼
受信任的上游 API / 图片线路
```

运行要求：

- Node.js `>=20`；Docker 生产基线见 `Dockerfile`。
- 后端仅为服务端章节视觉分析引入 `sharp` 图片编解码依赖；不要再为小功能随意引入框架或供应链依赖。
- 漫画繁简翻译由仓库内 `translation-service-poc/` 的独立 Python 容器处理，随主 Compose 统一管理；不要把 OCR 依赖并入 Node 镜像。
- 前端无构建步骤，浏览器直接加载 `public/` 下的 ES Module。
- SPA 使用 Hash 路由，服务端对非资源 GET 提供 `index.html` 回退。

## 3. 目录与模块职责

```text
jm-web/
├── server.js                 HTTP 入口、API 路由、鉴权、图片代理、静态服务
├── lib/
│   ├── jm-api.js             JM 签名/AES 解密、响应上限、API Host 故障切换
│   ├── https-fetch.js        DNS 校验后固定实际 TLS 地址、解压、取消和超时
│   ├── photo.js              chapter_view_template HTML 解析
│   ├── sessions.js           会话、按 Origin 隔离的 Cookie Jar、磁盘持久化
│   ├── settings.js           API/图片 Host 与服务端设置
│   └── features.js           DoH、AI、搜索、更新检查和运行日志
├── public/
│   ├── index.html            应用入口
│   ├── sw.js                 离线外壳 Service Worker
│   ├── manifest.webmanifest  PWA 配置
│   ├── css/                  全局、收藏与离线样式
│   └── js/
│       ├── app.js            应用外壳、路由、启动和路由清理
│       ├── api.js            浏览器同源 API 封装和图片 URL
│       ├── views.js          首页、搜索、分类、周榜、详情等页面
│       ├── ui.js             安全 DOM 工具、卡片、列表、Toast
│       ├── user.js           登录、收藏、历史、用户设置
│       ├── reader.js         在线/离线阅读器和图片生命周期
│       ├── reader-settings.js 阅读器设置面板
│       ├── downloads.js      IndexedDB 下载队列与跨标签协调
│       ├── download-view.js  下载管理界面
│       ├── offline.js        离线存储、校验、SW 注册
│       ├── advanced.js       应用锁、备份、AI、DoH、日志等高级功能
│       ├── gate.js           站点访问口令门禁
│       ├── store.js          localStorage 设置与本地历史
│       ├── descramble-core.js 浏览器端图片解扰共享算法
│       ├── descramble-worker.js 模块 Worker / OffscreenCanvas 解扰
│       └── descramble.js     Worker 调度与主线程兼容回退
├── test/                     单元、后端、安全、移动端和部署回归
├── translation-service-poc/  Python OCR/繁简转换服务、Dockerfile 与独立测试
├── data/                     运行状态；不进入 Git 或普通发布制品
├── Dockerfile
├── docker-compose.yml
├── .env.example
└── README.md
```

## 4. 关键数据流

### 4.1 首页、详情和搜索

1. 浏览器通过 `public/js/api.js` 请求同源 `/api/*`。
2. `server.js` 从服务端白名单选择 API Host。
3. `lib/jm-api.js` 添加 `token` / `tokenparam`，读取有界响应并解密 `data`。
4. 浏览器只接收整理后的 JSON，不接触上游登录 Cookie。

### 4.2 章节与图片

1. `/api/chapter` 请求上游 `chapter_view_template`。
2. `lib/photo.js` 解析图片列表、图片 Host、解扰参数和章节元数据。
3. `/api/img` 只代理受信 HTTPS Origin，逐跳校验重定向和 DNS。
4. 后端只接受安全栅格 MIME，并执行大小、并发、背压和客户端取消控制。
5. 需要解扰的正文图片优先由 `descramble-worker.js` 在浏览器模块 Worker/
   OffscreenCanvas 中处理；不支持时由 `descramble.js` 回退主线程 Canvas。

### 4.3 两层登录状态

- `ACCESS_PASSWORD` 是站点访问门禁；成功后签发 HttpOnly `jmw_auth`。
- JM 账号登录使用 `jmw_sid` 定位服务端 Session/Cookie Jar。
- 上游 Cookie 按精确 Origin 隔离，绝不能跨 Host 复制或发送到浏览器。
- JM 登录响应 `data.s` 仅作为实际成功 Origin 的 `AVS` Cookie 写入；用户资料会脱敏，`s`/`jwttoken` 等认证字段不返回也不落盘。
- 认证 GET 收到 401 时只在已有 AVS 的受信 Origin 间重试；全部失效后清除本地 JM 登录态，避免旧资料继续显示为已登录。
- `/api/logout` 退出 JM 会话，不等于退出站点访问门禁。
- 当前访问口令同时授予日志和全局 DoH 运维能力，因此只适合个人或完全互信用户，不是严格多租户 RBAC。

### 4.4 离线能力

- Service Worker 只负责应用静态外壳，不缓存登录 API 或图片代理响应。
- 漫画正文、章节配置和封面由 IndexedDB 显式管理。
- 修改 IndexedDB schema、下载恢复或多标签锁时，必须兼容旧数据并验证升级、阻塞和取消路径。

## 5. 后端安全不变量

修改后端时必须保持以下边界：

- `API_METHODS` 对每个 API 做方法白名单。
- JSON POST 只接受 JSON 媒体类型，顶层必须是普通对象，请求体有硬上限。
- 只允许 HTTPS 出站 URL，禁止 URL 用户信息和任意浏览器指定 Host。
- DNS 结果出现环回、私网、链路本地或其他非公网地址时必须拒绝。
- 安全校验后的地址必须固定到真实 TLS socket；不得删除 pinned lookup 或关闭证书校验。
- API 和图片重定向不得自动跟随；每一跳重新验证。
- 上游 Cookie 只发送给服务端明确受信的精确 Origin。
- GET 和非幂等 POST 的重试语义不同：POST 只有确定未送达时才允许换 Host 重发。
- 5xx、DNS、TLS、内部路径和上游原文默认不得回显给浏览器。
- API 日志不记录 Query，避免泄露搜索词、用户 ID 或临时参数。
- 开启访问门禁时，图片响应保持 `private` 缓存语义，不能直接改成 CDN `public`。

涉及默认资源限制时，同时检查并更新：

```text
server.js / lib/*
.env.example
docker-compose.yml
README.md
test/backend.test.js 或 test/deployment.test.js
```

当前图片相关默认保护为：单章节最多 2000 张、单文件 25 MiB、全局代理并发 12、
单客户端代理并发 6；封面进程内缓存总计 64 MiB、单项 2 MiB、TTL 24 小时，
图片等待队列最多 96 项、单项排队 3 秒。前端原图缓存按设备内存计算字节预算，解扰优先使用模块
Worker/OffscreenCanvas，且申请画布前检查像素、单轴尺寸与估算工作集；调整这些值时
必须重新做移动端和长条图回归。

## 6. 前端实现不变量

- 来自上游、用户或存储的数据必须使用 `textContent`/安全 DOM 构造，禁止直接拼接到 `innerHTML`。
- 异步 View 必须使用路由 `ctx.signal`/`ctx.isActive()`，离开路由后停止更新 DOM，并释放监听器、Observer、RAF、Timer、Object URL 和网络请求。
- 添加新的 JS/CSS/图标等静态文件时，同步更新 `public/sw.js` 的 `SHELL`、缓存版本和对应测试。
- 不在启动、`focus` 或 `visibilitychange` 中被动调用 `navigator.clipboard.readText()`；只能在明确用户手势或真实 `paste` 事件中访问剪贴板。
- 密码、应用锁和备份口令字段必须排除全局粘贴检测。
- 手机端访问门禁、应用锁和空搜索页不得自动聚焦可编辑字段，避免 iOS Edge/Safari 长期显示“粘贴”或弹出键盘。
- 页面根节点不得产生非设计性的横向滚动；横向漫画条、工具条和阅读器抽屉只能局部滚动。
- 手机布局使用 `100dvh`、safe-area 和可滚动模态；至少回归竖屏、横屏和 PWA 模式。
- 图片加载要控制并发和生命周期；离开首页后不能继续用大量封面占用阅读器图片通道。
- 阅读器首图属于关键路径，标题、封面和章节抽屉等非关键元数据不得无条件阻塞首图。
- Service Worker 在线策略目前优先获取新文件以避免永久旧缓存；未建立内容哈希和升级协议前，不要单独改成永久 cache-first。

## 7. 持久化状态与秘密

翻译生成结果单独保存到 Compose 命名卷 `translation-cache`（容器内 `/app/cache`），不覆盖原图或主站 `data/`。普通停止、重启、`down` 不删除缓存；不要用 `down -v` 进行升级。两个服务共享根 `.env` 的 `TRANSLATION_SERVICE_TOKEN`，翻译端口不发布到宿主机。

容器内状态目录：

```text
/app/data
├── .secret
├── settings.json
├── features.json
└── sessions/*.json
```

生产宿主机当前绑定目录：

```text
/home/shixian/project/jm-web/data
```

规则：

- 真实路径最终以生产 `.env` 的 `JMW_HOST_DATA_DIR` 和 `docker inspect` 为准。
- `.secret` 控制现有访问 Cookie 的有效性；Session 中含上游凭据和用户状态。
- `data/` 不得进入 Git、镜像、普通代码同步或候选测试数据。
- 不得用本地测试数据覆盖生产数据。
- 生产目录应由 `1000:1000` 使用，目录建议 `0700`，Session 文件按敏感凭据处理。
- 备份必须同时保护 `.secret`、Session 和生产 `.env`；一致性备份应停服或先完成状态 flush。
- 代码回滚不等于数据回滚。执行递归清理、`rsync --delete` 或迁移前，必须单独确认数据目录。

浏览器侧还包含 localStorage 和 IndexedDB。备份恢复、应用锁或 schema 修改不能只验证新浏览器，必须验证旧状态升级。

## 8. 生产拓扑与目录

```text
Cloudflare
  → shixian-clone / Caddy（公网入口）
  → Tailscale
  → ubuntu-server-bijiben / jm-web 容器
```

- 公网域名：`https://jm.shixinn.com/`
- 生产根目录：`/home/shixian/project/jm-web`
- 旧目录 `/srv/jm-web` 已停用，禁止在新脚本中继续硬编码。
- Caddy 在入口服务器，普通 `jm-web` 发布不要顺手修改入口配置。

生产目录结构：

```text
/home/shixian/project/jm-web/
├── current -> releases/<release-id>  当前运行 Release 的相对软链接
├── releases/                          不可变历史 Release
├── incoming/                          待验证制品
├── shared/.env                        生产秘密与环境配置
├── shared/docker-compose.prod.yml     生产 Compose 覆盖
└── data/                              唯一持久化运行状态
```

进入代码和查看服务：

```bash
cd /home/shixian/project/jm-web/current
docker compose --project-name jm-web \
  --file docker-compose.yml \
  --file ../../shared/docker-compose.prod.yml \
  --env-file ../../shared/.env ps
```

生产 Release 不含 `.git` 和测试目录。不要在 `current` 中执行 `git pull`，也不要手工修改文件。

## 9. 标准变更与发布流程

1. **基线**：确认 `git status`、`HEAD`、`origin/main` 和已有测试结果。
2. **证据**：复现一个从输入到错误分支/性能瓶颈的最窄链路。
3. **整改**：一次只改一个可解释变量，补对应回归测试。
4. **本地门禁**：完整测试、静态检查、Compose 配置检查、浏览器关键路由回归。
5. **提交推送**：使用清晰的 Conventional Commit，确认远端提交与本地一致。
6. **制品**：白名单打包，记录 Release ID、Git SHA、制品 SHA；排除 Git、测试数据、生产环境和凭据。
7. **候选验证**：使用隔离容器和隔离数据目录，不挂载生产 Session。
8. **原子部署**：候选 healthy 后再切换 `current`，使用已经核验的镜像重建生产容器。
9. **生产验收**：分别验证笔记本直连、入口代理和公网域名。
10. **失败回滚**：恢复原 `current` 和旧镜像；不得覆盖或回滚生产数据，除非有独立的数据恢复方案。

### GHCR 预构建镜像（可选）

- 主 Compose 同时构建 `jm-web` 和 `translation-service`；不带服务名的 `up -d`、`stop`、`restart`、`down` 统一管理两个容器。单独操作 `jm-web` 容器不代表同步操作翻译容器。
- GHCR workflow 同时发布 `jm-web` 和 `jm-web-translation` 两个镜像；预构建覆盖文件必须对两者都禁用 build，首次部署前确认两个镜像的对应标签均已发布。

- `.github/workflows/docker-publish.yml` 只在测试通过后发布 `linux/amd64` 与
  `linux/arm64`；Pull Request 只构建校验，不推送镜像。
- `vX.Y.Z` 版本标签生成版本标签和 `latest`；默认分支生成 `latest` 与 `edge`。GHCR 首次发布后，
  维护者须确认包的可见性；个人/小范围部署建议保持 Private，并在部署说明中明确拉取权限。
- 公开镜像会包含运行所需的 `server.js`、`lib/` 与前端资源；镜像可解包并不等于源码保密。
- `docker-compose.ghcr.yml` 只用于使用预构建镜像的外部部署，不替代生产 Release 的
  候选构建、校验、原子切换和回滚流程。生产仍须记录镜像 digest，并保留独立数据目录。
- 发布或升级后用 `docker buildx imagetools inspect <image>:<tag>` 确认两个平台都存在；
  不要把 `data/`、`.env` 或任何 Session 打进镜像。

发布制品至少包含运行所需文件和项目说明：

```text
.dockerignore
.env.example
AGENT.md
AGENTS.md
Dockerfile
LICENSE
README.md
docker-compose.yml
lib/
package.json
public/
server.js
translation-service-poc/.dockerignore
translation-service-poc/Dockerfile
translation-service-poc/requirements.txt
translation-service-poc/pipeline.py
translation-service-poc/service.py
```

制品禁止包含：

```text
.git/
data/
test/
translation-service-poc/tests/
translation-service-poc/cache/
__pycache__/
.env
生产 Cookie、密码、Key、Session
临时 QA 请求头或业务响应
```

## 10. 质量门禁

在开发工作区执行：

```bash
npm test
npm run check
python -m pytest translation-service-poc/tests -q
git diff --check
docker compose config --quiet
docker compose --env-file .env.example config --quiet
docker compose --env-file .env.example \
  -f docker-compose.yml -f docker-compose.ghcr.yml config --quiet
```

说明：

- 后端测试使用临时 `JMW_DATA_DIR`；绝不能把它改为生产路径。
- `test/backend.test.js` 会调整环境变量和模块级状态，应在独立 Node 进程运行。
- Node 测试浏览器模块时出现 `MODULE_TYPELESS_PACKAGE_JSON` 警告，不等于浏览器失败。
- 单元测试通过不等于 Cloudflare、Caddy、Tailscale、上游线路或 iPhone 通过。

前端最低回归矩阵：

- 手机竖屏约 `390×844`；矮屏/横屏约 `667×300` 或真实 iPhone 横屏。
- 首页、搜索、分类、周榜、详情、阅读、收藏、历史、下载、设置、高级功能。
- 页面 `scrollWidth === clientWidth`，局部横向区域除外。
- 控制台无未处理错误；离开路由后无继续增长的请求和监听器。
- 门禁、应用锁和空搜索页的活动焦点不是可编辑控件。
- 清理旧 SW/缓存后验证一次，再验证升级保留缓存的路径。

生产最低验收：

- 容器 `running/healthy`、`RestartCount=0`、`OOMKilled=false`。
- 运行用户 `1000:1000`、只读根文件系统、能力已移除。
- `/app/data` 实际绑定到新生产目录，迁移前后 inode/权限符合预期。
- `GET|HEAD /healthz` 在后端和公网均为 `200`。
- 授权后的 `/api/config`、`/api/home`、`/api/album`、`/api/chapter` 返回结构有效。
- 封面与正文 `/api/img` 返回安全图片 MIME。
- 生产静态资产 SHA 与本次 Release 一致，Service Worker 缓存版本已切换。
- 新容器日志无持续 5xx、重启或 OOM。

`/healthz` 只证明 Node 进程可响应，不检查数据可写、上游可用或完整业务链，因此不能作为唯一发布判据。

## 11. 已知高优先级技术债

修改前必须重新验证当前运行态，避免把已修问题重复引入：

### 性能与前端

- 阅读器当前可能等待详情元数据后才渲染已就绪的章节图片，慢详情会阻塞首图。
- 首页一次创建大量卡片；封面现由 IntersectionObserver、有界图片队列和后端缓存共同控制，仍需持续观察低端移动设备的首屏加载水位。
- `app.js` 静态导入阅读器、下载、高级和用户模块，首屏模块图偏大；路由级动态导入需单独设计应用锁和 SW 升级兼容。
- 长章节滚动定位会遍历页面槽位；预取应只在页码实际变化时触发。
- 超过单张 Canvas 上限的超长条漫当前会保护性拒绝，尚未实现分块重排和分块展示。
- 下载队列重启后的 `queued` 恢复策略需要明确，避免永久“等待中”或多标签重复下载。

### 后端与安全

- API Host 缺少完善的跨请求熔断/成功线路提升，坏首线路可能让每个请求重复等待。
- 图片路径代理已对超时/DNS/429/5xx 做短期负缓存，并对相同封面启用 single-flight；若上游线路继续频繁切换，仍需补充跨请求熔断和指标。
- 普通上游 API 缺少统一并发准入；图片、AI 和搜索已有独立上限。
- 非幂等 API 仍需统一的精确同源 CSRF 防护。
- `ACCESS_PASSWORD` 同时授予实例运维能力；若向非互信用户开放，需要独立管理员认证和 AI 配额，而不是只分享访问口令。
- `/healthz` 不是 readiness；生产数据不可写或上游全挂时仍可能显示 healthy。

### 运维

- 生产 `data/` 是唯一状态，必须建立加密备份、保留策略和恢复演练。
- 入口 Caddy 配置在另一台主机，尚未成为本仓库可复放的部署声明；排障时要单独保留入口证据。
- 图片成功请求和入口链路可观测性不足；漫画慢不能只看应用 CPU/内存，应分段测 DNS、connect、TLS、TTFB、total 和连接复用。
- 静态资源尚无内容哈希和长期 immutable 缓存，不能只在 Cloudflare 上强行缓存未版本化模块。

## 12. 明确禁止的操作

- 禁止把旧生产路径 `/srv/jm-web` 写回部署脚本或 `.env`。
- 禁止直接编辑 `/home/shixian/project/jm-web/current`。
- 禁止使用本地 `data/`、候选数据或空目录覆盖生产 `data/`。
- 禁止对非幂等 POST 进行不确定状态下的自动重放。
- 禁止为绕过线路故障关闭 TLS、SSRF、DNS、Origin Cookie 或响应大小检查。
- 禁止在启动、窗口聚焦或页面可见时被动读取剪贴板。
- 禁止新增静态文件却不更新 Service Worker 清单和测试。
- 禁止只看到 `healthz=200` 就宣布发布成功。
- 禁止在带真实 Cookie 的 QA 临时目录缺少 `umask 077` 和正确的 EXIT 清理。
- 禁止将生产密码、Cookie、`.secret`、Session 或内部凭据提交到 GitHub。

## 13. 文档维护

出现以下变化时必须同步更新本文：

- 生产根目录、域名、入口拓扑或 Compose 调用方式变化；
- 新增核心模块、持久化文件或浏览器存储；
- 鉴权、管理员边界、Cookie 或 CSRF 方案变化；
- 发布制品白名单、候选验证或回滚流程变化；
- 已知技术债完成整改并通过生产验收。
