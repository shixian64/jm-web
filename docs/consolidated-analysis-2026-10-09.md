# jm-web 2026-10-09 综合分析报告（三合一去重合并版）

| 项 | 值 |
| --- | --- |
| 合并日期 | 2026-10-09 |
| 合并来源 | ① `docs/issue-analysis-2026-10-09.md`（多角度问题分析，编号 S/B/F/D）② `SECURITY-AUDIT.md`（安全审计，编号 P2-x/P3-x）③ `docs/loading-performance-analysis.md`（加载性能分析，编号 A1-A8） |
| 代码基线 | 三份来源一致：`main` @ `1dd0697a5d8021a7e3130f13fa85625e9de8968b`（fix: reserve reader image dimensions，2026-09-08） |
| 合并原则 | **不删除任何信息**：三份报告的全部发现、证据、行号、场景、建议均已保留；同一问题被多份报告重复发现时合并为一条，条目标注全部来源编号；重复对照见第 2 节，矛盾标记见第 3 节 |
| 原始文档 | 三份原文文件保留未动；本文是去重后的唯一阅读入口 |

> **阅读须知**（合并自三份原文）
> - 本文标注的行号基于基线 commit `1dd0697`，后续提交会使行号漂移，**修复前必须重新定位**。
> - 按 AGENT.md 第 1 节原则："运行态证据与本文冲突时，以运行态为准"。所有发现均属静态推断，未做生产复现。
> - 来源标注约定：**【S/B/F/D】**= 多角度问题分析；**【P2/P3】**= 安全审计；**【A】**= 加载性能分析；**【已知债】**= AGENT.md 第 11 节已自我记录的债务；**【新发现】**= 文档未记录的问题。
> - 本文是分析与建议记录，不是整改方案评审结论。任何整改须遵循 AGENT.md 第 9 节变更流程：一次只改一个变量，补回归测试，同步更新 SW `SHELL`、`.env.example`、`docker-compose.yml`、README 与相关测试。

---

> **复核勘误（2026-10-09，基线 `8eaf132`）**：本文已按 [`zcode-remediation-plan-2026-10-09.md`](D:/project/AI/jm-web/docs/zcode-remediation-plan-2026-10-09.md) 第 2 节（C01–C15）以当前代码复核并就地校正，错误结论以 **【勘误 Cxx】** 标注；三份来源原文保留未动。另有两处基线漂移：SW 已为 `jmw-shell-v15`、SHELL 33 项（原报告记 v14/32 项）；`8eaf132` 已新增 API 层失效、认证世代保护与跨标签失效通知（影响 FE-05 的旧表述）。未经运行证据支撑的"稳定复现""唯一能打挂容器"等措辞均已降级为结构性推断。**摘要、索引、正文与路线图中的旧错误说法已改写，不得再作为执行依据。**

---

## 1. 结论摘要（三份原文，各自独立）

### 1.1 多角度问题分析的结论【S/B/F/D】

jm-web 的工程水准明显高于同类自部署项目：SSRF/DNS pin、上游 Cookie Origin 隔离、XSS 面、前端路由生命周期纪律、测试真实性（真行为测试而非空壳）都做得很扎实，AGENT.md 第 5/6 节的核心不变量经逐项核对**均被切实遵守且有测试锁定**。

真实问题集中在三个区域：

1. **chapter-ai 功能（较新引入）把 512MiB 生产容器置于 OOM 与同步 I/O 阻塞风险中**，且 enqueue 无限流，AI 费用可被耗尽；
2. **CI 缺依赖安装步骤**——workflow 无 `npm ci`，`npm test` 在干净 runner 上必然失败【勘误 C13：publish 依赖测试成功，测试失败是阻止发布，不等于不安全镜像已越过门禁发布；真实问题是门禁无法转绿、发布长期被阻断。补安装步骤后仍须修既有测试失败，不能直接宣布 CI 恢复】；
3. **若干已知安全债仍在等待修复**（统一 CSRF 缺失、口令即运维员），另有两个未文档化的遗漏（翻译路由无并发闸、反代默认配置下限流坍缩）。

建议处理顺序见第 9.1 节，最优先三项：修 CI、给 chapter-ai 上闸、补具体遗漏的 Promise/回调错误处理 + 翻译路由闸【勘误 C01：不能用仅打印日志的 unhandledRejection/uncaughtException 监听器吞掉未知异常让进程继续服务；诊断可用不改变退出语义的 monitor，致命错误保留非零退出与外部重启】。

### 1.2 安全审计的结论【P2/P3】

代码库整体安全工程质量**显著高于同类自部署项目**。`AGENT.md` 第 5 节声明的后端安全不变量（SSRF 双重校验 + 地址固定、恒定时间口令比较、上游 Cookie 不出站、5xx 默认不回显、静态文件路径遍历防护等）经逐一核查**确实在代码中落实**，不是纸面声明。前端 XSS 攻击面接近于零（全项目仅 3 处 `innerHTML` 且全部安全），容器加固（cap_drop ALL、read_only、非 root、资源限额、翻译端口不发布）到位。

真正的问题集中在三处：

1. **两个无上限的资源耗尽面**（AI 队列、翻译服务认证缺省）；
2. **反代/桥接部署形态下 per-IP 限流可能退化为共享桶**（是否发生取决于实际对端与代理链配置：端口发布、宿主反代、Tailscale 直连形态各不相同；默认 `JMW_TRUST_PROXY` 为空时按连接对端 IP 计数。未经运行态确认不能断言生产必然如此）【勘误 C02】，若确实共享桶则门禁限流可被用于锁死全站登录；
3. **供应链与默认配置层**（可变 `latest` 镜像标签、CI Action 未固定 SHA、服务间 token 默认为空、弱口令仅告警）。

未发现 P0/P1 级可直接远程利用的漏洞；两个 P2 资源类问题在默认 compose 配置（`ACCESS_PASSWORD` 为空）下按静态推断可被匿名触发（"稳定复现"未经运行态验证，属结构性推断）。发现统计：P0/P1：0 项；P2：4 项；P3：25 项。

### 1.3 加载性能分析的结论【A】

图片链路（封面缓存、single-flight、负缓存、有界并发、懒加载）和阅读器首图路径已有大量优化且现状良好。当前加载速度的主要瓶颈集中在**静态资源传输层**与**首屏模块图**：

| 编号 | 问题 | 影响量级（估算） | 优先级 |
| --- | --- | --- | --- |
| A1 | 静态资源零压缩裸传 | 675,825 B；逐文件 gzip 后约 197,409 B，可省约 **70.8%** 传输量（原 179,535 B/73% 为拼接压缩值，不代表独立文件总和）【勘误 C08】 | P0 |
| A2 | 无内容哈希 + immutable 缓存；SW 发版全量重下外壳 | 页面重新加载时全站条件协商；每次发版约 676 KB 全量重传（Hash 路由内切换不重新请求模块）【勘误 C04】 | P0 |
| A3 | 首屏 JS 全量加载（无路由级分割），HTML 无 `modulepreload` | 首屏解析执行约 552 KB JS（实际首屏仅需一小部分；advanced 有启动期依赖，不能整模块延后）【勘误 C06】 | P1 |
| A4 | 启动门禁探测串行 + 重复请求 `/api/me`（外壳已先挂载；探测后首页请求与头像并行） | 1 个串行 RTT + 1 个重复请求；慢网下路由内容最多延迟 8 s（非白屏）【勘误 C07】 | P1 |
| A5 | 上游 API 缺跨会话线路健康管理（会话内已有 `jar.apiHost` 亲和）；连接复用率未实测 | 首线路劣化时新会话/匿名请求重复等待；是否重付 DNS+TCP+TLS 需以 `reused_socket` 实测【勘误 C03】 | P1 |
| A6 | 首页数据到达后一次性全量渲染 | 低端机长任务，拖慢可交互时间 | P2 |
| A7 | CSS 渲染阻塞且未按视图拆分 | 103 KB 裸传（gzip 后约 23 KB） | P2 |
| A8 | 加载链路分段可观测性缺失 | 无法量化各段耗时，优化缺基线 | P3 |

---

## 2. 重复问题对照表（本次去重清单）

三份报告独立完成，同一问题被多次发现。下表列出**全部重复项**及合并后的统一编号（统一编号定义见第 7 节）。"互补差异"列说明合并时保留了各来源的哪些独有内容。

### 2.1 问题级重复（同一问题多处立项）

| # | 重复主题 | 多角度分析 | 安全审计 | 加载性能 | 合并编号 | 互补差异（均已保留） |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | chapter-ai enqueue 无限流、队列/落盘无上限、同步写盘、OOM | S2（安全）+ B1（OOM）+ B2（热路径写盘） | P2-1 | — | REL-01 | 分析侧重 AI 费用耗尽与写放大；审计补充匿名可达（默认空口令）与磁盘填满场景；B1 补充 descramble 内存细节 |
| 2 | 反代/默认部署下 per-IP 限流坍缩为共享桶；Cookie 无 Secure | S4 | P2-2（+P3-6 桶表满） | — | SEC-03 | 分析指出无口令模式行为不对称；审计补充网桥网关 IP、锁死全站登录场景与修复建议 |
| 3 | `jmw_auth` 静态令牌：无过期、无单项吊销、1 年 Max-Age | S3 | P3-2 | — | SEC-02 | 分析补充 `JMW_SESSION_TTL_SECONDS` 只影响 `jmw_sid`；审计补充"secret 或口令任一泄露即可离线计算"与时间片轮转建议【勘误 C10：该"任一泄露"说法与时间片即吊销的暗示均已在 SEC-02 正文校正——计算令牌需二者同时；服务端无过期校验，Max-Age 只约束浏览器保存】 |
| 4 | 弱口令仅告警不阻断 | S5（场景 a） | P3-3 | — | SEC-04 | 合并为一处，保留双方证据 |
| 5 | 空口令默认部署无强制拦截；无口令时会话写放大 DoS | S5（场景 b） | P3-23 | — | SEC-04 | 分析提供写放大链路细节；审计提供 `JMW_PUBLISH_HOST=127.0.0.1` 缓解与启动拦截建议 |
| 6 | 访问口令同时授予运维权限（DoH/日志） | S2 内引用（已知债） | P3-1 | — | SEC-05 | 审计展开为独立条目（元数据泄露、擦日志场景） |
| 7 | 翻译服务默认空 token 即放行 | D6 第 1 点 | P2-3 | — | SEC-07 | 审计补充 25MB 图片 OCR 资源耗尽场景与 fail-closed 建议 |
| 8 | 翻译 Python 依赖无锁、基础镜像未钉版本 | D6 第 2、3 点 | P3-18 | — | DEL-06 | 分析补充与 npm 侧 lockfile 纪律对比、`deployment.test.js:26` 断言缺口；审计补充 `pip compile --require-hashes` 建议 |
| 9 | `AI_BASE_URL` 默认第三方中转域名（隐私/单点） | D6 第 4 点 | P3-4 | — | SEC-06 | 合并为一处，保留双方证据 |
| 10 | NAT64/6to4 前缀不在私网拒绝清单 | S6 行 2 | P3-9 | — | SEC-08 | 分析额外覆盖 6to4（2002::/16）与十六进制/八进制 IPv4 说明 |
| 11 | HSTS / X-Frame-Options / CSP 覆盖不足 | S6 行 3 | P3-8 + P3-11 | — | SEC-09 | 分析指出 frame-ancestors 等效 XFO 可接受；审计补充 XFO 后备、`style-src 'unsafe-inline'`、index.html 加 CSP meta 双保险建议 |
| 12 | `/api/translation/page` 无超时、无并发闸 | B4 | P3-7（端点之一）+ P3-22（Python 侧相邻） | — | REL-03 | 分析给出 undici 300s、20 并发 OOM 量化；审计把该端点归入"上游转发无每 IP 限流"族（SEC-16）并单列 Python 服务连接限流（REL-10） |
| 13 | 上游 API Host 无跨请求熔断/线路亲和 | B5 | — | A5 | REL-04 + PERF-05 | 分析发现 429 语义两套不一致与"图片熔断已实现"文档滞后；性能分析补充连接复用（globalAgent 1s）维度与连接池方案 |
| 14 | 首屏 JS 全量静态导入、模块图偏大 | B10 行 7（量化 551 KB） | — | A3（详析） | PERF-03 | 性能分析补充 modulepreload 缺失、gate.js 动态 import 先例、分批方案 |
| 15 | 首页一次性全量渲染卡片 | §8 对照（现状可控判断） | — | A6（立项） | PERF-06 | 性能分析定位瓶颈在 DOM 构造而非图片 |
| 16 | Dockerfile `--ignore-scripts=false` 供应链面 | D7 行 8 | P3-20 | — | DEL-11 | 审计展开 root 运行时序与缓解建议 |
| 17 | 翻译服务 healthz 两切面 | B8（健康检查不覆盖 OCR 失败） | P3-21（healthz 无认证泄露状态） | — | REL-07 + SEC-21 | 同一端点两个不同缺陷，分别保留 |
| 18 | `/api/search` 缓存 256 条上限可被随机 query 绕过 | B10 行 2 | P3-7（列举内） | — | SEC-16 | 归入"上游转发端点无每 IP 限流"族，保留双方描述 |
| 19 | auth 限流（10 次/5 分钟）可被攻击者利用 | S5 场景 a（IP 轮换线性爆破） | P2-2 场景 1（共享桶锁死全站） | — | SEC-03 / SEC-04 | 两种不同利用方式，分别保留在各自条目 |
| 20 | `h()` 保留 `html:` → innerHTML 选项（零调用） | F7 行 2（作为问题立项） | 排除清单 #19（作为安全确认 + 建议删除） | — | FE-07 | 立场不同（问题 vs 确认），合并条目双标注 |
| 21 | 阅读器首图已不等详情元数据（AGENT.md §11 该条债已过时） | §8 对照表 | — | §5 良好现状 + §7 对照表 | 第 10 节对照 | 两份报告一致确认，建议修订 AGENT.md |
| 22 | 图片 Host 熔断已实现（AGENT.md §11"仍需补充"已过时） | B5 新细节 2 | — | §7 对照表（转述债项，未深查） | 第 10 节对照 + 矛盾 #2 | 两份对现状描述不一致，见第 3 节矛盾标记 |

### 2.2 "已验证无问题"排除清单的大面积重复

三份报告的排除/良好现状清单（分析 §3.2/§4.2/§5.2、审计 §6、性能 §5）存在大量对同一安全不变量的重复确认，已在第 8 节合并为单一清单并为每条标注确认来源。主要重复组：

- SSRF 主链路 / DNS pin / 重定向逐跳校验（分析 3.2 #1-2 ≙ 审计 #6-10）
- 上游 Cookie Origin 隔离与凭据脱敏（分析 3.2 #3 ≙ 审计 #5）
- 会话文件安全与 sid 熵（分析 3.2 #4 ≙ 审计 #3-4）
- 恒定时间口令比较（分析 3.2 #9 ≙ 审计 #1）
- 5xx 不回显 / 日志不泄密（分析 3.2 #6-7 ≙ 审计 #18）
- CORS 零放宽（分析 3.2 #8 ≙ 审计 #15，后者含错误声明，见矛盾 #1）
- 请求体处理与静态遍历防护（分析 3.2 #12 ≙ 审计 #11-12）
- 图片代理资源控制与限流基线（分析 3.2 #11 ≙ 审计 #17）
- XSS 面干净（分析 5.2 #1 ≙ 审计 #19，计数口径差异见矛盾 #3）
- 容器加固与发布脚本（审计 #23-25；分析 D 角度方法论中亦有覆盖）

---

## 3. 矛盾与口径差异标记（合并时已裁决/标注）

三份报告独立完成，存在以下结论冲突或口径差异。合并版处理方式如下（**均不删除任何一方的原始表述**，冲突条目在第 8 节相应位置再次标注）：

1. **CSRF 判断相反（实质性矛盾，已裁决）**
   - 多角度分析 S1：存在缺口——`/api/favorite`、`/api/like`、`/api/logout` 是参数取自 query 的 POST，无 JSON Content-Type 防线，HTML 表单即可跨站提交（有命令行抽验记录）。
   - 安全审计排除清单 #15："非幂等接口全部要求 application/json body（跨站表单无法伪造该 Content-Type）"——将 CSRF 列为已排除。
   - **裁决**：合并时重新核对源码，`server.js:2014`（/logout）、`server.js:2161-2164`（/like，`q.get('id')`）、`server.js:2166-2169`（/favorite，`q.get('aid')`）确认这三端点参数取自 query 且不调用 `readJsonBody`。**S1 正确**；审计排除 #15 中"非幂等接口全部要求 JSON body"的声明对这三个端点不成立（对其余带 JSON body 的 POST 端点仍成立）。审计排除清单其余部分（CORS 零头、SameSite=Lax 现状）与 S1 一致，不冲突。
2. **图片 Host 熔断是否已实现（现状描述不一致，已复核）**
   - 多角度分析 B5 新细节 2：`server.js:1294-1442` **已实现**跨请求指数退避熔断 + EWMA 健康打分 + 半开探测，AGENT.md §11"仍需补充跨请求熔断"描述滞后。
   - 加载性能分析 §7 对照表：转述 AGENT.md 债项"图片线路切换需跨请求熔断和指标——与 A5/A8 合并处理"，暗示仍缺失（其 §2.3 已声明"未深查"）。
   - **复核**：合并时核对 `server.js:1360-1440`，存在 `failures` 指数退避（`IMAGE_HOST_FAILURE_BASE_MS * 2**(failures-1)`）、EWMA 式打分（`previous.failures * 0.7 + … * 0.3`）、`probeInFlight`/`openUntil` 半开探测。**B5 的"已实现"判断正确**；AGENT.md §11 该条与性能分析 §7 的转述均滞后。
3. **XSS sink 计数口径差异（非矛盾）**
   - 多角度分析 5.2 #1："全仓 innerHTML/document.write 共 4 处"（icons.js:58、ui.js:28、ui.js:48、export.js:246）。
   - 安全审计排除 #19："innerHTML 全项目仅 3 处且全部安全"，另将 export.js:243 的 `document.write` 单列为发现 P3-15。
   - **口径**：4 = 3 处 `innerHTML` + 1 处 `document.write`（api.js:201 为注释）。两份实质一致，仅分类口径不同；export.js 的 `document.write` 一份计入"已确认安全"总账、另一份作为低风险发现单列，两种表述均保留。
4. **行号引用存在小幅出入（非矛盾，双保留）**
   - 同一代码两份报告引用行号略有偏差，如 `clientIp`：分析作 `server.js:524-541`、审计作 `server.js:525-540`；chapter-ai `save()`：分析作 151 行、审计作 157 行。合并条目中两组行号并排保留，修复前以重新定位为准。

---

## 4. 三份报告的元信息（原文头表合并）

### 4.1 多角度问题分析【S/B/F/D】

| 项 | 值 |
| --- | --- |
| 分析日期 | 2026-10-09 |
| 分析方式 | 静态代码审查（未运行动态测试），四角度并行深入排查 + 高影响结论独立抽验 |
| 分析范围 | `server.js`、`lib/`（7 模块）、`public/`（24 个 JS + 3 个 CSS + sw.js + index.html）、`test/`、`translation-service-poc/`、`Dockerfile`、`docker-compose*.yml`、`.github/workflows/`、`scripts/`、`.env.example`、`README.md`、`AGENT.md` |
| 参照基线 | AGENT.md 第 5 节（后端安全不变量）、第 6 节（前端不变量）、第 11 节（已知技术债） |

### 4.2 安全审计【P2/P3】

