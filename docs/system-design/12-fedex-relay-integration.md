# FedEx 中转站接入

> **实现状态（2026-09-01）**：OAuth、Rate、Validate、Create、Cancel 的后端封装、订单载荷映射、调用审计、面单保存和客户授权下载均已实现。管理员可从单票订单详情显式发起取消；查单和轨迹仍未实现。凭据仅存在于被忽略的本地配置文件，本文不记录任何真实凭据。

> 状态：联调准备中  
> 渠道类型：第三方中转站（不是 FedEx 官方 REST API）

## 已确认

- 基础地址：`https://direct.ship-api.com/fedex`；
- 鉴权凭据：供应商提供的 `SHIP_API_KEY`；
- 承运商账号：仅在本地受保护配置中维护，不写入设计文档；
- 凭据仅保存在后端本地／部署环境变量，前端、开放 API、日志和数据库查询响应均不得回显；
- 未认证探测返回 HTTP `401`，服务地址可达。

从对接脚本确认的接口契约：

| 能力 | 方法与路径 | 鉴权 |
|---|---|---|
| 获取 OAuth Token | `POST /oauth/token` | `ship-api-authorization: Bearer {SHIP_API_KEY}`，表单 `grant_type=client_credentials` |
| 费率查询 | `POST /rate/v1/rates/quotes` | OAuth Bearer Token + `ship-api-authorization` |
| 运单校验 | `POST /ship/v1/shipments/packages/validate` | 同上 |
| 创建面单 | `POST /ship/v1/shipments` | 同上 |
| 取消整票 | `DELETE /ship/v1/shipments/{trackingNumber}` | 同上；请求体提供账号、转单号、发件国与 `DELETE_ALL_PACKAGES` |

Ship-API Direct 按其说明镜像 FedEx Ship API 路径。取消使用 FedEx 的取消运单路径；系统只对已生成、未标记为已收货的订单发起请求，国际多件订单以主转单号和 `DELETE_ALL_PACKAGES` 取消整票。中转商尚未提供的查单／轨迹接口仍不实现，不能猜测路径。

## 取消运单的系统规则

- 管理员在“订单列表 → 订单详情”中对单票发起取消；`SUBMITTED`、明确 `FAILED` 的订单完成内部取消，`GENERATED` 的订单调用 FedEx；
- `RECEIVED`、`GENERATING`、`UNKNOWN`、`RETURNED` 订单不允许自动取消；网络超时、5xx 或取消响应未明确确认时转为 `UNKNOWN`，禁止自动重试；
- 仅在 FedEx 返回明确的 `cancelledShipment=true` 后，订单变为“已取消”。取消请求、响应（不含凭据）和失败信息都会写入供应商调用审计；
- 取消不会自动影响钱包或预扣。后续由会计在对账流程中确认退款，避免承运商结果不确定时发生错误退款。

## 已完成的只读联调

- OAuth 成功获取访问令牌，令牌有效期约 3599 秒；
- 使用荷兰本土测试线路调用 Rate API 成功，当前可用服务代码包括：`FEDEX_FIRST`、`FEDEX_PRIORITY_EXPRESS`、`FEDEX_PRIORITY`；
- 未调用 Validate 或 Create，未生成面单或产生订单。

## 本地配置位置

统一接口配置文件为 `config/connectors.local.json`，按供应商分块维护。该文件已经被 `.gitignore` 排除；可提交的模板为 `config/connectors.local.example.json`。

单一连接可沿用原有 `fedexRelay` 顶层字段。多个连接时，使用供应商连接编号作为 `profiles` 的键：

```json
{
  "fedexRelay": {
    "profiles": {
      "FEDEX_RELAY_SANDBOX_01": {
        "shipApiKey": "在此填写 SHIP_API_KEY"
      }
    }
  }
}
```

生产环境不应依赖本地文件，应将同一结构放入部署平台的 Secret／密钥管理服务，并通过 `CONNECTOR_CONFIG_PATH` 指定只读挂载路径。

## 必须向中转供应商取得

1. OpenAPI/Swagger、Postman Collection，或查询、取消面单的完整请求与响应示例（当前已依据 FedEx Ship API 实现取消，请提供中转站实测样例复核响应字段）；
2. `SHIP_API_KEY` 的安全交付方式及生产／测试环境差异；
3. 鉴权头名称与格式（例如 `X-API-Key`、Bearer 等）；
4. 创建面单路径、必填寄件人/收件人/货物/清关字段、可用服务代码及面单格式；
5. 幂等机制、超时后查单方式、取消时限及取消接口；
6. 最终实重、收费重、实际成本的回传能力；不能回传时账单 Excel 的列样例。

## 实现顺序

1. 建立 `FEDEX_RELAY` 驱动、FedEx 尾程渠道和对应 Sandbox/Production 供应商连接配置；
2. 映射内部订单到中转站创建面单载荷，保存脱敏调用记录与供应商参考号；
3. 将返回的面单文件存入对象存储、运单号写入订单，并将订单更新为“已生成”；
4. 实现查单优先的未知结果恢复、会计确认后的取消退款；
5. 接入实际数据回传或供应商账单 Excel 导入，进入会计对账。
