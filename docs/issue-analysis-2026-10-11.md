# jm-web 项目分析与修复记录

日期：2026-10-11。代码基线：`987cff6`，包含任务开始前工作区已有的导航、收藏和阅读器修改；这些修改未回退。本次检查范围为当前仓库的前端、Node 后端、Python 翻译服务、依赖、测试与发布校验，不涉及同级项目或生产配置。

## 结论

主要缺陷集中在异步资源回收、下载跨标签状态一致性、离线缓存可信性、翻译上传准入及依赖安全。已对能在本地明确复现的问题实施修复并添加回归。旧版审计报告中的 AI 无限队列、空 token 放行、缺少统一 Origin 校验等结论不能直接套用到本次基线；已有保护未删除或放宽。

本记录区分“已修复并通过本地回归”和“尚未解决/未验收”。没有执行任何编译、镜像构建、提交、推送或生产部署；测试通过不代表生产已升级。

## 已修复的问题

### 依赖安全与兼容性

- 官方 npm audit 对原 `sharp 0.33.5` 报告 1 个高危依赖，涉及 libvips、libheif、librsvg 的 3 条公告。这是依赖命中，不等于已证明本项目存在可直接利用的 RCE。
- 已固定到 `sharp 0.35.5` 并同步锁文件。安装显式使用 `--ignore-scripts`，仅获取预编译包，没有执行原生编译。运行要求同步从 Node 20.0 提高至 20.9；Docker 现有 Node 22 基线不变。
- 锁文件保留 Linux musl x64/arm64 的 sharp 与 libvips 包以及 Windows 包。真实运行确认 sharp 0.35.5、libvips 8.18.7、rsvg 2.63.2；新版真实图片处理测试通过。
- Python 字形重绘不再向 `Image.fromarray` 传递已弃用的 `mode` 参数，使用现有 uint8 三通道数据自动推断；测试将该路径的弃用警告视为错误。