| 项目 | 内容 |
| --- | --- |
| 审计性质 | 只读防御性安全审查，未修改任何代码或配置 |
| 审计范围 | `server.js`、`lib/`（7 模块）、`public/`（31 个文件）、`translation-service-poc/`、`Dockerfile`、Compose 三个文件、`.env.example`、`.github/workflows/`、`scripts/`、`.gitignore`/`.dockerignore` |
| 发现统计 | P0/P1：0 项；P2：4 项；P3：25 项；另附已核查未发现问题的排除清单 |

### 4.3 加载性能分析【A】

| 项 | 值 |
| --- | --- |
| 分析方式 | 本地开发工作区源码级静态分析（未连接生产实例、未抓包） |
| 范围 | 首屏加载路径、静态资源传输与缓存、Service Worker 策略、服务端静态服务、上游 API/图片链路、首页与阅读器关键渲染路径 |
| 约束依据 | AGENT.md（前端不变量、安全不变量、已知技术债、发布流程） |

---

## 5. 分析方法与过程（三份原文合并）

### 5.1 多角度分析的方法【S/B/F/D】

**步骤总览**：

```text
步骤 1  读取 AGENT.md/AGENTS.md，建立项目约定基线
        （安全不变量、前端不变量、已知技术债清单、发布流程）
        ↓
步骤 2  收集项目元数据：模块行数统计、git 历史、依赖清单
        ↓
步骤 3  四路并行深入排查（每路为独立的只读代码审查）：
        A. 安全角度          → server.js + lib/（鉴权、CSRF、SSRF、会话、泄露、限流）
        B. 后端可靠性/性能    → server.js + lib/ + 翻译服务（错误处理、资源、并发、启停、可维护性）
        C. 前端质量          → public/（XSS、生命周期泄漏、图片管线、SW、存储、移动端、可访问性）
        D. 测试/CI/部署/供应链 → test/、workflows、Docker/compose、脚本、文档一致性
        ↓
步骤 4  对 5 个最高影响结论做独立命令行抽验（防止排查结论失实）
        ↓
步骤 5  交叉比对去重：两个角度独立发现的同一问题（翻译路由无准入）置信度提升；
        将四路各自的 H/M/L 编号统一为本文 S/B/F/D 编号体系
```

**各角度检查清单（步骤 3 展开）**：

- **A. 安全角度**：门禁令牌签发/校验（恒定时间比较、过期、吊销）、ACCESS_PASSWORD 弱口令与爆破限流、非幂等 POST 的 CSRF 防护覆盖面、全部出站路径（JM API / 图片代理 / DoH / AI / 搜索 / 更新检查 / 翻译）的 SSRF 防护（DNS 私网拒绝、TLS pin、重定向逐跳校验）、会话文件与 `.secret` 的权限与熵、Cookie 隔离与回显、错误/日志泄密、响应头与缓存语义、各端点限流的可绕过性。
- **B. 后端可靠性角度**：错误处理一致性（floating promise、进程级兜底）、内存与缓存（封面 LRU、日志上界、sharp 释放、chapter-ai 内存峰值）、并发与超时体系（图片槽位、背压、客户端取消、各层 deadline）、上游 Host 故障切换与重试语义、优雅退出、同步 I/O 在热路径上的影响、lib/ 与 server.js 的职责重叠与重复代码、翻译容器的队列/内存/健康检查。
- **C. 前端角度**：全仓 `innerHTML`/`document.write` 逐点核对数据来源、异步视图的 `ctx.signal`/`isActive()` 与监听器/Observer/RAF/Timer/ObjectURL 释放、图片生命周期（LRU 预算、解码并发、预取）、sw.js SHELL 清单与磁盘文件逐文件比对、localStorage/IndexedDB schema 与升级、多标签锁协议竞态、门禁/登录过期后的状态感知、移动端 dvh/safe-area/自动聚焦不变量、可访问性、各文件行数与职责混杂。
- **D. 测试/部署角度**：抽查 6 个核心测试文件的断言真实性（backend/https-fetch/deployment/service-worker/reader-performance/translation-deployment）、CI workflow 覆盖与依赖、Dockerfile/compose 安全基线（用户、只读、能力、端口、健康检查）、npm/Python 供应链（锁文件、hash、基础镜像钉住）、`.env.example` 与代码 `process.env.*` 键的全量比对、制品校验脚本黑白名单与 AGENT.md 第 9 节的一致性、README 与 AGENT.md 的互相矛盾。

**高影响结论的独立抽验（步骤 4）**——以下 5 个结论用命令行直接复核源码确认（全部属实）：

| 抽验项 | 方法 | 结果 |
| --- | --- | --- |
| CI 缺依赖安装 | `grep -n "npm ci\|npm install\|setup-node" .github/workflows/*.yml` | 仅命中 `setup-node`（28 行），全文件无 `npm ci`/`npm install` → **确认** |
| README 零依赖宣称 | `grep -n "零.*依赖\|npm install" README.md` | README.md:40、280、291 三处宣称零依赖，与 `package.json` 的 sharp 依赖矛盾 → **确认** |
| 无进程级异常兜底 | `grep -rn "unhandledRejection\|uncaughtException" server.js lib/` | 仅命中 lib/https-fetch.js:162 的一行注释，无任何 `process.on` 注册 → **确认** |
| CSRF 缺口端点 | `sed -n '2161,2170p' server.js` | `/like`、`/favorite` 确为 POST 且参数取自 `q.get('id')`/`q.get('aid')`，无 JSON body 防线 → **确认** |
| chapter-ai 同步落盘 | `sed -n '151,168p' lib/chapter-ai.js` | `save()` 为 `writeFileSync+renameSync` 全量重写，`touchPopularity()` 每次调用即 save → **确认** |

**分析局限**：

- 静态审查为主，未起服务做动态验证（无 payload 实际构造、无负载实测）；
- 行号在后续提交后会漂移；
- 翻译服务 Python 侧只做了代码级审查，未实际构建镜像验证依赖解析；
- 性能类结论（OOM、写放大、掉帧）是结构性推断，量级估算基于配置上限（2000 页 × 25MiB 等），未实测触发；
- 四路排查各自独立完成，虽经抽验与去重，仍可能存在个别 file:line 偏差，修复前应重新定位核对。

### 5.2 安全审计的方法【P2/P3】

**方法与分工**——"三路并行探索 + 人工复核"：

