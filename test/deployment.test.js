'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const dockerfile = read('Dockerfile');
const compose = read('docker-compose.yml');
const ghcrCompose = read('docker-compose.ghcr.yml');
const workflow = read(path.join('.github', 'workflows', 'docker-publish.yml'));
const envExample = read('.env.example');
const server = read('server.js');
const readme = read('README.md');

function mustMatch(text, pattern, message) {
  assert.match(text, pattern, message);
}

mustMatch(
  dockerfile,
  /^ARG NODE_IMAGE=node:\d+\.\d+\.\d+-alpine\d+\.\d+$/m,
  'Dockerfile 默认基础镜像必须固定 Node 和 Alpine 的补丁版本',
);
mustMatch(dockerfile, /^FROM \$\{NODE_IMAGE\}$/m, 'Dockerfile 必须通过受控构建参数选择基础镜像');
for (const [pattern, source] of [
  [/^COPY --chown=node:node package\.json server\.js LICENSE \.\/$/m, '入口文件'],
  [/^COPY --chown=node:node lib \.\/lib$/m, '后端模块'],
  [/^COPY --chown=node:node public \.\/public$/m, '前端资源'],
]) mustMatch(dockerfile, pattern, `Dockerfile 必须显式把${source}归非 root 运行用户所有`);
mustMatch(dockerfile, /chown node:node \/app\/data/, '/app/data 必须归最终非 root 用户所有');
mustMatch(dockerfile, /chmod 0700 \/app\/data/, '/app/data 必须限制为容器用户私有');
mustMatch(dockerfile, /^USER node$/m, '镜像最终进程必须使用非 root 用户');
mustMatch(server, /const HOST = process\.env\.HOST \|\| '127\.0\.0\.1';/, '直接运行必须默认仅监听回环地址');
mustMatch(readme, /默认仅监听 `?127\.0\.0\.1:3210`?/, 'README 必须与安全监听默认值一致');
assert.ok(
  dockerfile.indexOf('chown node:node /app/data') < dockerfile.indexOf('USER node'),
  '必须先准备可写数据目录，再切换非 root 用户',
);

for (const [pattern, message] of [
  [/^\s{4}user: "1000:1000"$/m, 'Compose 必须固定与官方 node 用户一致的 uid/gid'],
  [/^\s{4}read_only: true$/m, 'Compose 必须保持只读根文件系统'],
  [/^\s{6}- no-new-privileges:true$/m, 'Compose 必须禁止提权'],
  [/^\s{6}- ALL$/m, 'Compose 必须移除全部 Linux capabilities'],
  [/^\s{4}cpus: /m, 'Compose 必须设置 CPU 上限'],
  [/^\s{4}mem_limit: /m, 'Compose 必须设置内存上限'],
  [/^\s{4}pids_limit: /m, 'Compose 必须设置进程数上限'],
  [/^\s{6}driver: json-file$/m, 'Compose 必须显式声明容器日志驱动'],
  [/^\s{8}max-size: /m, 'Compose 必须限制单个日志文件大小'],
  [/^\s{8}max-file: /m, 'Compose 必须限制日志文件数量'],
  [/host_ip: "\$\{JMW_PUBLISH_HOST:-127\.0\.0\.1\}"/, '默认发布地址必须保持为回环接口'],
  [/target: \/app\/data/, 'Compose 必须持久化 /app/data'],
  [/^\s{10}create_host_path: false$/m, 'Compose 必须禁止以 root 静默创建宿主机数据目录'],
]) mustMatch(compose, pattern, message);

for (const name of [
  'JMW_NODE_IMAGE',
  'JMW_CPU_LIMIT',
  'JMW_MEMORY_LIMIT',
  'JMW_PIDS_LIMIT',
  'JMW_LOG_MAX_SIZE',
  'JMW_LOG_MAX_FILE',
]) mustMatch(envExample, new RegExp(`^${name}=\\S+$`, 'm'), `.env.example 缺少 ${name}`);

mustMatch(
  ghcrCompose,
  /image: "\$\{JMW_IMAGE:-ghcr\.io\/shixian64\/jm-web:latest\}"/,
  'GHCR Compose 覆盖必须提供默认预构建镜像地址',
);
mustMatch(ghcrCompose, /build: !reset null/, 'GHCR Compose 覆盖必须禁用本地构建');
mustMatch(workflow, /linux\/amd64,linux\/arm64/, '镜像 workflow 必须发布 x86_64 和 arm64');
mustMatch(workflow, /packages:\s*write/, '镜像 workflow 必须允许写入 GHCR');
mustMatch(workflow, /docker\/build-push-action@v6/, '镜像 workflow 必须使用 Buildx 发布');
mustMatch(workflow, /if: github\.event_name != 'pull_request'/, 'Pull Request 不得发布镜像');

console.log('deployment hardening checks pass');
