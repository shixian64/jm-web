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
assert.match(web, /depends_on:\s+translation-service:\s+condition: service_healthy/);
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
for (const name of ['Dockerfile', '.dockerignore', 'requirements.txt', 'pipeline.py', 'service.py']) {
  assert.ok(fs.statSync(path.join(root, 'translation-service-poc', name)).isFile(), `缺少翻译运行文件 ${name}`);
}
assert.match(read('translation-service-poc/Dockerfile'), /^USER appuser$/m);
assert.match(read('.env.example'), /^TRANSLATION_SERVICE_URL=http:\/\/translation-service:8091$/m);
console.log('translation deployment checks pass');
