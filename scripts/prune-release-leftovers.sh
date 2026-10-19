#!/usr/bin/env bash
set -euo pipefail

# 清理 jm-web 发布残留：过期 Release、incoming 中的旧制品/脚本、候选数据目录、
# 候选容器与候选镜像，以及（显式开启时）Docker 构建缓存。
#
# 默认只打印计划（dry-run），必须显式 --apply 才会删除。无论参数如何，
# 都不会触碰 data/、shared/、current 指向的 Release 或运行中容器引用的 Release。
#
# 脚本不在发布制品内；生产执行时从开发工作区经 SSH 传入：
#   ssh <host> 'bash -s -- --root /home/shixian/project/jm-web' < scripts/prune-release-leftovers.sh
#   ssh <host> 'bash -s -- --root /home/shixian/project/jm-web --apply' < scripts/prune-release-leftovers.sh

usage() {
  cat >&2 <<'USAGE'
用法: prune-release-leftovers.sh --root <生产根目录> [选项]
  --keep N                     除 current 外保留最新的 N 个 Release（默认 5）
  --candidate-max-age-hours N  候选容器/镜像/数据目录超过 N 小时才视为残留（默认 24）
  --prune-build-cache          同时清理 7 天前的 Docker 构建缓存（影响同机其他项目的构建缓存）
  --no-docker                  只处理文件系统（测试或无 Docker 权限时使用）
  --apply                      实际执行删除；缺省只打印计划
USAGE
}

root=""
keep=5
apply=0
use_docker=1
prune_build_cache=0
candidate_max_age_hours=24

while [[ $# -gt 0 ]]; do
  case "$1" in
    --root) root="${2:-}"; shift 2 ;;
    --keep) keep="${2:-}"; shift 2 ;;
    --candidate-max-age-hours) candidate_max_age_hours="${2:-}"; shift 2 ;;
    --prune-build-cache) prune_build_cache=1; shift ;;
    --no-docker) use_docker=0; shift ;;
    --apply) apply=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数: $1" >&2; usage; exit 64 ;;
  esac
done

if [[ -z "$root" ]]; then
  echo "必须用 --root 指定生产根目录" >&2
  usage
  exit 64
fi
if ! [[ "$keep" =~ ^[0-9]+$ ]] || (( keep < 1 )); then
  echo "--keep 必须是不小于 1 的整数" >&2
  exit 64
fi
if ! [[ "$candidate_max_age_hours" =~ ^[0-9]+$ ]]; then
  echo "--candidate-max-age-hours 必须是非负整数" >&2
  exit 64
fi
if [[ ! -d "$root" || -L "$root" ]]; then
  echo "根目录不存在或是符号链接: $root" >&2
  exit 65
