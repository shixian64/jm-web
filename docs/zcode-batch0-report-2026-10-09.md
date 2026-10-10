# 第 0 批执行报告：基线确认与报告校正（2026-10-09）

依据 [`zcode-remediation-plan-2026-10-09.md`](D:/project/AI/jm-web/docs/zcode-remediation-plan-2026-10-09.md) 第 4 节执行。本文记录第 0 批的实际产出，并给出第 1–4 批的最小复现与新增测试计划；后续批次完成时在此追加结果。

## 1 基线记录（可按第 10 节命令重现）

| 项 | 值 |
| --- | --- |
| HEAD | `8eaf1322c64eaf67751645aa130ed2317da02487`（fix: preserve favorites state on reader return，与整改说明的复核基线一致） |
| 工作区 | 干净，仅未跟踪 `.zcodeignore`、`SECURITY-AUDIT.md`、`docs/`（归属识别：前两者与 `docs/` 三份来源报告均为本轮分析产物，保留不动） |
| Node / npm | v24.15.0 / 11.12.1 |
| 依赖 | `node_modules` 不存在；`sharp` 未安装（环境阻碍，不擅自安装） |
| SW 基线 | `jmw-shell-v15`，SHELL 33 项（与整改说明 C12 一致） |

基线测试命令结果（逐项检查退出码）：

| 命令 | 结果 |
| --- | --- |
| `node test/navigation-cache.test.js` | ✅ 通过（TTL/abort/identity/invalidation） |
| `node test/favorites-navigation.test.js` | ✅ 通过（快照/筛选/下拉刷新/认证失效） |
| `node test/navigation.test.js` | ✅ 通过 |
| `node test/service-worker.test.js` | ✅ 通过（33 cached assets） |
| `node test/reader-performance.test.js` | ❌ 失败于 `reader-performance.test.js:119`——断言原图路径区间不得出现 `state.dims.`，当前实现合法读取 `state.dims.get(idx)` 保留尺寸（与整改说明记载一致，属断言约束错误，非业务回归） |
| `npm run check` | ✅ 通过（34 JS、3 CSS / 1021 blocks） |
| `git diff --check` | ✅ 无问题 |
| `node test/deployment.test.js` | ❌ 失败于 `deployment.test.js:93`——Windows 下 POSIX 可执行位为 0（平台契约问题，已知） |
| `node test/chapter-ai.test.js` | ❌ `MODULE_NOT_FOUND: sharp`（缺依赖，环境阻碍） |
| `npm test` 全量 / Python 回归 / Compose 配置检查 | 未运行（依赖缺失、环境受限，如实标注） |

代码事实复核（勘误依据，均在 `8eaf132` 用当前源码确认）：

- `server.js:2745-2748`：`shuttingDown` 在退出入口被读取（防重复退出），非死变量（C09）。
- `server.js:1294+`：图片 Host 已实现跨请求指数退避（`IMAGE_HOST_FAILURE_BASE_MS * 2**(failures-1)`）、EWMA 打分（`latency * 0.7 + duration * 0.3`）、`probeInFlight`/`openUntil` 半开探测（AGENT.md §11 债项过时，已更新）。
- `public/js/reader.js:884-925`：`albumPromise` 并行 + `.catch(() => null)`，`render()`（923 行）先于 `await albumPromise`（925 行）——首图不等详情（AGENT.md §11 债项过时，已更新）。
- `public/js/app.js:395-421`：`boot()` 先 `mountShell()` 再 `/api/me` 探测；`startApplication()`（385-393 行）同步调用 `render()`（→ `/api/home`）与 `refreshAvatar()`（→ `/api/me`），二者并行——非 me、me、home 三次串行（C07）。
- `public/js/app.js:14` 导入 `prepareAdvancedRuntime`/`isLocalAppLocked`，`boot()` 在网络探测前调用——advanced 有启动期运行时（C06）。
- `public/js/api.js:12-122`：`identityEpoch` 认证世代、`invalidateNavigation`（auth/unauthorized/source/host/favorites）、401 自动失效、跨标签 storage 广播（C12，8eaf132 已部分修复 FE-05）。
- `lib/https-fetch.js`：未传 `agent`，走 Node 默认 globalAgent（Node 19+ 默认 keep-alive、timeout 5s；`keepAliveMsecs` 是 TCP 保活探测初始延迟，C03）。
- `server.js:596-598`：`authToken() = sha256(ACCESS_SECRET:ACCESS_PASSWORD)`，需二者同时已知（C10）。
- `translation-service-poc/pipeline.py:399-401`：`_ocr_call_lock` 只串行化 OCR 调用（C14）。
- `public/js/export.js:108-110`：CRC 逐条 `arrayBuffer()` 计算，每项算完即丢（C11）。
- `server.js` 全文无 `process.on('unhandledRejection'/'uncaughtException')`（C01 的事实部分成立，风险定性已勘误）。

## 2 C01–C15 校正落实清单

对象：[`consolidated-analysis-2026-10-09.md`](D:/project/AI/jm-web/docs/consolidated-analysis-2026-10-09.md)（就地改写并以【勘误 Cxx】标注，共 45+ 处；三份来源原文与 `SECURITY-AUDIT.md` 未动）。

| 编号 | 校正位置（摘要/索引/正文/路线图） |
| --- | --- |
| C01 | 头部勘误说明、§1.1 最优先三项、§7.0 REL-02 行、REL-02 正文、§9.1-3 |
| C02 | §1.2-2、§7.0 SEC-03 行、SEC-03 根因段、SEC-03 修复建议 1（禁止默认信任 172.16.0.0/12） |
| C03 | §1.3 A5 行、§5.3 局限、PERF-05 标题+证据、§9.3 P1-3 |
| C04 | §1.3 A2 行、§6.4 复访瀑布、PERF-02 证据三条 |
| C05 | §9.3 P0-2（哈希改名须覆盖 import/CSS/manifest/SW/旧标签页/回滚） |
| C06 | §1.3 A3 行、PERF-03 证据、§9.3 P1-1（advanced 先拆启动运行时） |
| C07 | §1.3 A4 行、§6.4、PERF-04 证据+影响、§9.3 P1-2（收益=消除一次重复请求） |
| C08 | §1.3 A1 行、§6.2 压缩表（逐文件口径 197,409 B/约 70.8%）、PERF-01 影响、§9.3 P0-1（HEAD 同表示、q=0/identity/Vary/304） |
| C09 | REL-05 正文（shuttingDown 非死变量；Node 19+ close 关空闲连接；改为收口/flush/强杀策略排查） |
| C10 | §2.1 行 3、SEC-02 正文三条（需二者、无服务端过期校验、时间片≠单项吊销） |
| C11 | FE-03 正文、FE-07 ZIP 行（峰值需实测；缺陷=无大小确认） |
| C12 | 头部说明、§7.0 FE-05 行、FE-05 正文、SW 版本引用（§6.4/PERF-02/§8.8-28/附录 → v15/33） |
| C13 | §1.1-2、DEL-01 影响（测试失败=阻止发布；补 npm ci 后仍须修既有失败） |
| C14 | REL-07 正文（锁只覆盖 OCR 调用；先分段测量再动） |
| C15 | §8.1-3（删除"无 fixation"绝对结论，保留条件性风险） |
| 措辞降级 | REL-01 引语、§9.1-2（"唯一能打挂"→未经运行验证的量级判断）、§1.2（"稳定复现"→静态推断） |