| 审计路 | 范围 | 核查重点 |
| --- | --- | --- |
| 后端 | `server.js`（约 2800 行，全文分段阅读）+ `lib/` 全部 7 个模块 | 门禁绕过、口令比较时序、会话/Cookie 隔离、SSRF/DNS rebinding/重定向、静态文件路径遍历、请求体处理、ReDoS、CSRF/CORS、安全响应头、限流、日志泄露、随机数 |
| 前端 | `public/` 全部 31 个文件（index.html、sw.js、manifest、js/*.js、css） | XSS sink 全量排查、门禁客户端绕过收益分析、凭据存储、postMessage/跨标签协调、SW 缓存策略、IndexedDB、剪贴板合规、`target=_blank`、图片 URL 构造 |
| 部署/供应链 | `Dockerfile`、3 个 Compose 文件、`.env.example`、`.github/workflows/`、`translation-service-poc/`（service.py、pipeline.py、requirements.txt、Dockerfile）、`scripts/`、ignore 文件 | 镜像标签固定、容器加固、CI 触发器/权限/脚本注入、服务间认证、Python 服务注入面、发布校验脚本、git 历史秘密扫描 |

后端与前端两路还对 AGENT.md 中"已检查未发现问题"的清单逐项做了独立验证（见第 8 节合并清单），避免把文档声明当作事实。

**人工复核记录**——三路审计产出的全部 P2 发现及关键 P3 发现，均由主审逐行打开对应源码复核确认：

| 发现 | 复核证据 |
| --- | --- |
| P2-1 AI 队列无上限 | 确认 `server.js:2406` 的 `/chapter-ai/enqueue` 分支无 `rateLimit` 调用（对比紧邻 `server.js:2413-2415` 的 `/ai/chat` 有）；确认 `lib/chapter-ai.js:191-206` 的 `enqueue()` 对新 key 无队列长度上限即 `push`，且 `save()`（157 行）为全量 `writeFileSync` 同步落盘；`touchPopularity` 每次调用同步落盘 |
| P2-2 限流退化 | 确认 `server.js:525-540` `clientIp()` 仅在 `isTrustedProxyIp(remoteAddress)` 为真时才解析 XFF；确认 `server.js:457-471` 限流桶表满 5000 时对新 key 返回 false（→429）；确认 `requestIsSecure()` 依赖同一信任判定，故反代后 Cookie 永不带 `Secure` |
| P2-3 翻译服务默认无认证 | 确认 `translation-service-poc/service.py:372-374` `if not token: return True`；确认 `docker-compose.yml` 两侧 `TRANSLATION_SERVICE_TOKEN` 默认均为空；token 比较本身为 `hmac.compare_digest`（380 行），实现正确 |
| P2-4 GHCR latest 标签 | 确认 `docker-compose.ghcr.yml:6,9` 为 `ghcr.io/...:latest`，文件头注释的部署命令含 `--pull always`；CI 侧有 `type=sha` 标签但部署侧未使用 |

其余 P3 发现基于审计路的 file:line 证据整理，标注了出处，整改前请先按 AGENT.md 要求核对当前运行态。

**审计局限**：

- 本报告基于 `1dd0697` 静态源码快照，未做动态渗透测试、未对生产环境（jm.shixinn.com）发起任何实际请求。
- 未审计 Cloudflare / 入口 Caddy / Tailscale 配置（在另一台主机，不在本仓库，AGENT.md 第 11 节已列为技术债）。
- `sharp`、npm 传递依赖、Python 依赖未做已知漏洞（CVE）数据库比对，仅审计了版本固定策略。
- 严重级别为结合本项目部署形态（个人/小范围自部署）的评估，若改为多租户开放部署，部分 P3（口令/运维权限未分离、明文落盘）应升级。

### 5.3 加载性能分析的方法【A】

**排查路径**——参照 AGENT.md 第 1 节建议的排查顺序（运行行为 → 网络流量 → 实际静态资源 → 容器/进程配置 → 持久化状态 → 当前源码），本次在无运行环境的条件下做了源码级静态分析：

1. 读取 `AGENT.md`，建立约束基线（第 6 节前端不变量、第 11 节已知技术债），避免把已修问题当作新发现。
2. 静态资源盘点：`public/` 全量文件体积、入口引用关系。
3. 入口 HTML（`public/index.html`）：阻塞资源、preload 提示、脚本形态。
4. 模块依赖图：`app.js` 的静态/动态 import，推导首屏实际加载集。
5. Service Worker 策略（`public/sw.js`）：precache、install/activate、fetch 拦截的缓存模式。
6. 服务端静态服务（`server.js` `serveStatic`）：缓存头、ETag/304、压缩、HEAD、SPA 回退。
7. API 链路：`public/js/api.js` → `server.js` 路由/缓存 → `lib/jm-api.js` host 故障切换 → `lib/https-fetch.js` 连接管理。
8. 首页与阅读器关键渲染路径：`views.js` `homeView`、`reader.js` 章节打开流程、`ui.js` 图片工具。
9. 图片代理链路：`server.js` `/api/img` 缓存与限流（仅核对，不作为问题源）。

**证据采集命令（可复现）**——均在仓库根目录于基准 commit 上执行：

```bash
# 静态资源体积盘点
find public -type f | xargs wc -c | sort -rn

# 压缩潜力测量（gzip -6 默认级别）
cat public/js/*.js | gzip -c | wc -c          # → 156047
cat public/css/*.css | gzip -c | wc -c        # → 23488
cat public/js/*.js public/css/*.css | wc -c   # → 675825

# 服务端缓存/压缩语义排查
grep -n "Cache-Control\|ETag\|gzip\|deflate\|compress\|immutable\|max-age" server.js
grep -n "zlib\|Accept-Encoding" server.js lib/*.js

# 上游连接管理排查
grep -n "keepAlive\|keep-alive\|new Agent\|Agent(\|https.request" lib/https-fetch.js lib/jm-api.js

# 前端模块图与启动序列
grep -n "^import\|import(" public/js/app.js
grep -n "registerOfflineWorker\|boot()\|refreshAvatar\|/api/me" public/js/app.js

# 首页/阅读器关键路径
grep -n "IntersectionObserver\|loading=\|prefetch" public/js/views.js public/js/reader.js public/js/ui.js
```

关键代码段通过 `sed -n` 定位阅读（`server.js:2507-2593` 静态服务、`public/sw.js` 全文、`lib/jm-api.js:455-540` 故障切换、`lib/https-fetch.js:150-250`、`public/js/reader.js:880-960`、`public/js/views.js:51-181`、`public/js/app.js:375-443`）。

**分析局限与不确定项**：

- **未做真实网络测量**：所有量化来自文件字节统计与 Node/HTTP 协议默认行为推理，无生产分段耗时（DNS/connect/TLS/TTFB）数据。建议按 A8 补可观测性后复核各项收益。
- **边缘压缩未实测**：生产拓扑为 Cloudflare → Caddy → Tailscale → 容器。Cloudflare 对文本类响应可能在边缘补压缩，但 AGENT.md 第 10 节要求的"笔记本直连"验收路径与内网/Tailscale 访问确定无压缩；边缘压缩质量（gzip vs brotli、级别）也不受本仓库控制。
- **Node globalAgent 行为**：`lib/https-fetch.js` 未显式传 `agent`，走 Node 默认 globalAgent。【勘误 C03：原文将 `keepAliveMsecs` 误当作连接空闲寿命——它是 TCP 保活探测初始延迟；Node 19 起默认 HTTPS Agent 已启用 keep-alive，默认 timeout 为 5 秒。因此"1 秒空闲窗口意味着不复用"的推断不成立，连接复用率须以 trace 的 `reused_socket` 字段实测确认。】
- 代码行号以基准 commit 为准，后续提交可能漂移。

### 5.4 测试真实性抽查结论【S/B/F/D §6.1】

抽查的 6 个核心测试文件中，`backend.test.js`、`https-fetch.test.js`、`service-worker.test.js` 属于**高质量真行为测试**（真实起 HTTP 服务器、socket 级畸形请求、drain 背压、LRU 竞态、子进程隔离测 ACCESS_PASSWORD），不存在"只跑不断言"的空壳。backend 的 env 隔离做法正确（独立进程 + 子进程）。问题在 CI 接线与覆盖缺口，不在既有测试质量。

---

## 6. 项目概况与量化基线（合并）

### 6.1 规模统计【S/B/F/D §2.1】

| 文件 | 行数 | 说明 |
| --- | --- | --- |
| server.js | 2,802 | 单文件承载路由/鉴权/图片代理/静态/AI/翻译/日志，`api()` 函数约 660 行 |
| public/js/reader.js | 2,096 | 图片管线 + 三种阅读模式手势 + 章节抽屉 + 历史，职责混杂 |
| public/js/advanced.js | 1,810 | 应用锁+WebAuthn、AES 备份、Markdown 渲染、AI 会话、DoH、日志、更新等 8 类 |
| public/js/user.js | 1,594 | 登录/签到/收藏/双历史/评论历史/设置 6 类 |
| public/js/views.js | 1,385 | 首页/搜索/分类/周榜/详情/评论 |
| public/js/downloads.js | 1,098 | 下载队列状态机 + 跨标签协议 |
| public/js/offline.js | 944 | 含约 220 行死代码（见 FE-08） |
| lib/ 全部 7 模块 | 3,057 | jm-api 770 / features 658 / sessions 578 / settings 327 / chapter-ai 317 / https-fetch 261 / photo 153 |
| public/js 合计 | 12,879（约 561 KB，无构建/无压缩） | 首屏静态导入约 551 KB（除 gate.js 动态、worker 外全部拉入） |
| translation-service-poc | service.py 542 + pipeline.py 555 | Python OCR/繁简转换容器 |

**活跃度**：仓库创建于 2026-08-30，最近提交 2026-09-08（基线），约 10 天高强度开发期；近期提交集中在阅读器加载/滚动稳定性、签到、翻译字体与镜像源配置；sharp 依赖随 chapter-ai 功能（后台章节视觉分析队列）引入，**workflow 未同步补依赖安装步骤**（见 DEL-01）。

### 6.2 `public/` 静态资源体积明细【A §3.1】（字节，基准 commit 实测）

| 文件 | 大小 | 文件 | 大小 |
| --- | ---: | --- | ---: |
| js/advanced.js | 105,250 | css/favorites.css | 11,814 |
| css/app.css | 91,464 | css/offline.css | 11,780 |
| js/reader.js | 82,447 | js/api.js | 10,580 |
| js/user.js | 69,208 | js/store.js | 10,236 |
| js/views.js | 58,012 | js/descramble.js | 10,036 |
| js/downloads.js | 45,246 | js/recommend.js | 7,888 |
| js/offline.js | 38,861 | sw.js | 7,371 |
| js/download-view.js | 29,497 | js/icons.js | 5,908 |
| js/app.js | 19,135 | icons/icon-512.png | 5,462 |
| js/ui.js | 18,030 | js/gate.js | 4,879 |
| js/export.js | 14,584 | js/descramble-worker.js | 3,817 |
| js/reader-settings.js | 13,669 | js/descramble-core.js | 3,242 |
| js/content-filter.js | 3,108 | js/content-actions.js | 2,909 |
| icons/icon-192.png | 1,942 | js/md5.js | 1,915 |
| js/booterr.js | 1,258 | index.html | 1,163 |
| manifest.webmanifest | 1,076 | js/navigation.js | 1,018 |

合计 **692,839 B**；其中 JS 560,767 B、CSS 115,058 B、HTML/清单/图标 17,014 B。

**压缩潜力（gzip -6 实测）**：

> 【勘误 C08】下表 gzip 值来自 `cat … | gzip` 拼接压缩，不代表独立 HTTP 文件的实际传输总量（每文件需独立压缩、含独立头部）。复核基线逐文件 zlib level 6 压缩合计约 **197,409 B（约省 70.8%）**；实施后应以逐资源实际传输字节验收。

| 类别 | 原始 | 拼接 gzip 后（原口径） | 逐文件 gzip 估算（复核口径） |
| --- | ---: | ---: | ---: |
| JS（全部 24 个模块） | 560,767 | 156,047 | — |
| CSS（3 个文件） | 115,058 | 23,488 | — |
| 合计 | 675,825 | 179,535（-73.4%） | 约 197,409（约 -70.8%） |

brotli（质量 5-6 以上）通常比 gzip 再省 15-20%。项目当前无构建步骤、无最小化（源码含完整注释与缩进），最小化可在压缩前再削减约 20-30%，但会改变"无构建步骤"的架构约定，需单独决策。

### 6.3 首屏静态模块图【A §3.3】

`public/js/app.js:2-19` 静态导入：`store`、`api`、`ui`、`icons`、`views`、`reader`、`download-view`（→ `downloads`）、`offline`、`navigation`、`advanced`、`user`；`views` 再引 `recommend`/`content-filter`/`content-actions`，`reader` 再引 `reader-settings`/`descramble`（→ `descramble-core`），`user`/`export` 再引 `md5` 等。

结果：**除 `gate.js`（动态 import，app.js:405）、`descramble-worker.js`（Worker 实体）、`sw.js`/`booterr.js`（特殊入口）外，全部 JS 都在首屏下载并解析执行，合计约 552 KB**（未压缩）。而首屏渲染（应用外壳 + 首页）实际只需要 `app/ui/views/api/store/icons/navigation/recommend` 一小部分。

`index.html` 无任何 `modulepreload`/`preload`，浏览器只能从 `app.js` 逐层发现 import（`app → views → ui/api/…`），HTTP/2 下仍有按发现深度串行付出额外 RTT 的成本。

### 6.4 首访/复访请求瀑布（按代码逻辑推断）【A §3.4】

**首次访问**：
HTML → `booterr.js`（同步经典脚本）→ `app.js` →（逐层发现）约 22 个模块全量 → `boot()` 内 `await /api/me`（8 s 上限）→ `startApplication()`：`render()` → `homeView` → `/api/home`（服务端 30 s 进程内缓存）+ `refreshAvatar()` → 又一次 `/api/me`；随后封面图经 `/api/img` 懒加载。

**复访（在线，页面重新加载）**：
HTML（SW network-first）→ 已由浏览器/SW 缓存的模块命中缓存，未命中或需协商的走 SW `staticResponse` 的 `fetch(request, { cache: 'no-cache' })` 条件协商【勘误 C04：Hash 路由内切换视图不会重新下载整套模块；32 个 SHELL 条目也不等于每次页面加载都发起 32 项请求；浏览器条件协商收到 304 后会与 HTTP 缓存合并，Fetch 通常得到带完整正文的缓存响应，并不依赖 `response.ok === false` 分支恢复正文——该分支只服务真实失败（404/5xx 等）】→ `/api/me` 探测后 `/api/home` 与头像 `/api/me` 并行。每次发版 `CACHE_VERSION` 变更触发 SW install，用 `cache: 'reload'` 全量重下 SHELL 文件（约 676 KB 裸传）并与用户当前浏览争带宽。【基线漂移：当前 `8eaf132` 为 v15、SHELL 33 项】

---

## 7. 统一问题清单

编号规则：`SEC-`（安全）、`REL-`（后端可靠性/性能）、`FE-`（前端质量）、`PERF-`（加载性能）、`DEL-`（测试/CI/部署/供应链）。每条标注全部来源编号。**安全类中 REL-01（chapter-ai）同时是安全与可靠性问题，为避免内容拆散，全文放在可靠性组，此处先行指引。**

### 7.0 问题索引

| 统一编号 | 级别 | 标题 | 来源 |
| --- | --- | --- | --- |
| SEC-01 | 高 | 非幂等 API 无统一同源 CSRF 防护，3 个端点连 JSON Content-Type 防线都没有 | S1（与审计排除#15 矛盾，已裁决） |
| SEC-02 | 中 | `jmw_auth` 全员相同的静态令牌：无过期、无单项吊销、硬编码 1 年 | S3 + P3-2 |
| SEC-03 | 中/高 | 反代/桥接形态下 per-IP 限流与并发可能坍缩为共享桶（取决于实际代理配置）；Cookie 拿不到 Secure；桶表满拒新 key【勘误 C02】 | S4 + P2-2 + P3-6 |
| SEC-04 | 中 | 弱/空口令治理：只告警不阻断；空口令默认；无口令部署会话写放大 DoS | S5 + P3-3 + P3-23 |
| SEC-05 | 中 | 站点访问口令与运维权限未分离（DoH/日志） | P3-1（S2 引用已知债） |
| SEC-06 | 中 | `AI_BASE_URL` 默认指向第三方中转域名 | P3-4 + D6 |
| SEC-07 | 中 | 翻译服务默认无认证（空 token 即完全放行） | P2-3 + D6 |
| SEC-08 | 低 | `assertPublicUrl` 未拒绝 NAT64（与 6to4）前缀 | P3-9 + S6 |
| SEC-09 | 低 | 响应头后备缺失（HSTS / X-Frame-Options / CSP meta） | P3-8 + P3-11 + S6 |
| SEC-10 | 低 | 会话固定：JM 登录不轮换 `jmw_sid`，Cookie 无 `__Host-` 前缀 | S6 |
| SEC-11 | 低 | 少量错误自反射/上游对象直通；`PRIVATE_USER_FIELDS` 黑名单制 | S6 |
| SEC-12 | 低 | 翻译服务出站走全局 fetch：跟随重定向、无 assertPublicUrl/DNS 校验 | S6 |
| SEC-13 | 低 | `upstreamRequest` 默认 `fetchImpl` 为全局 fetch | S6 |
| SEC-14 | 低 | 硬编码 JM 协议常量与上游可控 URL 透传（信息项） | P3-10 |
| SEC-15 | 低 | Windows 宿主直跑时敏感文件 0600 权限失效 | P3-5 |
| SEC-16 | 低 | 部分上游转发端点无每 IP 限流 | P3-7（关联 B10 行 2） |
| SEC-17 | 低 | booterr.js 启动错误页泄露堆栈片段/文件名/行号 | P3-12 |
| SEC-18 | 低 | 应用锁为纯客户端装饰，可被本机篡改绕过；4 位 PIN 可离线穷举 | P3-13 |
| SEC-19 | 低 | 浏览行为数据与离线正文明文落盘，无加密、隐私模式不清除 | P3-14 |
| SEC-20 | 低 | export.js 使用 `document.write` 与保留 opener 弹窗 | P3-15（呼应 5.2#1） |
| SEC-21 | 低 | 翻译服务 `/healthz` 无认证泄露内部运行状态 | P3-21（与 REL-07 同端点不同缺陷） |
| REL-01 | 高 | chapter-ai 综合症：enqueue 无限流无上限、匿名 DoS、OOM、同步写盘热路径、磁盘填满 | S2 + B1 + B2 + P2-1 |
| REL-02 | 待定级 | 无全局异常监听器（≠高危漏洞；应先修具体遗漏的 Promise/回调错误处理，保留默认退出语义）【勘误 C01】 | B3 |
| REL-03 | 高 | `/api/translation/page` 无超时、无并发闸、无限流 | B4（P3-7/P3-22 关联） |
| REL-04 | 中 | API Host 无跨请求熔断；429 语义两套不一致；文档滞后于实现 | B5（与 PERF-05 同族） |
| REL-05 | 中 | 优雅退出不完整 | B6 |
| REL-06 | 中 | lib/ 与 server.js 职责重叠、成片重复代码，威胁安全边界一致性 | B7 |
| REL-07 | 中 | 翻译容器健康检查不覆盖 OCR 失败；OCR 串行与字形渲染低效 | B8（P3-21 关联） |
| REL-08 | 中 | server.js 单文件 2802 行、模块加载即副作用，可测试性差 | B9 |
| REL-09 | 低 | 可靠性次要问题（7 项） | B10 |
| REL-10 | 低 | 翻译服务缺少连接级限流与慢速上传超时 | P3-22 |
| FE-01 | 高 | 下载管线网络请求无超时，任务可永久挂起 | F1 |
| FE-02 | 高 | `task.errors` 无上限增长 + 每张图全量 JSON 序列化持久化（O(n²) 写放大） | F2 |
| FE-03 | 高 | `listOfflineImages` 一次性物化整章 Blob，多处全量调用造成内存峰值 | F3 |
| FE-04 | 中 | 两个性能热点：滚动 O(n) 遍历与 AI 流式全量重建 | F4 |
| FE-05 | 中 | 门禁口令过期后无重新验证入口（待复现）；JM 登录失效感知已在 8eaf132 部分修复（API 层失效+世代保护+跨标签通知），顶栏旧头像等待独立复现【勘误 C12】 | F5 |
| FE-06 | 中 | 无 Web Locks 浏览器下的 aid claim 无限轮询 | F6 |
| FE-07 | 中 | 前端杂项硬伤（6 项） | F7（行 2 与审计排除#19 呼应） |
| FE-08 | 低 | 前端次要问题（9 项） | F8 |
| PERF-01 | P0 | 静态资源零压缩裸传 | A1 |
| PERF-02 | P0 | 无内容哈希 + immutable 缓存；SW 全量协商与全量重下 | A2 |
| PERF-03 | P1 | 首屏 JS 全量加载，无路由级分割、无 modulepreload | A3（B10 行 7 重复，已合并标注） |
| PERF-04 | P1 | 启动门禁探测串行 + 重复 `/api/me` 请求（探测后首页与头像已并行、外壳先挂载）【勘误 C07】 | A4 |
| PERF-05 | P1 | 上游 API 缺跨会话线路健康管理（会话内已有 `jar.apiHost` 亲和）；连接复用率未实测【勘误 C03】 | A5（B5 重复，已合并标注） |
| PERF-06 | P2 | 首页一次性全量渲染 | A6（分析 §8 对照重复） |
| PERF-07 | P2 | CSS 渲染阻塞且未按视图拆分 | A7 |
| PERF-08 | P3 | 加载链路分段可观测性缺失 | A8 |
| DEL-01 | 高 | CI 无依赖安装步骤，`npm test` 在干净 runner 上必然失败 | D1（合并时已再次验证） |
| DEL-02 | 高 | README 宣称"零运行时依赖、无需 npm install"，与 sharp 依赖直接矛盾 | D2 |
| DEL-03 | 高 | 发布制品校验脚本黑名单存在盲区 | D3 |
| DEL-04 | 中 | CI 矩阵与门禁缺口；一个无效安全断言 | D4 |
| DEL-05 | 中 | 翻译代理与 SW 升级路径零自动化测试 | D5 |
| DEL-06 | 中 | 翻译服务基础镜像与 Python 依赖均未固定版本 | P3-18 + D6 |
| DEL-07 | 中 | GHCR 部署默认拉取可变 `latest` 标签且 `--pull always` | P2-4 |
| DEL-08 | 中 | CI 第三方 action 仅按 tag 引用未固定 SHA；CI 测试从 PyPI 拉取未固定包 | P3-16 + P3-25 |
| DEL-09 | 低 | publish job 的 `id-token: write` 权限多余 | P3-17 |
| DEL-10 | 低 | 翻译镜像构建参数可注入 sed / 替换 PyPI 源 | P3-19 |
| DEL-11 | 低 | `npm ci --ignore-scripts=false` 以 root 运行允许依赖生命周期脚本 | P3-20 + D7 行 8 |
| DEL-12 | 低 | 主镜像基础标签锁定补丁版本但未锁 digest | P3-24 |
| DEL-13 | 低 | 交付/部署次要问题（8 项） | D7 其余行 |

### 7.1 安全类问题详情

#### SEC-01（高）【已知债】非幂等 API 无统一同源 CSRF 防护，三个端点连 JSON Content-Type 防线都没有（来源：S1；与审计排除#15 矛盾，见第 3 节矛盾 #1）

- `requestHasSafeBrowserContext`（校验 Origin/Sec-Fetch-Site，`server.js:626-639`）**只**被 `checkOperationalAccess`（`server.js:655`）调用，后者仅覆盖 `/logs`、POST `/doh`、`/doh/test`（`server.js:2703-2706`）；普通 API 路径对所有路由不做 Origin 校验。
- 缺口端点（POST 但参数取自 query，不调用 `readJsonBody`，HTML 表单即可跨站提交）——**合并时已用源码复核确认**（`server.js:2014/2161-2164/2166-2169`）：
  - `/api/favorite`（`server.js:2166-2169`，`q.get('aid')`）
  - `/api/like`（`server.js:2161-2164`，`q.get('id')`）
  - `/api/logout`（`server.js:2014-2017`）
- 带 JSON body 的 POST（login/comment/favorite_folder/history.delete/daily_chk/config.api-host/chapter-ai.enqueue/ai.chat/ai.search/doh）受 `readJsonBody` 强制 application/json（`server.js:413-421`）保护：跨站表单无法设置该 Content-Type，跨站 fetch 会触发注定失败的 preflight（服务端无 CORS 头）。
- 现状唯一防线：`jmw_sid`/`jmw_auth` 的 `SameSite=Lax`（`server.js:569、1964`）。
- 场景：不执行 SameSite 的旧浏览器（或未来任何把 Cookie 改为 `SameSite=None` 的改动）下，恶意页面用 `<form method=POST action="https://site/api/favorite?aid=123">` 即可冒充受害者收藏/点赞/登出。
- AGENT.md 第 11 节已承认此债；第 5 节不变量清单未列 CSRF，属文档化缺口。
- 【矛盾标注】安全审计排除清单 #15 声称"非幂等接口全部要求 application/json body"，对上述三端点不成立；对该列表中的 JSON body 端点仍成立。审计排除 #15 的其余内容（CORS 零放宽、SameSite=Lax 现状）与本文一致。

#### SEC-02（中）【新发现】`jmw_auth` 是全员相同的静态令牌：无过期、无单项吊销、硬编码 1 年（来源：S3 + P3-2 合并）

- `authToken() = sha256(ACCESS_SECRET:ACCESS_PASSWORD)`（`server.js:596-598`，审计作 `server.js:581-603`）——确定性、无 nonce、无时间因子；签发 `Max-Age=31536000` 写死（`server.js:1962-1965`，审计作 `server.js:1964`）；`JMW_SESSION_TTL_SECONDS` 只影响 `jmw_sid` 不影响它。
- 吊销手段仅剩改口令或删 `.secret`（全量吊销，无法针对单个泄露）。
- 【审计补充·已勘误 C10】令牌不含签发时间/随机数，服务端无失效清单。原文称"`.secret` 与口令任一泄露即可离线计算令牌"**有误**：`authToken() = sha256(ACCESS_SECRET:ACCESS_PASSWORD)` 需要二者同时已知才能计算；任一单独泄露不能离线推导令牌（但 Cookie 本身泄露即等效口令，属另一回事）。
- 场景【勘误 C10】：任意一枚 `jmw_auth` 泄露（日志、代理、浏览器同步、备份）即等效站点口令——**服务端没有令牌过期校验**，Cookie 的一年 Max-Age 只约束浏览器保存，被复制的令牌不受其限制，实际有效期持续到改口令/换 `.secret` 为止，并非"最长一年"。
- 恒定时间比较本身无问题（`server.js:449-453、600-611`）。
- 【审计建议·已勘误 C10】令牌掺入时间片（如按月轮转 `sha256(secret+password+period)`，容忍上一周期）可实现滚动过期；但**时间片轮换不等于单令牌吊销**——已泄露令牌在容忍窗口内仍有效，单项吊销仍需失效清单或改口令。

#### SEC-03（中，审计评 P2）【新发现】反代/默认部署后 per-IP 限流、图片并发坍缩为共享桶；Cookie 拿不到 Secure；限流桶表满拒新 key（来源：S4 + P2-2 + P3-6 合并）

**根因**（两份报告一致）：

- `clientIp`（`server.js:524-541`，审计作 `server.js:525-540`）仅当对端 IP 属于回环或配置 `JMW_TRUST_PROXY` 时才解析 XFF；`requestIsSecure`（`server.js:543-551`）同理。
- 生产拓扑（Cloudflare→Caddy→Tailscale→容器）中若对端是 Tailscale/桥接网关 IP，默认不受信 → 访客可能同 IP。审计具体化：容器经端口发布/宿主机反代访问时，容器内 `remoteAddress` 通常为 Docker 网桥网关（如 `172.18.0.1`）；`Dockerfile` `ENV HOST=0.0.0.0`、`docker-compose.yml` `JMW_TRUST_PROXY` 默认空。【勘误 C02：以上为按默认配置的结构性推断；实际是否共享桶取决于真实对端与代理链（如 Tailscale 直通容器 IP 时每客户端独立计数），未经运行态确认不得断言"生产必然如此"】

**后果**（合并双方场景）：

1. auth/AI/搜索限流共享单桶（`server.js:1957` `rateLimit('auth:${clientIp(req)}', 10, 5*60*1000)`）。攻击者每 5 分钟发 10 次错误口令即可让**全部真实用户**的 `/api/auth`、`/api/login` 持续 429——长期锁死站点登录，无需知道口令。
2. `MAX_IMAGE_CONCURRENCY_PER_IP=6` 实际变成全站并发上限（全局 12 永远用不满）；单人可挤占过半图片通道。
3. HTTPS 部署下 `Set-Cookie` 永不带 `Secure`（`server.js:553-555`）——`requestIsSecure()` 恒 false（同机另开 HTTP 端口时可旁路截获）。
4. 【P3-6】限流桶表满 5000 时对新 key 一律拒绝（`server.js:457-471` `if (rateBuckets.size >= 5000) return false` → 全部 429）。代码注释已自知此权衡（防内存撑爆）。正常配置下 XFF 不可伪造；仅当反代被错误配置为信任且透传客户端可控 XFF 时，攻击者可用 5000 个伪造 IP 填满桶表使所有"新 key"请求一律 429。

**其他细节**：

- `.env.example:87-89` 有文档说明属已知部署要求，但**有口令模式下检测到 XFF 却不采信时无任何告警**（无口令模式的 `checkOperationalAccess` 反而 fail-closed 检查转发头，`server.js:652-654`——行为不对称）。

**修复建议**（审计）：

1. 【勘误 C02：不得默认信任整个 `172.16.0.0/12` 或所有私网——那会让任意能接入 Docker 网桥的容器伪造 XFF。只按**实际验证过的代理链**配置必要的精确地址/CIDR，并确认该代理会覆盖（而非透传客户端自带）XFF 与协议头的处理方式；`requestIsSecure` 同样依赖该信任判定，配置错误会同时影响 Secure Cookie 判定】；
2. 共享桶场景改用"全站桶 + 更高阈值 + 失败退避"混合策略；
3. 桶表满时对新 key 使用共享降级桶而非硬拒绝（P3-6 与本条一并整改）。

#### SEC-04（中）【新发现】弱/空口令治理：弱口令只告警不阻断；空口令默认无强制；无口令部署存在会话写放大 DoS（来源：S5 + P3-3 + P3-23 合并）

**弱口令不阻断**（S5 + P3-3）：

- 口令长度 <16 字节仅 `console.error` 后照常启动（`server.js:250-254`，审计作 `server.js:248-254`）；`/api/auth` 限流 10 次/5 分钟/IP（`server.js:1957-1959`）为内存固定窗口（`server.js:456-471`，重启清零），按 `clientIp` 计数。
- 场景：弱口令 + IPv6/代理池轮换源 IP 线性扩展爆破。
- 【审计建议】低于阈值拒绝启动，或要求显式 `JMW_ALLOW_WEAK_PASSWORD=1`（与 P3-23 合并整改）。

**空口令默认**（P3-23）：

- `ACCESS_PASSWORD` 默认为空且无部署期强制拦截（`.env.example:28-30`、`docker-compose.yml:89`）。缓解：默认 `JMW_PUBLISH_HOST=127.0.0.1` 只绑回环（`.env.example:21` 有改 `0.0.0.0` 的警告）。风险：用户改 `0.0.0.0` 但忘设强口令时，服务对局域网/公网开放且无任何拦截机制。
- 【审计建议】启动时检测"非回环发布 + 空/弱 ACCESS_PASSWORD"组合，打印显著警告甚至拒绝启用高消耗功能（AI/翻译）。

**无口令部署的会话写放大 DoS**（S5）：

- 无 `ACCESS_PASSWORD` 时，`ensureJar`（`server.js:559-579`）对每个无/无效 `jmw_sid` 的请求创建新 jar，`scheduleSave` 300ms 后同步原子写（`lib/sessions.js:201-237`）；LRU 驱逐再同步落盘（`sessions.js:350-368`）；超 2000 文件后每 25 次写触发全目录同步扫描 + JSON.parse（`sessions.js:511-561`）。
- 场景：攻击者携随机 Cookie 洪泛 → 海量同步文件写 + 周期性全目录扫描阻塞事件循环。有口令时被门禁先行 401 挡住（`server.js:2700` 在 `api()` 之前），该路径安全。

#### SEC-05（中，审计 P3-1）站点访问口令与运维权限未分离（来源：P3-1；S2 与 AGENT.md 4.3/11 节均已承认为已知债）

- **位置**：`server.js:643-656`（`checkOperationalAccess`：`if (ACCESS_PASSWORD) return checkAccess(req)`）、`server.js:2703-2706`。
- **分析**：`ACCESS_PASSWORD` 设计为全站访客共享口令，但持有它即可 `POST /api/doh` 更改所有出站请求的 DNS 解析路径（自定义 DoH URL），并可 `GET/DELETE /api/logs`。口令在访客间共享/泄露后，任何人可将 DoH 指向自己控制的服务器（观察本实例全部域名解析轨迹，属元数据泄露），并擦除运维日志掩盖痕迹。DoH 返回地址仍受 `assertPublicUrl` 拦截，无法借此打内网。AGENT.md 第 11 节已自知此项，但截至基线仍未整改。
- **建议**：引入独立 `ADMIN_PASSWORD` 区分运维路由；或在部署文档明示该口令等同管理员权限。

#### SEC-06（中，审计 P3-4）`AI_BASE_URL` 默认指向第三方中转域名（来源：P3-4 + D6 第 4 点合并）

- **位置**：`server.js:140`、`lib/features.js:348`（默认 `https://newapi.shixian.me/v1`）、`docker-compose.yml:113`、`.env.example:94`。
- **分析**：部署者只设 `AI_API_KEY` 不改 `AI_BASE_URL` 时，API Key 与用户全部对话/搜索上下文（含章节图片）发送到该第三方域名。属默认配置/供应链风险，非代码缺陷——用户一设 `AI_API_KEY` 就默认把漫画页图片发往该中转，隐私与单点风险。
- **建议**：设置 `AI_API_KEY` 而 `AI_BASE_URL` 为默认值时打印显著告警。

#### SEC-07（中，审计 P2-3）翻译服务默认无认证，空 token 即完全放行（来源：P2-3 + D6 第 1 点合并）

- **位置**：`translation-service-poc/service.py:372-374`；`docker-compose.yml:37,105`；`.env.example:57`。
- **证据**（已人工复核）：

  ```python
  def _authorised(request: Request, token: str) -> bool:
      if not token:
          return True                      # 空 token = 完全放行
      ...
      return bool(supplied) and hmac.compare_digest(supplied, token)   # 比较本身实现正确
  ```

  ```yaml
  TRANSLATION_SERVICE_TOKEN: "${TRANSLATION_SERVICE_TOKEN:-}"   # 两侧默认均为空
  ```

- **利用场景**：默认部署下互信完全依赖 Docker 内部网络隔离。任何被附加到同一 compose 网络的其他容器、宿主机上可路由到容器 IP 的本地进程、或 jm-web 自身若出现 SSRF/请求代理缺陷，都可直接调用 `/v1/translate/page`，提交 25MB 图片触发 OCR 密集计算（每请求最长内联等待 5 秒），形成资源耗尽（配合 P3-22 无连接级限流可放大）。
- 【分析角度补充】与 `ACCESS_PASSWORD` 的红色告警（server.js:248-253）不对称——`.env.example` 留空且无警告注释；缓解：8091 不发布宿主机（有测试断言），但同 Docker 网络内任意容器可无令牌调用。
- **修复建议**：
  1. jm-web 启动时校验"配置了翻译服务但未设 token 即拒绝启用翻译路由"（fail-closed）；
  2. `.env.example` 将 `TRANSLATION_SERVICE_TOKEN` 标注为"生产必填"；
  3. 翻译服务侧可在生产模式下拒绝空 token 启动。

#### SEC-08（低，审计 P3-9）`assertPublicUrl` 未拒绝 NAT64 前缀（来源：P3-9 + S6 行 2 合并）

- **位置**：`lib/jm-api.js:102-117`（`unsafeIp`）、`lib/settings.js:67-80`。
- IPv4/IPv6 私网、环回、CGN、链路本地、多播、文档段均已覆盖（`::`、`::1`、`::ffff:v4`、fc00::/7、fe80::/10、ff00::/8、2001:db8），唯缺 NAT64 合成地址前缀 `64:ff9b::/96`【分析补充：6to4 `2002::/16` 同样不在清单】。
- 需同时满足"DNS 返回该记录 + NAT64 网关违规转换私有地址（违反 RFC 6052）"，实际可利用性极低，记录备查。十六进制/八进制 IPv4 走 DNS 后结果层校验可拦截，仅 NAT64 出口网络可绕过。

#### SEC-09（低，审计 P3-8 + P3-11）响应头与 CSP 加固缺失（来源：P3-8 + P3-11 + S6 行 3 合并）

- **位置**：`server.js:280-292`（CSP 仅用于 `.html` 静态响应）、`server.js:2550`、`public/index.html:3-9`。
- 【分析角度】无 HSTS；CSP 只加在 `.html` 响应；`frame-ancestors 'none'` 等效 XFO 可接受；HSTS 依赖边缘 Caddy/Cloudflare，仓库内无声明。
- 【审计角度】CSP 本身质量好（`frame-ancestors 'none'`、`script-src 'self'`），但 ① 无 HSTS（TLS 在反代终止，应在入口 Caddy 加 `Strict-Transport-Security`）；② 无 `X-Frame-Options: DENY` 后备（老浏览器不支持 frame-ancestors）；③ `style-src 'unsafe-inline'` 属常见放宽。
- 【P3-11】index.html 无 CSP meta，CSP 完全依赖服务端响应头（服务端 CSP 注入仅对 `.html` 扩展名生效）。若 index.html 被复制到其他静态托管（CDN、对象存储、`file://` 打开）或反代剥离 CSP 头，应用将失去 `script-src 'self'` 兜底——届时未来引入的任何 XSS 都不会被 CSP 拦截。**建议**在 index.html 加与服务端等价的 CSP meta（`script-src 'self'; object-src 'none'; base-uri 'none'`；`frame-ancestors` 不支持于 meta 可省略），双保险。

#### SEC-10（低）【新发现】会话固定：JM 登录不轮换 `jmw_sid`，Cookie 无 `__Host-` 前缀（来源：S6 行 1）

- 证据：`server.js:559-579、1977-2012`。攻击者若能向受害者浏览器注入 Cookie 可预置 sid 共享其 AVS；HttpOnly/Lax/条件 Secure 均有，利用前提较强。

#### SEC-11（低）【新发现】少量错误自反射/上游对象直通（来源：S6 行 4）

- 证据：`server.js:946、2496、2011`；`lib/sessions.js:39-42`。
- `/api/img` 403 回显 host、404 回显 route（自反射无敏感信息）；`PRIVATE_USER_FIELDS` 黑名单制可能漏掉上游将来新增的认证字段（如 `jwt_token` 下划线变体、`session`）。

#### SEC-12（低）【新发现】翻译服务出站走全局 `fetch`（来源：S6 行 5）

- 证据：`server.js:1768、1811`。跟随重定向、无 assertPublicUrl/DNS 校验；`TRANSLATION_SERVICE_URL` 无协议校验；默认明文内网（设计如此，端口不发布）；结果 URL 有 origin+路径白名单（`server.js:1805-1808`）；仅管理员 env 可控。

#### SEC-13（低）【新发现】`upstreamRequest` 默认 `fetchImpl` 为全局 fetch（来源：S6 行 6）

- 证据：`lib/jm-api.js:443-446`。不传 `fetchImpl` 时忽略 `jmwLookup`，存在二次解析 rebinding 窗口；当前所有调用点都传了 `features.outboundFetch`（已逐一核对），仅是新增调用点的潜伏地雷。

#### SEC-14（低，审计 P3-10）硬编码协议常量与上游可控 URL 透传（信息项）（来源：P3-10）

- `lib/jm-api.js:24` `API_SECRET = '185Hcomic3PAPP7R'`：JM 客户端公开协议常量（逆向自 jm-mobile/jmcomic-next），非本项目秘密，但意味着上游接口对任何第三方同样可用。
- `lib/photo.js:141-148`：章节图片 URL 由上游 HTML 的 `imghost/jmid/cache/name` 拼接后返回浏览器；出站请求一律重过 `validateImageUrl` 白名单（`server.js:934-950`），SSRF 已被阻断，仅前端展示层存在上游可控字符串。

#### SEC-15（低，审计 P3-5）Windows 宿主直跑时敏感文件 0600 权限失效（来源：P3-5）

- **位置**：`server.js:590`（`.secret` 写入）、`lib/sessions.js:18-21`（目录 chmod try/catch）。
- win32 忽略 POSIX mode，`data/.secret`、`data/sessions/*.json`（含上游 AVS 登录凭证）依赖目录 ACL。Docker 路径已由镜像 `chmod 0700 /app/data` 缓解。仅多用户 Windows 主机直跑时构成本机横向读取风险。

#### SEC-16（低，审计 P3-7）部分上游转发端点无每 IP 限流（来源：P3-7；B10 行 2 的 `/api/search` 缓存观察与此重叠）

- **位置**：`server.js:2480-2481`（`/api/update`，每次请求打 GitHub API）、`server.js:2074-2085`（`/api/search`，缓存 key 含 query，256 条上限可被随机 query 绕过逐条回源）、`server.js:2046-2051`（`/api/album`）、`server.js:2389`（`/api/translation/page`，25MiB body 无并发限制——该端点的主条目见 REL-03）。
- **分析**：有口令时可被用于放大流量打上游 JM 线路/GitHub、消耗实例带宽与翻译服务算力；无口令部署则匿名可达。已有字节上限与并发上限兜底，故 P3。
- **建议**：为这些路由补每 IP 固定窗口限流（复用现有 `rateLimit`）。

#### SEC-17（低，审计 P3-12）booterr.js 启动错误页泄露内部细节（来源：P3-12）

- **位置**：`public/js/booterr.js:13-21`：显示 `e.message + '@' + filename + ':' + lineno`，unhandledrejection 直接显示 `r.stack` 前 3 行。
- 错误非攻击者可控，但启动期网络代理注入的报错、模块 URL、内部路径会原样呈现在启动屏上，与 app.js 路由层刻意脱敏（app.js:121-131）的意图相悖。
- **建议**：生产下只显示通用文案 + 可选"详情"折叠；至少过滤 stack 中的完整 URL。

#### SEC-18（低，审计 P3-13）应用锁为纯客户端装饰，可被本机篡改绕过（来源：P3-13）

- **位置**：`store.js:75`、`advanced.js:579`（`if (!setting.appLockEnabled) return`）、`advanced.js:309-311`（删除 `jmw_lock_credential` 即跳过）、`app.js:394-397`。
- UI 已自我声明"访问口令是服务器级保护；这里是当前浏览器的个人锁"（advanced.js:555）。实现质量在纯客户端锁里属高位：PIN/图案经 PBKDF2-SHA256（180000 迭代 + 16 字节盐）、凭据损坏进灾难恢复而非放行、备份强制剥离锁配置、跨标签 storage 事件重建锁屏。剩余弱点：最短 4 位数字 PIN 在 180k 迭代下单机数小时可穷举；WebAuthn 仅验证平台认证器通过用户验证，未做公钥断言校验。物理接触已解锁设备的攻击者或浏览器内扩展改写 localStorage 即可绕过。
- **建议**：如需真实防护，用锁凭据派生密钥对本地历史/AI 会话做 AES-GCM 加密（绕过锁拿不到明文）；提示设置 ≥6 位 PIN。

#### SEC-19（低，审计 P3-14）浏览行为数据与离线正文明文落盘，无加密（来源：P3-14）

- **位置**：localStorage——本地阅读记录 `store.js:217-239`、搜索历史 `store.js:257-268`、阅读进度 `reader.js:2014-2032`、AI 会话全文 `store.js:154-155`、离线历史 `offline.js:810-817`；IndexedDB `jm-web-offline`（无加密）——专辑元数据 `downloads.js:872-883`、`offline.js:237-248`、全部章节图片 Blob `offline.js:283-301`。
- 共用电脑/被装恶意软件的设备上，任何进程或浏览器 profile 读取者可直接还原"看过什么、搜过什么、AI 聊了什么"及全部离线图片。隐私模式（`store.js:142`）只改标题和遮罩，不清除这些数据。属隐私设计权衡，应向用户披露。
- **建议**：设置页提供"一键清空 AI 会话/历史"；可选对 `jmw_ai_sessions` 用 WebCrypto 加密；至少在隐私模式说明中披露数据仍明文保留。

#### SEC-20（低，审计 P3-15）export.js 使用 `document.write` 与保留 opener 弹窗（内容静态，低风险）（来源：P3-15；分析 5.2#1 已将其计入 4 处安全 sink 并确认固定字符串）

- **位置**：`export.js:243-249`（`window.open('', '_blank', 'noopener=false')` 后 `document.write` 静态骨架）、`export.js:48-65`（`safeFilename`/`safeZipPath` 路径清洗正确）。
- `noopener=false` 为保留编程访问所必需；写入内容 100% 静态/属性化，无注入路径。低风险，建议将来改 `replaceChildren` + DOM API 以移除 `document.write`（浏览器策略渐弃）。

#### SEC-21（低，审计 P3-21）翻译服务 `/healthz` 无认证泄露内部运行状态（来源：P3-21；同一端点的另一缺陷"健康检查不覆盖 OCR 失败"见 REL-07）

- **位置**：`service.py:464-466`（路由无 guard）、`service.py:317-332`（返回 workers/inflight/queued/processing/capacity/ocrLoaded/warmupError/pipelineVersion）。虽仅内网可达，但可帮助内网侦察者探测队列占用与 OCR 加载状态，配合 SEC-07 放大 DoS 时机选择。
- **建议**：healthz 仅返回 `{"ok": true}`，详细状态移到需认证的 `/v1/status`。

### 7.2 后端可靠性 / 性能 / 可维护性问题详情

#### REL-01（高）chapter-ai 综合症：无限流、无上限、匿名 DoS、OOM、同步写盘热路径、磁盘填满（来源：S2 + B1 + B2 + P2-1 四条合并——三份报告中两份均将其列为最高优先级）

**（a）enqueue 无限流、队列无上限 → AI 费用与资源耗尽【S2】**

- `server.js:2406-2411`：任何通过门禁的用户可无限次 enqueue 任意 `aid/photoId`（仅正则校验），无 `rateLimit`、无队列长度上限；
- `lib/chapter-ai.js:191-209`：enqueue 不设队列上限（审计复核：对新 key 无队列长度上限即 `push`，且无条件 sort+save）；`268-307`：`analyze` 下载整章图片（单章上限 2000 张 × 25MiB）逐张 base64 发给视觉模型；
- 场景：持口令用户（或无口令部署的任何人）脚本化 POST 随机 ID，持续消耗上游带宽与 AI 账单。
- AGENT.md 第 4.3/11 节已承认"访问口令不是 RBAC、需要独立 AI 配额"。

**（b）审计证据摘录【P2-1，已人工复核】**

```js
// server.js:2406 —— 对比 2413 行的 /ai/chat 有 rateLimit，此处没有
case '/chapter-ai/enqueue': {
  const body = await readJsonBody(req);
  const aid = String(body.aid || ''); const photoId = String(body.photoId || '');
  if (!/^\d{1,16}$/.test(aid) || !/^\d{1,16}$/.test(photoId)) return sendJson(res, 400, ...);
  return sendJson(res, 202, { data: chapterAi.enqueue(aid, photoId, ...) });

// lib/chapter-ai.js:191 —— 无队列长度上限
enqueue(aid, photoId, priority = 0, order = null) {
  ...
  this.state.queue.push({ key, aid, photoId, ... });
  ...
  this.state.queue.sort(...); this.save();   // save() = 全量 writeFileSync
```

- **匿名利用场景**：compose 默认 `ACCESS_PASSWORD` 为空时，任何匿名请求可循环 POST 不同 `aid/photoId`（只需匹配 `^\d{1,16}$`，无需真实存在）。每个新 key 入队一条（约 100-150B），`save()` 将整个 state 同步 JSON 序列化写盘：队列达千万条时每请求写百 MB 级文件，可同时达成 ① 512MB 容器 mem_limit OOM（队列驻留内存）、② data 卷磁盘填满、③ CPU 序列化放大。`/api/album?id=<随机数>` 同理每请求触发全量落盘。
- **影响**：匿名拒绝服务；磁盘填满可能连带破坏正常 Session/状态写入。

**（c）后台任务全章节图片内存累积，512MiB 容器 OOM 风险【B1】**

- `lib/chapter-ai.js:268-280`：`analyze()` 把整章每页图片转 JPEG base64 全部 push 进 `content` 数组，单次模型请求发送；
- `lib/chapter-ai.js:60-84`：`descramble()` 顺序累积最多 20 个 PNG 无损切片缓冲，再 composite 全尺寸 RGBA 画布；
- `server.js:186-194`：每页允许读入 `MAX_IMAGE_BYTES`=25MiB 原图；`docker-compose.yml` `mem_limit: 512m`，`CHAPTER_AI_CONCURRENCY: 1` 只是缓解。
- 场景：调度器（`server.js:197` 每 30s tick）自动分析 100–2000 页长章节 → N 页 ×（原图 + JPEG 重编码 + base64 1.33× 膨胀）+ 最终 `JSON.stringify` 再翻倍，几十页即可逼近 512MiB → OOMKilled，重启丢掉全部内存态（封面缓存、熔断状态、session LRU）。**无任何整章页数/字节上限约束。**

**（d）同步全量写 state.json 挂在 /album、/chapter 请求热路径上【B2】**

- `lib/chapter-ai.js:151`：`save()` = `mkdirSync + writeFileSync + renameSync` 全部同步、每次写整个 state（审计作 157 行）；
- `lib/chapter-ai.js:158-168`：`touchPopularity()` 每次调用即 `save()`；`129-145`：`records` 只增不减；
- `server.js:2049-2051`：`/api/album` 单次请求 1 次 touchPopularity + 对 series 每章节 enqueue；`server.js:2356`：`/chapter` 同样 enqueue。
- 场景：打开一个 500 章节的漫画详情页 → 单 HTTP 请求内 ~501 次同步全量写盘，事件循环反复阻塞，所有并发请求（图片代理、API）延迟抖动；records 无限增长后写放大持续恶化。

**修复建议（审计，三条闸门）**：

1. 给 `state.queue` 与 `state.records` 设硬上限（如 5000，超出拒绝或淘汰最低优先级）；
2. 为 `/chapter-ai/enqueue` 增加每 IP 固定窗口限流（复用现有 `rateLimit`）；
3. `touchPopularity` 改防抖/scheduleSave，`save()` 改为脏标记 + 定时批量落盘。

【多角度分析的对应建议】enqueue 限流 + 队列上限；`save()` 改 debounce 异步并从 `/album` 热路径移除（touchPopularity 不落盘或合并写）；加整章页数/字节预算，分析任务改为流式/分批发模型。（原句"这是当前唯一能把生产容器直接打挂的功能"属未经运行验证的量级判断，仅保留为原报告措辞记录【勘误措辞】）

#### REL-02（待定级）【新发现·已勘误 C01】未注册全局异常监听器（来源：B3）

- `server.js:2755-2758` 只注册了 SIGINT/SIGTERM；全仓库 grep 无 `process.on('unhandledRejection'/'uncaughtException')`（已抽验确认，`8eaf132` 仍如此）。
- 【勘误 C01】原报告将此评为"高危漏洞"，结论不成立：Node 20 默认 unhandled rejection 即进程退出，这是 fail-fast 的**安全默认**；无监听器 ≠ 已存在漏洞。正确方向：①逐一排查并修复具体遗漏的 Promise/回调错误处理（静态文件回调、未 await 的调用等）；②如需诊断可注册**不改变退出语义**的 monitor（记录后仍交给默认行为）；③禁止用仅打印日志、继续服务的监听器吞掉未知异常——那会把未知故障伪装成正常服务；致命错误保留非零退出及容器外部重启机制（`restart: unless-stopped` + 健康检查）。

#### REL-03（高）【新发现，分析两路独立发现】`/api/translation/page` 无超时、无并发闸、无限流（来源：B4；审计 P3-7 将该端点列入无每 IP 限流族——见 SEC-16，P3-22 的 Python 侧连接问题见 REL-10）

- `server.js:1766-1773、1809-1818`：两次上游 `fetch()` 只挂客户端断开信号，无 deadline；翻译容器假死时每请求最长挂 undici 默认 300s；
- `server.js:1755`：请求体 `readBody(req, 25MiB)` 全量驻留内存；该路由不在图片槽位、不在 AI/搜索限流内，也没有自己的 rateLimit。
- 场景：~20 个并发上传即超 512MiB 触发 OOMKill。这是全部出站路径中唯一没有准入控制的（图片 12/6、AI 4、搜索 8 都有）。

#### REL-04（中）【已知债 + 新细节】API Host 无跨请求熔断；429 语义两套不一致；文档滞后于实现（来源：B5；加载性能分析从连接复用角度独立复核同一债项，见 PERF-05）

- `lib/jm-api.js:55、57`：单域名 20s、总预算 35s；`482-511`：每请求按 hosts 逐条 DNS 校验 + fetch，无跨请求健康记录。会话内粘性已由 `jar.apiHost`（`server.js:1864-1880`）缓解，但新会话/匿名首页每次都从坏线路开始付 20s。AGENT.md §11 已承认。
- **新细节 1**：上游 429 在 API 路径落入通用 4xx 分支直接抛错、不换线不退避（`jm-api.js:634-638`），而图片路径把 429 归为可重试瞬态（`server.js:1316-1318`）——同仓库两套语义。
- **新细节 2（文档滞后）**：图片 Host 其实**已实现**跨请求指数退避熔断 + EWMA 健康打分 + 半开探测（`server.js:1294-1442`），比 AGENT.md §11"仍需补充跨请求熔断"的描述新。应更新文档并把该机制推广到 API Host。（合并时已复核 `server.js:1360-1440` 确认该实现存在，见第 3 节矛盾 #2。）

#### REL-05（中）【新发现】优雅退出不完整（来源：B6）

- `server.js:2745-2748`：`shuttingDown` 在退出入口被读取（`if (shuttingDown) return`），用于避免重复退出——**不是死变量**【勘误 C09：原报告"赋值后无任何读取"有误，已在 `8eaf132` 复核】。`server.close()` 自 Node 19 起已默认关闭空闲连接，"close 后 keep-alive 连接仍派发新请求"在 Node ≥20（本项目 engines 要求）不成立。真实待排查点：在途任务（图片流、chapter-ai 任务）的收口、退出前最终落盘（含 300ms debounce 写是否来得及 flush）、以及强制退出时限与 `stop_grace_period` 的匹配策略；不应为错误理由补 `closeIdleConnections()` 之类的重复调用。
- `lib/sessions.js:459-464`：`flushAll()` 对全部缓存 jar（上限 800）逐个同步 saveJar（每个含临时文件 + fsync + chmod + 目录 fsync），无脏标记。
- 场景：每次原子发布/滚动重启触发；800 个 session 串行 fsync 可阻塞数秒，drain 窗口内新写入的登录态可能丢失。`stop_grace_period: 10s` vs 3s 强杀（`server.js:2753`）。

#### REL-06（中）【新发现】lib/ 与 server.js 职责重叠、成片重复代码，威胁安全边界一致性（来源：B7）

- IP 安全判定整套重复：`lib/jm-api.js:63-117` vs `lib/settings.js:27-95`（约 100 行两份，改私网段需双处同步）；
- `cancelBody` 两份（`jm-api.js:361-365` / `server.js:930-932`）；超时信号组合器两份（`jm-api.js:367-386` / `server.js:904-928`）；有界流读取器三份（`jm-api.js:389-416` / `server.js:1112-1135` / `server.js:382-411`）；trace 计时三份；
- 图片 Host 熔断（`server.js:1294-1442`）与 JM API host 轮换（`jm-api.js:443-748`）是两套平行故障切换实现。
- 行为漂移已发生（REL-04 的 429 分歧即例证）。安全边界类代码（IP 判定）分叉风险最高。

#### REL-07（中）【新发现】翻译容器健康检查不覆盖 OCR 失败；OCR 串行与字形渲染低效（来源：B8；同一 healthz 端点的无认证泄露问题见 SEC-21）

- `translation-service-poc/service.py:317-332`：`health()` 的 `ok` 只看 `not self._closed`，warmup 失败仅记日志（`service.py:444-454`），compose healthcheck 只断言 HTTP 200 → OCR 挂了仍 healthy，所有翻译请求持续 `translation_failed`，只能人工看日志；
- `pipeline.py:344-351`：`_draw_glyph` 在循环内对每个候选字形每个尺寸重新 `ImageFont.truetype` 读字体文件，无缓存；
- `pipeline.py:401、436-439`：默认 `TRANSLATION_OCR_SERIAL=1` 以 `_ocr_call_lock` 串行化 OCR 调用。原文"workers=2 的第二线程被锁挡住，实际吞吐 =1"**未实测**【勘误 C14：串行锁只覆盖 OCR 调用，不等于整个翻译处理（渲染、编码、IO）都没有并行收益】。不要为增加吞吐直接移除线程安全锁；先分段测量 OCR/渲染/编码耗时并确认 OCR 实例的并发契约，再决定是否有可安全并行化的区段。
- 内存侧实现良好（20M 像素先验头、`arr.copy()` 60MB、job 字节处理完即置空、`_jobs` 4096 上限），2g 限额内安全。

#### REL-08（中）【新发现】server.js 单文件 2802 行、模块加载即副作用，可测试性差（来源：B9）

- `server.js:1834-2498`：`api()` 单函数约 660 行 switch，内嵌闭包捕获请求状态；`116-134`：模块级 20+ 可变全局；`136-197`：require 即构造 ChapterAiScheduler 并 `start()`、读 `.secret`、执行 session 迁移扫描；`server.js:2624`：`http.createServer` 在模块层执行。
- 佐证：`test/backend.test.js` 必须先设 `JMW_DATA_DIR` 再 require，且为隔离状态不得不用子进程 spawn——测试成本本身就是架构症状。

#### REL-09（低）可靠性次要问题（来源：B10 表；行 2 与审计 P3-7 的 `/api/search` 观察重叠——见 SEC-16，行 7 与 PERF-03 重叠）

| 项 | 证据 | 说明 |
| --- | --- | --- |
| 会话文件触顶后周期性同步全目录扫描 | `lib/sessions.js:438-439、511-561` | 文件数稳定在 2000 上限时每 25 次写触发一次最多 2000 文件的同步读+解析，数百 ms 级事件循环毛刺 |
| 公共 API 缓存 loader 固定 `signal:null` | `server.js:312-339、2034、2042、2083` 等 | 客户端断开不取消上游（最多 35s × 全部候选线路）；缓存仅按条数 256 上限，无字节护栏 |
| HTTP server 未显式配置 headersTimeout/requestTimeout/keepAliveTimeout/maxConnections | server.js 全文无 | 依赖 Node 默认，slowloris 类慢连接每条可占 60–300s；有边缘前置时影响有限 |
| 每出站请求至少一次 DNS 解析、无系统缓存层 | `jm-api.js:496-511`、`features.js:241-258` | 高并发图片代理时 getaddrinfo 池成隐藏串行点；仅 DoH 开启时有 60s 缓存 |
| 每 API 响应重复 Set-Cookie | `server.js:567-570` | 带宽小浪费 + 代理日志噪音 |
| 封面缓存边角：过期条目懒清理；single-flight 竞争失败时瞬时并发回源 | `server.js:811-823、1484-1496` | 有界非泄漏，内存仍受 64MiB 预算约束 |
| 首屏模块图 | `public/js/app.js:2-18` 静态 import 全部模块 | 约 551 KB 未压缩 JS + 91 KB CSS；AGENT.md §11 已承认，此处量化（详析见 PERF-03） |

#### REL-10（低，审计 P3-22）翻译服务缺少连接级限流与慢速上传超时（来源：P3-22；Node 代理侧对应问题见 REL-03）

- **位置**：`service.py:383-403`（`_read_limited` 只限字节数，无总时长限制）、`translation-service-poc/Dockerfile:30`（uvicorn 未配置 `--limit-concurrency`）、`service.py:494-501`（每 50ms 轮询的内联等待任务）。
- 内网攻击者可慢速 POST（每 30 秒 1 字节）长期占用连接；大量并发下轮询任务累积。缓解：`mem_limit: 2g`、`pids_limit: 256`、`max_inflight` 准入已存在。
- **建议**：uvicorn 加 `--limit-concurrency`（如 32）与 `--timeout-keep-alive`；`_read_limited` 加整体读取截止时间（如 60 秒）。

### 7.3 前端质量问题详情（public/）

#### FE-01（高）【新发现】下载管线网络请求无超时，任务可永久挂起（来源：F1）

- `public/js/downloads.js:86-101`：`fetchJson` 仅透传任务 signal，无 `AbortSignal.timeout`（对比 `public/js/api.js:13-16` 主封装有 60s 超时）；`reader.js:287-307` 的 `readerRequest` 同样只有手动 abort。
- 场景：`/api/album` 或 `/api/chapter` 挂起（服务端半死）时，任务停留在 fetching/downloading，UI 无超时提示；阅读器首图同理可能无限等待。

#### FE-02（高）【新发现】`task.errors` 无上限增长 + 每张图全量 JSON 序列化持久化（O(n²) 写放大）（来源：F2）

- `downloads.js:1019-1022`：每页失败 push 一条，永不截断（`resume` 时 `task.errors = []` 才清空，`downloads.js:610`）；
- `downloads.js:781-793`：每张图片完成后 `putDownloadTask`，内部 `offline.js:345` `JSON.parse(JSON.stringify(task))` 全量序列化（含完整 chapters 与 errors 数组）。
- 场景：2000 页章节几百页失败时，错误数组单调增长且每张后续图片全量重写任务对象，IndexedDB 写放大 + 记录膨胀。

#### FE-03（高）【新发现】`listOfflineImages` 一次性物化整章 Blob，多处全量调用造成内存峰值（来源：F3）

- `public/js/offline.js:311-316`：`index.getAll(key)` 无 count 限制；全量调用点：`downloads.js:1028`（下载完成校验）、`downloads.js:181`（断点判断）、`offline.js:330`（hasOfflineChapter）、`offline.js:618`（full 完整性检查）、`export.js:174-189`（导出）。
- 场景【勘误 C11：原表述"整章 Blob 同时驻留，移动端可达数百 MB 峰值"把"IDB 全量返回 Blob 对象"直接等同于"全部字节立即复制进 JS 堆"，结论过强——Blob 可由浏览器按引用/外部存储支撑，实际内存峰值取决于各调用点随后是否 `arrayBuffer()`/解码及 GC 时机，需实测（读取量、峰值、设备）】。可确定的问题是：全量查询把整章 Blob 对象一次性物化并遍历，缺少元数据级查询与 cursor 校验路径；与阅读器逐页 `getOfflineImage`（`reader.js:1121`）的谨慎风格形成反差。AGENT.md 第 5 节只规定了原图缓存预算，未覆盖此 IDB 全量读取路径。优化方向（元数据查询、分页 cursor、导出大小提示）保留，"必然数百 MB/OOM"降级为待实测。

#### FE-04（中）【新发现】两个性能热点：滚动 O(n) 遍历与 AI 流式全量重建（来源：F4）

- `reader.js:1896-1921`：滚动模式每个滚动 rAF 内 `querySelectorAll('.slot').forEach` 读全部槽位 `offsetTop/offsetHeight`——2000 页长条漫低端机掉帧；可二分或维护排序 offset 缓存（AGENT.md §11 已有类似记录，此处定位到具体实现）。
- `advanced.js:1359、1315-1333`：AI 流式回答每 delta `renderMessages()` 全量重建所有历史消息 DOM 并重解析全部 Markdown——长对话移动端明显卡顿。

#### FE-05（中）【新发现】门禁口令过期后无重新验证入口；JM 登录过期感知滞后（来源：F5）

- `app.js:401-407`：gate 仅在 boot 的 `/api/me` 401 时挂载一次；`app.js:123-131`：此后路由错误只显示"需要访问口令，请先完成验证"，无任何重新拉起 gate 的路径，必须手动刷新页面。（此半条基于 `1dd0697`，`8eaf132` 是否仍如此需独立复现）
- 【勘误 C12】原文"`api.js:29-34`：401 仅抛错；前端只在显式登录/登出时派发 `jmw-auth-changed`"**已过时**：`8eaf132` 的 `api.js` 已实现 API 层集中失效（`invalidateNavigation`，含 auth/unauthorized/source/host/favorites 分类）、认证世代保护（`identityEpoch`/`requestEpoch`，旧世代响应不回填）、401 自动触发 `unauthorized` 失效、跨标签 localStorage 广播失效元数据，收藏页已有 401 清理提示。剩余问题（门禁再次弹出的入口、顶栏旧头像是否残留、收藏报错文案）须在新基线上独立复现后再立项，不得沿用旧结论。

#### FE-06（中）【新发现】无 Web Locks 浏览器下的 aid claim 无限轮询（来源：F6）

- `downloads.js:820-829`（claim 失败 → sleep 400ms → run 结束）+ `768-776`（finally 再次 pump 重新选中同一任务）；每轮还伴随 180ms 广播等待（`downloads.js:350`）。
- 场景：Safari 旧版/WebView 无 `navigator.locks` 时，双标签下载同一漫画，非 owner 标签以 ~0.6s/次无限循环广播，永不放弃也不降级提示。

#### FE-07（中）【新发现】杂项硬伤（来源：F7；行 2 与审计排除清单 #19 的"零调用确认"互相印证——审计建议直接删除该选项）

| 项 | 证据 | 说明 |
| --- | --- | --- |
| ZIP 导出全量组装且无大小确认 | `export.js:92-171` | 逐条 `arrayBuffer()` 算 CRC（每项算完即丢，ArrayBuffer 未全部保留），随后把各条目 Blob 拼进一个总 Blob。"总内存 ≈ 整本漫画体积、移动端直接 OOM"未经实测【勘误 C11：Blob 拼接不必然把全部字节复制进 JS 堆】；真实缺陷是导出前无大小确认/提示（PDF 路径有 `confirmLargePdf`（download-view.js:47-55），ZIP 无），大库导出的实际峰值需测量后决定提示阈值 |
| `h()` 保留 `html:` → innerHTML 选项 | `ui.js:28` | 当前零调用（审计独立确认"全项目零调用者，建议删除"），但与 AGENT.md 第 6 节不变量直接冲突的公共 API，未来误用即破防 |
| toast 无 `role="status"`/`aria-live` | `ui.js:46-53` | 全站操作反馈对读屏用户完全无感（对比 pull-refresh 指示器有 aria） |
| localStorage 损坏时应用锁静默失效 | `store.js:62-69、75` | `jmw_setting` JSON 损坏时 readJSON 静默回退默认值 → `appLockEnabled` 无声变 false；跨标签损坏有保护，启动时损坏无提示 |
| 跨标签 enqueue 重复任务竞态 | `downloads.js:521-523、547-554` | 去重只查本页内存镜像，不复查 IDB；不损坏数据但产生重复任务记录 |
| 启动即实例化 DownloadManager | `downloads.js:1095、214-217` | 不用下载功能的访客每次打开页面都开 IDB、发 HELLO 广播、短暂持锁 |

#### FE-08（低）前端次要问题（来源：F8）

| 项 | 证据 | 说明 |
| --- | --- | --- |
| ~220 行死代码：旧离线阅读器双轨 | `offline.js:727-944`（写 `jmw_offline_history`）vs 实际使用的 `reader.js:2014-2032` | 维护误导 |
| `AbortSignal.any` 不可用时超时被静默丢弃 | `api.js:12-16` | Safari <17.4 请求无 60s 兜底 |
| `#restore` 遇单条损坏记录整体瘫痪 | `offline.js:39-43` + `downloads.js:461-463、493-496` | IDB 数据损坏/旧版本残留时下载功能整体不可用且无自愈 |
| 屏蔽词双实现不一致 | `store.js:200-213`（含 author）vs `content-filter.js:64-86`（不含） | 屏蔽词恰为作者名时两处结果分裂 |
| 收藏夹操作 `_r=${Date.now()}` 刷新路由 | `user.js:810-812` | 每次产生新 history entry，返回键需逐层退过 |
| onboarding 模态无 Escape/焦点陷阱 | `advanced.js:1672-1692` | 键盘用户焦点漂移 |
| 大量阻塞式 alert/confirm | `download-view.js:54、392、550`、`user.js:850` | UX 粗糙 |
| descramble Worker 空闲常驻 | `descramble.js:75-77、117` | 正常完成后不 terminate，占用不大但与资源释放不变量精神不符 |
| reader init 的 500ms setTimeout 未清理 | `reader.js:913-916` | 离开路由后空转一次 |

### 7.4 加载性能问题详情

#### PERF-01（P0 / A1）静态资源零压缩裸传（来源：A1）

**结论**：`server.js` 对 `/api/img` 上游响应做了解压（`lib/https-fetch.js:62-64` 的 `createGunzip/createInflate/createBrotliDecompress`），但对浏览器下载的静态资源没有任何压缩输出；`zlib` 全仓库无压缩方向的使用。

**证据**：

- `server.js:2507-2593` `serveStatic`：`fs.readFile` 读全量后 `res.end(buf)`，响应头只有 `Content-Type`/`Content-Length`/`Cache-Control: no-cache`/`ETag`，无 `Content-Encoding`，无按 `Accept-Encoding` 协商。
- `grep -n "zlib\|createGzip\|Accept-Encoding" server.js` 无匹配（zlib 仅存在于 `lib/https-fetch.js` 的解压路径）。

**影响**：约 676 KB 的 JS+CSS 裸传（见 6.2 压缩表），移动网络下首屏传输时间约为压缩后的 3.8 倍（逐文件压缩口径约 70.8% 节省）【勘误 C08：压缩减少的是传输字节；"SW Cache Storage 占约 3.7 倍存储"为同比例推断，实际存储体积需实测，且当前在线策略下 Cache Storage 存的是带正文的 200 响应】。公网路径可能由 Cloudflare 边缘补压缩，但直连/内网路径无任何压缩。

#### PERF-02（P0 / A2）无内容哈希 + immutable 分层缓存；SW 全量协商与全量重下（来源：A2）

**结论**：静态资源由文件名寻址且永不改名，导致缓存策略只能保守；三个症状同源。

**证据**：

- `server.js:2546`：所有静态文件 `Cache-Control: no-cache` + 弱 ETag（`server.js:2539`）。【勘误 C04：原文"每次导航每文件一次条件请求"不成立——Hash 路由内的视图切换不触发模块请求；条件协商只发生在页面重新加载/实际资源请求时，且浏览器对 304 的正常处理是与 HTTP 缓存合并（Fetch 得到带完整正文的缓存响应），代价是"每文件一次条件请求"而非重新下载正文。32 个 SHELL 条目也不等于每次页面加载都请求 32 项（SW/HTTP 缓存命中与模块图发现时机决定实际请求数）】。
- `public/sw.js:179`：在线时 `staticResponse` 用 `fetch(request, { cache: 'no-cache' })` 做条件协商。【勘误 C04：原文"`response.ok` 为假（304）才回退 SW 缓存副本"对正常流程的描述有误——正常 304 协商由浏览器 HTTP 缓存层合并，Fetch 返回的是带完整正文的缓存响应（ok 为真）；`response.ok === false` 的回退分支针对真实失败（404/5xx 等），不是 304 的恢复路径】。该策略是 sw.js:177-178 注释中为避免"cache-first 永久旧缓存"而有意选择的安全策略，在缺乏内容哈希的前提下是正确的。
- `public/sw.js:50`：precache 用 `fetch(url, { cache: 'reload' })`（绕过 HTTP 缓存全量下载）；`CACHE_VERSION`（sw.js:7）每次发版递增，install（sw.js:96-99）即全量重下 SHELL 文件（sw.js:8-41）。【基线漂移：`8eaf132` 为 `jmw-shell-v15`、SHELL 33 项】

**影响**：复访延迟与用户"上次访问"完全无关，永远等于一次全站协商 + 两次 API 串行；每次发版移动端多耗约 676 KB 流量（压缩后约 180 KB）。AGENT.md 第 11 节已将"静态资源尚无内容哈希和长期 immutable 缓存"列为运维技术债，与本次核实一致。

#### PERF-03（P1 / A3）首屏 JS 全量加载，无路由级分割、无 modulepreload（来源：A3；多角度分析 B10 行 7 重复发现并量化为 ~551 KB——两组证据均保留）

**证据**：

- `public/js/app.js:2-19` 静态导入全部路由模块。【勘误 C06：原文"最大的 `advanced.js` 在首屏既不渲染也无初始化依赖"有误——`8eaf132` 的 `advanced.js` 导出 `prepareAdvancedRuntime`/`isLocalAppLocked` 等**启动期运行时**：`boot()` 在任何网络探测前调用 `prepareAdvancedRuntime()` 并依据 `isLocalAppLocked()` 先显示本地锁屏（app.js:396-401），本地应用锁、隐私监听及延迟自动任务都在启动路径上。因此不能把 advanced 整模块改成仅路由加载；若要拆分，先提取轻量启动运行时（锁 + 监听 + 延迟任务），保留"锁屏先于网络与业务任务"的顺序，剩余部分再路由化】
- `public/index.html` 仅引用两个阻塞 CSS 与两个 script，无任何资源提示。

**影响**：首屏下载/解析/执行约 552 KB JS（未压缩；压缩后约 150 KB）。中端手机解析执行 500 KB 级 JS 需数百毫秒至秒级；这是首访 TTI 的主要组成。AGENT.md 第 11 节已注明"路由级动态导入需单独设计应用锁和 SW 升级兼容"。

**关联**：`gate.js` 已经是动态 import 先例（app.js:405），说明动态化模式可行；主要风险在 SW SHELL 与模块加载时序的兼容设计。

#### PERF-04（P1 / A4）启动串行探测与重复请求（来源：A4）

**证据**：

- `public/js/app.js:391-421` `boot()`：`mountShell()` 先挂载外壳，随后 `await fetch('/api/me')`（AbortController 8 s 上限），401 则弹门禁，否则才 `startApplication()`。被阻塞的是路由内容渲染与首页数据（外壳已显示，并非白屏）；网络故障时最多等 8 s 才进入应用（虽有 catch 兜底，但等待本身发生）。
- `public/js/app.js:385-393、424-441`：`startApplication()` 同步先后调用 `render()`（触发 `/api/home`）与 `refreshAvatar()`（又一次 `/api/me`），二者并行执行；探测结果未被复用导致重复请求一次。

**影响**【勘误 C07：原文"首屏数据 = `/api/me`（探测）→ `/api/me`（头像）→ `/api/home` 三个串行往返"有误——当前代码探测通过后，首页请求与头像 `/api/me` 是并行的，串行的只有门禁探测一跳；外壳也已在探测前挂载】。真实收益：复用探测结果可消除一次重复 `/api/me` 请求；不能把收益写成"必然减少两个首屏串行 RTT"。高 RTT 网络下每省一个串行往返约省 100-500 ms。

#### PERF-05（P1 / A5）上游 API 缺跨会话线路健康管理；连接复用率未实测（来源：A5；多角度分析 B5 从"熔断缺失"角度重复发现同一债项——见 REL-04；标题已按 C03 勘误）

**证据**：

- `lib/jm-api.js:464-540` `call`：每次请求都 `for (let i = 0; i < list.length; i++)` 从候选列表第一个开始顺序尝试。【勘误 C03：原文"无跨请求的上次成功线路记忆"不完全成立——会话级已有 `jar.apiHost` 成功线路记忆（`server.js:1864-1880` 一带，REL-04 亦已记录），缺的是**跨会话/进程级健康管理**（失败计数、熔断、成功线路提升），新会话/匿名请求仍会从坏线路开始付等待】。首条线路劣化时，无历史健康信息的新请求重复支付首线路失败等待再切换（AGENT.md 第 11 节已知债）。
- `lib/https-fetch.js:170-182`：`https.request({...})` 未传 `agent`，使用 Node 默认 globalAgent。【勘误 C03：原文"keep-alive 空闲窗口约 1 s（keepAliveMsecs 默认 1000 ms）…实际每个请求重付 DNS+TCP+TLS"不成立——`keepAliveMsecs` 是 TCP 保活探测初始延迟而非空闲寿命；Node 19 起默认 HTTPS Agent 已启用 keep-alive（默认 timeout 5 秒）。复用率必须以 trace 的 `reused_socket` 字段（https-fetch.js:233-243）实测，未见汇总前不能断言"近乎不复用"】。

**影响**：每个上游 API 请求的 TTFB 中，握手可能占 100-500 ms（视线路 RTT）；坏首线路时整体放大为每请求双重等待。这是"漫画慢"感知的最直接后端因素之一。

#### PERF-06（P2 / A6）首页一次性全量渲染（来源：A6；多角度分析 §8 对照表以"现状可控"口径复核同一债项）

**证据**：`public/js/views.js:51-181` `homeView.loadHome`：数据到达后 `content.replaceChildren()`（views.js:133 一带）一次性 append 全部 block 的全部卡片；推荐位（`getPreferenceRecommendations`）异步到达后再追加一批。无分帧、无虚拟化、无 `content-visibility`。

**影响**：首页返回内容多时（连载更新 + 多个板块 + 推荐），一次性构造数百个 DOM 节点在低端机形成长任务，阻塞主线程并推迟可交互时间。AGENT.md 第 11 节"首页一次创建大量卡片"与本次核实一致；封面网络侧已有 IntersectionObserver + 有界队列控制（`ui.js:81-82,200`），瓶颈在 DOM 构造而非图片。

#### PERF-07（P2 / A7）CSS 渲染阻塞且未按视图拆分（来源：A7）

**证据**：`public/index.html:11-12` head 中 `/css/app.css`（91 KB）与 `/css/favorites.css`（11.8 KB）均为渲染阻塞资源；`favorites.css` 服务收藏视图样式却全站加载；`offline.css`（11.8 KB）未在入口引用（按需，合理）。

**影响**：首屏渲染被 103 KB 未压缩 CSS 阻塞（gzip 后约 23 KB，绝对量小于 JS，故列 P2）；收藏样式对非收藏页面是纯开销。

#### PERF-08（P3 / A8）加载链路分段可观测性缺失（来源：A8）

**证据**：`lib/https-fetch.js` 的 `jmwTrace` 已采集 `connect_ms/tls_ms/ttfb_ms/upstream_ms/reused_socket/attempts` 等字段，但无汇总输出与留存；AGENT.md 第 11 节运维债明确指出"应分段测 DNS、connect、TLS、TTFB、total 和连接复用"。

**影响**：本报告中多项收益估算（A1/A4/A5）只能来自推理；无基线就无法验证整改效果，也无法回答"漫画慢到底慢在哪一段"。

### 7.5 测试 / CI / 部署 / 供应链问题详情

#### DEL-01（高）【新发现，多角度分析列为最优先】CI 无依赖安装步骤，`npm test` 在干净 runner 上必然失败（来源：D1；合并时已再次验证 workflow 仍只有 setup-node + npm test）

- `.github/workflows/docker-publish.yml:27-33`：只有 setup-node 后直接 `npm test`；全文件 grep 仅 `npm test`（33）与 `npm run check`（36），无 `npm ci`/`npm install`，也无 npm cache 配置（已抽验确认）。
- 而 `test/chapter-ai.test.js:7` 顶层 `require('sharp')`；`test/backend.test.js:71` require `../server` → `server.js:45` → `lib/chapter-ai.js:8` 顶层 `require('sharp')`。npm run 不会自动安装依赖 → test:unit 第 14 个文件和整个 test:backend 都会 `MODULE_NOT_FOUND`。
- git 历史显示 sharp 随 chapter-ai 提交引入后 workflow 未补依赖安装。
- 影响【勘误 C13】：干净 runner 上 `npm test` 必然失败 → publish 从依赖它的那次提交起持续被阻断（或仓库从未在 CI 绿过、发布路径长期不可用）。注意方向：**publish job 依赖测试成功，测试失败是阻止发布**，不等于不安全镜像已越过门禁发布。修复含两步：补 `npm ci` 之后，还须修好既有测试失败（本机 Windows 基线：reader-performance 断言、deployment POSIX 位），门禁才真正恢复。

#### DEL-02（高）【新发现】README 宣称"零运行时依赖、无需 npm install"，与 sharp 依赖直接矛盾（来源：D2）

- `README.md:40`（"零运行时依赖，无需 `npm install`"）、`README.md:45`（`node server.js` 直接跑）、`README.md:280、291`（"零依赖 Node.js"）vs `package.json:21`（dependencies: sharp）+ `lib/chapter-ai.js:8`（顶层加载，非懒加载）（已抽验确认）。
- `AGENT.md:37` 已如实记录，但 README 的"方式一：直接运行（推荐）"未更新。新用户按推荐路径启动直接崩溃。

#### DEL-03（高）【新发现】发布制品校验脚本黑名单存在盲区（来源：D3）

- `scripts/validate-release-artifact.sh:59-73`：仅封目录名（`.git/data/test/tests/node_modules/__pycache__/.pytest_cache/cache`）、`.env`/`.env.*`（除 example）、`*.log|*.secret|*.jsonl` 后缀。
- 漏网：`sessions/` 目录（AGENT.md:295 明令禁止生产 Session 进制品，但目录名不在黑名单）、`*.pem`/`*.key`/`id_rsa`/`*.sql`/`*.zip`/`*.tar`、非点前缀 `prod.env`；"白名单"只查必需文件存在（33-45），清单外多余文件（整个 `.github/`、任意压缩包）不报警。
- 影响：包含生产会话或密钥备份的制品可通过 `RELEASE-MANIFEST: PASS`，与 AGENT.md 第 9 节禁止清单不匹配。

#### DEL-04（中）【新发现】CI 矩阵与门禁缺口；一个无效安全断言（来源：D4）

- 仅 ubuntu-latest + 单 Node 22.23.2（`docker-publish.yml:22、30`）；`engines: >=20` 从未在 20.x 测过；无 Windows/macOS（开发环境是 Windows）。
- 无镜像漏洞扫描（trivy/grype）即推送 GHCR；无 Dependabot/Renovate。
- AGENT.md:308-311 要求的组合校验 `docker compose --env-file .env.example -f docker-compose.yml -f docker-compose.ghcr.yml config --quiet` 未进 CI，只跑了单文件校验（`docker-publish.yml:39`）——`!reset` 语法（compose v2.24+，`docker-compose.ghcr.yml:7、11`）回归只能靠本地自觉。
- `test/deployment.test.js:149-154`："生产路径阻断"测试对 `/srv/jm-web/../jm-web` 断言 `/目录不存在|生产路径|exited with/` 任一即过——该路径在 CI 上根本不存在，必以"目录不存在"失败，**删掉 validate-release-artifact.sh:22-31 的安全 case 块测试照样通过**，该安全逻辑实际零覆盖。

#### DEL-05（中）【新发现】翻译代理与 SW 升级路径零自动化测试（来源：D5）

- `/api/translation/page`（`server.js:1740-1800`）：token 转发（1730-1732）、query 白名单、2MiB 响应上限（1781）、429/5xx 状态映射（1783-1790）、415/503/412 分支，backend.test.js 无任何用例——token 是否真的不泄露给浏览器、透传是否正确无回归保护。
- `public/sw.js:101-114`：activate 清理旧缓存、SKIP_WAITING/PRECACHE_SHELL/CLEAR_SHELL_CACHE 消息处理，`service-worker.test.js` harness 只驱动 fetch listener 与 precache()（82-116）；AGENT.md:328 明确要求的"升级保留缓存"回归只有手工流程。

#### DEL-06（中，审计 P3-18）翻译服务基础镜像与 Python 依赖均未固定版本（来源：P3-18 + D6 第 2、3 点合并）

- **位置**：`translation-service-poc/Dockerfile:1`（`FROM python:3.12-slim`，浮动 minor 标签，未锁 digest）、`requirements.txt:1-10`（全部范围版本）。对比主 Dockerfile 至少锁到 `node:22.23.2-alpine3.24`。
- 【分析角度补充】全部 `>=x,<y` 范围、无 lock、无 hash，构建不可复现；`PYPI_INDEX_URL` 构建参数可整体替换源——与 npm 侧 lockfile+sha512 纪律形成反差。`deployment.test.js:26` 只断言 Node 镜像钉住，Python 侧无断言。
- **建议**：锁 digest；生成 requirements 锁文件（`pip compile` + `--require-hashes`）。

#### DEL-07（中，审计 P2-4）GHCR 部署默认使用可变 `latest` 标签，未固定 digest（来源：P2-4）

- **位置**：`docker-compose.ghcr.yml:6,9` 及文件头注释（部署命令 `--pull always`）；CI 侧 `.github/workflows/docker-publish.yml:136` 有 `type=sha` 标签但部署侧未使用。
- **证据**（已人工复核）：

  ```yaml
  image: "${TRANSLATION_IMAGE:-ghcr.io/shixian64/jm-web-translation:latest}"
  image: "${JMW_IMAGE:-ghcr.io/shixian64/jm-web:latest}"
  ```

- **利用场景**：`latest` 为可变标签。一旦 GHCR 包权限被接管、CI 被攻破或标签被恶意重推，`--pull always` 会让服务器在下次拉取时自动运行被替换的镜像。AGENT.md 第 9 节要求生产记录镜像 digest，但预构建部署路径本身没有强制。
- **修复建议**：部署清单默认值改为不可变 digest（`ghcr.io/...@sha256:<digest>`）或 `type=sha` 版本标签；`latest` 仅作回退并在文档标注风险。

#### DEL-08（中，审计 P3-16 + P3-25）CI 全部第三方 action 仅按 tag 引用未固定 SHA；CI 测试步骤从 PyPI 拉取未固定包（来源：P3-16 + P3-25，审计自述"同源可合并处理"）

- **P3-16 位置**：`.github/workflows/docker-publish.yml:25,28,42,47,59,100,103,106,116,124,144`（`actions/checkout@v4`、`docker/build-push-action@v6` 等 11 处）。
- **P3-16 分析**：上游 action tag 被移动（账号被盗或维护者恶意）时，publish job 持有 `packages: write`，恶意代码可篡改发布镜像——被多次真实利用的供应链路径。**建议**：所有 `uses:` 固定完整 commit SHA，启用 Dependabot/renovate 自动更新 SHA。
- **P3-25 位置**：`docker-publish.yml:71-75`（容器内 `pip install --user "pytest>=8,<9" "httpx>=0.27,<1"`）。测试期依赖落入范围即安装，属 CI 供应链面（不直接影响发布镜像，但可篡改测试结果）。与 P3-16 同源，可合并处理。

#### DEL-09（低，审计 P3-17）publish job 的 `id-token: write` 权限多余（来源：P3-17）

- **位置**：`docker-publish.yml:93-97`。workflow 无 cosign/keyless 签名步骤；`provenance: mode=max` 与 `sbom: true` 由 BuildKit 生成，不需要 OIDC token。与 DEL-08（P3-16）叠加时可放大危害。**建议**：删除 `id-token: write`；无对应推送步骤的 `attestations: write` 一并复核。

#### DEL-10（低，审计 P3-19）翻译镜像构建参数可注入 sed 表达式 / 替换 PyPI 源（来源：P3-19）

- **位置**：`translation-service-poc/Dockerfile:11,18`：

  ```dockerfile
  RUN sed -i "s|deb.debian.org|${DEBIAN_MIRROR_HOST}|g" /etc/apt/sources.list.d/debian.sources
  RUN pip install --no-cache-dir --index-url "${PYPI_INDEX_URL}" -r requirements.txt
  ```

- **分析**：`DEBIAN_MIRROR_HOST` 含 `|` 即可注入额外 sed 命令；`PYPI_INDEX_URL` 指向恶意 index 可在 build 阶段以 root 执行恶意包安装脚本。缓解：这两个 build arg 仅由本地构建者经 `.env` 控制（CI 未传 args），构建者本就控制构建产物，故 P3；若未来 CI 接受外部输入（如 workflow_dispatch inputs）则风险升级。
- **建议**：build arg 格式白名单校验（如 `^(https://|[A-Za-z0-9.-]+)$`），CI 中禁止外部传入。

#### DEL-11（低）`npm ci --ignore-scripts=false` 以 root 运行允许依赖生命周期脚本（来源：P3-20 + D7 行 8 合并）

- **位置**：`Dockerfile:10`（第 29 行才 `USER node`）。显式允许 install scripts 是因 `sharp` 需下载预编译二进制；代价是构建期间任何传递依赖的 postinstall 能以 root 在构建容器执行任意代码。
- 【分析角度】sharp 0.33 走预编译二进制本可 `--ignore-scripts`，轻微扩大供应链面。
- **建议**：维持 lockfile 审计（`npm audit` / lockfile diff 审查），或改用 sharp 预构建镜像层。

#### DEL-12（低，审计 P3-24）主镜像基础标签已锁补丁版本但未锁 digest（来源：P3-24）

- **位置**：`Dockerfile:1`（`ARG NODE_IMAGE=node:22.23.2-alpine3.24`）；`.env.example:4-5` 仅以注释建议 digest 格式，CI 未实施。CI 每次发布重建镜像时该标签内容可变。
- **建议**：publish job 以 digest 形式传入 `NODE_IMAGE` build-arg。

#### DEL-13（低）交付/部署次要问题（来源：D7 其余行）

| 项 | 证据 | 说明 |
| --- | --- | --- |
| 部署测试是"文本正则"型 | `deployment.test.js:46-59`（精确缩进/引号）、`38`（匹配 server.js 源码原文）、`translation-deployment.test.js:9-10`（split 切 compose） | YAML 重排/重构即碎；证明的是"文件里有这行字"而非行为 |
| 本地门禁不可移植到 Windows | `deployment.test.js:108` | `execFileSync(.sh)` 在 win32 无 sh 关联时抛错；开发环境即 Windows，CI 是 ubuntu 所以不暴露 |
| `validate:artifact` 未接入 CI | `package.json:13` | 发布流程靠人工纪律 |
| `test/check.js` 只是 `node --check` + CSS 花括号计数 | — | 无真正 lint |
| `cancel-in-progress: true` 对 main 连续推送 | `docker-publish.yml:15-17` | 会取消进行中的 publish |
| `TRANSLATION_OCR_SERIAL` 未列入 .env.example/compose | `pipeline.py:401` | 配置漂移（其余 36 个 `process.env.*` 键全部有对应，无缺漏无过期键；资源默认值与 AGENT.md:145-147、README:107 三方一致） |
| tmpfs /tmp 仅 16m | `docker-compose.yml:74` | sharp/libvips 处理长条图溢出内存时落盘临时文件，整章串行解码可能不够 |
| GPL-3.0 与内容合规 | — | GPL-3.0 与 sharp/libvips 的 LGPL-3.0 兼容；项目代理上游受版权保护内容，公开镜像不转移内容合规责任，README:9 已有免责声明 |

---

## 8. 已验证无问题合并清单（三份排除/良好清单去重合并）

以下各项经至少一份报告独立核查确认实现正确，整改时**不得以"简化"名义破坏**（与 AGENT.md 第 5/6 节不变量一致）。来源标注：◎=多角度分析、●=安全审计、◆=加载性能分析；多标即多份重复确认。

### 8.1 门禁与会话

1. ◎● **口令比较时序**：`checkPassword`/`checkAccess` 均先 SHA-256（定长）再 `crypto.timingSafeEqual`（`server.js:449-453, 600-611`），无长度/内容时序泄露；`authToken` 单向哈希含 256 位服务器秘密，Cookie 泄露无法离线爆破口令。
2. ● **门禁绕过面**：门禁前可达的仅 `/healthz`（固定 `{"ok":true}`）与 `/api/auth`（登录本身）；其余全部 `/api/*`（含 `/api/img`、`/api/config`、`/api/logs`）在 `server.js:2700-2702` 统一过 `checkAccess`。客户端跳过 gate.js 只能得到空壳界面 + 全量 401（`app.js:399-413` 每次启动重新探测）。
3. ● **Cookie 伪造**：`jmw_auth` = `sha256(随机32字节secret + 口令)`，secret 持久化于 `data/.secret`（0600）；`jmw_sid` 客户端值须匹配 `^[a-f0-9]{32}$` 才被加载（`lib/sessions.js:377-381`）。【勘误 C15：原文"无 fixation"为绝对化结论——sid 格式校验只保证形态合法，不能证明不存在会话固定；是否存在 fixation 取决于攻击者能否向受害者注入有效既存 sid、登录时是否轮换 sid 等条件。条件性风险描述见 SEC-10】
4. ◎● **会话文件安全**：128-bit `crypto.randomBytes` sid（`sessions.js:340-342`）；目录 0700、文件 0600、O_EXCL+O_NOFOLLOW 原子写、symlink 拒绝、sid 正则杜绝路径注入（`sessions.js:18-21、201-237、297-298、378`）；登出清内存+删文件+`Max-Age=0`（`server.js:2014-2017`）；磁盘/内存均有上限与 prune。
5. ◎● **上游凭据隔离**：上游 Set-Cookie 仅写入受信 `cookieHosts` 精确 origin 的服务端 jar，从不透传浏览器；仅发往白名单 origin（`jm-api.js:467-469、516-520`）；登录 `data.s` 只写实际成功 origin（`server.js:1996-2011`）；401 恢复只在已持有 AVS 的受信 origin 间（`jm-api.js:519、611-617`）；`/api/me` 只返回脱敏 user（`server.js:1975`），`sanitizeUser` 剥离 `s/jwttoken/token/cookie`（`lib/sessions.js:39-42, 79-102`）；启动迁移 + 加载时二次清洗（`sessions.js:278-338、386-391`）；JM 密码仅存在于登录表单内存，不落盘（`user.js:376-410`）。
6. ◎ **POST 非幂等不盲目重放**：`requestNeverSent` 仅认确定未送达错误码（`jm-api.js:321-359`）；AggregateError 需全部子项为 connect 失败；5xx/超时/解密失败的 POST 不换线重发（`jm-api.js:590-595、642-656`）；未发现"未确定未送达即重发"。
7. ◎ **无口令模式运维端点 fail-closed**：仅直接 TCP 回环 + 回环 Host + 无转发头 + 同源浏览器上下文（`server.js:647-656`），测试覆盖。

### 8.2 SSRF 与出站请求

8. ◎● **SSRF 主链路完整**：所有用户可达出站（JM API、图片代理、DoH、AI、搜索、更新检查）都经 `features.outboundFetch → publicHttpsFetch`：`assertPublicUrl` 对全部 A/AAAA 做私网拒绝（`jm-api.js:154-190`；审计：覆盖完整私网段 + 本地 hostname 黑名单），`pinnedLookup` 把已验证地址集固定给真实 TLS socket 并校验主机名（`features.js:207-239`）——**TOCTOU 已正确消除**；`autoSelectFamily` 只在预验证地址间选择（`https-fetch.js:26-45`）；TLS 强制、证书校验无关闭开关。
9. ◎● **重定向逐跳校验**：图片代理 manual + 每跳白名单 + assertPublicUrl（`server.js:1039-1093`，≤4 跳）；JM API 3xx 一律报错不跟随且 POST 不重放（`jm-api.js:583-589`）；AI/搜索/DoH/更新检查全部 `redirect: 'error'`（`features.js:280、383、466`）。
10. ● **图片白名单**：绝对 URL 必须 HTTPS + 无 userinfo + 精确 origin 白名单（子域/`@`/十进制 IP/query 拼接均无法绕过）；学习型新域名受 `isKnownImageHost` 正则与 12 个上限约束（`lib/settings.js:126-140`）。
11. ● **出站主机来源**：DoH/SearXNG/AI/更新检查/翻译的出站主机均来自 env 或固定常量，浏览器输入只进 query 参数（`URLSearchParams` 编码）；翻译结果 URL 限定 service origin + `^/v1/results/[0-9a-f]{64}\.webp$`（`server.js:1801-1808`，分析作 1805-1808）；更新检查 repo 经 `^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$` 校验 + GitHub host 精确匹配（`lib/features.js:600-652`）。

### 8.3 输入处理与注入

12. ◎● **静态文件遍历**：`decodeURIComponent` → NUL 拒绝 → `path.normalize` → 带 `path.sep` 前缀校验（`server.js:2502-2592`）；`..%5C`、`%2e%2e/`、`/data/settings.json`、`/.env`、`/server.js` 等载荷均落在 403/404；无目录列表；`data/`、`test/`、`.env` 均在 public 前缀之外。
13. ◎● **请求体基线**：`API_METHODS` 方法白名单；默认 1MB 上限、413 后继续 drain 保住 keep-alive（`server.js:382-411`）；Content-Type 必须 JSON（415）；非对象/原型异常 JSON 拒绝；深嵌套 `JSON.parse` 的 RangeError 转 400；顶层必须是普通对象（`server.js:199-239、413-421`）。
14. ◎ **缓存键防投毒**：封面缓存路径拒绝原始/编码点段（`server.js:956-974`）；`/api/img` 在门禁开启时同样要求 `jmw_auth`（`server.js:2700`）。
15. ● **ReDoS**：`lib/photo.js` 为逐字符线性状态机（花括号平衡+字符串感知），无嵌套量词；搜索解析正则为有界惰性匹配，输入上限 3MB，未发现灾难性回溯结构。
16. ● **Python 服务注入面**：token 比较用 `hmac.compare_digest`；缓存键/结果路径强制 64 位十六进制、job_id 强制 32 位十六进制——无路径遍历、无任意文件读写；OCR 输入纯内存处理；输出经 `NamedTemporaryFile` + `os.replace` 原子写入固定目录；无 `subprocess`/`eval`/`exec`/`pickle`（grep 全量确认）；PIL 解码炸弹防护（先 header 检查再 `load()`，捕获 `DecompressionBombError`，pipeline.py:465-478）；metadata 白名单正则 `[\w.:-]{1,128}`。

### 8.4 CSRF / CORS / 响应头

17. ◎● **CORS 零放宽**：全仓库无 `Access-Control-Allow-*`（不回显 Origin）；Cookie `HttpOnly + SameSite=Lax + host-only`。
    **【矛盾标注】**● 审计排除 #15 另声称"非幂等接口全部要求 application/json body"——该声明对 `/api/favorite`、`/api/like`、`/api/logout` 三个 query-POST 端点**不成立**（见 SEC-01 与第 3 节矛盾 #1），CSRF 不能视为已排除；对其余 JSON body 端点该防线确实存在。
18. ◎● **安全响应头/缓存语义**：`X-Content-Type-Options: nosniff` 全局；HTML CSP 含 `frame-ancestors 'none'`、`object-src 'none'`、`base-uri 'self'`（`server.js:280-292`）；`/api/*` 全部 `no-store`；开启口令时 `/api/img` 与翻译结果均为 `Cache-Control: private`（`server.js:1170-1174`），图片响应保持 `private` 缓存语义符合第 5 节不变量。

### 8.5 限流与 DoS 基线

19. ◎● **限流与资源控制基线**：auth/login 10/5min/IP、AI 30/5min/IP + 全局 60、AI 搜索 20/5min + 全局 120、DoH 测试 10/5min；图片代理全局 12/每客户端 6 并发上限、等待队列上限与超时、缓存字节/TTL 双限（封面 64 MiB/24h）、背压、熔断负缓存（`server.js:704-793` 等）；所有出站响应体按实际解压字节硬限（API 16MB / 图片 25MB / 搜索 3MB / AI 流 16MB / DoH 128KB）；slowloris 由 Node 20+ 默认 `headersTimeout`/`requestTimeout` 兜底。（共享桶退化风险与端点缺口见 SEC-03/SEC-16。）

### 8.6 日志与信息泄露

20. ◎● **日志不泄密 / 5xx 不回显**：API 访问日志只记 pathname 不含 query（`server.js:2653-2659/2660`）；图片失败日志只记 `error_type/error_code` 不含 Error message（`server.js:1448-1463/1464`）；`ApiError.expose` 默认仅 4xx（`jm-api.js:305-319`）；未标记 500 统一文案（`server.js:2710-2715`）；均有测试锁定（backend.test.js:678 起、1165-1178）；后台任务（chapter-ai 的 discover/fetchChapter/fetchImage）全部复用同一套白名单 + SSRF 校验。

### 8.7 可靠性基线（◎多角度分析）

21. **图片并发/队列记账无泄漏**：槽位释放走路由 finally（`server.js:2381-2386`）；waiter 有超时、abort 监听移除、按客户端 1/4 队列配额（`server.js:728-793`）。
22. **背压与客户端断开链路完整**：`waitForDrain` + write false 即暂停（`server.js:1137-1167`）；`bindClientAbort` → 上游 reader.cancel + socket 销毁（`https-fetch.js:112-127`）。
23. **超时体系基本完整**：图片 30s 总预算/单跳 min(8s, remaining)、API 20s/35s、AI 120s、搜索 35s、DoH 8s；per-attempt 的 linked signal 覆盖到响应体读完。唯一缺口即 REL-03 与入站默认值。
24. **运行日志有界**：内存环形 1000 条、不落盘（`features.js:28-29、124-130`）；stdout 由 compose json-file 10m×3 轮转约束。

### 8.8 前端专项

25. ◎● **XSS 面干净**：全仓 `innerHTML`/`document.write` 共 4 处 sink——`icons.js:58`（静态图标注册表）、`ui.js:28`（`h()` 的 `html` 键，**全项目零调用**，●审计建议删除，◎分析列为问题 FE-07 行 2）、`ui.js:48`（toast 清空后走 createTextNode）、`export.js:246`（固定字符串，●另列为低风险发现 P3-15/SEC-20）。●审计口径为"innerHTML 仅 3 处"，document.write 单列，实质一致（见第 3 节矛盾 #3）。上游评论经白名单降级纯文本（`api.js:113-130`）；头像/封面强制收敛到同源 `/api/img` + `encodeURIComponent`（`api.js:140-199`）——不可能注入 `javascript:`/`data:`，阅读器章节图双重约束（强制 https + 拒绝 userinfo + blob MIME 白名单）；title/alt/href/style 走 setAttribute 或 CSSOM；事件属性全为代码内函数；`insertAdjacentHTML/outerHTML/srcdoc/eval/new Function/setTimeout(string)` 均不存在；AI Markdown 渲染器纯 DOM API、链接强制 http/https、图片语法降级为文本链接；无 iframe、无 `message` 监听、无 `document.domain`。**无可达注入路径。**
26. ◎ **路由生命周期纪律严格**：各异步视图普遍实现 loadSeq + AbortController + isInactive 三件套；`/read`、`/offline`、`/downloads` 由自身 destroy() 等价兜底（`reader.js:779-824` 全量释放）。未发现真实泄漏（除空闲 Worker，见 FE-08）。
27. ◎ **图片生命周期达标**：raw LRU 按设备内存 48-128MiB 预算（`reader.js:25-35`）；解码并发按 deviceMemory 限制；decoded 严格窗口淘汰 + ObjectURL 延迟回收 + destroy 全量 revoke（`reader.js:1502-1519`）；首图不等专辑元数据（`reader.js:920-923`）；离开首页后封面不再回源。
28. ◎ **sw.js SHELL 与磁盘完全一致**：逐文件比对无漏更新（原基线 32 项；`8eaf132` 为 33 项）；`CACHE_VERSION`（原 v14；`8eaf132` 为 v15）手动 bump 有测试守护；原子预缓存 + activate 清理旧版本 + 导航 network-first 失败回退。network-first 无内容哈希属 AGENT.md §6 已知债（代价分析见 PERF-02，并受 C04 勘误约束）。
29. ◎ **锁协议设计缜密**：library shared/exclusive + per-aid exclusive 层级 + BroadcastChannel/storage 双通道 + HELLO/ACK/SUSPEND/RELEASE 协议 + owner 心跳 + ifAvailable 探测降级 paused；restore 与 clearAll 同序防复活。缺口仅 FE-06/FE-07 所列。
30. ◎ **移动端不变量已落实**：100dvh/safe-area 覆盖到位；`overflow-x: clip` + 横条局部滚动；门禁/锁屏/空搜索页无自动聚焦；剪贴板只在真实 paste 与显式按钮读取（●补充：且跳过密码字段；全部 5 处 `target="_blank"` 外链带 `rel="noopener noreferrer"`；CSS 无 `@import`/`expression()`/远程 `url()`；`index.html:8` 有 `<meta name="referrer" content="no-referrer">`）。
31. ◎ **阅读器键盘导航完备**（`reader.js:1924-1974`）；gate/锁屏/抽屉/设置面板均有焦点陷阱与 inert。
32. ● **SW 与存储安全**：`sw.js:195` 明确排除 `/api/*` 与 `/healthz`，不缓存任何 API/图片代理响应；版本化缓存 + staging 先写后换 + 失败回滚；跨标签协调用 BroadcastChannel + storage 事件（天然同源），任务状态不信任消息体而以 IndexedDB 为准。
33. ● **备份与锁**：备份导出显式排除锁凭据键、导入剥离锁配置（`store.js:11, 161-176, 184-194`）——防止恶意备份关闭他人锁。

### 8.9 容器与发布（●安全审计）

34. **主 Dockerfile/Compose**：`USER node`（1000）非 root；`/app/data` 预建 `chmod 0700`；HEALTHCHECK 存在；COPY 白名单未打入 data/.env/test；两服务均 `cap_drop: ALL`、`no-new-privileges`、`read_only`、tmpfs `noexec,nosuid,nodev`、cpus/mem/pids 限额、`init: true`、日志轮转；翻译服务**无 `ports` 段**（端口未发布到宿主机）；jm-web 默认发布到 `127.0.0.1`；bind 挂载 `create_host_path: false`。
35. **CI workflow**：无 `pull_request_target`/`workflow_run` 危险触发器；PR 只构建不发布；无脚本注入（无可信输入进入 `run:`，`GITHUB_OUTPUT` 经 env 中转）；顶层 `permissions: contents: read`；缓存 scope 分离（PR 缓存污染不进入发布构建路径）。
36. **发布脚本与 ignore**：`validate-release-artifact.sh` 有 `set -euo pipefail`、路径规范化 + 生产路径阻断、拒绝符号链接、heredoc 单引号防扩展、无命令注入；`.gitignore`/`.dockerignore` 正确排除 `data/`、`.env`、`.secret`；git 全历史核查未发现真实秘密入库（仅 `.env.example` 模板）。（黑名单盲区见 DEL-03。）

### 8.10 加载链路良好现状（◆加载性能分析——"整改时勿回退、勿重复投入"）

| 项 | 证据 | 状态 |
| --- | --- | --- |
| 阅读器首图不被详情阻塞：album 并行 `.catch(() => null)` 后台补齐，标题先用占位，`render()` 先行 | `public/js/reader.js:887-931`（含注释"章节图片已就绪时立即挂载首屏"） | **AGENT.md 第 11 节该条债在当前代码已实际修复**（◎分析 §8 对照独立确认），下次修订 AGENT.md 时可移除 |
| 翻译配置探测不阻塞首图 | `reader.js:912-919`：`/api/config` 与 500 ms 定时器 `Promise.race` | 良好 |
| 首页 API 服务端进程内缓存（30 s TTL，LRU 语义） | `server.js:312-322` `publicApiCache`、`server.js:2031-2035` `/api/home` → `cachedPublicApi('/home', 30_000)` | 良好 |
| 图片代理：封面进程缓存 64 MiB/TTL 24 h、single-flight、超时/DNS/429/5xx 负缓存、全局并发 12/单客户端 6、`private … immutable` 长缓存 | `server.js:1173` `imageCacheControl`、`server.js:995-1010` `sendCachedImage`、AGENT.md 第 5 节 | 良好，符合"门禁开启时保持 private"不变量 |
| 封面懒加载与生命周期 | `ui.js:200`（`loading=lazy, decoding=async, fetchpriority=low`）、`ui.js:81-82` IntersectionObserver 失败重试、`views.js:86` | 良好 |
| 阅读器预取有界且有序 | `reader.js:83-110`（半径 1-12、顺序表、窗口过滤）、`reader.js:1486-1495`（序列号防过期任务） | 良好 |
| 静态 304/HEAD/SPA 回退语义、静态错误 `no-store` 防 CDN 负缓存 | `server.js:2507-2593` | 良好 |
| SW 升级安全（staging 缓存 + 快照回滚，防半套缓存） | `sw.js:43-94` | 良好（策略本身正确，问题只在 PERF-02 的代价） |
| 无第三方前端运行时依赖、无字体文件、图标全内联 SVG | `index.html`、`package.json` | 良好 |

---

## 9. 建议处理顺序（三份原文路线图合并保留）

### 9.1 多角度分析的建议顺序（按投入产出比）

1. **修 CI（DEL-01）**：workflow 在 `npm test` 前加 `npm ci`——一行修复，让整个发布门禁恢复意义；顺带核对 CI 最近的真实运行记录（若一直红说明无人看）。
2. **给 chapter-ai 上三道闸（REL-01，原 B1/B2/S2）**：enqueue 限流 + 队列上限；`save()` 改 debounce 异步并从 `/album` 热路径移除（touchPopularity 不落盘或合并写）；加整章页数/字节预算，分析任务改为流式/分批发模型。（原句"这是当前唯一能把生产容器直接打挂的功能"属未经运行验证的量级判断【勘误措辞】，OOM/写放大为结构性推断，量级需按第 2 批验收标准实测）
3. **错误处理排查 + 翻译闸（REL-02/REL-03，原 B3/B4）**【勘误 C01：原建议"注册 `process.on('unhandledRejection')` 日志兜底"作废——仅打印日志的监听器会吞掉未知异常并让进程带病服务；改为逐一排查具体遗漏的 Promise/回调错误处理，需要诊断时用不改变退出语义的 monitor】；给 `/api/translation/page` 加并发计数与显式 deadline。
4. **统一 CSRF（SEC-01）**：`requestHasSafeBrowserContext` 已有现成实现，在 API 门禁处复用即可；`/api/favorite`、`/api/like`、`/api/logout` 三个 query-POST 端点优先处理。
5. **文档对齐（DEL-02 + REL-04）**：README 修正"零依赖"宣称与推荐启动路径；AGENT.md §11 更新"图片熔断已实现"的现状，避免重复排期。
6. **按严重度排入迭代**：SEC-02/SEC-03（令牌时效与 TRUST_PROXY 告警）、FE-01~FE-03（下载管线超时/错误截断/分页读取）、DEL-03（制品黑名单补 `sessions/` 与密钥后缀）、REL-05/REL-06（启停与重复代码收敛）、DEL-05（翻译代理与 SW 升级补测）、REL-07（翻译健康检查覆盖 warmup）。
7. **低优先级**：各角度 L 级问题按机会清理（死代码、toast aria、文本正则测试加固等）。

### 9.2 安全审计的建议顺序（按"改动成本 × 风险收敛速度"）

1. **P2-1（REL-01）**：`/chapter-ai/enqueue` 加每 IP 限流 + 队列/记录硬上限，`touchPopularity` 防抖落盘。改动小，堵住唯一的匿名资源耗尽面。
2. **P2-2（含 P3-6）（SEC-03）**：部署侧按网桥网段补 `JMW_TRUST_PROXY`；代码侧对共享桶场景加"全站桶 + 更高阈值 + 失败退避"混合策略。否则公网部署下门禁限流形同虚设。
3. **供应链一次性整改**（DEL-07 + DEL-08/09/12，原 P2-4 + P3-16/17/24/25）：GHCR 部署改 digest、CI action 固定 SHA、删除多余 `id-token: write`、基础镜像锁 digest。
4. **P2-3（含 P3-21/22）（SEC-07 + SEC-21 + REL-10）**：翻译服务 fail-closed 强制 token、healthz 脱敏、连接级限流。
5. **P3-1/2/3/23（SEC-05/02/04）**：口令治理——独立管理员口令、令牌时间片轮转、弱口令/空口令 + 非回环发布的启动强制；建议随下次入口 Caddy 配置变更一并加 HSTS/XFO（SEC-09）。
6. **前端加固**（SEC-17/18/19 + SEC-11，原 P3-11/12/13/14）：CSP meta 双保险、booterr 脱敏、锁凭据派生加密、隐私数据披露。
7. **P3-4/5/7/9/10/15/18/19/20（SEC-06/15/16/08/14/20、DEL-06/10/11）**：按运维成本排期。

### 9.3 加载性能的实施路线图（每项方案、涉及面、验证方式；所有改动须遵守 AGENT.md 第 5/6 节不变量与第 9 节流程）

**P0-1 静态资源压缩（对应 PERF-01/A1）**

- **方案**：发布/打包阶段预生成 `.br`（brotli -5/6）与 `.gz`（gzip -6）双副本；`serveStatic` 按 `Accept-Encoding` 协商返回，`Vary: Accept-Encoding`，`Content-Length` 用实际发送体长度。预压缩避免运行时压缩 CPU（与 AGENT.md"零第三方运行依赖"一致，zlib 属 Node 内建）。若暂不做哈希改名，这是独立可上线的最小改动。
- **涉及面**：`server.js`（serveStatic + MIME + HEAD 语义【勘误 C08：HEAD 必须与同条件 GET 选择同一表示——按相同 `Accept-Encoding` 协商结果返回对应 `Content-Length`/ETag，不能任意返回另一种编码的长度】）、`.dockerignore` 无需变更、`test/backend.test.js` / `test/deployment.test.js` 增加协商与 304 断言。协商测试须覆盖 `Accept-Encoding: q=0`、identity、`Vary: Accept-Encoding`、ETag 一致性与 304 组合。
- **收益**：传输量约 -70%（逐文件压缩口径，见 6.2 勘误后表）；直连/内网路径立即受益。
- **注意**：ETag 语义需覆盖"同一 URL 多编码表示"（建议 ETag 加入编码维度，或 304 时保持与所选表示一致）；【勘误 C08：压缩降低传输字节确定，但"SW Cache Storage 体积同步下降"为推断，需实施后实测确认（Cache Storage 存编码正文，但当前 SW 在线策略只在 `response.ok` 时入缓存，实际命中率与体积都要测量）】。

**P0-2 内容哈希 + 分层缓存（对应 PERF-02/A2）**

- **方案**：引入轻量发布脚本（Node 脚本即可，不引入构建链）：对 `public/` 下 JS/CSS/图标按内容哈希改名，重写 `index.html` 与自动生成 SW `SHELL` 清单（含新哈希名与缓存版本号）；【勘误 C05：只重写 HTML 与 SHELL 不足以完成改名——ES 模块的静态 `import`/动态 `import()`、CSS `url()` 引用、PWA `manifest.webmanifest`、`sw.js` 自身引用、仍在运行的旧标签页（持有旧 URL 的已加载模块）以及版本回滚都必须一并纳入升级协议；任何一处漏改都会使内部引用失效。没有完整升级协议前，不得把未版本化资源改成永久 cache-first】带哈希资源返回 `Cache-Control: max-age=31536000, immutable`（门禁开启时按第 5 节不变量保持 `private`），`index.html` 保持 `no-cache`；SW 对带哈希资源改 cache-first（此时安全：文件名即版本），precache 只下载清单中哈希变化的条目。
- **涉及面**：新发布脚本 + `server.js` 缓存头分支 + `sw.js` 生成方式（手工清单 → 生成清单）+ `test/`（SW 清单完整性测试已有先例，需适配生成产物）+ AGENT.md 第 6 节"新增静态文件须同步 SHELL"条目的表述更新。
- **收益**：复访从"32 文件全协商"降为"仅 index.html 一次协商"；发版增量下载；这是 AGENT.md 运维债的正式闭环。
- **风险与顺序**：必须与 SW 升级协议一起设计（sw.js:177-179 注释明确：未建立内容哈希前不得单独改 cache-first——本项正是其前置条件）。建议先 P0-1 后 P0-2，回滚路径各自独立。

**P1-1 路由级动态 import + 资源提示（对应 PERF-03/A3）**

- **方案**：分批把 `user.js`（69 KB，收藏/历史/设置）→ `downloads.js`/`download-view.js`/`offline.js` → `reader.js`（82 KB，阅读路由独占）改为路由级 `import()`；`app.js` 保留外壳与首页所需（`views/ui/api/store/icons/navigation/recommend`）。【勘误 C06：`advanced.js`（105 KB）不能按原方案"整模块路由化"——它承载启动期运行时（`prepareAdvancedRuntime`/`isLocalAppLocked`：本地应用锁、隐私监听、延迟自动任务），拆分须先提取该轻量启动运行时并保留"锁屏先于网络与业务任务"的顺序】`index.html` 对首屏关键模块加 `modulepreload`。设计需覆盖 AGENT.md 第 6 节提示的两个兼容点：本地应用锁（锁屏期间不得预加载敏感视图模块）与 SW 升级窗口（动态 import 失败的回退重试）。
- **收益**：首屏 JS 从约 552 KB 降至约 150-250 KB（视批次）；解析执行时间同比例下降。

**P1-2 启动并行化与去重（对应 PERF-04/A4）**

- **方案**【勘误 C07：当前 `8eaf132` 已是"外壳先挂载 → `/api/me` 探测 → `render()` 与 `refreshAvatar()` 并行"，本项的剩余空间是复用探测结果消除重复的 `/api/me`，不是把三次串行改并行】：`boot()` 的 `/api/me` 探测结果直接喂 `refreshAvatar`（消除第二次 `/api/me`）；401 时再动态弹门禁。保持"网络故障仍进入应用"的既有兜底语义（app.js:420-421 注释）与认证世代保护，不得借去重跳过世代检查或提前触发签到等延迟任务。
- **收益**：消除一次重复请求；串行等待只省探测与头像合并中的一项，**不能写成必然减少两个首屏串行 RTT**；改动局限在 `app.js`，风险低。

**P1-3 上游连接池与线路亲和（对应 PERF-05/A5，与 REL-04/B5 同治）**

- **方案**：
  1. 【勘误 C03：原方案第一条的理由不成立——`keepAliveMsecs` 是 TCP 保活探测初始延迟而非空闲寿命，Node 19+ 默认 HTTPS Agent 已启用 keep-alive（timeout 5s），"把 keepAliveMsecs 改成 15000"本身不能证明复用改善。是否引入自定义 Agent 应**先收集 `reused_socket` 复用率与分段耗时（DNS/connect/TLS/TTFB）**再决定；若引入，须与现有并发保护对齐 maxSockets 并写入 `.env.example`/测试，同时定义配置变化后旧连接的处置】；
  2. `lib/jm-api.js` 在会话级 `jar.apiHost` 亲和之上增加**跨会话**的进程内"最近成功 host"健康管理：下一请求优先尝试上次成功线路，连续 N 次失败才回退全列表轮询。必须保持既有安全语义：pinned lookup、逐跳校验、Cookie 仅发受信 origin、POST 重试规则（AGENT.md 第 5 节）一律不动；Socket 复用不得绕过每跳 DNS 安全校验（`assertPublicUrl` 校验的是 URL 安全性，Socket 复用发生在校验通过的同一 host 内，语义兼容，实现时需在测试中确认）。
- **收益**（待实测确认）：若实测复用率低，每个上游 API 请求可省重复 DNS/TCP/TLS（约 100-500 ms/次）；坏首线路不再放大到每个新会话请求。
- **验证**：trace 已有 `reused_socket` 字段，可直接断言复用率；配合 PERF-08 输出基线对比。

**P2-1 首页分帧渲染（对应 PERF-06/A6）**

- **方案**：`loadHome` 数据到达后按 block 分帧 append（`requestAnimationFrame` 队列），或对首页卡片网格容器加 `content-visibility: auto` + `contain-intrinsic-size`；移动端回归矩阵（AGENT.md 第 10 节）复测滚动与 `scrollWidth === clientWidth`。
- **收益**：低端机长任务拆分，TTI 提前；图片懒加载行为不受影响（IntersectionObserver 不变）。

**P2-2 CSS 拆分与随视图加载（对应 PERF-07/A7）**

- **方案**：`favorites.css` 改为收藏视图挂载时注入（`link` 或打包进 `user.js` 的 adoptable style）；在 P0-1 预压缩管线中覆盖 CSS。`offline.css` 维持按需现状。
- **收益**：首屏阻塞 CSS 从 103 KB 降至 91 KB（压缩后差异小，主要收益在渲染树简化与缓存粒度）。

**P3-1 加载链路分段可观测性（对应 PERF-08/A8）**

- **方案**：聚合 `jmwTrace` 现有字段到运行日志（复用 `lib/features.js` 日志通道），按 API 方法/图片路径输出分位数（P50/P95）的 `connect_ms/tls_ms/ttfb_ms/upstream_ms` 与 `reused_socket` 率、host 切换次数；前端可用 `PerformanceObserver` 汇总静态资源与 `/api/*` 耗时上报到现有日志接口。
- **收益**：为 P0/P1 各项提供前后对比基线，形成"漫画慢"的定位能力（AGENT.md 运维债闭环）。

**实施顺序建议**：

```text
P0-1 压缩（独立、低风险、立即收益）
  → P0-2 内容哈希+缓存分层（依赖 P0-1 的预压缩管线，重构 SW 策略）
  → P1-2 启动并行化（小改动） ‖ P1-3 连接池/线路亲和（后端独立）
  → P1-1 路由动态 import（需兼容设计，分批）
  → P2-1/P2-2 渲染与 CSS
  → P3-1 可观测性（也可最先做，为其余项提供基线）
```

### 9.4 整改注意事项（●安全审计，依据 AGENT.md 的项目约定）

- 每项整改一次只改一个可解释变量，并补对应回归测试；涉及默认资源限制时同步检查 `server.js`/`lib/*`、`.env.example`、`docker-compose.yml`、`README.md`、`test/backend.test.js`、`test/deployment.test.js`。
- 涉及鉴权、Cookie、管理员边界的改动（SEC-05/02/04，原 P3-1/2/3）完成后必须更新 AGENT.md 第 13 节所列文档。
- 本地门禁：`npm test`、`npm run check`、`python -m pytest translation-service-poc/tests -q`、Compose config 检查（AGENT.md 第 10 节）。
- 修复不得以关闭 TLS、SSRF、DNS、Origin Cookie 或响应大小检查为代价（AGENT.md 第 12 节）。
- 后端测试使用临时 `JMW_DATA_DIR`，绝不指向生产路径。

### 9.5 合并视图：两份报告共同的最优先项

- **chapter-ai 上闸**：多角度分析列第 2、安全审计列第 1（REL-01）——唯一被两份独立报告共同置于顶部的代码问题。
- **限流/反代治理**：安全审计 P2-2（SEC-03）与多角度分析 S4 是同一问题，两份的处理建议已合并入 SEC-03。
- **CI/供应链**：多角度分析的 DEL-01（缺 `npm ci`，测试根本跑不起来）与安全审计的 DEL-08（action 未固定 SHA）是**不同问题**，前者使门禁失效、后者是供应链攻击面，建议都修且互不替代。

---

## 10. 与 AGENT.md 第 11 节已知技术债的对照（两份报告的对照表合并）

| AGENT.md §11 条目 | 多角度分析核实（S/B/F/D） | 加载性能核实（A） | 备注 |
| --- | --- | --- | --- |
| 阅读器可能等待详情元数据后才渲染已就绪章节图片 | 已实现"首图不等元数据"（`reader.js:920-923`），疑似已修复，建议更新文档 | **当前代码已修复**（reader.js:887-931：album 并行后台化、配置 500 ms 上限、先 render 后补详情）。建议修订 AGENT.md 时移除 | 两报告一致：**AGENT.md 该条已过时** |
| 首页一次创建大量卡片 | 已有 IntersectionObserver + 有界队列 + 后端缓存，现状可控 | 仍存在（A6/PERF-06）；图片侧已受控，瓶颈在 DOM 构造 | 判断互补，不矛盾 |
| `app.js` 静态导入阅读器、下载、高级和用户模块，首屏模块图偏大 | 确认，量化为 ~551 KB 未压缩（B10 行 7） | 仍存在（A3/PERF-03）；本次补充了量化（约 552 KB）与分批建议 | 重复发现，已合并入 PERF-03 |
| 长章节滚动定位遍历页面槽位；预取应只在页码实际变化时触发 | 确认（F4/FE-04），定位到 `reader.js:1896-1921` 每帧 O(n) | 未深查；预取已有序列号门闩（reader.js:1494-1495） | — |
| 超长条漫 Canvas 上限保护性拒绝、分块重排未实现 | 未深入核对（维持原状） | 未在本次范围 | — |
| 下载队列重启 `queued` 恢复策略 | 本次发现相邻新问题（F1/F2/F6 → FE-01/02/06） | 未在本次范围 | — |
| API Host 缺少跨请求熔断/成功线路提升 | 确认（B5/REL-04），另发现 429 语义不一致 | 仍存在（A5/PERF-05），本次补充连接复用维度 | 重复发现，见 REL-04 + PERF-05 |
| 普通上游 API 缺少统一并发准入 | 确认，且翻译路由连超时都没有（B4/REL-03） | 未核实 | — |
| 图片路径"仍需补充跨请求熔断" | **文档滞后**：`server.js:1294-1442` 已实现跨请求熔断 + EWMA 打分 + 半开探测（B5；合并时已复核代码确认） | 表内转述债项"与 A5/A8 合并处理"（未深查，见第 3 节矛盾 #2） | **AGENT.md 该条已过时** |
| 非幂等 API CSRF | 确认（S1/SEC-01），定位到 3 个 query-POST 端点 | — | — |
| `ACCESS_PASSWORD` 权限合一 | 确认（S2 引用；审计展开为 P3-1/SEC-05） | — | — |
| `/healthz` 非 readiness | 确认，未新增细节 | — | — |
| 生产备份 / 入口链路可观测性 / 静态资源哈希 | 属运维侧，本次未深入 | 可观测性仍存在（A8/PERF-08）；静态哈希仍存在（A2/PERF-02）并给出完整落地方案（P0-2） | — |

---

## 11. 附录

### 附录 A：关键证据摘录（◆加载性能分析）

**PERF-01 证据 —— `server.js` 静态服务无压缩（节选自 `serveStatic`，server.js:2539-2563）**

```js
const etag = `W/"${st.size}-${st.mtimeMs}"`;
if (req.headers['if-none-match'] === etag) {
  res.writeHead(304, baseHeaders({ ETag: etag }));
  return res.end();
}
const headers = baseHeaders({
  'Content-Type': MIME[ext] || 'application/octet-stream',
  'Cache-Control': 'no-cache',
  'Content-Length': st.size,
  ETag: etag,
});
```

`grep -n "zlib" server.js` 无匹配；`lib/https-fetch.js:62-64` 的 zlib 仅用于解压上游响应。

**PERF-02 证据 —— SW 在线强制协商（public/sw.js:176-186）**

```js
// 在线时先做 ETag 协商，部署新静态文件后立即生效；断网才回退离线副本。
// 旧的 cache-first 会在 sw.js 本身未改动时永久返回上一版模块。
const response = await fetch(request, { cache: 'no-cache' });
if (cache && response.ok && response.type === 'basic') {
  cache.put(request, response.clone()).catch(() => {});
}
return response.ok || !cached ? response : cached;
```

precache 全量重下：`sw.js:50` `fetch(url, { cache: 'reload', credentials: 'same-origin' })`；SHELL 原基线 32 项（sw.js:8-41），`8eaf132` 为 33 项。

**PERF-03 证据 —— app.js 静态导入（public/js/app.js:2-19，节选）**

```js
import { homeView, searchView, categoryView, categoryListView, promoteListView, weekView, albumView } from './views.js';
import { mountReader } from './reader.js';
import { downloadsView } from './download-view.js';
import { registerOfflineWorker } from './offline.js';
import { advancedHubView, /* …11 个导出 */ } from './advanced.js';
import { userView, signinView, favoritesView, /* … */ } from './user.js';
```

**PERF-04 证据 —— 启动串行探测（public/js/app.js:403-412，节选）**

```js
// 访问口令保护：/api/me 返回 401 说明服务器开启了口令且本机未验证
const accessProbe = new AbortController();
const accessProbeTimer = setTimeout(() => accessProbe.abort(), 8000);
const res = await fetch('/api/me', { signal: accessProbe.signal });
```

**PERF-05 证据 —— 每请求顺序轮询全部线路（lib/jm-api.js:472-478，节选）**

```js
const deadline = Date.now() + TOTAL_TIMEOUT;
for (let i = 0; i < list.length; i++) {
  if (signal && signal.aborted) throw abortReason(signal);
  const remaining = deadline - Date.now();
  if (remaining <= 0) break;
  const host = list[i].replace(/\/+$/, '');
```

连接未显式配置 Agent：`lib/https-fetch.js:170-178` `https.request({ protocol, hostname, port, path, method, headers, lookup, autoSelectFamily, … })` 无 `agent` 字段。

**PERF-05 反证（现状合理处）**：trace 字段已具备（`lib/https-fetch.js:233-243` 记录 `reused_socket/connect_ms/tls_ms`），整改验证无需新增埋点。

**阅读器首图已修复的证据（public/js/reader.js:887-925，节选）**

```js
const albumPromise = state.aid
  ? readerRequest(`/album?id=${encodeURIComponent(state.aid)}`).catch(() => null)
  : Promise.resolve(null);
// …
data = await readerRequest(`/chapter?id=…&shunt=…`);
// …
const config = await Promise.race([
  translationConfigPromise,
  new Promise((resolve) => setTimeout(() => resolve(null), 500)),
]);
// …
render();                      // 章节图片就绪即挂载首屏
const album = await albumPromise;   // 详情只补标题/封面/章节抽屉
```

### 附录 B：术语与度量口径（◆加载性能分析）

- 字节统计：`wc -c`（十进制 KB）；压缩率：`gzip -6` 默认级别实测。
- "首屏 JS"：`app.js` 及其静态可达模块全集（含 `booterr.js`，不含 `gate.js`、`descramble-worker.js`、`sw.js`）。
- RTT：同源（用户 → 源站/边缘）往返；上游 RTT 另计。
- 本文所有 `文件:行号` 以 commit `1dd0697` 为基准。

### 附录 C：来源文档行号口径说明

三份来源对同一代码的行号引用存在小幅偏差（见第 3 节矛盾 #4），本文在合并条目中将两组行号并排保留（如 `server.js:524-541`（审计作 525-540））。修复前必须按 AGENT.md 要求重新定位。

---

*本合并报告由三份 2026-10-09 独立分析（多角度问题分析、安全审计、加载性能分析，基线均为 `1dd0697`）去重合并生成；三份原文文件保留未动。原始尾注：多角度分析——"本报告由静态代码审查生成，作为问题台账使用；修复时按 AGENT.md 第 9 节流程逐项建立最小复现、一次一改、补回归测试"；安全审计——"本报告由三路并行静态审计 + 人工复核生成，基线 `1dd0697`。严重级别为静态分析评估，动态验证与生产环境复核未在本报告范围内"。*
