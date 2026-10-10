# JM Web 综合分析复核与 ZCode 整改执行说明

本说明用于把综合分析报告转换为可验证的整改任务。主要资源控制和 CI 问题值得修复，但不能照抄原报告中的全部结论和路线图。执行时先校正基线，再分批修复；每批必须有最小复现、回归测试和独立差异，不能一次性重写整个项目。

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-10-09 |
| 工作区 | `D:\project\AI\jm-web` |
| 复核代码基线 | `8eaf1322c64eaf67751645aa130ed2317da02487`，`fix: preserve favorites state on reader return` |
| 原报告基线 | `1dd0697a5d8021a7e3130f13fa85625e9de8968b` |
| 综合报告 | [consolidated-analysis-2026-10-09.md](D:/project/AI/jm-web/docs/consolidated-analysis-2026-10-09.md) |
| 项目约定 | [AGENT.md](D:/project/AI/jm-web/AGENT.md)、[AGENTS.md](D:/project/AI/jm-web/AGENTS.md) |
| 实施范围 | 后续用户将本文交给 ZCode 执行时，默认按第 0 至第 4 批推进；后续批次先出方案，再由用户选择是否实施 |

本文只规定后续整改任务，不表示整改已经完成，也不表示生产环境已经验收。若当前 HEAD 已变化，先重新定位与复现，不回退其他人已经完成的改动。

## 1 执行边界

1. 先阅读项目约定，中文汇报。以实际执行行为和当前代码为依据，不把旧报告当作事实来源。
2. 用户已禁止编译和构建。不要执行 Docker 镜像构建、打包构建、编译原生依赖、`make`、`ninja` 等命令。测试、语法检查和 Compose 配置解析不属于构建；如依赖安装会运行生命周期脚本或触发原生编译，应先说明并取得用户许可。
3. 可以修改 CI 中的依赖安装步骤，但这不授权在本机安装依赖、运行镜像构建、推送触发远端构建或发布。
4. 不访问或修改生产部署、Caddy、生产 `.env`、真实 Session、持久化数据或翻译缓存卷。后端测试只用隔离临时目录和合成凭据。
5. 不推送远端、不发布、不部署；提交也须用户另行要求。禁止 `git add .` 或把无关文件纳入提交。
6. 当前已有未跟踪的 `.zcodeignore`、`SECURITY-AUDIT.md` 和 `docs/` 文件。先识别归属，不删除、不覆盖不相关内容。三份来源报告作为历史记录保留；综合报告可按第 0 批校正。
7. 不关闭 TLS、SSRF、DNS 校验、地址固定、上游 Cookie Origin 隔离、请求方法白名单、响应体上限或图片背压。
8. 先做针对性修复，不把拆分大型文件、换框架、换存储方案或改 AI 输出契约混入首轮。

## 2 必须修正的报告结论

以下行号指原综合报告，仅用于查找旧表述，修改后会漂移。摘要、索引、正文和路线图必须一起校正，不能只在末尾加一段勘误后仍让错误方案成为执行依据。

