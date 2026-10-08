# FedEx / UPS 轨迹同步与上线

## 已实现范围

- FedEx Relay 用订单原供应商 profile 代理调用 FedEx Track；UPS Official 用原 profile 的 OAuth 令牌逐箱查询 UPS Tracking。轨迹查询只读，不改变订单、余额或面单状态。
- Worker 每分钟检查待同步目标，首次为最近 90 天已生成面单的订单补建目标；面单待揽收每 2 小时、在途每 1 小时查询。已妥投、已退回和已取消订单停止自动查询。异常暂存上次成功轨迹，按 15 分钟起指数退避（最多 24 小时）。
- 管理员可在订单详情请求刷新，单票 5 分钟冷却；客户门户和 Open API 只读取持久化结果，不触发承运商请求。
- 同一订单可以有多条承运商运单号轨迹；UPS 关联箱号，FedEx 优先使用面单运单号，缺失时使用订单主单号。按扫描时间、状态码、描述及地点生成事件去重键。
- 统一状态：`LABEL_CREATED`、`IN_TRANSIT`、`OUT_FOR_DELIVERY`、`DELIVERED`、`EXCEPTION`、`RETURNING`、`RETURNED`、`UNKNOWN`；无面单时接口返回 `PENDING` 和空数组。同步状态独立表示 `PENDING`、`PROCESSING`、`READY`、`NO_EVENTS`、`ERROR`、`STOPPED`。

## 服务器首次升级（含数据库变更）

`update-production.sh` 发现 `apps/api/prisma/` 变化时会主动停止；**不能直接反复执行更新脚本**。数据库和生产凭据不得复制到本地仓库。应先在服务器审阅 `apps/api/prisma/migrate-shipment-tracking.sql`，确认 PostgreSQL 备份可恢复，再进入维护窗口。以下命令使用现有服务器 Compose：

```bash
cd ~/movixfreight
git status --short
git fetch origin main
git diff HEAD..origin/main -- apps/api/prisma/
git pull --ff-only origin main
dc() { docker compose --env-file .env.production -f docker-compose.server.yml "$@"; }
dc build api worker admin-web customer-web
```

先停止 API 阻止新单，等待现有面单任务完成，再停 Worker。**如果有 `GENERATING` 或 `PROCESSING`，先核查，不能中断正在调用承运商的请求。**

```bash
dc stop api
dc exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
SELECT count(*) AS dispatch_processing FROM "ShipmentDispatchJob" WHERE status = 'PROCESSING';
SELECT count(*) AS carrier_generating FROM "Order" WHERE "shipmentStatus" = 'GENERATING';
SQL
```

两个计数均为 0 后继续。备份脚本的输出应存在且非空；仍需遵守现有本机备份的灾备限制。

```bash
dc stop worker
BACKUP_DIR="$HOME/movix-backups" bash infra/scripts/backup-production.sh
dc exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  < apps/api/prisma/migrate-shipment-tracking.sql
dc up -d --no-deps api worker admin-web customer-web
curl -fsS http://127.0.0.1:3340/api/health/ready
dc logs --tail=100 api worker
```

迁移仅添加轨迹目标和事件表，不修改历史订单、面单、账务流水。新 Worker 启动后会自动为最近 90 天符合条件的历史订单补建轨迹目标并实际访问承运商 Track API，**不会重新打单**。如同一批部署还包含别的未执行 Prisma 增量迁移，必须先逐一审阅并执行，不能只执行此 SQL。若迁移失败，保持旧服务停机并核查数据库；不要运行 `db push --accept-data-loss`、清库或 `down -v`。

## 验收与边界

分别选一票既有 FedEx 和 UPS 生产面单，管理员详情点击“刷新轨迹”，等待 Worker 完成后比对承运商官方页面的扫描时间、地点及逐箱运单号。再用归属客户的 API Key 调用 `GET /api/open/v1/shipments/ORD-…/tracking`，确认只返回本客户数据；其他客户订单必须 `404`。Sandbox 结果不代替生产验收。

生产账号若尚未开通 Track API 权限，系统保留旧扫描记录并显示同步失败；不要因轨迹失败而重新创建或取消运单。当前实现不提供客户主动刷新、Webhook 或历史超过 90 天的自动补建。订单状态和财务状态不随轨迹自动修改。