依据：[sharp 安全公告](https://github.com/advisories/GHSA-wq5f-xc86-pv6w)、[官方安装与运行要求](https://sharp.pixelplumbing.com/install/)。审计前默认 npm 镜像不支持 audit 接口，最终结果使用显式官方 registry，不修改用户全局 registry。

### 后端安全和会话稳定性

| 问题与可复现分支 | 修复 | 回归位置 |
| --- | --- | --- |
| 模型返回非 2xx、读取超时、fetch 超时后迟到时，响应流未回收 | 主动取消响应体，释放 reader 和 abort 监听，取消 Promise 不得延长已到期任务 | `test/chapter-ai.test.js` |
| `CHAPTER_AI_MAX_RETRIES=0` 被 `|| 3` 覆盖，无法关闭重试 | 使用现有有界数值解析，保留数字/字符串 0 | `test/chapter-ai.test.js` |
| Cookie 同时包含正数 Max-Age 与已过期 Expires 时，正常续期被误判为撤销 | 有效 Max-Age 优先于 Expires，非法 Max-Age 才回退 | `test/backend.test.js` |
| IPv6 `fec0::/10` 站点本地地址漏过出站检查 | Host 规范化和 DNS 地址校验同时拒绝该范围 | `test/backend.test.js` |

### 下载与认证流程

| 问题与可复现分支 | 修复 | 回归位置 |
| --- | --- | --- |
| 页面重开恢复 queued 记录后没有启动调度，任务永久等待 | 完整恢复后触发 pump | `test/downloads-runtime.test.js` |
| 等待锁的旧任务镜像会重跑其他标签已完成的任务 | 锁内重读 IndexedDB，以最新持久状态决定执行 | 同上 |
| 等待锁期间任务被删除，旧镜像仍继续执行并复活任务 | 缺失任务直接移除本地镜像，不再下载 | 同上 |
| 一个 worker 失败后 Promise.all 提前返回，其他 worker 仍在写 IDB，但锁已释放 | 等待全部 worker 结束再失败和释放锁 | 同上 |
| 阅读器与下载 JSON fetch 绕过共享 401 处理，门禁过期无重新验证 | 复用 apiRequest，保留取消信号和业务包装校验 | `test/auth-guard.test.js` |
| 不支持 SW 时，预缓存函数访问 null registration | 明确返回 false | `test/offline-metadata.test.js` |

下载四个用例及认证包装分支均先验证修复前失败，再验证修复后通过。已有导航、收藏、阅读性能与布局测试继续通过。

### 离线外壳

- 原先预缓存仅判断 HTTP 成功，反向代理返回 HTTP 200 错误页也能替换离线外壳。现在验证 MIME、最终 URL，以及入口 HTML 标记；在线静态更新同样验证，异常响应优先回退已有模块。
- 多标签同时发送预缓存消息会竞争同一个 staging 缓存。现在同一 SW 实例内合并为一个在途任务，成功/失败后都允许再次刷新。
- 任意同源静态扩展名路径、无限 query 变体原来都能进入 Cache Storage。现在只缓存 SHELL 清单的无 query 固定键。
- 写缓存纳入响应生命周期；缓存版本升级为 `jmw-shell-v17`。仍保持网络优先和 API/图片不缓存的原有边界。
- `test/service-worker.test.js` 覆盖错误页、错误 MIME、重定向、并发、失败重试、缓存键数量及原有回滚行为。

### 翻译代理与 Python 服务

| 问题 | 修复与验证 |
| --- | --- |
| Node fetch 默认跟随重定向，绕开结果 URL 的初始校验 | 上传与结果下载都设置 `redirect: 'error'`，结果地址拒绝用户信息/query/hash；本地假服务验证不会转发到非允许路径 |
| 取消/超限/非法 MIME 未主动释放流，读取完成残留 abort 监听 | 有界读取统一清理 reader、监听和异常响应体 |
| `res.end()` 后立即归还并发槽位，慢连接仍持有图片 Buffer，整体截止时间过早撤销 | 等到 finish 才归还；close/error/取消/总期限销毁未完成响应。用真实 Node Writable 背压和异常事件验证 |
| Python 上传阶段仅限制活跃连接，等待者数量无上限 | 新增 `TRANSLATION_MAX_UPLOAD_WAITERS=16`，范围 0..128，满队列立即 429；同步 Compose、环境示例与 README |
| `TRANSLATION_UPLOAD_WAIT_SECONDS=0` 实际无限等 | 现在表示不排队，容量已满立即 429 |
| 空请求体进入 OCR 队列 | 上传完成后检查长度并返回 400 |
| 非 ASCII Bearer 值使 compare_digest 抛错并返回 500 | 比较 UTF-8 字节，错误凭据正常返回 401 |
| 重复任务的 inline 等待仍持有整张上传图片 | 提交后释放请求侧 source 引用，以弱引用测试确认 |

已发 200 响应头后发生回传超时，只能关闭连接，不能向客户端重新发送一个 504 响应头。服务端会保留对应的超时错误语义。

### 测试与发布校验

- Windows 部署测试原使用 PATH 中的 WSL bash，不能识别 `D:/...`，导致完整 npm test 失败。现在沿 `git --exec-path` 定位 Git Bash；缺失时给明确错误，不静默跳过。
- 制品路径先 realpath，但保护前缀 current 不解析，会漏掉软链接子目录及真实 Release 路径。现在同时检查逻辑与物理保护前缀；隔离临时目录用 junction/软链接验证，未访问生产目录。
- 新增下载运行态测试纳入 `npm test`；部署回归锁定修复后的依赖版本、Node 要求与跨平台预编译包清单。

## 本地验证

以下在 Windows 工作区运行，后端会话使用隔离目录，上游及 AI 使用测试输入：

```powershell
npm test
npm run check
python -m pytest translation-service-poc/tests -q
npm audit --omit=dev --registry=https://registry.npmjs.org --json
docker compose config --quiet
docker compose --env-file .env.example config --quiet
docker compose --env-file .env.example -f docker-compose.yml -f docker-compose.ghcr.yml config --quiet
git diff --check
```

结果：完整 npm 测试通过；语法/样式检查通过（36 个 JS、3 个 CSS）；Python 20 passed，无此前 Pillow 弃用警告；官方 npm audit 为 0 已知漏洞；三种 Compose 配置检查和 diff 检查通过。Compose config 只解析配置，没有启动容器或构建镜像。

一次组合测试过程中，Windows 后端进程曾以原生异常 `0xC0000409` 退出，没有 JS assertion。后续独立加连续 4 次后端回归、新依赖真实编解码和最终完整 npm test 均通过，sharp 单独加载/退出 20 次通过。该异常根因未明，不能宣称已经定位或修复。

### 真实浏览器 smoke

使用 Edge、本地隔离数据和合成访问口令，关闭 AI/翻译，仅监听回环接口：

- 门禁登录、在线下载中心及设置页正常，在线控制台无 error/warn。
- 实际 CSS 视口约 390×843 与 667×300，均满足页面 scrollWidth 等于 clientWidth；路由切换后的焦点为 MAIN。
- 停止本地服务后重新加载下载中心，离线外壳仍完整显示；仅有预期的访问保护网络探测失败警告。
- 自建服务已停止、端口确认不可用，验收标签关闭、视口恢复。设置页断网时明确显示网络错误，并非所有功能都支持离线。

桌面鼠标环境不能验证 iOS/触屏焦点策略。首次欢迎引导与门禁同时显示时的键盘焦点关系还需进一步验证。截图接口未稳定返回可用图像，本记录不以截图宣称视觉验收全覆盖。

本次合成测试目录 `jm-web-browser-smoke-*`（Windows 用户临时目录） 的清理被执行策略阻止，未绕过，目录暂时保留；其中不含生产账号或状态。

## 仍需处理的风险与验收

1. **持久化容量**：会话文件 2 MiB 限制没有覆盖正常 loadJar/修剪读取。隔离输入 2,097,180 字节仍能加载；整改需要有界读取、保留异常文件及既有状态恢复策略，不能直接删除过大的真实会话。
2. **翻译磁盘与任务寿命**：结果缓存没有总量/淘汰上限；OCR 线程没有可强制中止的执行隔离。新增上传闸门不解决这两类风险，应另做磁盘预算与进程级任务截止设计。
3. **浏览器边界**：Blob 图片请求单独返回 401 的路径仍未复用 JSON 认证分流；无 Web Locks 的多标签降级协调、冻结/恢复和真实触屏行为需进一步回归。
4. **SW 升级协议**：尚未引入内容哈希；MIME 正确不等于内容完整或版本一致。普通资源更新、清缓存消息与预缓存之间尚非全局事务。
5. **运维与架构**：普通上游 API 统一并发准入、API Host 跨请求熔断、独立 readiness、访问口令与管理员权限分离、加密备份恢复演练仍待专项实施。
6. **供应链边界**：本次 npm audit 不覆盖 Python 依赖、基础镜像或生产系统。生产必须使用新依赖镜像做候选验收，不能仅覆盖 JS 源码而继续运行旧 sharp；本次未获构建允许，未执行镜像构建。

建议下一步先处理会话/翻译缓存容量，再在允许构建后做双服务候选验证与可回滚发布。真实上游账号、OCR 模型、Cloudflare/Caddy/Tailscale 与生产负载未纳入本次本地回归，不应由 healthz=200 推断这些链路已验收。