| 编号 | 原条目与位置 | 正确结论及实施约束 |
| --- | --- | --- |
| C01 | REL-02，663、1042 行 | 无全局异常监听器不等于已经存在高危漏洞。不能用仅打印日志的 `unhandledRejection` 或 `uncaughtException` 监听器吞掉未知异常、让进程继续正常服务。先修具体遗漏的 Promise/回调错误处理；诊断可使用不改变退出语义的 monitor。致命错误保留非零退出及外部重启机制。 |
| C02 | SEC-03，462、477 行 | 代理共享桶和 Secure 缺失取决于实际对端及代理配置，尚不能断言生产必然如此。禁止默认信任整个 `172.16.0.0/12` 或所有私网。只按验证过的代理链配置必要地址，并确认 XFF 与协议头的处理方式。 |
| C03 | PERF-05，285、831、1087 行 | `keepAliveMsecs` 是 TCP 保活探测初始延迟，不是连接空闲寿命。Node 19 起默认 HTTPS Agent 已启用 keep-alive，默认 timeout 为 5 秒。仅改成 15000 不能证明复用改善。另已有 `jar.apiHost` 会话级成功线路记忆，缺的是跨会话健康管理，而非完全没有亲和。 |
| C04 | PERF-02，360、800、801 行 | Hash 路由内切换不会重新下载整套模块。静态资源协商应限定为页面重新加载/实际资源请求；32 个 SHELL 条目也不等于每次页面加载都请求这 32 项。浏览器正常条件协商收到 304 后会合并缓存，Fetch 通常得到带完整正文的缓存响应，不是靠 `response.ok === false` 才恢复正文。 |
| C05 | PERF-02，1069 行 | 哈希改名必须同时解决静态 import、动态 import、CSS URL、HTML、清单、SW、旧标签页和回滚。只重写 HTML 与 SHELL 会使内部引用失效。没有完整升级协议前，不改未版本化资源为永久 cache-first。 |
| C06 | PERF-03，810、1076 行 | `advanced` 有启动依赖：本地应用锁、隐私监听及延迟自动任务。不能直接整模块改成仅路由加载。若拆分，先提取轻量启动运行时，保留锁屏先于网络及业务任务的顺序。 |
| C07 | PERF-04，824 行 | 当前启动是首次 `/api/me` 探测后，首页请求与头像 `/api/me` 并行，不是 me、me、home 三次串行。外壳也已经先挂载。去重能减少一个请求，但不能把收益写成必然减少两个首屏串行 RTT。 |
| C08 | PERF-01，792、1063、1065 行 | 压缩减少传输字节，不直接证明 SW Cache Storage 同比例变小。HEAD 应与同条件 GET 选择同一表示，不能任意返回另一种编码的长度。压缩协商还须覆盖 `q=0`、identity、Vary、ETag 和 304。 |
| C09 | REL-05，682 行 | `shuttingDown` 在退出入口被读取，用于避免重复退出，不是完全无读取的死变量。Node 19 起 `server.close()` 已关闭空闲连接。应排查在途任务、退出前最终落盘及强制退出策略，不为错误理由补重复调用。 |
| C10 | SEC-02，452、453 行 | 计算 `sha256(secret:password)` 需要 secret 与 password 两者，不能说任一泄露就能计算。现有服务端没有令牌过期校验；Cookie 的一年 Max-Age 只约束浏览器保存，不保证被复制令牌一年后不能重放。时间片轮换也不等于单令牌吊销。 |
| C11 | FE-03、FE-07，736、760 行 | IDB 全量返回 Blob 对象不等于全部字节立即复制进 JS 堆。ZIP 的 CRC 读取是逐项进行，并未把每张图的 ArrayBuffer 全部保留。可以优化全量查询、增加导出大小提示，但不能把总 Blob 大小直接认定为内存峰值，或宣称必然 OOM。 |
| C12 | FE-05，749 行及 SW 相关统计 | 当前 `8eaf132` 已新增 API 层失效、认证世代保护、跨标签通知及收藏页 401 清理提示。不能仍写“401 仅抛错，只有视图派发登录事件”。门禁再次弹出、顶栏旧头像等剩余问题要独立复现。SW 当前为 v15、SHELL 33 项。 |
| C13 | DEL-01，860 行及摘要 | CI 缺少 `npm ci` 是真实问题，但 `publish` 依赖测试成功；测试失败是阻止发布，不是证明不安全镜像已经越过门禁。补安装步骤后仍须修既有测试失败，不能直接宣布 CI 恢复。 |
| C14 | REL-07，697 行 | 串行锁覆盖 OCR 调用，不等于整个翻译处理都没有并行收益。不要为增加吞吐直接移除线程安全锁；先测量 OCR、渲染、编码各段耗时并确认 OCR 实例的并发契约。 |
| C15 | SEC-10 与排除清单第 960 行 | sid 格式校验不能证明“无会话固定”。是否存在 fixation 取决于攻击者能否注入有效既存 sid、登录时是否轮换等条件。保留有条件风险描述，删除与 SEC-10 相反的绝对排除结论。 |

