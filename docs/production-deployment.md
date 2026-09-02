# Movix Freight 生产部署操作手册（通用 Ubuntu + 宿主机 Nginx）

> 已在 `movixfreight.com` 的 Ubuntu 24.04 服务器完成验证的实际部署流程，请优先使用[已验证部署方案](ubuntu-24.04-verified-deployment.md)。它使用 `docker-compose.server.yml` 和 `3340–3342` 端口。本文件保留为通用部署参考，不能与该方案的端口和 Compose 文件混用。

本文适用于现有服务器已运行多个网站、且由宿主机 Nginx 统一监听 `80/443` 的情况。目标是**替换现有 `movixfreight.com -> 127.0.0.1:3333` 服务**，不影响 `yycargo.com`、`epix-logistics.com` 或其他站点。

部署后的访问入口：

| 用途 | 地址 | 容器本机端口 |
| --- | --- | --- |
| 客户门户 | `https://movixfreight.com/` | `127.0.0.1:3303` |
| 管理员端 | `https://movixfreight.com/admin/` | `127.0.0.1:3302` |
| API / Open API | `https://movixfreight.com/api/` | `127.0.0.1:3301` |

PostgreSQL、Redis 和 Worker 没有宿主机端口；只能由 Docker 内部网络访问。所有 3301–3303 端口都绑定在 `127.0.0.1`，不会暴露到公网。

> 本方案的数据库、Redis 和面单 PDF 均保存在本机 Docker 卷。没有异地灾备；服务器或磁盘丢失时不能保证恢复。

## 0. 上线前检查

需要具备：Ubuntu、Docker Engine 与 Docker Compose v2、宿主机 Nginx、已存在的 `movixfreight.com` 证书，以及能访问代码仓库的权限。

在服务器执行：

```bash
docker --version
docker compose version
sudo nginx -v
sudo systemctl enable --now docker
sudo ss -ltnp | grep -E ':3333|:3301|:3302|:3303' || true
```

`3333` 应是待替换的旧 Movix 服务；`3301`、`3302`、`3303` 必须未被使用。若已占用，请先确认占用者，**不要直接 kill 进程**：

```bash
sudo ss -ltnp '( sport = :3333 )'
docker ps --format 'table {{.Names}}\t{{.Ports}}\t{{.Status}}'
```

生产 FedEx 前还必须在 Ship-API Direct/FedEx 一侧取得真实生产凭据与标签授权。系统配置完整不代表上游已授权；实际 Validate/Create 的明确错误仍会阻止真实出单。

## 1. 上传代码并准备目录

以下以 `/opt/movixfreight` 为部署目录。首次部署：

```bash
sudo mkdir -p /opt/movixfreight
sudo chown "$USER":"$USER" /opt/movixfreight
git clone <你的仓库地址> /opt/movixfreight
cd /opt/movixfreight
```

已有目录时先备份现有 Nginx 站点配置，再更新代码：

```bash
sudo cp /etc/nginx/sites-available/movixfreight \
  /etc/nginx/sites-available/movixfreight.bak.$(date +%F-%H%M%S)
cd /opt/movixfreight
git fetch --all --prune
git pull --ff-only
```

## 2. 写入生产环境与供应商密钥

这两个文件含密钥，已经被 `.gitignore` 忽略，只应存在服务器上，权限必须收紧：

```bash
cd /opt/movixfreight
cp .env.production.example .env.production
cp config/connectors.local.example.json config/connectors.production.json
chmod 600 .env.production config/connectors.production.json
```

编辑 `.env.production`。至少替换所有 `replace-with-...` 值；密码和 JWT 密钥可生成如下：

```bash
openssl rand -base64 36
```

建议的关键值：

```dotenv
NODE_ENV=production
PORT=3000
POSTGRES_USER=movix_prod
POSTGRES_PASSWORD=<高强度数据库密码>
POSTGRES_DB=movix_freight
REDIS_PASSWORD=<高强度 Redis 密码>
JWT_SECRET=<至少 32 字符的随机密钥>
JWT_EXPIRES_IN_SECONDS=28800
CORS_ORIGINS=https://movixfreight.com,https://www.movixfreight.com
CONNECTOR_CONFIG_PATH=/run/secrets/connectors.json
DISPATCH_WORKER_CONCURRENCY=1
ADMIN_BOOTSTRAP_USERNAME=movix
ADMIN_BOOTSTRAP_PASSWORD=<首次管理员高强度密码>
```

编辑 `config/connectors.production.json`：

