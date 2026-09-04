#!/usr/bin/env bash
set -euo pipefail

# 校验已打包的、不可变的运行制品。脚本只生成 PASS，不负责替代 docker build；
# 调用方必须在构建命令成功后显式传入 RELEASE_BUILD_STATUS=PASS。

artifact="${1:-}"
if [[ -z "$artifact" ]]; then
  echo "用法: RELEASE_BUILD_STATUS=PASS $0 <artifact-dir>" >&2
  exit 64
fi
if [[ "${RELEASE_BUILD_STATUS:-}" != "PASS" ]]; then
  echo "构建状态未确认：先成功构建，再设置 RELEASE_BUILD_STATUS=PASS" >&2
  exit 66
fi
if [[ ! -d "$artifact" || -L "$artifact" ]]; then
  echo "制品目录不存在或是符号链接: $artifact" >&2
  exit 67
fi
# 规范化后再做路径阻断，避免通过 `..` 或相对路径绕过生产目录保护。
artifact="$(cd -- "$artifact" && pwd -P)"
case "$artifact" in
  /srv/jm-web|/srv/jm-web/*)
    echo "拒绝已停用的生产路径: $artifact" >&2
    exit 65
    ;;
  /home/shixian/project/jm-web/current|/home/shixian/project/jm-web/current/*)
    echo "拒绝正在运行的生产 current: $artifact" >&2
    exit 65
    ;;
esac

required=(
  .dockerignore .env.example AGENT.md AGENTS.md Dockerfile LICENSE README.md
  docker-compose.yml lib package.json public server.js
)
for item in "${required[@]}"; do
  if [[ ! -e "$artifact/$item" || -L "$artifact/$item" ]]; then
    echo "制品缺少必需文件或目录: $item" >&2
    exit 68
  fi
done

node - "$artifact" <<'NODE'
try {
const fs = require('fs');
const path = require('path');
const root = path.resolve(process.argv[2]);
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg) || typeof pkg.name !== 'string') {
  throw new Error('package.json 不是有效运行清单');
}

// 递归检查路径，不能只看制品根目录：嵌套 data/.git/.env 同样可能携带
// 生产状态或凭据。符号链接一律拒绝，避免校验路径与实际打包内容不一致。
const forbiddenDirs = new Set(['.git', 'data', 'test', 'node_modules']);
const walk = (dir, relative = '') => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    const child = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`制品不得包含符号链接: ${childRelative}`);
    if (forbiddenDirs.has(entry.name) || entry.name === '.env'
        || (entry.name.startsWith('.env.') && entry.name !== '.env.example')) {
      throw new Error(`制品包含禁止内容: ${childRelative}`);
    }
    if (entry.isDirectory()) walk(child, childRelative);
    else if (entry.isFile() && /(?:\.log|\.secret|\.jsonl)$/i.test(entry.name)) {
      throw new Error(`制品包含日志或秘密文件: ${childRelative}`);
    }
  }
};
walk(root);

const docker = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
for (const [pattern, label] of [
  [/^COPY --chown=node:node package\.json server\.js LICENSE \.\/$/m, '入口文件'],
  [/^COPY --chown=node:node lib \.\/lib$/m, 'lib'],
  [/^COPY --chown=node:node public \.\/public$/m, 'public'],
]) {
  if (!pattern.test(docker)) throw new Error(`Dockerfile 未明确复制运行源: ${label}`);
}
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(72);
}
NODE

printf 'RELEASE-MANIFEST: PASS\nartifact=%s\n' "$(cd "$artifact" && pwd)"