性能报告的 gzip 数字来自拼接压缩，不代表独立 HTTP 文件的总传输体积。复核基线 JS/CSS 共 675825 B；本机 Node zlib level 6 逐文件压缩合计 197409 B，约减少 70.8%。不同压缩实现可能略有差异，实施后应以逐资源实际传输字节和耗时验收。

“稳定复现”“唯一能打挂容器”“公网一定共享桶”等措辞只在有对应运行证据时使用。结构性风险、配置条件和已观测现象应明确区分。

## 3 已有修复与测试基线

### 必须保留的返回导航修复

`8eaf132` 已实现收藏完整分页快照、筛选状态和滚动恢复，以及详情返回缓存。后续认证、启动、模块拆分和 SW 修改不得回退以下行为：

- 收藏多页同步恢复；不把新第一页与旧后续页混合。
- 后台顺序重验证全部已加载页，整批成功后才替换快照；活动 DOM 不自动重排。
- 更新通过提示让用户应用；下拉刷新走原有单一手势监听并重取收藏夹元数据。
- 登录、退出、数据源、Host、401、收藏操作集中失效；旧世代响应不能回填。
- 单个消费者取消不误伤共享请求；所有消费者取消后不回填。
- 跨标签只传播失效元数据，不持久化账号或业务缓存。

相关入口为 [navigation-cache.js](D:/project/AI/jm-web/public/js/navigation-cache.js)、[api.js](D:/project/AI/jm-web/public/js/api.js)、[user.js](D:/project/AI/jm-web/public/js/user.js)、[views.js](D:/project/AI/jm-web/public/js/views.js)、[ui.js](D:/project/AI/jm-web/public/js/ui.js) 和 [app.js](D:/project/AI/jm-web/public/js/app.js)。

### 当前已知测试结果

- 复核时 [navigation-cache.test.js](D:/project/AI/jm-web/test/navigation-cache.test.js) 与 [favorites-navigation.test.js](D:/project/AI/jm-web/test/favorites-navigation.test.js) 通过；此前 [service-worker.test.js](D:/project/AI/jm-web/test/service-worker.test.js) 和 `npm run check` 也通过。
- [reader-performance.test.js](D:/project/AI/jm-web/test/reader-performance.test.js:119) 仍失败：断言禁止区间内出现任何 `state.dims.`，而当前实现合法读取 `state.dims.get(idx)` 来保留尺寸。应补行为验证，区分读取与错误清除，不能删断言或改业务代码去迎合字符串匹配。
- 当前本机没有安装 `sharp`，相关测试缺依赖。记录为环境阻碍，不称为代码通过，也不要擅自触发原生依赖编译。
- Windows 下 [deployment.test.js](D:/project/AI/jm-web/test/deployment.test.js:93) 的 POSIX 可执行位检查失败，后续直接执行 `.sh` 也需 Bash 支持。应明确平台契约或提供适配，不能靠跳过所有制品安全测试变绿。
- 阅读器和该性能测试相对原报告基线没有改动，上述阅读器断言失败不是返回导航修复新引入的。

这些是起点，不是实施后的验收结果。每批结束都重新记录实际通过、失败与未运行项。

## 4 第 0 批 校正报告与建立基线

1. 记录 HEAD、工作区状态、Node 版本及可用测试环境。若有并行编辑，只处理本任务明确归属的内容。
2. 按第 2 节校正综合报告，保留三份原始来源不动。旧说法如需留作历史引用，明确标为已作废，不再出现在当前建议清单中。
3. 把问题分为“已确认且待修”“已部分修复”“需运行验证”“设计权衡”，不要把全部低优先级观察当作缺陷立即修改。
4. 更新过时的项目债项：阅读器已先渲染再补详情；图片 Host 已有指数退避、EWMA 打分和半开探测。只修对应描述，不重写运维文档。
5. 给后续每批列出最小复现和将新增的测试，先证明问题再改代码。