- 保留现有 `FEDEX_RELAY_SANDBOX_01`，它只供管理员联调使用。
- 填写 `FEDEX_RELAY_PRODUCTION_01` 的生产 `baseUrl`、`shipApiKey`、FedEx 生产账号和发件人资料，并把此 profile 的 `enabled` 改为 `true`。
- `baseUrl` 必须以 Ship-API Direct 提供的**生产地址**为准，不能把 Sandbox 地址复制过去。
- 生产供应商连接的“供应商编号”必须与 profile 名完全相同：`FEDEX_RELAY_PRODUCTION_01`。
- 不在数据库、管理端字段、浏览器环境变量或日志中填写/显示密钥。

## 3. 先建立并检查容器（不切流）

生产 Compose 已移除了占用 80/443 的 `gateway` 容器；它只启动应用组件。

```bash
cd /opt/movixfreight
docker compose -f docker-compose.production.yml build
docker compose -f docker-compose.production.yml up -d postgres redis api worker admin-web customer-web
docker compose -f docker-compose.production.yml ps
```

首次部署或代码带有数据库改动时执行迁移。迁移前请确认备份可用：

```bash
docker compose -f docker-compose.production.yml exec -T api \
  npx prisma db execute --schema apps/api/prisma/schema.prisma \
  --file apps/api/prisma/migrate-production-readiness.sql
```

首次部署还必须初始化管理员；没有这一步，管理员登录接口会正确返回 `401`。Seed 只会创建不存在的同名管理员，**不会覆盖已有管理员密码**：

```bash
docker compose -f docker-compose.production.yml exec -T api \
  npx tsx apps/api/prisma/seed.ts
```

确认管理员已经存在（不会显示密码或密码哈希）：

```bash
docker compose -f docker-compose.production.yml exec -T postgres \
  psql -U movix_prod -d movix_freight \
  -c 'SELECT username, enabled FROM "AdminUser";'
```

上例中的 `movix_prod` 与 `movix_freight` 请替换为 `.env.production` 中的实际值。管理员首次登录成功后，应将 `ADMIN_BOOTSTRAP_PASSWORD` 从 `.env.production` 删除或置空，再重启相关容器；它不参与日常登录，也不会自动重置密码。

检查容器和本机服务。任何一项失败时，不要替换 Nginx：

```bash
docker compose -f docker-compose.production.yml logs --tail=100 api worker
curl -fsS http://127.0.0.1:3301/api/health
curl -fsS http://127.0.0.1:3301/api/health/ready
curl -I http://127.0.0.1:3302/
curl -I http://127.0.0.1:3303/
```

`/api/health/ready` 必须显示 API、数据库和生产 profile 已就绪；Redis 与 Worker 运行状态需结合 `docker compose ... ps` 和 Worker 日志确认。Worker 正常运行但不需要监听公网端口。

## 4. 替换 `movixfreight.com` 的宿主机 Nginx 配置

项目已提供可直接使用的模板：`infra/nginx/movixfreight.host.conf.example`。它沿用你服务器当前证书路径，替换旧的 `127.0.0.1:3333` 单一代理。

```bash
sudo cp /opt/movixfreight/infra/nginx/movixfreight.host.conf.example \
  /etc/nginx/sites-available/movixfreight
sudo nginx -t
sudo systemctl reload nginx
```

该配置的路由关系为：

- `/` 转发至客户门户 `3303`；
- `/admin/` 转发至管理员端 `3302`；
- `/api/` 保留前缀并转发至 Nest API `3301`；
- `/api/docs` 被公网阻断。若需要查看 Swagger，请通过 SSH 隧道访问 `http://127.0.0.1:3301/api/docs`，或临时按公司固定出口 IP 放行。

切流后立即验证：

```bash
curl -I https://movixfreight.com/
curl -I https://movixfreight.com/admin/
curl -fsS https://movixfreight.com/api/health/ready
curl -I https://movixfreight.com/api/docs
```

最后一条应返回 `404`。浏览器还应分别验证：客户注册/登录、管理员登录、创建普通订单、生产服务可见性、管理员 Sandbox 服务可见性。

## 5. 确认后停止旧 3333 服务

只有步骤 4 全部通过后，才停止 3333 的旧服务。先使用第 0 步的命令确认它是 Docker 容器、systemd 服务还是其他进程，再按实际所有者停用。例如：

```bash
# 旧服务是 Docker Compose 项目时：在旧项目目录执行
docker compose down

# 旧服务是 systemd 单元时：将 <旧服务名> 替换为 ss/systemctl 查到的真实名称
sudo systemctl disable --now <旧服务名>
```

不要对未知 PID 使用 `kill -9`。停止后再次确认 `3333` 已释放：

```bash
sudo ss -ltnp '( sport = :3333 )'
```

## 6. 在后台完成生产业务配置

部署成功不会自动创建可销售的生产服务。管理员登录 `https://movixfreight.com/admin/` 后依次完成：

