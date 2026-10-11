# 2026-10-11 生产发布记录

## 结果

- 已提交并推送运行代码：`2928523bc0cd796a124264989ff0b5bab4a60a1a`。
- Release：`20261011T032414Z-2928523bc0cd`。
- 2026-10-11 11:42:12（北京时间）切换，11:44:33 完成验收；发布成功，未触发回滚。
- 主服务和翻译服务均 `running/healthy`、`RestartCount=0`、`OOMKilled=false`。
- 本记录的后续文档提交不改变上述已部署的运行代码版本。

修复明细见 [项目分析与修复记录](issue-analysis-2026-10-11.md)。未宣称该项目全部技术债或供应链风险已经消除。

## 构建与版本证据

用户明确允许本次构建和部署后执行：

1. 从已提交 Git SHA 白名单打包，排除 `.git`、测试、数据和真实环境配置；58 个制品文件逐一校验。
2. 制品 SHA256：`ee34751563a9eba3bd8898e42bea14922a9c13ce58437b655e6e45a9cb5fe191`。
3. 主服务在目标主机构建新镜像，实际运行 Node `22.23.2`、Sharp `0.35.5`、libvips `8.18.7`；真实 PNG→WebP→像素解码通过。没有继续复用旧 Sharp。
4. 翻译服务标准构建遇到 Debian 下载缓慢，GHCR 拉取 10 分钟仍未完成。停止本次受阻操作后，以固定的现网翻译依赖镜像为基础，复制本次已提交的 Python 源码和完全一致的 requirements，并采用本次 Dockerfile 的完整 CMD，构建新的不可变镜像。不是运行时源码覆盖挂载，也未声称升级 Python 依赖或基础系统。
5. 新翻译镜像的 `pip check`、运行文件哈希、真实 OCR、WebP 解码及缓存回归均通过。基础镜像、派生 Dockerfile 和构建日志保留在服务器本次 incoming 中。
6. [GitHub Actions 38108213662](https://github.com/shixian64/jm-web/actions/runs/38108213662) 的测试及两个发布任务全部成功；GHCR 两个镜像均确认含 `linux/amd64`、`linux/arm64`。实际生产使用下表目标主机核验的镜像 ID，不将 CI 镜像误记为本次实际部署镜像。

| 用途 | 固定镜像 ID |
| --- | --- |
| 新主服务 | `sha256:08ac4b65274d950480b979f0d10ac6eeec30c3d8185b1a452b5caf514f507170` |
| 新翻译服务 | `sha256:dd7eb6c4977916adf45767c601f53746143ac59e3fe4f5ab20bf3870621acf3f` |
| 翻译依赖基础／原翻译镜像 | `sha256:d9b9ca3a6d046d5ae778c8f26266912db0f1a7695fa061021dbbb22c021465b5` |
| 原主服务镜像 | `sha256:94f69e1886ee0dd748b632b286ec762fa686d7cb5cfe1333789606643ef0bf97` |

## 验证

### 本地与 CI

- `npm test`、`npm run check`、`git diff --check` 通过。
- Python 测试 `20 passed`，Pillow 弃用警告已消除。
- 三种 Compose 配置解析通过；官方 npm audit 为 0 已知漏洞，此结论不覆盖 Python、镜像或系统。
- 既有导航、收藏与阅读器修改一并保留并通过回归。

### 隔离候选

使用独立 data、独立缓存卷和合成口令，仅绑定回环端口：

- Web 46 个运行文件、翻译 3 个运行文件与提交清单完全一致。
- 33 个静态资源、根入口及 `jmw-shell-v17` 一致。
- GET/HEAD healthz、未认证 401、认证 Cookie 属性、config/me 正常。
- 真实首页→详情→章节→封面/正文图片通过；图片 MIME、签名及 private 缓存语义正确。
- 繁体中文合成图经真实 OCR 检出 3 个文本块并完成 14 处转换；结果为可解码的 1000×280 WebP，重复请求命中缓存。
- 主站翻译代理完整走通排队→结果回传→重复缓存命中，非仅直接测试翻译容器。
- `pip check` 无依赖冲突。

### 生产

- 生产候选和最终容器镜像 ID 逐一相等；已移除旧源码覆盖挂载，运行文件哈希再次一致。
- 宿主机直连与公网域名均完成上述门禁、静态资源及真实业务链验收；公网 Secure Cookie 正常。
- 生产翻译容器再次通过真实 OCR 和缓存测试；主站原有 AI／翻译关闭配置保持不变，没有擅自开启功能。
- Windows 客户端访问公网 healthz 为 200。
- Web 实际 UID 1000，翻译 UID 10001；只读根文件系统、cap-drop ALL、no-new-privileges 保持。
- 验收窗口内两个容器未发现 HTTP 5xx 或 fatal/traceback/uncaught/OOM 关键字日志。
- 本次候选容器、网络及独立翻译缓存卷已清理；生产缓存卷未删除。

这不是长时间负载验收，不涵盖真实 JM 账号登录、iOS 真机或全部历史存储升级场景。

## 数据保护与回滚材料

- 生产根目录仍为 `/home/shixian/project/jm-web`；`current` 原子切换到新 Release。
- 原指向：`releases/20261010T043615Z-987cff6b9008`；原 Release、旧镜像均保留。
- 停止两服务并确认优雅退出后生成一致性备份，大小 1,114,309 字节，包含生产 data、`.env` 及原 Compose 覆盖。
- Web 正常退出码 0；翻译 Uvicorn 正常重抛 SIGTERM 返回 143，已限定本次时间窗口核实 `Application shutdown complete.`，未将其误判为崩溃。
- 备份、原覆盖、镜像锁定回滚覆盖及审计日志位于 `/home/shixian/project/jm-web/incoming/20261011T032414Z-2928523bc0cd`，目录 0700、敏感文件 0600；未上传或提交这些文件。
- 发布前后 data 的设备号、inode、所有者和权限一致；`.secret` 与生产 `.env` 哈希一致；全部非源码真实挂载保持一致，翻译缓存仍是 `jm-web_translation-cache`。
- 自动失败回滚恢复原覆盖、原 current 和旧镜像，不解包覆盖 data。未对服务器升级、重启操作系统、修改 Caddy 或其他容器。

如需人工回滚，先停止两服务完成 flush，再原子恢复 `docker-compose.prod.original.yml` 与原 current；使用本次 `docker-compose.rollback-images.yml` 固定旧镜像，以 `up -d --no-build --pull never --wait` 重建并重新做业务验收。代码回滚不等于数据恢复，禁止自动解包备份覆盖现有 data。