验收：报告的摘要、索引和路线图不再包含 C01 至 C15 的错误执行依据；基线结果可以按原命令重现。

## 5 第 1 批 CI 测试与制品校验

涉及 [docker-publish.yml](D:/project/AI/jm-web/.github/workflows/docker-publish.yml)、[package.json](D:/project/AI/jm-web/package.json)、[Dockerfile](D:/project/AI/jm-web/Dockerfile)、[validate-release-artifact.sh](D:/project/AI/jm-web/scripts/validate-release-artifact.sh)、[deployment.test.js](D:/project/AI/jm-web/test/deployment.test.js)、[reader-performance.test.js](D:/project/AI/jm-web/test/reader-performance.test.js) 和 [README.md](D:/project/AI/jm-web/README.md)。

整改要求：

1. CI 在测试前使用锁文件安装依赖，保留测试失败阻止发布、PR 不发布的规则；本机是否执行安装受第 1 节约束。
2. 修阅读器性能测试的错误约束。用最小行为测试证明 LRU 重用保留已验证尺寸，并证明原图路径不为测尺寸做完整预解码。测试应能识别真正清除尺寸的回归。
3. 明确发布脚本的平台要求。Windows 测试不能把 POSIX 位缺失直接当作脚本业务错误；Linux CI 仍须验证脚本可执行和真实拒绝行为。
4. 制品必需清单补 `package-lock.json`，并同步制品测试及项目发布清单。当前 Dockerfile 必须复制锁文件，但校验器和测试制品均漏掉它。
5. 加强秘密与额外文件检查，覆盖 `sessions/`、密钥文件、环境备份及不允许的归档。优先使用明确允许的发布目录/文件规则，而不是只堆后缀黑名单；合法运行文件不能误拦。
6. 用隔离目录或可注入路径策略验证生产路径拒绝；不能以“目录不存在”作为已经测到生产路径阻断分支的证据。
7. README 修正零运行依赖和直接启动步骤。不要改变 sharp 引入目的、擅自移除依赖或同时升级全部依赖。

验收：

- 在依赖齐备且平台合适的隔离环境，全量 Node 门禁通过；环境受限时如实标注未完成验证。
- 锁文件缺失、合成 Session、合成密钥、嵌套禁止目录均不能通过制品校验；合法最小制品能通过。
- Compose 基础配置和 GHCR 覆盖组合可解析，测试确实覆盖双方禁用 build 的配置意图。
- 不能以删除失败测试、放宽发布条件或允许生产状态入制品作为修复。

## 6 第 2 批 chapter AI 资源控制

涉及 [chapter-ai.js](D:/project/AI/jm-web/lib/chapter-ai.js)、[server.js](D:/project/AI/jm-web/server.js)、[chapter-ai.test.js](D:/project/AI/jm-web/test/chapter-ai.test.js)、[backend.test.js](D:/project/AI/jm-web/test/backend.test.js)、[.env.example](D:/project/AI/jm-web/.env.example) 和 [docker-compose.yml](D:/project/AI/jm-web/docker-compose.yml)。

已确认：`enqueue` 无队列硬上限；`touchPopularity` 和入队同步全量写盘；详情页逐章节入队造成写放大；`analyze` 把整章 JPEG base64 积累到单次模型请求。内存桩验证未配置 AI Key 时，500 个新章节入队仍触发 501 次同步写盘调用。

整改要求：

