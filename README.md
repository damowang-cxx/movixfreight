# Movix Freight

中国至欧洲尾程物流的打单、预扣费、供应商对接和会计对账系统。

> 当前状态（2026-09-01）：开发中的本地联调原型，已具备“尾程渠道 → 供应商连接 → 服务”、多级客户利润报价、预扣、FedEx Sandbox 打单、账单匹配、会计重算与确认主链路；管理员可维护头像、本人密码、全局申报字段及供应商面单模板。尚未完成生产部署、真实账单文件导入和生产级安全运维，不能作为生产系统使用。

## 当前成果

- 两个独立前端：管理员端与客户端，共用 NestJS 后端 API。
- PostgreSQL 数据模型覆盖客户、等级/分组归属历史、EUR/GBP 钱包、资金流水、尾程渠道/供应商连接/服务、价格版本及修改审计、订单、面单、供应商调用审计及账单对账重算。
- 订单创建时根据预估计费重量预扣；客户相应币种余额不足或为负时禁止继续下单。
- 供应商账单先匹配、再由财务应用、最后人工确认差额；确认前不会改变客户余额。
- 已接入 FedEx Ship-API Direct 中转站的 OAuth、报价、运单校验、显式创建面单和单票取消能力；取消成功后仍须由会计确认退款。
- 管理员端已实现可折叠菜单、顶部双行栏与刷新恢复的多标签工作区；客户门户已实现登录、余额/流水、通知、订单/面单和自助下单。
- 报价支持欧洲国家表、成本表头、国家组和 Excel 价格矩阵；矩阵可混合按票、按箱和每 KG 计价，并支持最低箱收费、燃油费和邮编偏远费；订单 Excel 导入支持预校验与幂等预扣。
- 客户 API 密钥支持管理员创建、轮换与一次性安全展示；数据库只保存哈希。
- 管理员右上角账户菜单支持头像上传、修改本人密码及（仅超级管理员）全局申报字段必填设置；FedEx 服务会额外强制其清关所需字段。
- “系统设置 → 面单模板设置”支持按供应商连接维护输出格式、标签规格与热敏设计稿；标准 FedEx 标签规格可下发，热敏自定义图文在供应商确认透传字段前仅用于预览。
- Open API v1 已开放 API Key 鉴权、异步创建运单、标签状态查询和 PDF 下载；具体请求字段与限制见下方接口文档。

完整的已实现范围、手动验收步骤、限制和下一步计划见 [当前开发进度与验收说明](./docs/current-development-report.md)。

## 项目结构

```text
apps/
  admin-web/       管理员端 React + Vite，默认 3001
  customer-web/    客户端 React + Vite，默认 3002
  api/             NestJS API，默认 3000
packages/
  pricing-engine/  纯函数计价引擎
  connector-sdk/   可插拔供应商适配器契约
  shared-types/    共享类型基础包
config/
  connectors.local.example.json  本地供应商配置模板
docs/system-design/              需求、设计、现状与路线图
```

## 本地启动

前置条件：Node.js、pnpm、Docker Desktop。

```powershell
pnpm install
docker compose up -d
pnpm db:generate
pnpm dev
```

本地 PostgreSQL 映射到 `localhost:15432`，避免与开发机默认的 `5432` 冲突。启动后可访问：

- 管理员端：`http://localhost:3001`
- 客户端：`http://localhost:3002`
- API 健康检查：`http://localhost:3000/api/health`
- Swagger：`http://localhost:3000/api/docs`
- Open API 对接文档（无需登录）：`http://localhost:3000/api/open/v1/docs`

API 使用 `apps/api/.env`。FedEx 等供应商密钥只放在被忽略的 `config/connectors.local.json` 中；可从 `config/connectors.local.example.json` 复制模板，绝不可提交真实密钥。

## 数据库说明

当前本地开发库已应用 schema。Windows + 当前 Node/Prisma 组合下，`prisma migrate dev` 曾出现无详细信息的 schema engine 错误，因此尚未建立可直接用于新环境的标准 Prisma migration 历史。新环境初始化或继续修改 schema 前，请先阅读 [当前开发基线中的数据库说明](./docs/system-design/00-current-development-status.md#数据库与运行环境)，不要假定 `pnpm db:migrate` 已可稳定执行。

## 验证状态

2026-08-22 已执行并通过：

```powershell
pnpm typecheck
pnpm --filter @movix/pricing-engine test
pnpm build
```

成本表 schema 已同步到当前本地开发库，历史成本数据已执行一次预检迁移；迁移脚本可重复执行：`pnpm --filter @movix/api prisma:migrate-cost-tables`。

构建会提示前端产物超过 500 kB 的体积告警；这不阻塞构建，但上线前应做路由级代码分割。

## 文档入口

- [系统设计文档索引](./docs/system-design/README.md)
- [当前开发基线、已实现与缺口](./docs/system-design/00-current-development-status.md)
- [当前开发进度、可测试功能与规划](./docs/current-development-report.md)
- [完整设计与里程碑计划](./docs/system-design/11-overall-development-plan.md)
- [FedEx 中转站接入说明](./docs/system-design/12-fedex-relay-integration.md)
- [生产部署与 FedEx Production 上线](./docs/production-deployment.md)
- [Open API v1 接入说明](./docs/open-api-v1.md)
- [实施记录](./docs/implementation-log.md)