fi
root="$(cd -- "$root" && pwd -P)"
if [[ "$root" == "/" || "$root" == "/srv/jm-web" || "$root" == /srv/jm-web/* ]]; then
  echo "拒绝已停用或不安全的根目录: $root" >&2
  exit 65
fi
if [[ ! -d "$root/releases" || -L "$root/releases" || ! -e "$root/current" ]]; then
  echo "不像 jm-web 生产根目录（缺少 releases/ 或 current）: $root" >&2
  exit 65
fi
releases_dir="$(cd -- "$root/releases" && pwd -P)"
current_target="$(cd -- "$root/current" && pwd -P)"
if [[ "$(dirname -- "$current_target")" != "$releases_dir" ]]; then
  echo "current 未指向 releases/ 下的 Release，停止: $current_target" >&2
  exit 65
fi
current_id="$(basename -- "$current_target")"

release_id_re='^[0-9]{8}T[0-9]{6}Z(-[0-9a-f]+)+$'
# 从 incoming 条目名中提取 Release 时间戳（YYYYMMDDTHHMMSSZ）。
stamp_re='([0-9]{8}T[0-9]{6}Z)'
now_epoch="$(date +%s)"
max_age_seconds=$(( candidate_max_age_hours * 3600 ))
mode="DRY-RUN"
(( apply )) && mode="APPLY"
removed=0
planned=0

act() {
  # act <描述> <命令...>
  local description="$1"
  shift
  planned=$((planned + 1))
  if (( apply )); then
    if "$@"; then
      echo "REMOVED $description"
      removed=$((removed + 1))
    else
      echo "FAILED  $description" >&2
    fi
  else
    echo "PLAN    $description"
  fi
}

echo "== jm-web 发布残留清理（$mode） root=$root keep=$keep current=$current_id"

# ---------- 受保护的 Release：current、最新 N 个、容器 Compose 工作目录 ----------
declare -A protected=()
protected["$current_id"]=1
mapfile -t release_ids < <(
  find "$releases_dir" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | grep -E "$release_id_re" | sort
)
newest=()
for (( i=${#release_ids[@]}-1; i>=0 && ${#newest[@]}<keep; i-- )); do
  id="${release_ids[$i]}"
  [[ "$id" == "$current_id" ]] && continue
  newest+=("$id")
  protected["$id"]=1
done

declare -A container_names=()
if (( use_docker )); then
  if ! command -v docker >/dev/null 2>&1; then
    echo "找不到 docker；如只需清理文件系统请使用 --no-docker" >&2
    exit 69
  fi
  while IFS=$'\t' read -r name workdir; do
    [[ -n "$name" ]] && container_names["$name"]=1
    if [[ "$workdir" == "$releases_dir"/* || "$workdir" == "$root/releases"/* ]]; then
      id="$(basename -- "$workdir")"
      [[ -z "${protected[$id]:-}" ]] && echo "KEEP    release $id（被容器 $name 引用）"
      protected["$id"]=1
    fi
  done < <(docker ps -a --format '{{.Names}}{{"\t"}}{{.Label "com.docker.compose.project.working_dir"}}')
fi

oldest_kept=""
for id in "${!protected[@]}"; do
  if [[ -z "$oldest_kept" || "$id" < "$oldest_kept" ]]; then oldest_kept="$id"; fi
done
oldest_kept_stamp="${oldest_kept:0:16}"
echo "保留 Release: $(printf '%s\n' "${!protected[@]}" | sort | tr '\n' ' ')"

# ---------- releases/ ----------
for id in "${release_ids[@]}"; do
  [[ -n "${protected[$id]:-}" ]] && continue
  target="$releases_dir/$id"
  [[ -L "$target" ]] && continue
  act "release $id" rm -rf -- "$target"
done

# ---------- incoming/：比最旧保留 Release 更早的制品、脚本和解包目录 ----------
if [[ -d "$root/incoming" && ! -L "$root/incoming" ]]; then
  incoming_dir="$(cd -- "$root/incoming" && pwd -P)"
  while IFS= read -r name; do
    if [[ "$name" =~ $stamp_re ]]; then
      stamp="${BASH_REMATCH[1]}"
      # 保留 Release 自身的制品；更新的条目可能是进行中的发布，同样保留。
      if [[ "$stamp" < "$oldest_kept_stamp" ]]; then
        act "incoming/$name" rm -rf -- "$incoming_dir/$name"
      fi
    else
      echo "SKIP    incoming/$name（无法识别 Release 时间戳，需人工确认）"
    fi
  done < <(find "$incoming_dir" -mindepth 1 -maxdepth 1 ! -type l -printf '%f\n' | sort)
fi

# ---------- 候选容器 ----------
if (( use_docker )); then
  while IFS=$'\t' read -r name state created; do
    [[ -z "$name" ]] && continue
    created_epoch="$(date -d "$created" +%s 2>/dev/null || echo "$now_epoch")"
    age=$(( now_epoch - created_epoch ))
    if [[ "$state" != "running" || $age -ge $max_age_seconds ]]; then
      act "container $name（$state，$(( age / 3600 ))h）" docker rm -f "$name"
      unset 'container_names[$name]'
    else
      echo "KEEP    container $name（运行中且未超过 ${candidate_max_age_hours}h，可能是进行中的发布）"
    fi
  done < <(docker ps -a --filter 'name=^jm-web-candidate-' \
    --format '{{.Names}}{{"\t"}}{{.State}}{{"\t"}}{{.CreatedAt}}' \
    | sed -E 's/ [A-Z]{3,5}$//')
fi

# ---------- 候选数据目录（仅候选容器使用的合成数据） ----------
while IFS= read -r name; do
  id="${name#.candidate-data-}"
  [[ "$id" =~ $release_id_re ]] || { echo "SKIP    $name（名称不符合候选数据目录格式）"; continue; }
  if [[ -n "${container_names[jm-web-candidate-$id]:-}" ]]; then
    echo "KEEP    $name（候选容器仍存在）"
    continue
  fi
  mtime="$(stat -c %Y -- "$root/$name")"
  if (( now_epoch - mtime >= max_age_seconds )); then
    act "$name" rm -rf -- "$root/$name"
  else
    echo "KEEP    $name（未超过 ${candidate_max_age_hours}h）"
  fi
done < <(find "$root" -mindepth 1 -maxdepth 1 -type d -name '.candidate-data-*' -printf '%f\n' | sort)

# ---------- 候选镜像（不被任何容器使用） ----------
if (( use_docker )); then
  declare -A used_images=()
  while IFS= read -r image_id; do
    [[ -n "$image_id" ]] && used_images["$image_id"]=1
  done < <(docker ps -aq | xargs -r docker inspect -f '{{.Image}}')
  while IFS=$'\t' read -r ref image_id created; do
    [[ -z "$ref" || "$ref" == *"<none>"* ]] && continue
    if [[ -n "${used_images[$image_id]:-}" ]]; then
      echo "KEEP    image $ref（被容器使用）"
      continue
    fi
    created_epoch="$(date -d "$created" +%s 2>/dev/null || echo "$now_epoch")"
    if (( now_epoch - created_epoch < max_age_seconds )); then
      echo "KEEP    image $ref（未超过 ${candidate_max_age_hours}h）"
      continue
    fi
    # 按标签删除且不加 -f：镜像仍被引用时 Docker 会拒绝。
    act "image $ref" docker rmi "$ref"
  done < <(docker images --no-trunc --format '{{.Repository}}:{{.Tag}}{{"\t"}}{{.ID}}{{"\t"}}{{.CreatedAt}}' \
    | grep -E '^jm-web[^:]*(candidate[^:]*:|:candidate-)' \
    | sed -E 's/ [A-Z]{3,5}$//')

  if (( prune_build_cache )); then
    act "docker build cache older than 7d" docker builder prune --force --filter until=168h
  fi
fi

if (( apply )); then
  echo "== 完成：已删除 $removed / 计划 $planned 项"
else
  echo "== 计划 $planned 项；确认无误后加 --apply 执行"
fi