AGENT.md §11 两处过时债项已同步更新（阅读器首图、图片 Host 熔断），只改描述、未重写运维文档。

## 3 问题四分类

### 3.1 已确认且待修（代码级证据充分，按批次推进）

| 编号 | 内容 | 批次 |
| --- | --- | --- |
| DEL-01 | CI 缺 `npm ci`（publish 依赖测试成功，属门禁被阻断而非防线失效） | 第 1 批 |
| DEL-02 | README 零依赖宣称与 sharp 矛盾 | 第 1 批 |
| DEL-03/DEL-04 | 制品校验黑名单盲区（`sessions/`、密钥后缀、锁文件缺失）；deployment 测试平台契约与无效安全断言 | 第 1 批 |
| 测试 | reader-performance.test.js:119 断言把合法的尺寸保留读取误判为违规 | 第 1 批 |
| REL-01 | chapter-ai：enqueue 无上限、`touchPopularity`/入队同步全量写盘、整章 base64 单请求积累（均有代码证据；OOM 量级属结构性推断，按第 2 批验收实测） | 第 2 批 |
| REL-03/REL-10 | 翻译代理无 deadline/准入；Python 侧上传无期限、`max_inflight` 在上传之后 | 第 3 批 |
| SEC-07 | 空 token 默认放行（`service.py` 证据确凿） | 第 3 批 |
| SEC-01 | `/api/favorite`、`/api/like`、`/api/logout` 无同源校验（query-POST，已复核） | 第 4 批 |

### 3.2 已部分修复（8eaf132 已含，不得回退）

| 项 | 现状 | 剩余 |
| --- | --- | --- |
| FE-05 后半 | API 层失效 + 认证世代 + 跨标签通知 + 收藏 401 清理提示已实现 | 门禁再次弹出的入口、顶栏旧头像是否残留：需独立复现再立项 |
| 阅读器首图不等详情 | 已实现且有测试 | 文档已更新（本次） |
| 图片 Host 跨请求熔断 | 指数退避/EWMA/半开探测已实现 | 指标观测仍缺（运维债） |
| REL-04 | 会话级 `jar.apiHost` 亲和已存在 | 跨会话健康管理仍缺（性能批方案先行） |

### 3.3 需运行验证（先测后改，不得按推断直接改代码）

- SEC-03 共享桶退化：取决于实际对端与代理链，需在生产形态确认 `clientIp` 实际取值。
- PERF-01/02：逐资源实际传输字节与 SW Cache Storage 体积（拼接 gzip 数已作废）。
- PERF-03/04：模块拆分与启动去重的实测收益（受 C06/C07 约束）。
- PERF-05：`reused_socket` 复用率与分段耗时基线。
- REL-02：具体遗漏的 Promise/回调错误处理点需逐一列举（事实部分成立，修法受 C01 约束）。
- FE-03/C11：IDB 全量读取与 ZIP 导出的真实内存峰值。
- REL-07：OCR 串行下的分段耗时与吞吐（C14）。

### 3.4 设计权衡（先出方案，等用户选择）

- SEC-02 令牌过期/吊销/时间片、SEC-05 管理员权限分离、SEC-04 口令治理：需兼容/迁移/回滚设计（第 4 批后单独评审）。
- C02 `JMW_TRUST_PROXY` 配置策略：依赖生产代理链确认，禁止默认信任私网段。
- PERF-02 内容哈希+缓存分层（发布协议变更）、PERF-03 动态 import 拆分（锁运行时+SW 升级兼容）。
- 下载/离线批次（FE-01/02/03）、供应链固定（DEL-07/08，SHA/digest 须实际核验值）。

## 4 第 1–4 批最小复现与新增测试计划

### 第 1 批 CI 测试与制品校验

复现（已具备）：
1. `grep -n "npm ci\|npm install" .github/workflows/docker-publish.yml` → 无命中（DEL-01）。
2. `node test/reader-performance.test.js` → 119 行断言失败（已复现）：证明断言以字符串扫描把"LRU 复用保留已验证尺寸"的合法读取误判。
3. `node test/deployment.test.js` → 93 行 POSIX 位失败（已复现，Windows）。
4. 临时目录构造合成制品：最小合法制品 + `sessions/` 目录 + 合成 `.pem` + 缺 `package-lock.json`，经 Git Bash 运行 `scripts/validate-release-artifact.sh`，证明当前脚本放行（DEL-03/制品清单缺口）。

新增/修改测试（先证明问题再改）：
- reader-performance：行为级断言替代字符串扫描——验证 LRU 重用条目保留已验证尺寸、原图路径不为测尺寸做完整预解码（stub 解码计数），且能捕获"真正清除尺寸"的回归。
- deployment：平台契约（win32 不把 POSIX 位缺失当业务错误但显式标记；Linux CI 保留可执行位与真实拒绝断言）；生产路径阻断改用可注入路径，删除"目录不存在也算过"的无效断言。
- 制品校验：必需清单补 `package-lock.json`；允许目录/文件规则（白名单优先）；合成 session/密钥/嵌套禁止目录必须 FAIL，合法最小制品必须 PASS。
- CI：`npm ci`（锁文件安装）加在 `npm test` 之前，保留"测试失败阻止发布、PR 不发布"。
- README：修正零运行依赖与直接启动步骤。

### 第 2 批 chapter AI 资源控制

复现：内存桩（沿用 `chapter-ai.test.js` 的 stub 基建）：未配置 AI Key 时 500 个新章节入队触发 501 次同步写盘调用（整改说明已给出的桩验证，本轮重跑确认）。

