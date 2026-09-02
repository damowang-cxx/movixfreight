# Movix Freight Ubuntu 24.04 生产环境部署方案（已验证）

本方案来自 `movixfreight.com` 的实际成功部署，适用于同一台 Ubuntu 服务器已有多个线上服务、由宿主机 Nginx 统一监听 `80/443` 的场景。

> 使用本方案时，统一使用 `docker-compose.server.yml` 和本文件的 `3340–3342` 端口；不要和旧版 `docker-compose.production.yml` 的 `3301–3303` 端口方案混用。

## 架构与端口

```text
公网 HTTPS
  -> 宿主机 Nginx :80 / :443
     -> /api/   -> 127.0.0.1:3340 (NestJS API)
     -> /admin/ -> 127.0.0.1:3341 (管理员端)
     -> /       -> 127.0.0.1:3342 (客户门户)

Docker 内部网络：PostgreSQL 5432、Redis 6379、Worker
```

旧 Movix 服务使用的 `3333` 可在切流初期保留，用于 Nginx 回滚。3340–3342 必须仅绑定 `127.0.0.1`；PostgreSQL 与 Redis 不映射宿主机端口。

## 1. 前置检查与代码目录

实际部署目录为 `/home/ubuntu/movixfreight`：

```bash
cd ~/movixfreight
docker --version
docker compose version
sudo nginx -t
sudo ss -ltnp | grep -E ':3333|:3340|:3341|:3342' || true
git status
git log -1 --oneline
```

预期旧服务可占用 `3333`，3340–3342 应为空闲。不要对未知进程直接执行 `kill -9`。

## 2. 生产密钥文件

创建 `.env.production`，并仅保存在服务器：

```dotenv
NODE_ENV=production
PORT=3000
POSTGRES_USER=movix_prod
POSTGRES_PASSWORD=<独立的高强度数据库密码>
POSTGRES_DB=movix_freight
REDIS_PASSWORD=<独立的高强度 Redis 密码>
JWT_SECRET=<至少 32 字节的随机密钥>
JWT_EXPIRES_IN_SECONDS=28800
CORS_ORIGINS=https://movixfreight.com,https://www.movixfreight.com
CONNECTOR_CONFIG_PATH=/run/secrets/connectors.json
MOVIX_DOMAIN=movixfreight.com
DISPATCH_WORKER_CONCURRENCY=1
```

随机值可用 `openssl rand -hex 32` 生成，三种密码/密钥不得复用。

生产供应商凭据文件：

```bash
cp config/connectors.local.example.json config/connectors.production.json
chmod 600 .env.production config/connectors.production.json
```

在 `connectors.production.json` 中填写 Ship-API Direct/FedEx 的 Production profile、账号和发件人资料；生产资料未确认前保持该 profile `enabled: false`。仓库已忽略上述两个密钥文件，不能将其提交进 Git。

## 3. 已验证的 Docker 构建约束

仓库 Dockerfile 已包含以下必要修正，不要回退：

1. API Dockerfile 先执行 `pnpm --filter @movix/pricing-engine build`，再生成 Prisma Client 和编译 API；否则会出现 `Cannot find module '@movix/pricing-engine'`。
2. Web Dockerfile 在 Nginx 最终阶段重新声明 `ARG APP`；否则会出现 `/app/apps//dist not found`。

检查 Compose：

```bash
docker compose --env-file .env.production -f docker-compose.server.yml config -q
```

无输出并返回 shell 代表 YAML 校验成功。

## 4. 首次建立生产数据库

先构建，并只启动数据库和 Redis：

```bash
docker compose --env-file .env.production -f docker-compose.server.yml build
docker compose --env-file .env.production -f docker-compose.server.yml up -d postgres redis
docker compose --env-file .env.production -f docker-compose.server.yml ps
```

当前仓库尚未建立完整的 Prisma migrations 历史。**仅首次初始化空数据库**时，用项目自带 Prisma 6 执行 `db push`：

```bash
docker compose --env-file .env.production -f docker-compose.server.yml run --rm api \
  ./apps/api/node_modules/.bin/prisma db push --schema apps/api/prisma/schema.prisma
```

不要使用宿主机 `prisma`，也不要用可能下载其他版本的 `npx prisma`。之后执行生产就绪 SQL：

```bash
docker compose --env-file .env.production -f docker-compose.server.yml run --rm api \
  ./apps/api/node_modules/.bin/prisma db execute \
  --schema apps/api/prisma/schema.prisma \
  --file apps/api/prisma/migrate-production-readiness.sql
```

真实生产库有业务数据后，禁止把 `db push` 当作日常更新手段；更新前必须备份、审查 Schema 差异与 SQL，再执行经过审阅的迁移。

## 5. 初始化管理员

管理员与客户登录入口不同。创建超级管理员时，密码不写入 shell 历史：

```bash
export ADMIN_BOOTSTRAP_USERNAME=movix
read -s -p '请输入管理员初始密码: ' ADMIN_BOOTSTRAP_PASSWORD
echo
export ADMIN_BOOTSTRAP_PASSWORD
docker compose --env-file .env.production -f docker-compose.server.yml run --rm \
  -e ADMIN_BOOTSTRAP_USERNAME -e ADMIN_BOOTSTRAP_PASSWORD api \
  ./apps/api/node_modules/.bin/tsx apps/api/prisma/seed.ts
unset ADMIN_BOOTSTRAP_USERNAME ADMIN_BOOTSTRAP_PASSWORD
```

