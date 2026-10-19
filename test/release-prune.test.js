'use strict';

// 发布残留清理脚本的文件系统回归：默认 dry-run 不删除；--apply 只删除过期
// Release / incoming 条目 / 过期候选数据，绝不触碰 current、data/、shared/。
// Docker 步骤需要真实守护进程，这里用 --no-docker 隔离。

const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const script = path.join(root, 'scripts', 'prune-release-leftovers.sh');
assert.ok(fs.statSync(script).isFile(), '缺少发布残留清理脚本');
if (process.platform !== 'win32') {
  assert.ok(fs.statSync(script).mode & 0o111, '清理脚本必须可执行');
}

// 与 deployment.test.js 相同：Windows 上跟随 Git 安装定位 Git Bash，不使用 WSL bash。
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
  throw new Error('Windows 清理脚本回归需要 Git for Windows 的 Git Bash，不能使用 WSL bash');
})();
const toPosixPath = (value) => (process.platform === 'win32' ? String(value).replace(/\\/g, '/') : String(value));

function run(args) {
  try {
    return { code: 0, out: execFileSync(bashCommand, [toPosixPath(script), ...args], { encoding: 'utf8', stdio: 'pipe' }) };
  } catch (error) {
    return { code: error.status, out: `${error.stdout || ''}${error.stderr || ''}` };
  }
}

const ids = [
  '20260901T010000Z-aaaaaaaaaaaa-111111111111',
  '20260902T010000Z-bbbbbbbbbbbb-222222222222',
  '20260903T010000Z-cccccccccccc-333333333333',
  '20260904T010000Z-dddddddddddd-444444444444',
  '20260905T010000Z-eeeeeeeeeeee-555555555555',
  '20260906T010000Z-ffffffffffff',
  '20260907T010000Z-1234567-123456789abc',
  '20260908T010000Z-abcdef012345-666666666666',
];
const pendingId = '20260909T010000Z-999999999999-777777777777';
const currentId = ids[5];

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jmw-prune-test-'));
try {
  const releases = path.join(base, 'releases');
  for (const id of ids) {
    fs.mkdirSync(path.join(releases, id, 'public'), { recursive: true });
    fs.writeFileSync(path.join(releases, id, 'server.js'), id);
  }
  fs.symlinkSync(path.join(releases, currentId), path.join(base, 'current'),
    process.platform === 'win32' ? 'junction' : 'dir');
  const incoming = path.join(base, 'incoming');
  fs.mkdirSync(incoming);
  const incomingEntries = {
    [`${ids[0]}.tar.gz`]: 'file',
    [`${ids[0]}.tar.gz.sha256`]: 'file',
    [`prepare-${ids[1]}.sh`]: 'file',
    [`failed-release-${ids[2]}`]: 'dir',
    [`${ids[6]}.tar.gz`]: 'file',
    [`${ids[7]}-seed`]: 'dir',
    [`${pendingId}.tar.gz`]: 'file',
    'repack-150901': 'dir',
  };
  for (const [name, kind] of Object.entries(incomingEntries)) {
    if (kind === 'dir') fs.mkdirSync(path.join(incoming, name));
    else fs.writeFileSync(path.join(incoming, name), name);
  }
  const twoDaysAgo = new Date(Date.now() - 48 * 3600 * 1000);
  const staleCandidate = path.join(base, `.candidate-data-${ids[3]}`);
  const freshCandidate = path.join(base, `.candidate-data-${ids[7]}`);
  fs.mkdirSync(path.join(staleCandidate, 'sessions'), { recursive: true });
  fs.mkdirSync(freshCandidate);
  fs.utimesSync(staleCandidate, twoDaysAgo, twoDaysAgo);
  for (const dir of ['data', 'shared']) {
    fs.mkdirSync(path.join(base, dir, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(base, dir, '.secret'), 'keep-me');
  }
  const snapshot = () => ({
    releases: fs.readdirSync(releases).sort(),
    incoming: fs.readdirSync(incoming).sort(),
    top: fs.readdirSync(base).sort(),
  });

  // 参数与根目录校验。
  assert.strictEqual(run([]).code, 64, '缺少 --root 必须拒绝');
  assert.strictEqual(run(['--root', toPosixPath(base), '--keep', '0', '--no-docker']).code, 64);
  const notRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jmw-prune-not-root-'));
  try {
    const refused = run(['--root', toPosixPath(notRoot), '--no-docker']);
    assert.strictEqual(refused.code, 65, '缺少 releases/current 的目录不得被当作生产根目录');
  } finally {
    fs.rmSync(notRoot, { recursive: true, force: true });
  }

  // 默认 dry-run：列出计划但不删除任何内容。
  const before = snapshot();
  const dry = run(['--root', toPosixPath(base), '--keep', '2', '--no-docker']);
  assert.strictEqual(dry.code, 0, dry.out);
  assert.match(dry.out, /DRY-RUN/);
  for (const id of ids.slice(0, 5)) assert.match(dry.out, new RegExp(`PLAN    release ${id}`));
  assert.match(dry.out, /SKIP    incoming\/repack-150901/);
  assert.deepStrictEqual(snapshot(), before, 'dry-run 不得删除任何内容');

  // --apply：current 与最新 2 个保留；更早的 Release、incoming 条目与过期候选数据删除。
  const applied = run(['--root', toPosixPath(base), '--keep', '2', '--no-docker', '--apply']);
  assert.strictEqual(applied.code, 0, applied.out);
  const after = snapshot();
  assert.deepStrictEqual(after.releases, [ids[5], ids[6], ids[7]]);
  assert.deepStrictEqual(after.incoming, [
    `${ids[6]}.tar.gz`, `${ids[7]}-seed`, `${pendingId}.tar.gz`, 'repack-150901',
  ].sort(), '只删除比最旧保留 Release 更早的 incoming 条目；进行中的发布和无法识别的条目保留');
  assert.ok(!fs.existsSync(staleCandidate), '过期候选数据目录应删除');
  assert.ok(fs.existsSync(freshCandidate), '未过期候选数据目录可能属于进行中的发布，必须保留');
  for (const dir of ['data', 'shared']) {
    assert.strictEqual(fs.readFileSync(path.join(base, dir, '.secret'), 'utf8'), 'keep-me', `${dir}/ 不得被触碰`);
  }
  assert.strictEqual(fs.readFileSync(path.join(base, 'current', 'server.js'), 'utf8'), currentId, 'current 必须仍然有效');

  // 再次执行应无事可做（幂等）。
  const again = run(['--root', toPosixPath(base), '--keep', '2', '--no-docker', '--apply']);
  assert.strictEqual(again.code, 0, again.out);
  assert.match(again.out, /已删除 0 \/ 计划 0 项/);
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}

console.log('release prune checks pass');