新增测试（`chapter-ai.test.js`/`backend.test.js`）：
- 容量边界：queue/records/stats 条数与持久化字节上限；满后状态不增长、超限有明确结果。
- 同 key 不重复入队；手工 enqueue 与自动发现/详情批量/启动恢复服从同一容量边界。
- 无 AI Key 不因普通浏览自动建任务/热度写盘；既有完成结果可读；显式离线排队写成契约并测试。
- 脏标记+合并写+单写者+原子替换：500 章节模拟请求的写盘次数远小于 501 且最终状态正确；新更新不被早写覆盖；写失败保留重试态。
- 预算：整任务页数/累计输出字节/单图像素/总时长，检查先于重编码与发送；计时覆盖响应体读取；模型返回有字节上限。
- 旧 state 加载、重复 key、运行中任务、重试、退出 flush；超预算明确失败（保留整章语义）。

配置：`.env.example`/`docker-compose.yml` 同步新默认值与依据，README 对应段落。

### 第 3 批 翻译代理与服务资源边界

复现：隔离假翻译服务（本地 Node HTTP stub）覆盖慢上传、超上限、排队满、永不返回响应头、永不结束响应体、客户端断开、非法结果 URL/MIME；逐路径断言槽位归还与监听器清理。

新增测试：
- Node 代理（`backend.test.js`）：槽位在读取 body 前获取；等待数/等待时间/读取时间上限；整体 deadline 覆盖上传/POST/响应头/响应体/结果 GET；`private` 缓存与 MIME/origin/路径白名单不回归；token 不出现在浏览器响应与日志。
- Python（`translation-service-poc/tests`）：上传期限与连接/上传阶段准入；`max_inflight` 前移或补充前置闸；队列忙/未配置/失败返回不同状态；空 token 不默认放行（缺 token 禁用能力并明确提示，或严格模式拒绝启动——按用户选定契约）；liveness/readiness 分离，warmup 失败使 readiness 失败且不阻断整站启动语义被验证。
- 不移除 OCR 串行锁；字体缓存仅在证明热点后有界化。

### 第 4 批 CSRF 与认证失效交互

复现：假请求矩阵——跨源 POST `/api/favorite`（`Origin: https://evil.example`）、same-site 不同 origin、`Origin: null`、无 Origin 脚本请求、可信/不可信代理链 XFF 组合，证明当前三端点放行、伪造转发头可影响 IP/Secure 判定（用假请求在本机验证，不动生产 TRUST_PROXY）。

新增测试：
- 集中同源校验覆盖 favorite/like/logout（及盘点其他非安全方法）；跨源/same-site 跨 origin/null 拒绝，同源与明确支持的脚本请求放行。
- 门禁失效（`needAuth: true`）与 JM 失效区分：前者单实例重新验证，后者清账号 UI 引导重登；并发 401 不重复建 gate；旧响应不清新账户；恢复后只恢复活跃路由、无重复监听器与 me 循环。
- 现有认证失效/收藏快照/共享请求/跨标签测试（navigation-cache、favorites-navigation、service-worker 等）必须继续通过。
- 冷启动本地锁先于 API；手机端 gate 不自动聚焦。

## 5 验收对照（第 0 批）

- 报告摘要、索引、路线图不再含 C01–C15 错误执行依据：✅（45+ 处勘误，残留检查通过；错误说法仅以"原文…有误"引用形式保留）。
- 基线结果可按原命令重现：✅（第 1 节表格，命令与整改说明第 10 节一致）。
- 三份来源报告未动：✅（仅改 consolidated-analysis 与 AGENT.md 两条债项描述）。

---

# 第 1 批执行结果：CI 测试与制品校验（2026-10-09）

修复的编号：DEL-01、DEL-02、DEL-03、DEL-04（平台契约与无效安全断言部分）；C13 的方向性结论已在本批落实（CI 补安装后仍需修既有测试失败——本机 reader-performance 与 deployment 两处失败已在本批修复）。

## 修改文件与行为差异