Seed 会创建 `SUPER_ADMIN`；同名管理员存在时不会覆盖其密码。核对账号：

```bash
docker compose --env-file .env.production -f docker-compose.server.yml exec -T postgres sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT \"username\", \"enabled\" FROM \"AdminUser\";"'
```

## 6. 启动、检查与本机验收

```bash
docker compose --env-file .env.production -f docker-compose.server.yml up -d --build
docker compose --env-file .env.production -f docker-compose.server.yml ps
curl http://127.0.0.1:3340/api/health
curl http://127.0.0.1:3340/api/health/ready
curl -I http://127.0.0.1:3341/
curl -I http://127.0.0.1:3342/
docker compose --env-file .env.production -f docker-compose.server.yml logs --tail=100 api worker
```

`/api/health/ready` 内 `workerEnabled: false` 是 API 容器的正常状态；独立 Worker 容器应使用 `DISPATCH_WORKER_ENABLED=true`。

## 7. 宿主机 Nginx

切流前备份现有站点：

```bash
sudo cp /etc/nginx/sites-available/movixfreight \
  /etc/nginx/sites-available/movixfreight.bak-$(date +%Y%m%d-%H%M%S)
```

`/etc/nginx/sites-available/movixfreight` 使用如下核心配置（证书路径沿用服务器现有路径）：

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    '' close;
}

server {
    listen 80;
    listen [::]:80;
    server_name movixfreight.com www.movixfreight.com;
    return 301 https://movixfreight.com$request_uri;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name movixfreight.com www.movixfreight.com;
    ssl_certificate /etc/nginx/ssl/movixfreight.com/movixfreight.com.pem;
    ssl_certificate_key /etc/nginx/ssl/movixfreight.com/movixfreight.com.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    client_max_body_size 100M;
    access_log /var/log/nginx/movixfreight.com.access.log;
    error_log /var/log/nginx/movixfreight.com.error.log;

    location = /api/docs { return 404; }
    location ^~ /api/docs/ { return 404; }

    location /api/ {
        proxy_pass http://127.0.0.1:3340;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Port $server_port;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }

    location = /admin { return 301 /admin/; }
    location /admin/ {
        proxy_pass http://127.0.0.1:3341/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }

    location / {
        proxy_pass http://127.0.0.1:3342;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
```

`map` 必须由 Nginx 的 `http` 上下文加载；Ubuntu 默认将 `sites-enabled/*` include 在该上下文，因此本服务器当前方式可用。保存后必须先测试再重载：

```bash
sudo nginx -t
sudo systemctl reload nginx
```

不要优先 `restart nginx`，因为服务器还承载其他站点。

## 8. 域名验收、登录与回滚

```bash
curl https://movixfreight.com/api/health
curl https://movixfreight.com/api/health/ready
curl -I https://movixfreight.com/
curl -I https://movixfreight.com/admin/
```

- 管理员必须在 `https://movixfreight.com/admin/` 登录，调用 `POST /api/auth/admin/login`。
- 根路径是客户门户，调用 `POST /api/auth/customer/login`；将管理员账号填入客户门户会得到正常的 `401`。
- 新版本有严重故障时，恢复 `movixfreight.bak-<时间戳>`，`nginx -t` 后 reload，即可切回尚在运行的 3333 旧服务。Nginx 回滚不等于数据库或真实业务数据回滚。

## 9. 一键更新、备份与日常操作

仓库提供两个服务器运维脚本：

```bash
chmod 700 infra/scripts/backup-production.sh infra/scripts/update-production.sh
```

日常更新顺序为：本地完成验证并推送 GitHub 后，服务器只需执行：

```bash
cd ~/movixfreight
./infra/scripts/update-production.sh
```

脚本会校验 Compose、拉取远程提交、发现数据库目录变更时安全停止、检查是否存在 `PROCESSING` 自动打单任务、备份 PostgreSQL、重建容器并轮询本机 API 就绪状态。确认提示可用 `--yes` 跳过：

```bash
./infra/scripts/update-production.sh --yes
```

如果更新涉及 `apps/api/prisma/`，脚本会在拉取前停止；必须按数据库变更流程手工审查/执行 SQL，不能让脚本自动执行 `db push`。

单独备份数据库：

```bash
./infra/scripts/backup-production.sh
```

每日备份数据库到 `/var/backups/movixfreight`，并保留 14 天：

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$HOME/movixfreight"
set -a; source .env.production; set +a
BACKUP_DIR="/var/backups/movixfreight"
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"
docker compose --env-file .env.production -f docker-compose.server.yml exec -T postgres \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc \
  > "$BACKUP_DIR/movix-freight-$STAMP.dump"
find "$BACKUP_DIR" -type f -name 'movix-freight-*.dump' -mtime +14 -delete
```

常用命令：

```bash
docker compose --env-file .env.production -f docker-compose.server.yml ps
docker compose --env-file .env.production -f docker-compose.server.yml logs --tail=200 api
docker compose --env-file .env.production -f docker-compose.server.yml logs --tail=200 worker
docker compose --env-file .env.production -f docker-compose.server.yml up -d --build
docker compose --env-file .env.production -f docker-compose.server.yml restart api worker
docker compose --env-file .env.production -f docker-compose.server.yml down
```

`down` 不会删除数据库卷；没有已验证备份时严禁执行 `down -v`。本机备份不构成异地灾备，后续应增加对象存储或另一台服务器副本。
