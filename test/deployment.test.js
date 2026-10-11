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
  [/^COPY --chown=node:node package-lock\.json \.\/$/m, '锁文件'],
  [/^COPY --chown=node:node lib \.\/lib$/m, '后端模块'],
  [/^COPY --chown=node:node public \.\/public$/m, '前端资源'],
]) mustMatch(dockerfile, pattern, `Dockerfile 必须显式把${source}归非 root 运行用户所有`);
mustMatch(dockerfile, /chown node:node \/app\/data/, '/app/data 必须归最终非 root 用户所有');
mustMatch(dockerfile, /chmod 0700 \/app\/data/, '/app/data 必须限制为容器用户私有');
mustMatch(dockerfile, /^USER node$/m, '镜像最终进程必须使用非 root 用户');
mustMatch(server, /const HOST = process\.env\.HOST \|\| '127\.0\.0\.1';/, '直接运行必须默认仅监听回环地址');
mustMatch(readme, /默认仅监听 `?127\.0\.0\.1:3210`?/, 'README 必须与安全监听默认值一致');
mustMatch(readme, /npm ci --omit=dev/, 'README 直接运行路径必须先按锁文件安装依赖（sharp）');
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
assert.strictEqual(
  (ghcrCompose.match(/build: !reset null/g) || []).length, 2,
  'GHCR 覆盖必须同时禁用 jm-web 与 translation 两个服务的本地构建（首次部署前两镜像都来自 GHCR）',
);
mustMatch(workflow, /linux\/amd64,linux\/arm64/, '镜像 workflow 必须发布 x86_64 和 arm64');
mustMatch(workflow, /packages:\s*write/, '镜像 workflow 必须允许写入 GHCR');
mustMatch(workflow, /docker\/build-push-action@v6/, '镜像 workflow 必须使用 Buildx 发布');
mustMatch(workflow, /if: github\.event_name != 'pull_request'/, 'Pull Request 不得发布镜像');
mustMatch(workflow, /run: npm ci/, 'CI 必须在测试前按锁文件安装依赖，否则干净 runner 必然失败');
// 安全修复必须锁定精确版本，且跨平台锁文件保留生产 Alpine 预编译包。
const packageManifest = JSON.parse(read('package.json'));
const packageLock = JSON.parse(read('package-lock.json'));
assert.strictEqual(packageManifest.dependencies.sharp, '0.35.5');
assert.strictEqual(packageLock.packages['node_modules/sharp'].version, packageManifest.dependencies.sharp);
assert.strictEqual(packageManifest.engines.node, '>=20.9.0');
assert.strictEqual(packageLock.packages[''].engines.node, packageManifest.engines.node);
for (const name of ['sharp-linuxmusl-x64', 'sharp-linuxmusl-arm64',
  'sharp-libvips-linuxmusl-x64', 'sharp-libvips-linuxmusl-arm64', 'sharp-win32-x64']) {
  assert.ok(packageLock.packages[`node_modules/@img/${name}`], `锁文件缺少预编译包 ${name}`);
}
mustMatch(read('package.json'), /"validate:artifact"\s*:/, 'package.json 必须提供制品校验入口');

// 平台契约：Windows 文件系统不承载 POSIX 可执行位，不能把位缺失当作脚本业务错误。
// git 索引是 Linux 检出获得执行位的权威记录，所有平台都验证它；能承载 POSIX 位的平台
// 再额外断言文件系统当前状态。
const trackedValidatorMode = execFileSync(
  'git',
  ['ls-files', '-s', '--', 'scripts/validate-release-artifact.sh'],
  { cwd: root, encoding: 'utf8' },
).trim();
assert.ok(
  trackedValidatorMode.startsWith('100755 '),
  `git 索引必须把制品校验脚本记录为可执行（100755），实际: ${trackedValidatorMode || '(未跟踪)'}`,
);
if (process.platform !== 'win32') {
  assert.ok(fs.statSync(artifactValidator).mode & 0o111, '制品校验脚本必须可执行');
}

