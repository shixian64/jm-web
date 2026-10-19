'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const compose = read('docker-compose.yml');
const translation = compose.split('\n  jm-web:')[0];
const web = compose.split('\n  jm-web:')[1];
const ghcr = read('docker-compose.ghcr.yml');
const workflow = read('.github/workflows/docker-publish.yml');

assert.match(translation, /context: \.\/translation-service-poc/, '源码构建必须使用仓库内的翻译服务');
assert.match(translation, /restart: unless-stopped/, '翻译容器必须配置自动重启');
assert.match(translation, /translation-cache:\/app\/cache/, '翻译缓存必须持久化，不能与主站会话混用');
assert.doesNotMatch(translation, /^\s+ports:/m, '不得向宿主机公开翻译端口');
for (const key of ['read_only', 'cpus', 'mem_limit', 'pids_limit', 'healthcheck']) {
  assert.match(translation, new RegExp(`^    ${key}:`, 'm'), `翻译容器必须配置 ${key}`);
}
assert.match(web, /depends_on:\s+translation-service:\s+condition: service_started\s+required: false/,
  '翻译为可选能力，翻译容器不健康或启动失败不得阻断主站');
assert.doesNotMatch(web, /condition: service_healthy/, '主站不得等待翻译容器 healthy');
assert.match(web, /TRANSLATION_SERVICE_URL: "\$\{TRANSLATION_SERVICE_URL-http:\/\/translation-service:8091\}"/,
  '必须默认使用服务名连接，并允许显式空值关闭翻译');
assert.equal((compose.match(/TRANSLATION_SERVICE_TOKEN: "\$\{TRANSLATION_SERVICE_TOKEN:-\}"/g) || []).length, 2,
  '两个容器必须读取同一个根配置令牌');
assert.doesNotMatch(compose, /host\.docker\.internal/, '一体部署不得依赖宿主机回环端口');
assert.match(ghcr, /TRANSLATION_IMAGE:-ghcr\.io\/shixian64\/jm-web-translation:latest/);
assert.equal((ghcr.match(/build: !reset null/g) || []).length, 2, '预构建部署必须禁用两个服务的本地构建');
assert.match(workflow, /component: translation/);
assert.match(workflow, /suffix: "-translation"/);
assert.match(workflow, /Build translation test image/);
assert.match(workflow, /linux\/amd64,linux\/arm64/);
for (const name of ['Dockerfile', '.dockerignore', 'requirements.txt', 'constraints.txt', 'pipeline.py', 'service.py']) {
  assert.ok(fs.statSync(path.join(root, 'translation-service-poc', name)).isFile(), `缺少翻译运行文件 ${name}`);
}
assert.match(read('translation-service-poc/Dockerfile'), /^USER appuser$/m);
// Python 依赖与基础镜像必须可复现：直接依赖都在 constraints.txt 中锁定到精确版本。
const translationDockerfile = read('translation-service-poc/Dockerfile');
assert.match(translationDockerfile, /-r requirements\.txt -c constraints\.txt/, '安装必须使用锁定约束');
assert.match(translationDockerfile, /^ARG PYTHON_IMAGE=python:\d+\.\d+\.\d+-slim-[a-z]+$/m, '基础镜像必须固定补丁版本');
const normalizeName = (name) => name.toLowerCase().replace(/[-_.]+/g, '-');
const pinned = new Map(read('translation-service-poc/constraints.txt').split('\n')
  .map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))
  .map((line) => {
    const match = line.match(/^([A-Za-z0-9_.-]+)==([^\s;]+)$/);
    assert.ok(match, `constraints.txt 只能包含精确版本：${line}`);
    return [normalizeName(match[1]), match[2]];
  }));
for (const line of read('translation-service-poc/requirements.txt').split('\n')) {
  const name = (line.trim().match(/^([A-Za-z0-9_.-]+)/) || [])[1];
  if (!name || line.trim().startsWith('#')) continue;
  assert.ok(pinned.has(normalizeName(name)), `直接依赖 ${name} 必须在 constraints.txt 中锁定`);
}
assert.match(read('.env.example'), /^TRANSLATION_SERVICE_URL=http:\/\/translation-service:8091$/m);
assert.match(translation, /TRANSLATION_MAX_UPLOAD_WAITERS: "\$\{TRANSLATION_MAX_UPLOAD_WAITERS:-16\}"/,
  'Compose 必须传递翻译上传等待队列上限');
assert.match(read('.env.example'), /^TRANSLATION_MAX_UPLOAD_WAITERS=16$/m);
assert.match(read('README.md'), /TRANSLATION_MAX_UPLOAD_WAITERS/);
console.log('translation deployment checks pass');
