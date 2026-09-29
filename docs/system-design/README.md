# Movix Freight 系统设计资料

> 最近整理：2026-08-10  
> 当前阶段：本地联调主链路与双端运营页面已实现；正在补齐真实供应商验收、账单文件接入与生产化能力。

本目录保存产品决策、业务规则、架构方案以及当前代码实现状态。阅读或继续开发时，请优先以 [当前开发基线](./00-current-development-status.md) 判断“已经实现”和“仍待实现”的边界；各专题文档则保留已确认的业务设计。

## 推荐阅读顺序

1. [当前开发进度、可测试功能与验收步骤](../current-development-report.md)
2. [当前开发基线、已实现范围与后续路线](./00-current-development-status.md)
2. [业务范围与核心概念](./01-business-scope.md)
3. [总体架构与供应商接入](./02-architecture-and-connectors.md)
4. [客户资金与账单](./03-funds-and-billing.md)
5. [订单管理](./06-order-management.md)
6. [产品与渠道](./09-products-and-channels.md) 与 [报价管理](./10-pricing-management.md)
7. [总体系统设计与开发方案](./11-overall-development-plan.md)
8. [FedEx 中转站接入说明](./12-fedex-relay-integration.md)

## 全部文档索引

| 文档 | 用途 |
|---|---|
| [../current-development-report.md](../current-development-report.md) | 当前功能总览、可测试范围、手动验收步骤、后续规划与外部资料需求 |
| [00-current-development-status.md](./00-current-development-status.md) | 当前代码能力、限制、验证记录与建议开发顺序 |
| [01-business-scope.md](./01-business-scope.md) | 业务定位、角色和领域语言 |
| [02-architecture-and-connectors.md](./02-architecture-and-connectors.md) | 双前端、后端模块与可插拔供应商适配器 |
| [03-funds-and-billing.md](./03-funds-and-billing.md) | EUR/GBP 钱包、预扣、退款、补扣和对账原则 |
| [04-frontend-and-access.md](./04-frontend-and-access.md) | 管理员端/客户端边界与权限原则 |
| [05-admin-information-architecture.md](./05-admin-information-architecture.md) | 管理员端导航、标签工作区与页面信息架构 |
| [06-order-management.md](./06-order-management.md) | 订单状态、箱货、申报、面单与取消规则 |
| [07-customer-order-risk.md](./07-customer-order-risk.md) | 后续客户打单风控方向 |
| [08-customer-management.md](./08-customer-management.md) | 客户、钱包、注册审核与 API 密钥设计 |
| [09-products-and-channels.md](./09-products-and-channels.md) | 供应商、渠道、服务与服务约束 |
| [10-pricing-management.md](./10-pricing-management.md) | 成本表、利润表、附加费、版本和优先级 |
| [11-overall-development-plan.md](./11-overall-development-plan.md) | 原始总体设计、技术选型与里程碑计划 |
| [12-fedex-relay-integration.md](./12-fedex-relay-integration.md) | 当前 FedEx Ship-API Direct 中转配置与对接边界 |
| [decisions.md](./decisions.md) | 已确认业务决策记录 |
| [open-questions.md](./open-questions.md) | 仍需用户确认的业务问题 |

## 当前状态摘要

| 领域 | 设计状态 | 代码状态 |
|---|---|---|
| 多供应商、渠道与服务 | 已确认 | 基础数据模型与 API 已实现 |
| EUR/GBP 钱包、预扣与对账 | 已确认 | 预警/通知、标准化账单录入与会计确认已实现；账单文件上传待补齐 |
| 双前端与管理员多标签 | 已确认 | 管理员与客户核心运营页面已接入；统计、注册和部分配置编辑待补齐 |
| 报价与成本 | 已确认 | 重量、体积、材积重、燃油、偏远费与版本已实现；超重、客户分层与报价快照待补齐 |
| FedEx 中转 | 已确认 | OAuth、Rate、Validate、Create 已封装；取消/查询/轨迹待文档 |
| 风控、统计与生产化 | 后续阶段 | 未实现 |

## 维护规则

1. 新的业务结论写入 `decisions.md`；替代旧结论时保留关联关系。
2. 代码完成、验证结果和限制更新到 `00-current-development-status.md` 与 `docs/implementation-log.md`。
3. 供应商密钥、账户信息、访问令牌和客户隐私数据不得写入任何设计文档或提交到仓库。
4. 涉及余额、退款、补扣、面单创建和供应商未知结果的变更，必须同时说明授权、审计和幂等处理。

- [13 · UPS 官方接口：Standard、逐箱 PDF、整票取消与升级](./13-ups-official-integration.md)
