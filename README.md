# JM Web —— 自部署网页版漫画阅读站

参照 [jmcomic-next](https://github.com/HongShi2333/jmcomic-next) 与 [jm-mobile](https://github.com/Dedicatus546/jm-mobile)
两个安卓客户端的通信协议，实现的**网页版本**。电脑、手机浏览器均可使用（响应式布局）。

> ⚠️ NSFW 警告：本项目可能包含不适宜公共场合的内容，未成年人请勿使用。
> 本项目仅供学习、研究和技术交流使用，与任何第三方服务无关；请自行遵守当地法律法规，使用产生的一切风险由使用者自行承担。

## 功能

- **首页推荐**：轮播图 + 多区块推荐 + 继续阅读（本地记录）
- **搜索**：关键词 / 作者 / 标签 / 漫画 ID，四种排序，搜索历史，无限滚动
- **分类浏览**：主分类 + 子分类 + 热门标签
- **每周必看**：按期数和类型浏览
- **漫画详情**：封面、标签、简介、章节列表、相关推荐、点赞 / 收藏
- **阅读器**：
  - 连续滚动 / 单页翻页两种模式（可随时切换）
  - 图片自动解扰还原（与客户端一致的分片重排算法，Canvas 前端解码，不占服务器带宽 CPU）
  - 前后多页预加载、阅读进度条、翻页手势（手机滑动 / 点击分区、电脑键盘 ← →）
  - 章节间跳转、恢复上次阅读位置
- **用户系统**：登录、自动登录、签到日历、收藏列表、云端阅读历史、我的评论、发表评论
- **本地数据**：阅读记录、搜索历史保存在浏览器本地，无需登录也可用
- **多线路**：API 域名 / 图片分流线路可切换，接口请求失败自动故障切换到其他域名

## 部署

### 方式一：直接运行（推荐）

服务器需有 Node.js **18.14.1 或更高**版本（无需 npm install，零依赖；18.14 以下缺少 `getSetCookie()`，登录态无法保持）：

```bash
git clone <本项目目录> jm-web   # 或直接上传 jm-web 文件夹
cd jm-web
PORT=3210 node server.js
```

从其他机器迁移代码时不要一并分发现有 `data/`：其中包含服务器密钥、设置和登录会话。新部署可让程序自动创建该目录；只有明确进行同一实例的数据迁移时才应单独、安全地复制它。

生产环境建议用 systemd / pm2 守护：

```bash
pm2 start server.js --name jm-web
```

### 方式二：Docker

```bash
cd jm-web
ACCESS_PASSWORD=你的访问口令 docker compose up -d
# 或不使用 compose：
docker build -t jm-web .
docker run -d --name jm-web -p 3210:3210 -v ./data:/app/data -e ACCESS_PASSWORD=你的口令 jm-web
```

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `3210` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `ACCESS_PASSWORD` | 空 | 设置后打开网页需要输入口令（强烈建议公网部署时设置；口令错误有 5 分钟限流） |
| `JM_API_BASE` | 空 | 覆盖 API 域名，逗号分隔多个候选；**设置后锁定**，网页设置页不可再切换 |
| `JM_UA` | `okhttp/4.9.3` | 请求上游使用的 UA |
| `JM_TIMEOUT` | `20000` | 上游单域名超时（毫秒） |
| `JM_TOTAL_TIMEOUT` | `35000` | 上游全部域名轮询总时间预算（毫秒） |
| `JMW_DATA_DIR` | `./data` | 会话与设置持久化目录 |
| `JMW_MAX_IMAGE_BYTES` | `26214400` | 图片代理单文件大小上限（字节，范围 1–100 MiB） |
| `JMW_MAX_IMAGE_CONCURRENCY` | `24` | 图片代理最大并发数（范围 1–100） |

容器及反向代理可使用 `GET /healthz` 做健康检查。该接口不需要访问口令、不会创建会话，也不会请求上游服务。

### 反向代理（可选）

用 Nginx 托管域名 + HTTPS：

```nginx
server {
    listen 443 ssl http2;
    server_name your.domain.com;
    location / {
        proxy_pass http://127.0.0.1:3210;
        proxy_set_header Host $host;
        proxy_read_timeout 120s;
    }
}
```

## 使用说明

1. 浏览器打开 `http://服务器IP:3210`（或你配置的域名）。
2. 搜索、阅读无需登录；如需**收藏 / 评论 / 签到**，在「我的」页面用 JM 官网账号登录
   （登录凭据仅保存在你自己的服务器 `data/sessions/` 中）。
3. 设置页可切换：主题（浅色/深色/跟随系统）、阅读模式、翻页适配、预加载数量、图片分流线路。
   「API 域名」只能在服务器内置候选中切换，且仅对**当前浏览器**生效；若服务器设置了 `JM_API_BASE`，该项由管理员锁定。

## 技术实现

| 层 | 说明 |
| --- | --- |
| 后端 | 零依赖 Node.js（≥18），`server.js` + `lib/` |
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
├── data/                运行时生成（会话、设置，已被 .gitignore 排除）
├── test/                单元/后端回归测试与静态检查（npm test / npm run check）
├── Dockerfile / docker-compose.yml
├── LICENSE
└── README.md
```

## 验证

```bash
npm test   # 解析/MD5 单元测试 + 后端路由、会话、故障切换与图片代理回归测试
npm run check
```

## License

GPL-3.0（与参照项目一致），完整条款见 `LICENSE`。仅供学习研究使用。
