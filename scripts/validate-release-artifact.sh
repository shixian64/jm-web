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
blocked_prefixes=(
  "/srv/jm-web"
  "/home/shixian/project/jm-web/current"
)
# 仅供自动化测试注入额外受保护前缀（换行分隔）；
# 只会追加阻断目标，不能替换或移除内置的生产路径。
if [[ -n "${JMW_RELEASE_EXTRA_BLOCKED_PATHS:-}" ]]; then
  while IFS= read -r extra; do
    [[ -n "$extra" ]] && blocked_prefixes+=("$extra")
  done <<< "$JMW_RELEASE_EXTRA_BLOCKED_PATHS"
fi
for prefix in "${blocked_prefixes[@]}"; do
  if [[ "$artifact" == "$prefix" || "$artifact" == "$prefix"/* ]]; then
    echo "拒绝已停用或受保护的生产路径: $artifact" >&2
    exit 65
  fi
done

required=(
  .dockerignore .env.example AGENT.md AGENTS.md Dockerfile LICENSE README.md
  docker-compose.yml lib package.json package-lock.json public server.js
  translation-service-poc/.dockerignore translation-service-poc/Dockerfile
  translation-service-poc/requirements.txt translation-service-poc/pipeline.py
  translation-service-poc/service.py
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

// 发布制品使用明确的顶层允许清单：清单之外的任何顶层条目（含整个 .github/、
// 压缩包、备份）都视为多余内容拒绝，而不是仅依赖后缀黑名单猜异常文件。
const allowedTopLevel = new Set([
  '.dockerignore', '.env.example', 'AGENT.md', 'AGENTS.md', 'Dockerfile', 'LICENSE',
  'README.md', 'docker-compose.yml', 'lib', 'package.json', 'package-lock.json',
  'public', 'server.js', 'translation-service-poc',
]);
const allowedTranslation = new Set([
  '.dockerignore', 'Dockerfile', 'requirements.txt', 'pipeline.py', 'service.py',
]);
for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
  if (!allowedTopLevel.has(entry.name)) {
    throw new Error(`制品包含发布清单之外的顶层内容: ${entry.name}`);
  }
}
const translationDir = path.join(root, 'translation-service-poc');
for (const entry of fs.readdirSync(translationDir, { withFileTypes: true })) {
  if (!allowedTranslation.has(entry.name)) {
    throw new Error(`translation-service-poc 含非运行文件: ${entry.name}`);
  }
}

// 递归检查路径，不能只看制品根目录：嵌套 data/sessions/.git/.env 同样可能携带
// 生产状态或凭据。符号链接一律拒绝，避免校验路径与实际打包内容不一致。
const forbiddenDirs = new Set([
  '.git', 'data', 'test', 'tests', 'node_modules', '__pycache__',
  '.pytest_cache', 'cache', 'sessions',
]);
const isForbiddenFile = (name) => name === '.env'
  || name.endsWith('.env') // 覆盖 prod.env / production.env 等非点前缀环境备份
  || (name.startsWith('.env.') && name !== '.env.example')
  || /(?:\.log|\.secret|\.jsonl|\.pem|\.key|\.sql)$/i.test(name)
  || /(?:\.zip|\.tar|\.gz|\.tgz|\.7z|\.rar|\.xz|\.bz2)$/i.test(name) // 归档不进制品
  || /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/.test(name); // SSH 私钥材料
const walk = (dir, relative = '') => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    const child = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`制品不得包含符号链接: ${childRelative}`);
    if (forbiddenDirs.has(entry.name)) throw new Error(`制品包含禁止目录: ${childRelative}`);
    if (entry.isFile() && isForbiddenFile(entry.name)) {
      throw new Error(`制品包含日志、秘密或归档文件: ${childRelative}`);
    }
    if (entry.isDirectory()) walk(child, childRelative);
  }
};
walk(root);

const docker = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
for (const [pattern, label] of [
  [/^COPY --chown=node:node package\.json server\.js LICENSE \.\/$/m, '入口文件'],
  [/^COPY --chown=node:node package-lock\.json \.\/$/m, '锁文件'],
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