| 文件 | 差异 |
| --- | --- |
| `.github/workflows/docker-publish.yml` | 测试前新增 `npm ci`（锁文件安装）；publish `needs: test` 与 PR 不发布规则未动。 |
| `public/js/reader.js` | 抽取纯函数 `readerDecodedRecord({url, generation, sourceVersion, dims})`（1:1 行为等价），`doDecode` 原图路径改为调用它读取 `state.dims.get(idx)` 保留已验证尺寸。无行为变化。 |
| `test/reader-performance.test.js` | 原 119 行"禁止区间出现任何 `state.dims.`"改为：①禁止 `state.dims.set/delete/clear`（真回归=清除尺寸）；②要求存在 `state.dims.get(idx)` 读取（防静默丢失）；③新增 `readerDecodedRecord` 行为用例：保留已验证宽高、undefined/null 不伪造、backfill 回填端到端可读。 |
| `scripts/validate-release-artifact.sh` | 必需清单补 `package-lock.json`；生产路径阻断改为前缀循环并支持 `JMW_RELEASE_EXTRA_BLOCKED_PATHS`（仅追加、不能移除内置前缀）；Node 校验新增顶层允许清单与 translation 目录允许清单（白名单优先）、`sessions/` 禁止目录、`.pem/.key/.sql/SSH 私钥/归档后缀/任意 `*.env` 环境备份；Dockerfile 模式新增锁文件 COPY 检查。 |
| `test/deployment.test.js` | 平台契约：git 索引 `100755` 断言（全平台）+ POSIX 位断言仅非 win32 + win32 经 bash 运行校验器（缺 bash 显式失败，不静默跳过）；制品夹具补锁文件；新增负向用例：缺锁文件(68)、顶层多余文件、嵌套 `lib/nested/data`、顶层与 `lib/sessions/`、`deploy.pem`、`uploads.env`、`backup.zip`、翻译目录多余文件（均 72）；生产路径测试重写：不存在路径断言精确命中 67 分支，注入受保护前缀用真实存在目录命中 65 阻断分支（经 `pwd -P` 规范化，win32 兼容）；负向用例全部还原后最小合法制品重新 PASS；GHCR 覆盖 `build: !reset null` 计数=2（双服务禁构建）；workflow `run: npm ci` 与 README `npm ci --omit=dev` 均有回归断言。 |
| `README.md` | 部署方式一改为先 `npm ci --omit=dev` 再 `node server.js`；明确后端唯一运行依赖 sharp（章节视觉分析）；技术实现表与目录树同步修正。 |
| `AGENT.md` | §9 发布制品白名单补 `package-lock.json`（与校验器、Dockerfile、测试一致）。 |

## 测试结果（2026-10-09，Windows + Git Bash，Node v24.15.0）

| 项 | 结果 |
| --- | --- |
| test:unit 全部 16 文件（photo/content-filter/offline-metadata/navigation/navigation-cache/favorites-navigation/service-worker/frontend-robustness/user-list-pagination/mobile-layout/mobile-gate-focus/clipboard-runtime/home-swiper-loading/reader-performance/descramble-worker） | ✅ 全过（reader-performance 由失败转绿） |
| chapter-ai.test.js | ❌ 未运行通过：`MODULE_NOT_FOUND: sharp`（本机未安装依赖，环境阻碍；CI 加 `npm ci` 后可运行） |
| translation-deployment.test.js / deployment.test.js | ✅ 全过（deployment 由 Windows 平台失败转绿） |
| backend.test.js / https-fetch.test.js | ❌ 同为缺 sharp 未运行（环境阻碍） |
| `npm run check` | ✅（34 JS、3 CSS） |
| `git diff --check` | ✅ |
| `docker compose --env-file .env.example config --quiet` | ✅ |
| `docker compose --env-file .env.example -f docker-compose.yml -f docker-compose.ghcr.yml config --quiet` | ✅（双方禁用 build 由计数断言锁定） |
| Python 回归 / 浏览器矩阵 | 未运行（本轮改动未触及前端行为与 Python 侧；reader.js 为等价抽取，已过 check 与单测） |

新增测试对原故障的可捕获性（突变自检）：删 workflow 的 `npm ci`→deployment 断言失败；删 README 安装步骤→断言失败；校验器移除锁文件要求→缺锁用例失败；移除 sessions/或密钥检查→对应用例失败；删除生产路径阻断 case→注入用例得到 68 而非 65 失败；原图路径清除/不读 dims→字符串守卫失败；`readerDecodedRecord` 丢弃 dims→行为用例失败。

## 回滚与兼容

- 本批 7 个文件独立成批，`git checkout -- <files>` 即可整体回滚；reader.js 抽取为行为等价重构，回滚无数据/接口影响。
- `JMW_RELEASE_EXTRA_BLOCKED_PATHS` 只能追加阻断前缀，不能削弱内置生产路径保护；不设置时行为与旧版一致（除新增拒绝项）。
- 未提交、未推送；下一批（chapter-ai）不依赖本批改动。

---

# 第 2 批执行结果：chapter AI 资源控制（2026-10-09）

修复的编号：REL-01（enqueue 无限流无上限、匿名/持口令 DoS 面、同步写盘热路径、整章 base64 无预算积累；OOM/写放大量级按验收标准以合成任务实测）。REL-01 中"`/api/album?id=<随机数>` 每请求触发全量落盘"的写放大部分已消除；匿名可达性取决于 `ACCESS_PASSWORD` 是否为空（SEC-04 治理属后续设计权衡批）。

## 行为差异（对照整改说明第 6 节 7 条要求）

1. **状态容量**（`lib/chapter-ai.js`）：queue/records/stats 条数上限（默认 1000/5000/2000）+ 状态文件字节护栏 8 MiB；启动加载即收敛超限历史状态；记录淘汰顺序=失败 → 孤儿 queued → 旧提示词版本 completed → 最旧当前版本 completed（排队/运行中的记录不淘汰）；热度统计淘汰调度价值最小条目。默认值依据写在构造函数注释并同步 `.env.example`（含说明）、`docker-compose.yml`、README、AGENT.md §5。
2. **统一准入**：`enqueue()` 成为唯一入口（手工/自动发现/详情批量/启动恢复共用容量边界）。手工超限抛 `code='queue_full'`（路由映射 429）、自动超限返回 null（状态不增长）；`/chapter-ai/enqueue` 新增客户端 20 次/5 分钟 + 全局 120 次/5 分钟限流。
3. **无 AI Key 契约**（显式化并测试）：自动入队返回 null（不建任务）；手工入队返回 503（`code='ai_disabled'`）；热度/榜单更新仅驻内存、不调度写盘；既有完成结果仍可 `GET /api/chapter-ai` 读取展示。
4. **写盘模型重构**：脏标记 + 250ms 合并延迟写 + 单写者 + 保留 tmp/rename 原子替换；请求热路径只置脏。写失败保留脏标记与 `lastSaveError` 待重试（不静默丢失）；`shutdown()` 顺序新增 `chapterAi.stop() + flushSync()`。**验收实测：500 章节 touchPopularity+enqueue 模拟请求期间同步写盘 0 次，合并窗口后恰好 1 次落盘且状态完整**（旧基线为 501 次同步全量写）。
5. **单任务预算**：页数（60，先于任何下载）、单图像素（40M，仅读元数据即判定，先于重编码）、累计编码字节（24 MiB，逐张累加判定，先于模型发送）、总时长（10 分钟，deadline 覆盖下载/解扰/发送/**响应体读取**，body 读取经 abort-race 中断）、模型响应体字节（4 MiB，逐块读取超限即取消流）。预算失败抛 `ChapterAiBudgetError` → 永久终止不重试（重试不可能成功）。
6. **整章语义保留**：超预算明确失败并写入失败原因，不截取前几页、不改分批摘要。
7. **旧状态兼容**：v1 记录重排队受队列上限约束；running 标志复位逻辑不变；重启加载后状态与内存一致（有测试）。

## 修改文件

`lib/chapter-ai.js`（容量/合并写/预算/契约）、`server.js`（构造参数接线、enqueue 路由限流与状态码映射、shutdown flush）、`test/chapter-ai.test.js`（重写：保留全部原用例 + 新增 8 组行为用例）、`.env.example`、`docker-compose.yml`、`README.md`（env 表）、`AGENT.md`（§5 资源默认值段）。

## 测试结果

| 项 | 结果 |
| --- | --- |
| chapter-ai.test.js | ✅ 全过。**注意：本机未安装 sharp，图像编解码使用最小桩（输出显式标注）；调度器/容量/写盘/预算逻辑为真实行为验证，编解码行为由 CI（npm ci 后）覆盖。** 新增用例：500 章节写放大复现→合并写；无 Key 契约（500 次浏览 0 写盘、自动 null、手工 ai_disabled、完成结果可读）；队列容量（手工 429/自动跳过/同 key 幂等/完成结果不占容量）；记录与热度淘汰顺序；超大历史队列加载收敛；页数/像素/累计字节/总时长/响应字节/挂起响应体 6 类预算失败（预算失败不重试）；写失败保留重试且数据不丢；退出 flushSync。 |
| 其余 15 个单元测试 + translation-deployment + deployment | ✅ 全过 |
| `npm run check` / `git diff --check` / Compose 基础与 GHCR 组合解析 | ✅ |
| backend.test.js | ❌ 未运行：缺 sharp（环境阻碍；CI 已具备 npm ci）。server.js 改动经 `node --check` 与静态检查，路由行为待 CI backend 测试覆盖。 |
| Python 回归 | 不适用（本批未触及） |

## 回滚与兼容

- 单批回滚：恢复上述 7 个文件即可；状态文件格式未变（新增上限只影响写入时机与容量，旧状态可直接回滚加载）。
- 兼容：既有 v1/v3 记录、队列结构、`GET /api/chapter-ai` 响应契约不变；`/chapter-ai/enqueue` 在禁用/满载时由 202 变为 503/429（新契约，前端该入口当前无调用方——advanced.js 未调用此端点，属纯管理接口）。
- 下一批（翻译代理）不依赖本批改动。

---

# 第 3 批执行结果：翻译代理与服务资源边界（2026-10-09）

修复的编号：REL-03（无超时、无并发闸）、REL-10（连接级限流与慢速上传超时）、SEC-07（空 token 默认放行）、B8/REL-07 的 readiness 部分（healthz 不覆盖 OCR 失败）；SEC-21（healthz 详情无认证）按整改说明保留为后续项，本批未改 healthz 返回内容。

## 行为差异（对照整改说明第 7 节 7 条要求）

1. **Node 代理准入先于上传**：新增 `lib/translation-proxy.js`（从 server.js 抽取以便不起 server.js 即可测试）。全局（默认 4）/单客户端（默认 2）并发槽位在读取上传体**之前**获取；等待队列上限 16、等待超时 5s（满/超时均 429 busy 并排空请求体）；上传读取期限 30s（慢速上传 504，不转发）。
2. **整体 deadline**：单条截止时间（默认 120s）覆盖上传 → 服务 POST → 服务响应体 → 结果 GET → 结果响应体，全程与客户端断开信号组合；所有成功/错误/超时/取消路径经 `finally` 释放槽位并 dispose 定时器与监听器；等待者取消后不会获槽（FIFO 泵送时重检 aborted）。
3. **既有边界保持**：图片 MIME 白名单、上传/结果字节上限、结果 origin+`^/v1/results/[0-9a-f]{64}\.webp$` 白名单、`private, max-age=86400` 缓存语义全部保留并有测试锁定；token 只进入发往翻译服务的 `Authorization` 头，不进浏览器响应（测试断言响应头/体不含 token）。
4. **Python 上传期限与准入**：`_read_limited` 增加总读取期限（默认 60s，408）；`/v1/translate/page` 在读取请求体前获取上传闸门（默认 8 连接、等待 5s 超时 429 `upload_queue_full`）；任务队列忙（429 `translation_queue_full`）、配置未就绪（503 warmup 失败）、任务失败（job error）三种状态明确区分；uvicorn 增加 `--limit-concurrency 64 --timeout-keep-alive 30`。
5. **空 token 契约（选择的兼容策略）**：`TRANSLATION_SERVICE_TOKEN` 为空时，主站 `/api/config` 报告翻译不可用、代理返回 503 明确提示；翻译容器 `/v1/*` 返回 503 `disabled`（与 401 认证失败区分）；`/readyz` 不因空 token 失败、不阻断整站启动；严格模式 `TRANSLATION_REQUIRE_TOKEN=1` 时翻译容器拒绝启动（RuntimeError，uvicorn 非零退出）。不生成/提交真实 token，未改生产 `.env`。
6. **liveness/readiness 分离**：`/healthz` 保持 200 存活探针（含详情与 auth 标记）；新增 `/readyz`——warmup 失败时 503（`reason` 为异常类型），翻译路由同时拒绝（503 未就绪）；Compose 翻译健康检查切换到 `/readyz`，`service_healthy` 依赖语义变为"OCR 真坏才挡站点，空 token 不挡"。
7. **OCR 串行锁与字体缓存未动**（按整改说明第 7 条约束，留待测量后决策）。

## 修改文件

`lib/translation-proxy.js`（新增）、`server.js`（抽取接线、空 token 探测一致化、准入/期限配置）、`translation-service-poc/service.py`（上传期限/闸门/契约/readyz/严格模式）、`translation-service-poc/Dockerfile`（uvicorn 护栏）、`docker-compose.yml`（新变量透传 + healthcheck→readyz）、`.env.example`、`README.md`、`AGENT.md` §7、`test/translation-proxy.test.js`（新增 13 组行为用例）、`translation-service-poc/tests/test_service.py`（新增 5 用例）、`package.json`（test:unit 接入）。

## 测试结果

| 项 | 结果 |
| --- | --- |
| `node test/translation-proxy.test.js`（隔离假服务，13 组场景） | ✅ 正常路径（token 转发/不回传、private 缓存、202/429 透传）、空 token 503、MIME 415、排队满/等待超时 429、客户端断开后不获槽、单客户端上限、服务无响应头 504、响应体永不结束 504、慢速上传 504 不转发、超上限 413、跨源/错路径/错 MIME 结果 502；每场景后槽位归零 |
| Python `pytest tests`（本地已装 fastapi/pytest 等 wheel 依赖） | ✅ 13 通过（8 原有 + 5 新增：上传期限 408、空 token 禁用但存活/就绪不受阻、严格模式拒绝启动、warmup 失败→readyz 503+路由 503、上传闸门 429 与释放恢复） |
| 其余 16 个单元测试 / deployment×2 / check（35 JS）/ Compose 双配置解析 / git diff --check | ✅ 全过 |
| backend.test.js | ❌ 仍因缺 sharp 未运行（环境阻碍，CI 覆盖；server.js 侧改动经语法与静态检查 + 代理 lib 独立测试覆盖） |

依赖说明：为本地可验证 Python 侧，用 `pip install --user --only-binary :all:` 安装了 fastapi/uvicorn/httpx/pytest/Pillow/opencc/numpy（全部预编译 wheel，未触发原生编译与生命周期脚本，符合约束）。

## 回滚与兼容

- 单批回滚：恢复上述文件；`lib/translation-proxy.js` 与新测试文件整体删除即可，server.js 恢复内联实现。
- 兼容影响（有意变更）：空 token 部署从"匿名可用"变为"双方禁用并提示"（安全收紧，README/AGENT 已写明）；compose 健康检查从 `/healthz` 改 `/readyz`；`/api/config` 的 `translation.available` 在空 token 时为 false（阅读器据此跳过翻译路径，与路由行为一致）。
- 下一批（CSRF）不依赖本批改动。

---

# 第 4 批执行结果：CSRF 与认证失效交互（2026-10-09）

修复的编号：SEC-01（非幂等 API 无统一同源 CSRF 防护——三个 query-POST 端点连同全部非安全方法 /api 路由）；FE-05 剩余半条（门禁再次弹出的入口）；C15 相关的会话固定观察保持条件性描述未动。

## 行为差异（对照整改说明第 8 节 5 条要求）

1. **集中同源校验**：新增 `lib/origin-guard.js` 的 `checkSameOrigin`，server.js 在方法白名单（405）之后、鉴权之前对所有非 GET/HEAD 的 `/api/*` 路由统一调用。证据优先级 Sec-Fetch-Site > Origin > Referer；拒绝跨源、same-site 不同 origin、`Origin: null`、`Sec-Fetch-Site: cross-site/same-site`、矛盾元数据（cross-site + 同源 Origin）、Host 缺失但有 Origin、端口/scheme 不匹配。**无来源头契约（明确）**：三者全缺（curl/脚本/老浏览器）放行且认证要求不变——SameSite=Lax Cookie 与 JSON Content-Type 仍是该场景防线，写入 AGENT.md §5。覆盖 `/api/favorite`、`/api/like`、`/api/logout` 及其余全部非安全方法（含 /api/auth、login、comment、chapter-ai/enqueue 等）。
2. **假代理链矩阵（不靠信任私网过测试）**：clientIp/requestIsSecure/isTrustedProxyIp 从 server.js 抽取为 `createProxyTrust`（server.js 行为不变）。矩阵证实：不可信对端自带 XFF / `X-Forwarded-Proto: https` 不能改变 clientIp/Secure；环回与**显式配置的精确 CIDR** 内才解析转发头；配置 `172.18.0.0/16` 时 `172.19.0.9`（网段外私网）不受信；XFF 链从最靠近应用一跳剥离可信代理；追加式 `X-Forwarded-Proto: https, http` 整体拒绝；垃圾 token 使整头不采信；TLS socket 直连判 https。未修改生产 TRUST_PROXY。
3. **两类 401 分流**：`needAuth: true`（站点门禁失效）→ api.js 派发 `jmw-access-required` → app.js **单实例**（`accessGateOpen` 守卫）动态拉起 gate，成功后只 `refreshAvatar()` + `render(prepareHashNavigation())` 恢复当前路由；JM 登录失效（无 needAuth）→ 既有 unauthorized 失效 + 仅在原有登录态时派发一次 `jmw-auth-changed`（清头像等旧账号 UI），路由错误文案区分（`routeErrorMessage` 移至 ui.js：门禁 vs “JM 登录已失效，请重新登录”）。
4. **并发与迟到 401**：并发 needAuth 401 只建一个 gate；`wasIdentified` 守卫防 me→401→通知→me 循环（重复 401 不再派发）；登录期间旧世代 401 被 `requestEpoch !== identityEpoch` 跳过，不清新账户、不误弹门禁（8eaf132 既有机制，新增断言锁定）。
5. **既有回归**：navigation-cache、favorites-navigation、service-worker、mobile-gate-focus（gate 不自动聚焦）等全部继续通过；冷启动顺序新增断言（本地锁运行时先于 /api/me 探测）。

未做（按整改说明边界）：未更换门禁令牌格式、未增加管理员角色、未强制修改口令；SEC-02/SEC-05 的服务端过期/吊销与权限分离留待单独设计评审。

## 修改文件

`lib/origin-guard.js`（新增）、`server.js`（代理信任抽取 + CSRF 接线，`requestHasSafeBrowserContext` 运维路由语义未动）、`public/js/api.js`（401 分流派发）、`public/js/ui.js`（承接 `routeErrorMessage`）、`public/js/app.js`（单实例重验证 + 监听一次）、`test/auth-guard.test.js`（新增）、`package.json`、`AGENT.md`（§5 不变量、§6 前端分流、§11 债项改写）。

## 测试结果

| 项 | 结果 |
| --- | --- |
| `node test/auth-guard.test.js` | ✅ 同源矩阵 20 例（含矛盾元数据/端口/scheme/Host 缺失/无证据契约）、代理链矩阵 12 例（不可信伪造全部失败）、api.js 行为 5 组（needAuth 分流、JM 失效单次清理、防 me 循环、登录期旧 401、跨标签失效广播）、文案区分 5 例、app.js 接线断言（单实例守卫/监听唯一/恢复仅当前路由/冷启动锁先于网络） |
| 其余 17 个单元测试（含 navigation-cache/favorites-navigation/service-worker/mobile-gate-focus） | ✅ 全过 |
| deployment×2 / check（36 JS）/ Compose 双配置 / git diff --check / Python 13 项 | ✅ 全过 |
| backend.test.js（含路由级 403 集成） | ❌ 缺 sharp 未运行（环境阻碍；CI 覆盖。守卫逻辑矩阵在 lib 层独立验证，接线为单一调用点且经语法/静态检查） |

## 回滚与兼容

- 单批回滚：恢复上述文件并删除 `lib/origin-guard.js`、`test/auth-guard.test.js`。CSRF 守卫为纯新增拒绝分支，回滚即恢复旧行为。
- 兼容影响（有意收紧）：跨源/same-site 跨 origin/无 Origin 但 Sec-Fetch-Site 指示跨站的非安全方法请求从“依赖 SameSite”变为直接 403；本站前端全部同源 fetch（浏览器对 POST 必带 Origin）与 curl 类无源头请求不受影响。运维路由（/logs、/doh）维持原 `checkOperationalAccess` 语义。
- 浏览器矩阵（真机 390×844/667×300、旧 SW 升级窗口）本轮未执行——前端改动限于 api.js 派发与 app.js 单实例守卫，已有导航/收藏/焦点测试覆盖对应逻辑；发布前按 AGENT.md §10 补真机回归。

---

# 总汇报（第 0–4 批）

**已交付批次与核心结果**

- 第 0 批：基线固定（HEAD `8eaf132`、Node 24.15.0、缺 sharp/浏览器矩阵的受限项如实记录）；综合报告按 C01–C15 就地勘误 45+ 处（摘要/索引/正文/路线图全覆盖，三份来源原文未动）；AGENT.md 两条过时债项修正；四分类与批次计划成文（本文档）。
- 第 1 批：CI 补 `npm ci`；reader-performance 断言修正并补行为测试（保留尺寸语义、捕获真实回归）；deployment 平台契约（git 索引执行位 + bash 执行，不再静默跳过）；制品校验改允许清单并补锁文件/sessions/密钥/归档检查；生产路径阻断用注入前缀真实覆盖 65 分支；README 零依赖宣称修正。**修复 DEL-01/02/03/04。**
- 第 2 批：chapter-ai 容量（queue/records/stats/字节）+ 脏标记合并写（500 章节模拟从 501 次同步写盘 → 0 热路径写 + 1 次合并落盘）+ 无 Key 禁用契约 + 手工入队限流（429/503）+ 五类任务预算（超限永久失败不重试）+ 退出 flush。**修复 REL-01。**
- 第 3 批：翻译代理抽取为 lib 并获得准入（先于上传）/整体 deadline/取消释放全套边界测试；Python 侧上传期限/上传前准入/空 token 双方禁用契约/readyz 分离/严格模式。**修复 REL-03/REL-10/SEC-07 及 readiness 半条。**
- 第 4 批：全部非安全 /api 方法集中同源校验；代理信任抽取并矩阵验证“不可信转发头不可伪造”；前端 401 分流（单实例门禁重验证 vs JM 失效清理）+ 防 me 循环。**修复 SEC-01 与 FE-05 剩余半条。**

**统一验证状态（2026-10-09，Windows + Git Bash）**：18 个单元测试、deployment×2、`npm run check`（36 JS/3 CSS）、Compose 基础与 GHCR 组合解析、`git diff --check`、Python 13 项全部通过；`backend.test.js` 与 `https-fetch.test.js` 因本机缺 sharp 未运行（CI 已具备 `npm ci`，属环境阻碍而非跳过）；真机浏览器矩阵与生产验收未执行（发布前按 AGENT.md §10 补）。

**回滚**：每批独立成组（见各批“回滚与兼容”），未提交、未推送、未改生产配置与数据。

**后续（先出方案等用户选择，未实施）**：下载/离线（FE-01/02/03、queued 恢复策略）、启动与静态资源性能（压缩实测、哈希+缓存分层协议、动态 import 拆分、连接池实测、可观测性）、SEC-02 令牌过期/吊销与 SEC-05 权限分离（含兼容/迁移/回滚设计）、SEC-03 生产代理链确认与 TRUST_PROXY 配置、SEC-04 口令治理、供应链固定（DEL-07/08）、SEC-21 healthz 详情收敛、REL-02 具体错误处理点排查、REL-05 退出收口细化、REL-06 重复代码收敛、REL-08 拆分、DEL-04 CI 矩阵扩展。





---

# 复核补修（2026-10-09 第二轮，独立复核发现的 7 项遗漏）

用户独立复核发现 7 项边界遗漏，全部补修并附行为测试；另按复核意见勘误两处报告错误。

> 此处保留第二轮原始汇报作为历史记录，不代表最终验收结论。2026-10-10 再次复核发现 #4 的元数据读取期限、#5 的不可淘汰状态容量仍有遗漏，且真实 sharp 用例未通过；补修与最终实测状态见本文末节。

| # | 遗漏 | 补修 | 验证 |
| --- | --- | --- | --- |
| 1 | Python 上传超时只在收到下一块时检查，停传连接永久占用上传闸门 | `_read_limited` 改为 `asyncio.wait_for(read_all(), timeout)` 整体超时：到期取消读取任务（覆盖停传/慢速两种形态），408 后 finally 归还闸门 | `test_stalled_upload_is_interrupted_and_gate_released`：发一块后停传 30s → 408；后续请求 200/202（闸门已归还） |
| 2 | 空 token 禁用翻译时仍执行 OCR warmup，warmup 失败 → `/readyz` 503 → `service_healthy` 阻断整站 | lifespan 在 `token_disabled` 时跳过 warmup（禁用状态下无理由加载 OCR，也不让可选失败进入 readiness） | `test_empty_token_skips_warmup_so_readyz_stays_ok`：空 token + broken OCR + WARMUP=1 → `/readyz` 200、`ready: true` |
| 3 | Node 上传超时后未清空已缓冲字节、未移除请求流监听器，停传上传保留全部已收数据绕过内存约束 | `readRequestBody` 终止时清 `chunks` 并移除 data/end/error 监听；`handle` 上传超时改为**先回 504 再 `req.destroy()`**（剩余字节不可预知，不为保 keep-alive 无界排空） | translation-proxy 场景 10 扩展：慢速与停传两种上传 → 504、`listenerCount('data')===0`、`req.destroyed`、槽位归零、后续请求 200 |
| 4 | chapter-ai 总时长只是循环起点的时间戳检查，章节/图片获取挂起时任务长期 `running` | `analyze` 改为共享 `AbortController` + 到期 abort 的完整截止期限：每个阶段（章节获取/逐图获取/解扰/重编码/模型发送/响应体读取）都与截止 Promise **race**（注入实现忽略取消信号也到点结束）；信号协作转发到 `fetchChapter(aid, photoId, signal)`/`fetchImage(url, signal)`（server.js 已转发到 `upstreamRequest`/`fetchImageResponse`）；模型阶段超时经共享控制器立即中断响应体读取。附带修复：截止定时器此前误 `unref`，会在事件循环清空时静默退出制造假绿，已改为任务运行期保持进程存活 | 新增三用例：章节获取挂起（忽略信号）→ 1s 预算处 `ChapterAiBudgetError`，runJob 后任务 failed 出队；图片获取挂起但尊重信号 → 到期终止；挂起响应体 → 模型阶段超时中断 |
| 5 | 记录条数上限被运行/完成路径绕过（runJob 建记录不收敛）；字节预算用紧凑 JSON 度量、实际写格式化 JSON，超限仍写盘成功 | `runJob` 在创建 running 记录后与完成后各执行 `enforceRecordCap()`；新增 `serializeState()`，`writeState` 与 `evictRecordsForSize` 使用同一格式化序列化 | 新增用例：`maxRecordEntries=2` 连续完成 3 任务 → 内存与磁盘都恰 2 条；`maxStateBytes=65536` 灌 8 条 ≈144KB 记录 → `save()` 后落盘文件 ≤65536B |
| 6 | `api.auth()` 成功不切换访问认证世代：门禁期间发出的旧请求迟到返回 needAuth 401 会再次派发 `jmw-access-required` 重开 gate | `api.auth` 成功后执行 `invalidateNavigation('all')`（世代 +1 并清除验证前积累的未授权缓存态）；迟到的旧 401 因 `requestEpoch !== identityEpoch` 不再派发 | auth-guard 新增完整生命周期用例：A 触发门禁（dispatch×1）→ B 在途 → `api.auth` 成功 → B 迟到 401 → dispatch 仍为 1，且 B 的 401 错误本身保留 |
| 7 | Origin 匹配即放行，不校验 Referer 矛盾 | `checkSameOrigin`：Origin 与 Referer 同时存在时必须同源，矛盾 → `origin_referer_conflict` 拒绝（一致仍放行）；原测试中“以 Origin 为准”的错误断言改为拒绝 | auth-guard 矩阵新增两例：矛盾拒绝、一致放行 |

## 报告勘误（按复核意见）

1. **`test/https-fetch.test.js` 不依赖 sharp、本机可运行且通过**——此前第 2/3/4 批把它与 backend.test.js 一并列为“缺 sharp 未运行”是错误的；实际受阻碍的只有 `backend.test.js`，以及 `chapter-ai.test.js` 的真实编解码路径（桩模式覆盖调度器逻辑，编解码行为仍由 CI 覆盖）。
2. **部署测试的 bash 依赖是 Git Bash**：win32 下 `deployment.test.js` 经 PATH 上的 `bash` 运行校验脚本，若 PATH 默认解析到 WSL bash 会因路径转换失败；本会话在 Git Bash 环境执行，全部通过。

## 补修后全量回归（2026-10-09 第二轮）

18 个单元测试 ✅（含扩展后的 chapter-ai / translation-proxy / auth-guard）、`npm run check`（36 JS/3 CSS）✅、deployment×2 ✅、Compose 双配置 ✅、`git diff --check` ✅、Python 15 项 ✅（13 + 2 新增）、`node test/https-fetch.test.js` ✅（勘误后纳入常规验证）。仍未运行：`backend.test.js`（缺 sharp，CI 覆盖）、真机浏览器矩阵、生产验收。

---

# 最终复核补修（2026-10-10，Codex 执行）

## 原汇报的剩余遗漏与复现

第二轮 #1/#2/#3/#6/#7 已经通过独立复核，本轮保留这些实现；#4/#5 尚不能认定完成：

1. `analyze()` 直接等待 `sharp(...).metadata()`，未与总期限竞争。注入挂起元数据读取后，1 秒任务预算到期，任务仍可能占用 running 槽位。
2. 记录上限为 2 时，3 个失败重试任务都留在队列，记录不可淘汰，内存与磁盘都保留 3 条；64 KiB 文件预算下，600 条只有队列字段的状态实际写出 92878 B，`save()` 仍返回成功。原有“只淘汰可淘汰记录，剩余超限告警但写盘”的实现不构成硬上限。
3. 安装真实 `sharp@0.33.5` 后，原累计字节用例报 `Missing expected rejection`：该环境下 2×2 图片编码为 321 B，3 页共 963 B，未超过生产实现的 1024 B 最小预算。桩测试通过不能证明这条编解码用例通过，也不能据 CI 已配置依赖声称 CI 实测通过。

## 修复与新增行为测试

| 问题 | 实现 | 实测 |
| --- | --- | --- |
| 元数据读取漏期限 | 默认元数据读取仍使用 sharp；通过可注入的 `readImageMetadata`，将读取与共享任务截止 Promise race | 完全忽略取消的挂起读取在 1 秒预算处结束；`active=0`、队列移除、记录 failed 且错误为总时长预算；独立 3 秒 watchdog 防止静默退出假绿 |
| 重试记录不可淘汰 | 每条已接受任务预留 4 KiB 队列/重试记录空间，固定状态另预留 4 KiB；有效队列取配置、记录上限、字节槽位的最小值 | records=2、queue=5：只接受 2 条，第三条自动跳过/手工 queue_full；并发失败后内存与磁盘均 2 条 queued |
| 队列独占字节预算 | 64 KiB 文件预算下有效队列为 15；按格式化 JSON 实际 UTF-8 字节计算，优先淘汰非任务记录/低价值热度；旧待重试记录必要时仅去掉旧结果缓存 | 600 次入队只接受容量允许的任务；使用最大 16 位 ID、500 个全需 JSON 转义的错误字符、500 条热度压力后，文件仍 ≤65536 B；重启后已接受任务和重试次数全部保留 |
| 无法收敛仍写超限文件 | 仍超限时 `state_full` 拒写，旧文件不动、dirty 保留；暂停新任务准入，成功重试后恢复 | 注入无法淘汰的超大 scheduler 字段：save=false、capacityBlocked=true、原文件逐字节不变；移除异常字段后 flush 成功并恢复入队 |
| 历史队列恢复 | 超限旧队列先独占保存原始 `state.capacity-recovery.json`，再保留高优先级活动任务；副本已有/保存失败则拒绝启动，不能覆盖旧副本或原状态 | 10→5 与 600→15 均保留完整原始队列副本、活动状态在预算内；副本冲突时原状态/副本都不改写；超额任务仅保留在副本，不自动回灌 |
| 旧记录淘汰键不一致 | 按 records 字典实际键识别/淘汰，不依赖记录内部 key | 内部 key 错误的失败缓存可淘汰，不进入无进展循环；对应活动队列的记录保留 |
| 真 sharp 测试假设错误 | 按与 analyze 相同的 JPEG 编码输出计算必定超限的页数，不降生产 1024 B 下限、不删或放宽拒绝断言 | 真实 sharp 与缺依赖桩模式各通过，真实模式输出没有“使用桩”标记 |

现有 API 接线也做了本机 HTTP 实测（隔离数据目录、无上游调用）：`GET /api/ai/config` 的 `chapterAnalysis.maxQueueEntries=2`；连续三个手工入队返回 `202/202/429`；落盘队列为 2，文件小于 64 KiB。

本轮修改：`lib/chapter-ai.js`、`test/chapter-ai.test.js`、`.env.example`、`README.md`、`AGENT.md` 与本文。无新增环境变量，Compose 现有透传不变。AGENT §5/§7 按 §13 补充容量不变量和新恢复副本；README 说明有效容量、超限拒写与恢复副本操作边界。

## 最终门禁（2026-10-10，本地实测）

sharp 使用仓库内隔离临时依赖目录，来自现有锁文件与官方预编译包；安装时 `--ignore-scripts --omit=dev`，未编译/构建。通过 `NODE_PATH` 让测试加载真实 sharp，未修改根 package/package-lock、未触生产配置或数据。部署脚本使用 Git Bash，而非 PATH 中的 WSL bash。

| 命令/检查 | 结果 |
| --- | --- |
| `npm test`（真实 sharp + Git Bash） | 通过：18 个单元测试文件、backend、https-fetch、2 个 deployment；backend 与章节真实编解码不再列为“缺 sharp 未运行” |
| `node test/chapter-ai.test.js`（无 NODE_PATH） | 通过，明确标记桩模式；与真实模式结果区分 |
| `npm run check` | 36 JS / 3 CSS 通过 |
| `python -m pytest translation-service-poc/tests -q` | 15 通过；1 条既有 Pillow 弃用警告 |
| 基础 Compose / 基础+GHCR 覆盖 `config --quiet` | 两种配置均通过，仅解析未启动/构建容器 |
| `git diff --check` | 通过 |
| 真机浏览器矩阵、生产验收、GitHub CI 实际运行 | 本轮未执行，不据本地测试宣称这些验收已通过 |

未提交、未推送、未部署，保留 ZCode 原有未提交工作。回滚本轮时应仅回退本节列出的增量，不能覆盖之前批次成果；如上线后产生恢复副本，代码回滚不删除副本或回灌覆盖生产状态。
