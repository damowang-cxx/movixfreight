# 生产部署与 FedEx Production 上线

> 本部署方案使用单台 Linux Docker Compose。数据库和面单文件保留在本机 Docker 卷；这不是异地灾备方案。

## 上线前必须准备

1. FedEx/Ship-API Direct 已提供可用的生产 `SHIP_API_KEY`、FedEx 账号、生产发件人资料与生产地址；FedEx 标签认证已完成。
2. 创建生产供应商连接，例如 `FEDEX_RELAY_PRODUCTION_01`，环境必须为 `PRODUCTION`；其编号必须与 `config/connectors.production.json` 的 `fedexRelay.profiles` 键完全一致。
3. 为该连接建立启用中的生产服务、成本表、利润表和燃油费区间。Sandbox 服务不会返回给普通客户。
4. 准备域名、DNS A 记录、HTTPS 证书，以及 `.env.production` 中所有高强度随机密码。

## 部署

```bash
cp .env.production.example .env.production
cp config/connectors.local.example.json config/connectors.production.json
# 仅在服务器本机填写 Production profile，禁止提交该文件
docker compose -f docker-compose.production.yml up -d --build
```

首次启动后执行生产数据库迁移脚本：

```bash
docker compose -f docker-compose.production.yml exec -T api \
  npx prisma db execute --schema apps/api/prisma/schema.prisma --file apps/api/prisma/migrate-production-readiness.sql
```

检查 `https://域名/api/health/ready`、管理员登录、生产服务可见性和 Worker 日志。管理员界面位于 `https://域名/admin/`，客户门户位于 `https://域名/`。

## 运行规则

- 客户门户和 Open API 的生产订单预扣后会创建唯一的 Redis 面单任务；Worker 依次 Validate/Create。供应商明确失败不会重试；超时或结果未知需要人工处理。
- 管理员创建订单仍需人工 Validate/Create。FedEx 取消成功后自动生成取消退款待办，只有会计确认才会写入余额流水。
- 每日运行 `infra/scripts/backup-postgres.sh` 生成本机数据库备份。请配置系统 cron；本机磁盘、Docker 卷或服务器丢失时无法保证恢复。
- `/api/docs` 不应通过公网暴露；反向代理应限制管理员网络访问。

## 禁止事项

- 不要把生产密钥写进 `.env.production`、数据库、前端构建变量或 Git。
- 不要把生产供应商连接指向 Sandbox profile，也不要用 Sandbox 服务向普通客户开放。
- 不要在 `UNKNOWN` 状态自动重试 Create/Cancel 或自动退款。