1. 同时约束 queue、records、stats 的条数/保留策略及持久化字节；仅限制 queue 不足以阻止其余状态增长。默认值需说明依据并同步配置文档。
2. 手工 enqueue 增加客户端与全局准入；自动发现、详情批量入队和启动恢复必须服从同一容量边界。超限有明确结果，不无限排队。
3. 没有 AI Key 时不因普通浏览持续自动创建新分析任务或无价值热度写盘；既有完成结果仍可读取展示。是否允许显式离线排队要写成明确契约并测试。
4. 用脏标记、合并写入、单写者和原子替换消除请求热路径全量同步落盘。新更新不能被较早的异步写覆盖；写失败保留可重试状态，不能静默丢失。
5. 增加整任务页数、累计输出字节、单图像素/尺寸和总时长预算；预算检查先于重编码、大数组积累和模型发送。计时覆盖响应体读完，模型返回也有字节上限。
6. 首轮保留整章分析语义，超预算明确失败；不要默默截取前几页，也不要未经方案评审改成分批摘要导致标题/描述失真。
7. 覆盖旧 state 加载、重复 key、正在运行任务、重试和退出 flush。批量入队按批更新，不用一次 HTTP 请求循环几百次同步保存。

验收：

- 用小容量配置和合成任务验证边界，无需真实堆积百万条或实际消耗模型费用。
- 同 key 不重复入队；容量满后状态不会增长；既有完成结果不因淘汰策略意外丢失。
- 500 章节模拟请求不再对应 501 次同步全量写盘，且最终状态正确落盘。
- 超页数/字节/像素/时长时明确结束并释放资源，失败重试有界。
- 延迟写、并发更新、写失败、重启和退出测试证明没有旧状态覆盖或任务复活。

## 7 第 3 批 翻译代理与服务资源边界

涉及 [server.js](D:/project/AI/jm-web/server.js)、[service.py](D:/project/AI/jm-web/translation-service-poc/service.py)、[pipeline.py](D:/project/AI/jm-web/translation-service-poc/pipeline.py)、[翻译服务测试目录](D:/project/AI/jm-web/translation-service-poc/tests)、[backend.test.js](D:/project/AI/jm-web/test/backend.test.js) 及配置文档。

整改要求：

1. Node 代理在完整读取上传体前获取有界全局/客户端槽位。等待数量、等待时间和读取时间均有上限，拒绝时正确处理请求体。
2. 整体 deadline 覆盖上传、服务 POST、服务响应体、结果 GET 和结果响应体，并与客户端断开信号组合。所有成功、错误、超时和取消路径释放槽位与监听器。
3. 保持图片 MIME、上传/结果字节上限、结果 origin 与路径白名单及 `private` 缓存语义。服务端 token 不得出现在浏览器响应或日志里。
4. Python 增加上传期限和连接/上传阶段的准入。`max_inflight` 位于上传之后，不能单独保护大量并发上传。任务队列忙、配置未就绪和任务失败要返回不同的明确状态。
5. 认证不能以空 token 默认放行。先制定兼容策略：缺少 token 时禁用翻译能力并明确提示，或在用户选定的严格部署模式下拒绝启动；不生成或提交真实 token，不擅自编辑生产 `.env`。
6. 区分 liveness 与 readiness。OCR 初始化失败应使翻译 readiness 失败；不能简单把 healthz 永远改成 `ok: true` 丢掉故障信号。注意 Compose 的 `service_healthy` 依赖，不能因默认 token 为空而无说明地阻断整个网站启动。
7. 不直接移除 OCR 串行锁。字体缓存属于独立的小优化，先证明热点及有界缓存策略再改。

验收：

- 隔离假服务覆盖慢上传、超过上限、排队满、永不返回响应头、永不结束响应体、客户端断开以及非法结果 URL/MIME。
- 任一路径结束后槽位回到初始值；取消的等待者不会后来意外获得槽位。
- 正常 token 正确转发；缺失/错误 token 被拒绝；真实 token 不回传给浏览器。
- 缺配置时能力探测与实际路由一致；readiness 对 warmup 失败有真实检测，不伪装为健康。
- 不需要真实 OCR 镜像构建或外部 API 就能覆盖 Node 代理边界；Python 测试按已有可用运行环境执行。

## 8 第 4 批 CSRF 与认证失效交互

涉及 [server.js](D:/project/AI/jm-web/server.js)、[api.js](D:/project/AI/jm-web/public/js/api.js)、[app.js](D:/project/AI/jm-web/public/js/app.js)、[gate.js](D:/project/AI/jm-web/public/js/gate.js) 和对应测试。