1. 在“产品与渠道”确认有 `FedEx` 尾程渠道。
2. 新建供应商连接，环境选择 `Production`，驱动选择 `FEDEX_RELAY`，供应商编号使用 `FEDEX_RELAY_PRODUCTION_01`，启用连接。
3. 新建并启用生产服务，绑定上述供应商连接；不要绑定 Sandbox 服务。
4. 在供应商成本表中建立有效期、邮编价格列和价格矩阵；建立服务利润表、渠道燃油费时间区间及必要附加费。
5. 用管理员进行一次小额真实订单的 Validate/Create 验收；确认面单、转单号、预扣、订单审计都正确后，再让普通客户使用生产服务。

普通客户门户与 Open API 会隐藏 Sandbox 服务。生产订单预扣成功后由 Worker 异步 Validate/Create；明确失败或 `UNKNOWN` 状态不会自动重试，必须人工处理。

## 7. 日常运维

查看状态和日志：

```bash
cd /opt/movixfreight
docker compose -f docker-compose.production.yml ps
docker compose -f docker-compose.production.yml logs -f --tail=200 api worker
docker compose -f docker-compose.production.yml restart api worker
```

升级应用（先在测试环境验证同一版本）：

```bash
cd /opt/movixfreight
git pull --ff-only
docker compose -f docker-compose.production.yml build
docker compose -f docker-compose.production.yml up -d postgres redis api worker admin-web customer-web
docker compose -f docker-compose.production.yml exec -T api \
  npx prisma db execute --schema apps/api/prisma/schema.prisma \
  --file apps/api/prisma/migrate-production-readiness.sql
curl -fsS https://movixfreight.com/api/health/ready
```

若本次版本包含 `migrate-shipment-dispatch-monitoring.sql`，必须在启动新 Worker 前额外执行该 SQL。它会把历史 `SUBMITTED` 且尚未生成面单的 FedEx 订单补进自动打单队列，可能产生真实 FedEx 调用；先确认这些订单确实需要继续出单：

```bash
docker compose -f docker-compose.production.yml run --rm api \
  ./apps/api/node_modules/.bin/prisma db execute \
  --schema apps/api/prisma/schema.prisma \
  --file apps/api/prisma/migrate-shipment-dispatch-monitoring.sql
```

## 8. 本机数据库备份与恢复演练

每天导出一个 PostgreSQL 压缩备份，并定期把恢复流程在非生产库演练一次：

```bash
sudo mkdir -p /opt/movixfreight/backups
sudo chown "$USER":"$USER" /opt/movixfreight/backups
cd /opt/movixfreight
docker compose -f docker-compose.production.yml exec -T postgres \
  pg_dump -U movix_prod -d movix_freight -Fc \
  > backups/movix_freight_$(date +%F_%H%M%S).dump
```

将 `movix_prod` 和 `movix_freight` 改成 `.env.production` 的实际值。用 cron 定时执行前，先手工执行并确认备份文件不是 0 字节。备份文件仍在同一台服务器；它不等同于异地灾备。

恢复仅应在确认目标库、停止相关应用并获得业务授权后执行：

```bash
docker compose -f docker-compose.production.yml exec -T postgres \
  pg_restore -U movix_prod -d movix_freight --clean --if-exists \
  < backups/<确认过的备份文件>.dump
```

## 9. 故障定位与回滚

| 现象 | 先检查 |
| --- | --- |
| `502 Bad Gateway` | `docker compose ... ps`，再检查 `api`/前端容器日志和 3301–3303 本机 curl |
| API 启动报数据库/Redis错误 | `.env.production`、`postgres`/`redis` 容器、`/api/health/ready` |
| 生产连接未就绪 | `connectors.production.json` profile 名、环境、供应商编号、发件人配置，且不泄漏密钥到日志 |
| 无法真实出单 | 先看订单供应商调用审计和 Worker 日志，再由 Ship-API Direct/FedEx 核实生产授权；不要对 `UNKNOWN` 自动重试 |
| 管理端白屏或资源 404 | 检查 `/admin/` 是否保留末尾 `/`，以及 Nginx `proxy_pass http://127.0.0.1:3302/;` 是否也有末尾 `/` |

若新版本切流失败，先恢复备份的 Nginx 文件并 reload；旧服务尚未停止时即可立即回到旧站点：

```bash
sudo cp /etc/nginx/sites-available/movixfreight.bak.<时间戳> \
  /etc/nginx/sites-available/movixfreight
sudo nginx -t && sudo systemctl reload nginx
```

如果旧服务已经停止，先按其原有启动方式恢复它，再回滚 Nginx。数据库迁移与真实订单不可通过 Nginx 回滚；上线前务必完成数据库备份和小额人工验收。
