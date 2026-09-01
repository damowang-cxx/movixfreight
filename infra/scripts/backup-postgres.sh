#!/bin/sh
set -eu
: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"
backup_dir="${BACKUP_DIR:-/backups}"
mkdir -p "$backup_dir"
stamp="$(date +%Y%m%d-%H%M%S)"
PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -h "${POSTGRES_HOST:-postgres}" -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > "$backup_dir/movix-freight-$stamp.dump"
find "$backup_dir" -type f -name 'movix-freight-*.dump' -mtime +"${BACKUP_RETENTION_DAYS:-14}" -delete