整改要求：

1. 为状态改变 API 建立集中同源校验，优先覆盖 favorite、like、logout，并盘点其他非安全方法。拒绝跨源、same-site 但不同 origin、`Origin: null`、矛盾来源元数据；脚本无来源头的兼容策略须明确且不改变认证要求。
2. 不能机械调用现有 `requestHasSafeBrowserContext` 后忽略 HTTPS 反代条件。先用假请求矩阵验证可信代理、协议、Host 与 Origin 的组合；不靠广泛信任私网来让测试通过。
3. 明确区分 `needAuth: true` 的站点访问门禁和 JM 登录失效。前者触发单实例重新验证；后者清旧账号 UI 并引导 JM 登录，不弹错门禁。
4. 多个并发 401 不重复创建 gate。登录/退出期间旧响应不能清掉新账户；认证恢复后只恢复当前活跃路由，不能重复添加应用监听器或形成 me 请求循环。
5. 原有认证失效、收藏快照、共享请求和跨标签测试必须继续通过。

验收：

- 当前页面跨源表单/请求被拒绝；同源请求和明确支持的脚本请求正常。
- 假代理链测试证实不可信转发头无法伪造客户端 IP 或 Secure 状态；本轮不修改生产 TRUST_PROXY。
- 访问口令失效、JM 失效、两者并发、旧账户迟到 401 及重新验证成功都有行为测试。
- 冷启动本地锁仍先于 API；手机端 gate 不自动聚焦可编辑字段；退出路由后无 DOM 更新和监听器积累。

本批不顺带更换门禁令牌格式、增加管理员角色或强制所有部署修改口令。SEC-02、SEC-05 的服务端过期、吊销及权限分离需要单独设计兼容、迁移和回滚，再交用户确认。

## 9 后续批次 先出方案再选择实施

### 下载与离线

FE-01/02 的超时和任务错误/持久化放大值得优先做小范围方案。计时应覆盖响应体，保留任务取消；错误总数与有限的展示样本分开，合并保存不能破坏暂停/删除的跨标签一致性。

FE-03 先测量 Blob 查询与实际 ArrayBuffer/解码峰值。设计元数据查询或 cursor 校验时，保留缺页、重复序号、空 Blob 和完整性检查，不能仅用 count 宣称完整。无 Web Locks 的等待频率可以优化，但不能抢占另一个活跃 owner 或使任务永远无法恢复。

涉及 [downloads.js](D:/project/AI/jm-web/public/js/downloads.js)、[offline.js](D:/project/AI/jm-web/public/js/offline.js)、[reader.js](D:/project/AI/jm-web/public/js/reader.js) 和 [export.js](D:/project/AI/jm-web/public/js/export.js)。IDB schema 变更须有旧数据升级、阻塞和取消测试。

### 启动与静态资源性能

- 启动去重先做请求顺序测量，再复用门禁探测结果；结果应进入一致的身份处理路径，不能跳过认证世代保护，也不能提前运行签到等任务。
- 静态压缩可以独立设计，先测直连与用户实际访问路径，避免重复边缘压缩。覆盖协商、HEAD、304、Vary、ETag 和错误响应。
- 动态模块拆分先梳理完整依赖图，分离锁运行时，并验证启动、深链接、离线和更新窗口。
- 内容哈希和 SW 缓存分层属于发布协议变更，不是简单改文件名。须说明全部引用重写、依赖哈希传播、未变化资源复用、旧标签页资源保留及版本回滚。
- 连接池/跨会话线路健康管理先收集复用率及分段耗时；保留每次 URL/DNS 安全检查、受信 Cookie Origin 和 POST 不确定送达时不得重放的规则。配置变化后旧连接的处置也须有测试。
- 可观测性使用有界聚合和脱敏日志，不记录用户查询、Cookie、token、图片正文或完整响应。不为遥测顺手新增匿名上报入口。

