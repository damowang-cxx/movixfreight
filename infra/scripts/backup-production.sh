#!/usr/bin/env bash
# 在 Ubuntu 生产服务器执行 PostgreSQL 备份。
# 默认项目根目录为本脚本所在目录向上两级，即 ~/movixfreight。
set -Eeuo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.server.yml}"
ENV_FILE="${ENV_FILE:-.env.production}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/movixfreight}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"

cd "$PROJECT_DIR"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "错误：未找到生产环境文件：$PROJECT_DIR/$ENV_FILE" >&2
  exit 1
fi
if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "错误：未找到 Compose 文件：$PROJECT_DIR/$COMPOSE_FILE" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

: "${POSTGRES_USER:?缺少 POSTGRES_USER}"
: "${POSTGRES_DB:?缺少 POSTGRES_DB}"

mkdir -p "$BACKUP_DIR"
if [[ ! -w "$BACKUP_DIR" ]]; then
  echo "错误：备份目录不可写：$BACKUP_DIR。请先设置目录所有者或使用 BACKUP_DIR 指定可写目录。" >&2
  exit 1
fi

stamp="$(date +%Y%m%d-%H%M%S)"
backup_file="$BACKUP_DIR/movix-freight-$stamp.dump"
temp_file="$backup_file.partial"
cleanup() { rm -f "$temp_file"; }
trap cleanup EXIT

echo "开始备份 PostgreSQL 到：$backup_file"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T postgres \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > "$temp_file"

if [[ ! -s "$temp_file" ]]; then
  echo "错误：备份文件为空，未保留本次备份。" >&2
  exit 1
fi

mv "$temp_file" "$backup_file"
trap - EXIT
find "$BACKUP_DIR" -type f -name 'movix-freight-*.dump' -mtime +"$RETENTION_DAYS" -delete
echo "备份完成：$backup_file"