// 校验脚本是 bash 脚本：win32 无 .sh 执行关联，统一经 bash 运行全部业务规则；
// 缺少 bash 时此处会显式失败（明确环境阻碍），而不是静默跳过制品安全测试。
// Windows 的 PATH 中 bash 可能是 WSL launcher，不能识别 D:/... 路径。
// 跟随本测试已依赖的 Git 安装定位 Git Bash，避免误选另一套文件系统/Node。
const bashCommand = (() => {
  if (process.platform !== 'win32') return 'bash';
  const gitExecPath = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
  for (let dir = path.resolve(gitExecPath);;) {
    for (const relative of ['bin/bash.exe', 'usr/bin/bash.exe']) {
      const candidate = path.join(dir, relative);
      if (fs.existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Windows 制品回归需要 Git for Windows 的 Git Bash，不能使用 WSL bash');
})();
const toPosixPath = (dir) => (process.platform === 'win32' ? String(dir).replace(/\\/g, '/') : String(dir));
const runValidator = (dir, extraEnv = {}) => {
  const env = { ...process.env, RELEASE_BUILD_STATUS: 'PASS', ...extraEnv };
  if (process.platform === 'win32') {
    return execFileSync(bashCommand, [toPosixPath(artifactValidator), toPosixPath(dir)], {
      env, encoding: 'utf8',
    });
  }
  return execFileSync(artifactValidator, [String(dir)], { env, encoding: 'utf8' });
};
const expectValidatorFailure = (dir, { env: extraEnv, code, message } = {}) => {
  let caught;
  try {
    runValidator(dir, extraEnv);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, '制品校验必须失败');
  if (code !== undefined) {
    assert.strictEqual(
      caught.status, code,
      `期望校验器退出码 ${code}，实际 ${caught.status}`,
    );
  }
  if (message) {
    const output = `${caught.message}\n${caught.stderr ? caught.stderr.toString() : ''}`;
    assert.match(output, message);
  }
  return caught;
};
// 与校验脚本相同的路径规范化（bash pwd -P），用于构造能命中阻断分支的受保护前缀。
const normalizeViaBash = (dir) => execFileSync(
  bashCommand, ['-c', `cd -- "${toPosixPath(dir).replace(/"/g, '\\"')}" && pwd -P`], { encoding: 'utf8' },
).trim();

// 制品校验必须只在构建成功标志明确存在时生成 PASS，并拒绝缺失运行文件（含锁文件）。
const artifact = fs.mkdtempSync(path.join(os.tmpdir(), 'jmw-release-artifact-test-'));
try {
  for (const item of ['.dockerignore', '.env.example', 'AGENT.md', 'AGENTS.md', 'Dockerfile',
    'LICENSE', 'README.md', 'docker-compose.yml', 'package.json', 'package-lock.json', 'server.js']) {
    fs.cpSync(path.join(root, item), path.join(artifact, item), { recursive: true });
  }
  for (const dir of ['lib', 'public']) fs.cpSync(path.join(root, dir), path.join(artifact, dir), { recursive: true });
  fs.mkdirSync(path.join(artifact, 'translation-service-poc'));
  for (const item of ['.dockerignore', 'Dockerfile', 'requirements.txt', 'pipeline.py', 'service.py']) {
    fs.copyFileSync(path.join(root, 'translation-service-poc', item), path.join(artifact, 'translation-service-poc', item));
  }
  const output = runValidator(artifact);
  assert.match(output, /RELEASE-MANIFEST: PASS/);

  const pipelinePath = path.join(artifact, 'translation-service-poc', 'pipeline.py');
  fs.rmSync(pipelinePath);
  expectValidatorFailure(artifact, { code: 68, message: /pipeline\.py/ });
  fs.copyFileSync(path.join(root, 'translation-service-poc', 'pipeline.py'), pipelinePath);

  expectValidatorFailure(artifact, {
    env: { RELEASE_BUILD_STATUS: '' },
    code: 66,
    message: /构建状态未确认/,
  });

  const packagePath = path.join(artifact, 'package.json');
  fs.rmSync(packagePath);
  expectValidatorFailure(artifact, { code: 68, message: /package\.json/ });
  fs.copyFileSync(path.join(root, 'package.json'), packagePath);

  const lockPath = path.join(artifact, 'package-lock.json');
  fs.rmSync(lockPath);
  expectValidatorFailure(artifact, {
    code: 68,
    message: /package-lock\.json/,
  });
  fs.copyFileSync(path.join(root, 'package-lock.json'), lockPath);

  // 禁止内容检查必须递归：顶层允许清单先拦下未知目录，但把生产状态藏进
  // 允许目录（lib/）内部的嵌套路径同样必须被递归 walk 拒绝。
  fs.mkdirSync(path.join(artifact, 'nested', 'data'), { recursive: true });
  expectValidatorFailure(artifact, { code: 72, message: /顶层内容.*nested|nested.*顶层/ });
  fs.rmSync(path.join(artifact, 'nested'), { recursive: true, force: true });
  fs.mkdirSync(path.join(artifact, 'lib', 'nested', 'data'), { recursive: true });
  expectValidatorFailure(artifact, { code: 72, message: /nested\/data/ });
  fs.rmSync(path.join(artifact, 'lib', 'nested'), { recursive: true, force: true });

  // 生产会话目录无论出现在顶层还是嵌套路径都不得进入制品。
  fs.mkdirSync(path.join(artifact, 'sessions'), { recursive: true });
  expectValidatorFailure(artifact, { code: 72, message: /sessions/ });
  fs.rmSync(path.join(artifact, 'sessions'), { recursive: true, force: true });
  fs.mkdirSync(path.join(artifact, 'lib', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(artifact, 'lib', 'sessions', 'session.json'), '{}');
  expectValidatorFailure(artifact, { code: 72, message: /lib\/sessions/ });
  fs.rmSync(path.join(artifact, 'lib', 'sessions'), { recursive: true, force: true });

  // 密钥、环境备份与归档后缀不得出现在制品任意层级。
  fs.writeFileSync(path.join(artifact, 'lib', 'deploy.pem'), '-----BEGIN PRIVATE KEY-----\n');
  expectValidatorFailure(artifact, { code: 72, message: /deploy\.pem/ });
  fs.rmSync(path.join(artifact, 'lib', 'deploy.pem'));
  fs.writeFileSync(path.join(artifact, 'public', 'uploads.env'), 'ACCESS_PASSWORD=x\n');
  expectValidatorFailure(artifact, { code: 72, message: /uploads\.env/ });
  fs.rmSync(path.join(artifact, 'public', 'uploads.env'));
  fs.writeFileSync(path.join(artifact, 'public', 'backup.zip'), 'PK');
  expectValidatorFailure(artifact, { code: 72, message: /backup\.zip/ });
  fs.rmSync(path.join(artifact, 'public', 'backup.zip'));

  // 发布目录采用明确允许清单：清单之外的顶层条目与翻译目录多余文件都必须拒绝。
  fs.writeFileSync(path.join(artifact, 'notes.txt'), 'extra');
  expectValidatorFailure(artifact, { code: 72, message: /notes\.txt/ });
  fs.rmSync(path.join(artifact, 'notes.txt'));
  fs.writeFileSync(path.join(artifact, 'translation-service-poc', 'NOTES.md'), 'extra');
  expectValidatorFailure(artifact, { code: 72, message: /NOTES\.md/ });
  fs.rmSync(path.join(artifact, 'translation-service-poc', 'NOTES.md'));

  // 不存在的路径命中“目录不存在”分支（67）；这是独立分支，
  // 不得被当作已经测到生产路径阻断（65）的证据。
  expectValidatorFailure('/srv/jm-web/../jm-web', {
    code: 67,
    message: /目录不存在/,
  });

  // 生产路径阻断分支必须有真实存在的目录命中：通过仅增不减排除法注入受保护前缀，
  // 用隔离临时目录验证规范化后的阻断逻辑（65），不依赖生产目录真实存在。
  const blockedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jmw-blocked-root-'));
  try {
    const inner = path.join(blockedRoot, 'inner');
    fs.mkdirSync(inner, { recursive: true });
    const blockedPrefix = normalizeViaBash(blockedRoot);
    expectValidatorFailure(inner, {
      env: { JMW_RELEASE_EXTRA_BLOCKED_PATHS: blockedPrefix },
      code: 65,
      message: /生产路径/,
    });
  } finally {
    fs.rmSync(blockedRoot, { recursive: true, force: true });
  }

  // current 是目录软链接：不能先 realpath 制品，再仅拿未解析的 current 前缀比较。
  const aliasRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jmw-blocked-alias-'));
  try {
    const release = path.join(aliasRoot, 'releases', 'candidate');
    const current = path.join(aliasRoot, 'current');
    fs.mkdirSync(path.join(release, 'inner'), { recursive: true });
    fs.symlinkSync(release, current, process.platform === 'win32' ? 'junction' : 'dir');
    const protectedAlias = `${normalizeViaBash(aliasRoot)}/current`;
    for (const input of [path.join(current, 'inner'), path.join(release, 'inner')]) {
      expectValidatorFailure(input, {
        env: { JMW_RELEASE_EXTRA_BLOCKED_PATHS: protectedAlias },
        code: 65,
        message: /生产路径/,
      });
    }
  } finally {
    fs.rmSync(aliasRoot, { recursive: true, force: true });
  }

  // 负向用例全部还原后，最小合法制品必须重新通过校验。
  assert.match(runValidator(artifact), /RELEASE-MANIFEST: PASS/);
} finally {
  fs.rmSync(artifact, { recursive: true, force: true });
}

console.log('deployment hardening checks pass');
