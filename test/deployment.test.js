'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const dockerfile = read('Dockerfile');
const compose = read('docker-compose.yml');
const ghcrCompose = read('docker-compose.ghcr.yml');
const workflow = read(path.join('.github', 'workflows', 'docker-publish.yml'));
const envExample = read('.env.example');
const server = read('server.js');
const readme = read('README.md');
const artifactValidator = path.join(root, 'scripts', 'validate-release-artifact.sh');

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
  [/JMW_MAX_IMAGE_CONCURRENCY_PER_IP:/, 'Compose 必须传递单客户端图片并发上限'],
  [/host_ip: "\$\{JMW_PUBLISH_HOST:-127\.0\.0\.1\}"/, '默认发布地址必须保持为回环接口'],
  [/target: \/app\/data/, 'Compose 必须持久化 /app/data'],
  [/^\s{10}create_host_path: false$/m, 'Compose 必须禁止以 root 静默创建宿主机数据目录'],
]) mustMatch(compose, pattern, message);
for (const name of [
  'JMW_IMAGE_CACHE_BYTES', 'JMW_IMAGE_CACHE_ENTRY_BYTES', 'JMW_IMAGE_CACHE_TTL',
  'JMW_IMAGE_QUEUE_LIMIT', 'JMW_IMAGE_QUEUE_TIMEOUT',
]) mustMatch(compose, new RegExp(`${name}:`), `Compose 必须传递 ${name}`);

for (const name of [
  'JMW_NODE_IMAGE',
  'JMW_CPU_LIMIT',
  'JMW_MEMORY_LIMIT',
  'JMW_PIDS_LIMIT',
  'JMW_LOG_MAX_SIZE',
  'JMW_LOG_MAX_FILE',
  'JMW_MAX_CHAPTER_IMAGES',
  'JMW_MAX_IMAGE_CONCURRENCY',
  'JMW_MAX_IMAGE_CONCURRENCY_PER_IP',
  'JMW_IMAGE_CACHE_BYTES',
  'JMW_IMAGE_CACHE_ENTRY_BYTES',
  'JMW_IMAGE_CACHE_TTL',
  'JMW_IMAGE_QUEUE_LIMIT',
  'JMW_IMAGE_QUEUE_TIMEOUT',
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
assert.ok(fs.statSync(artifactValidator).mode & 0o111, '制品校验脚本必须可执行');
mustMatch(read('package.json'), /"validate:artifact"\s*:/, 'package.json 必须提供制品校验入口');

// 制品校验必须只在构建成功标志明确存在时生成 PASS，并拒绝缺失运行文件。
const artifact = fs.mkdtempSync(path.join(os.tmpdir(), 'jmw-release-artifact-test-'));
try {
  for (const item of ['.dockerignore', '.env.example', 'AGENT.md', 'AGENTS.md', 'Dockerfile',
    'LICENSE', 'README.md', 'docker-compose.yml', 'package.json', 'server.js']) {
    fs.cpSync(path.join(root, item), path.join(artifact, item), { recursive: true });
  }
  for (const dir of ['lib', 'public']) fs.cpSync(path.join(root, dir), path.join(artifact, dir), { recursive: true });
  fs.mkdirSync(path.join(artifact, 'translation-service-poc'));
  for (const item of ['.dockerignore', 'Dockerfile', 'requirements.txt', 'pipeline.py', 'service.py']) {
    fs.copyFileSync(path.join(root, 'translation-service-poc', item), path.join(artifact, 'translation-service-poc', item));
  }
  const output = execFileSync(artifactValidator, [artifact], {
    env: { ...process.env, RELEASE_BUILD_STATUS: 'PASS' }, encoding: 'utf8',
  });
  assert.match(output, /RELEASE-MANIFEST: PASS/);
  const pipelinePath = path.join(artifact, 'translation-service-poc', 'pipeline.py');
  fs.rmSync(pipelinePath);
  assert.throws(
    () => execFileSync(artifactValidator, [artifact], {
      env: { ...process.env, RELEASE_BUILD_STATUS: 'PASS' }, encoding: 'utf8',
    }),
    /status|exited with|pipeline\.py/i,
    '缺少翻译运行源码的制品不得通过',
  );
  fs.copyFileSync(path.join(root, 'translation-service-poc', 'pipeline.py'), pipelinePath);
  assert.throws(
    () => execFileSync(artifactValidator, [artifact], { env: { ...process.env }, encoding: 'utf8' }),
    /status|exited with|package\.json/i,
    '未确认构建成功不得生成 PASS',
  );
  fs.rmSync(path.join(artifact, 'package.json'));
  assert.throws(
    () => execFileSync(artifactValidator, [artifact], {
      env: { ...process.env, RELEASE_BUILD_STATUS: 'PASS' }, encoding: 'utf8',
    }),
    /status|exited with|package\.json/i,
    '缺少 package.json 的失败制品不得通过',
  );

  // 禁止内容检查必须递归，不能通过把生产状态放入嵌套目录绕过门禁。
  fs.writeFileSync(path.join(artifact, 'package.json'), JSON.stringify({ name: 'jm-web' }));
  fs.mkdirSync(path.join(artifact, 'nested', 'data'), { recursive: true });
  assert.throws(
    () => execFileSync(artifactValidator, [artifact], {
      env: { ...process.env, RELEASE_BUILD_STATUS: 'PASS' }, encoding: 'utf8',
    }),
    /禁止内容|nested\/data/i,
    '嵌套 data 目录不得进入发布制品',
  );

  // 路径规范化后仍须阻断旧生产目录；这里只验证不存在的变体不会被误判
  // 为制品，实际生产目录由部署流程单独保护。
  assert.throws(
    () => execFileSync(artifactValidator, ['/srv/jm-web/../jm-web'], {
      env: { ...process.env, RELEASE_BUILD_STATUS: 'PASS' }, encoding: 'utf8',
    }),
    /目录不存在|生产路径|exited with/i,
  );
} finally {
  fs.rmSync(artifact, { recursive: true, force: true });
}

console.log('deployment hardening checks pass');
