# 客户充值水单与充值历史

## 使用方式

管理员进入“客户管理 → 客户 → 客户详情 → 客户充值与余额调整”。财务或超级管理员选择 EUR/GBP、填写正数金额和备注，即可确认充值入账。水单不是必填项；如需附上水单，可通过文件按钮选择图片，或点击水单区域并按 `Ctrl+V` 粘贴截图。仅接受 PNG、JPG、WebP，单张最大 5 MB。确认后展示资金流水号，可在下方充值历史中查看入账记录和已有水单。

人工扣减仍可填写原因后执行，但不附充值水单；操作同样写入原有钱包流水。其他管理员仅可查看充值历史，无余额调整权限。客户端只读展示自己的充值历史与水单。

每笔充值的余额变化和 `ADMIN_CREDIT` 流水在同一数据库事务内保存；如附有水单，图片也在该事务内保存，任一写入失败整笔回滚。无论新旧充值，未上传水单都不影响入账或历史查询，页面标明“未上传水单”。图片原文不会出现在客户详情或充值历史 JSON 中，只有经认证且校验客户归属的图片接口才读取二进制数据。

## 接口

| 入口 | 方法和路径 | 用途 |
| --- | --- | --- |
| 管理端 | `POST /api/admin/v1/customers/:customerId/wallet-adjustments` | `CREDIT` 无水单时使用 JSON；有水单时使用 `multipart/form-data`，原有 `currency`、`amount`、`direction`、`reason` 字段加可选 `receipt` 图片。`DEBIT` 使用 JSON。仅财务或超级管理员。 |
| 管理端 | `GET /api/admin/v1/customers/:customerId/recharges?cursor=` | 倒序读取充值历史，每页最多 50 条，返回 `items` 和 `nextCursor`。 |
| 管理端 | `GET /api/admin/v1/customers/:customerId/recharges/:ledgerId/receipt` | 认证后返回图片。 |
| 客户端 | `GET /api/customer/v1/recharges?cursor=` | 仅返回当前登录客户的充值历史。 |
| 客户端 | `GET /api/customer/v1/recharges/:ledgerId/receipt` | 仅返回当前登录客户的图片。 |

充值历史包含流水号、币种、金额、调整前后余额、备注、时间及水单元数据；管理端另含操作人。充值水单不是对外 Open API v1 的一部分。

## 数据迁移与部署

本功能新增 `RechargeReceipt` 表，不改写旧钱包或旧流水。新 API 启动前必须先迁移数据库，否则充值和历史查询会失败。生产服务器按现有流程先做备份并核对备份文件，再审阅 [增量 SQL](../apps/api/prisma/migrate-recharge-receipts.sql)。在项目根目录执行：

```bash
docker compose --env-file .env.production -f docker-compose.server.yml exec -T postgres \
  sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  < apps/api/prisma/migrate-recharge-receipts.sql
```

迁移成功后再运行生产更新脚本。若更新脚本因 Prisma 目录变化要求人工审查，应按其提示核对目标提交；不要跳过迁移保护。水单保存在 PostgreSQL 中，数据库备份和容量监控也应覆盖这些图片。部署验收至少包括 EUR/GBP 各一笔充值、历史预览、客户归属隔离、错误图片被拒绝，以及入账失败时余额不变。
