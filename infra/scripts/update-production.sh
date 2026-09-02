#!/usr/bin/env bash
# 在 Ubuntu 生产服务器执行：备份 -> 拉取 GitHub -> 重建容器 -> 健康检查。
# 不会自动执行 Prisma db push 或未知 SQL；检测到数据库目录变更时会安全停止。
set -Eeuo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.server.yml}"
ENV_FILE="${ENV_FILE:-.env.production}"
REMOTE_NAME="${REMOTE_NAME:-origin}"
UPDATE_BRANCH="${UPDATE_BRANCH:-main}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3340/api/health/ready}"
HEALTH_RETRIES="${HEALTH_RETRIES:-30}"

usage() {
  cat <<'EOF'
用法：./infra/scripts/update-production.sh [--yes]

环境变量（可选）：
  UPDATE_BRANCH=main             要部署的 Git 分支
  BACKUP_DIR=/var/backups/...    传给备份脚本的目标目录
  COMPOSE_FILE=docker-compose.server.yml
  ENV_FILE=.env.production
  HEALTH_URL=http://127.0.0.1:3340/api/health/ready

发现 apps/api/prisma/ 有变更时，脚本不会更新：请先备份、审查并手动执行迁移。
EOF
}

assert_no_processing_jobs() {
  local processing_jobs
  processing_jobs="$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T postgres sh -c \
    'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT count(*) FROM \"ShipmentDispatchJob\" WHERE status = '\''PROCESSING'\'';"')"
  processing_jobs="${processing_jobs//[[:space:]]/}"
  if [[ "$processing_jobs" != "0" ]]; then
    echo "错误：存在 $processing_jobs 个正在处理的自动打单任务。为避免中断供应商调用，本次更新已停止。" >&2
    echo "请等待任务完成，或在后台人工核查后再更新。" >&2
    exit 4
  fi
}

assume_yes=false
case "${1:-}" in
  "") ;;
  --yes) assume_yes=true ;;
  -h|--help) usage; exit 0 ;;
  *) echo "错误：不支持的参数：$1" >&2; usage >&2; exit 2 ;;
esac

cd "$PROJECT_DIR"

for required in "$COMPOSE_FILE" "$ENV_FILE"; do
  if [[ ! -f "$required" ]]; then
    echo "错误：未找到 $PROJECT_DIR/$required" >&2
    exit 1
  fi
done
if ! command -v docker >/dev/null 2>&1 || ! command -v git >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
  echo "错误：服务器需要安装 docker、git 与 curl。" >&2
  exit 1
fi
if [[ -n "$(git status --porcelain)" ]]; then
  echo "错误：仓库存在未提交的非忽略改动。请先处理后再更新：" >&2
  git status --short >&2
  exit 1
fi

echo "校验 Compose 配置..."
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" config -q

echo "获取 $REMOTE_NAME/$UPDATE_BRANCH 最新提交..."
git fetch "$REMOTE_NAME" "$UPDATE_BRANCH"
if git diff --quiet HEAD.."$REMOTE_NAME/$UPDATE_BRANCH"; then
  echo "当前服务器已经是最新版本，无需更新。"
  exit 0
fi

echo "待部署提交："
git log --oneline HEAD.."$REMOTE_NAME/$UPDATE_BRANCH"

if ! git diff --quiet HEAD.."$REMOTE_NAME/$UPDATE_BRANCH" -- apps/api/prisma/; then
  echo "错误：本次更新包含 apps/api/prisma/ 数据库结构或迁移文件变更。" >&2
  echo "为保护真实订单与余额，脚本不会自动更新。请先备份、审查 SQL、手动完成迁移后再部署。" >&2
  git diff --name-only HEAD.."$REMOTE_NAME/$UPDATE_BRANCH" -- apps/api/prisma/ >&2
  exit 3
fi

assert_no_processing_jobs

if [[ "$assume_yes" != true ]]; then
  read -r -p "将先备份并部署以上提交，是否继续？[y/N] " confirmation
  [[ "$confirmation" =~ ^[Yy]$ ]] || { echo "已取消。"; exit 0; }
fi

echo "执行数据库备份..."
bash "$PROJECT_DIR/infra/scripts/backup-production.sh"

echo "拉取代码..."
git pull --ff-only "$REMOTE_NAME" "$UPDATE_BRANCH"

echo "构建新镜像..."
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" build

# 构建期间仍可能有新订单进入队列；启动新 Worker 前再检查一次。
assert_no_processing_jobs

echo "启动新版本服务..."
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d

echo "等待 API 就绪..."
for ((attempt = 1; attempt <= HEALTH_RETRIES; attempt++)); do
  if curl --fail --silent --show-error --max-time 5 "$HEALTH_URL"; then
    echo
    echo "更新完成。"
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps
    exit 0
  fi
  sleep 2
done

echo "错误：容器已启动，但 API 在 $((HEALTH_RETRIES * 2)) 秒内未就绪。请检查日志：" >&2
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" logs --tail=120 api worker >&2
exit 5