本地预压缩、哈希生成或打包如果属于构建/制品生成，仍受用户禁止构建的约束。不能借“轻量脚本”绕过许可。

### 退出与供应链

优雅退出应停止接收新工作、收口在途任务、最终 flush，再按期限退出；强制结束不能伪装成成功。诊断异常不等于吞掉异常。

Action SHA、镜像 digest、Python 锁文件等方案必须使用实际核验值，不编造 SHA/digest。固定版本还需可维护的更新机制，不直接批量升级或把真实凭据写入模板。

## 10 测试与交付要求

以下为 Windows PowerShell 命令，执行每项后检查 `$LASTEXITCODE`，不要用最后一个命令成功掩盖前面的失败：

```powershell
Set-Location -LiteralPath 'D:\project\AI\jm-web'
git status --short
git rev-parse HEAD
node --version

node 'D:\project\AI\jm-web\test\navigation-cache.test.js'
node 'D:\project\AI\jm-web\test\favorites-navigation.test.js'
node 'D:\project\AI\jm-web\test\navigation.test.js'
node 'D:\project\AI\jm-web\test\service-worker.test.js'
node 'D:\project\AI\jm-web\test\reader-performance.test.js'
npm run check
git diff --check
```

依赖已具备且未触发禁止构建的前提下，再运行 `npm test`、Python 回归及 Compose 配置检查。缺依赖、无 Docker/Bash 或无目标浏览器时，报告限制，不伪造通过。

浏览器最低验证：手机竖屏 390×844、横屏 667×300；收藏三页以上进入详情/阅读器再返回，分页、筛选、滚动位置均保持；冷缓存、后台更新、手动刷新、401、跨标签退出和旧 SW 升级。不要把模拟 viewport 写成真实 iPhone/Safari 验收。

每批交付应回答四件事：

1. 修复了哪些报告编号，哪些结论被作废或仍待验证。
2. 修改文件与行为差异，以及能重放的合成输入/状态。
3. 测试命令、实际结果与未完成项；新增测试是否能捕获原故障。
4. 回滚方法、兼容影响和下一批的依赖。

独立批次不等于允许自动提交。用户要求提交时，只暂存本批归属文件；不推送，不执行生产操作。

## 11 规范依据

- [Node Agent 选项](https://nodejs.org/api/http.html#new-agentoptions)：`keepAliveMsecs` 是 TCP 保活探测初始延迟。
- [Node HTTPS globalAgent](https://nodejs.org/api/https.html#httpsglobalagent)：Node 19 起默认启用 keep-alive 和 5 秒 timeout。
- [Node server.close](https://nodejs.org/api/http.html#serverclosecallback)：Node 19 起关闭空闲连接。
- [Node 致命异常处理](https://nodejs.org/docs/latest-v22.x/api/process.html#warning-using-uncaughtexception-correctly)：未知致命异常后不应恢复正常运行。
- [Fetch 内容解码](https://fetch.spec.whatwg.org/#concept-handle-content-encodings) 与 [HTTP 网络或缓存获取](https://fetch.spec.whatwg.org/#http-network-or-cache-fetch)：区分传输编码、可读取响应体和正常 304 协商。

## 12 可直接交给 ZCode 的任务

> 先阅读 `D:\project\AI\jm-web\AGENT.md`、`D:\project\AI\jm-web\AGENTS.md` 和 `D:\project\AI\jm-web\docs\zcode-remediation-plan-2026-10-09.md`。以当前代码重新确认基线，不机械执行旧综合报告。按本文第 0 至第 4 批逐批推进，先复现、后修复、补行为测试并汇报各批结果。保留 `8eaf132` 的收藏/详情返回缓存与认证世代保护。后续下载、性能、令牌和权限改造先出方案，等待用户选择。禁止编译/构建，不自动安装会执行生命周期脚本的依赖，不提交、不推送、不发布、不改生产配置或数据，不混入其他 session 的无关改动。遇到缺依赖、平台限制或设计选择，只报告明确阻碍，不用删除断言、放宽安全边界或吞异常来制造通过。
