# Open API v1

客户 ERP 使用独立前缀 `https://{host}/api/open/v1`，不得调用管理端或客户门户接口。

## 在线文档

部署后，技术人员可无需登录访问 `https://{host}/api/open/v1/docs`。该页面提供接口概览、可复制的请求示例、字段规则、错误格式和当前供应商能力边界；调试时可额外访问 `https://{host}/api/docs` 的 Swagger 页面。

## 鉴权与幂等

```http
X-API-Key: mvx_... 
Idempotency-Key: 客户侧唯一请求键
```

API Key 由管理员在客户详情创建或轮换；明文只显示一次。创建运单必须提供 `Idempotency-Key`。同一客户以相同键、相同请求体重试不会重复预扣；相同键对应不同请求体返回 `409`。

所有 JSON 响应含 `status`（1 成功、0 失败）与 Unix 毫秒 `time`。失败响应的 `info.code` 和 `info.message` 可供程序处理和人工排查。

## 已开放接口

### 创建运单

`POST /shipments`

请求体根字段为 `shipment`。必填业务字段：`service`、`parcel_count`、`to_address`、`parcels`、`declaration_currency`。国家使用中文或英文国家名，系统会转换为 ISO 两位代码。

`to_address` 必须提供姓名、城市、国家、邮编、至少一个地址字段（`address_1`、`address_2`、`address_3`），并至少提供电话或手机。三段地址会按单个空格合并后重新分配为 FedEx 的最多三段地址；每段最多 20 个 Unicode 字符，系统绝不拆分完整单词。单个单词超过 20 个字符或总地址无法容纳时会明确拒绝请求。

`parcels` 中的 `number`、`client_weight`、`client_length`、`client_width`、`client_height` 必填，且 `parcel_count` 必须等于数组长度。每条 `declarations` 至少有 `name_cn`、`name_en`；FedEx 服务还要求原产国、HS 编码、数量、单价与申报币种。

成功返回 HTTP `202`，`data.shipment.shipment_id` 为系统订单号 `ORD-…`。它表示订单已预扣并进入异步面单任务，不表示已获取转单号或 PDF。

### 查询标签状态

`GET /shipments/:shipmentId/label`

返回 `PENDING`、`READY`、`FAILED` 或 `UNKNOWN`。`READY` 时包含 `transfer_number`、每张面单的 `label_id` 与下载地址。`UNKNOWN` 不会自动重试，避免供应商重复创建面单。

### 下载标签

`GET /shipments/:shipmentId/label/download?label_id=...`

标签就绪后返回 PDF 附件。单箱订单可省略 `label_id`；多箱订单必须使用状态接口返回的具体 `label_id`。

## 字段与当前限制

- `attrs` 是数组，仅允许 `elec`、`magnetic`、`danger`、`liquid`、`powder`、`paste`、`sensitive_goods`、`wood`、`textile`。
- `taxwith`、`deliverywith`、`exportwith`、`importwith` 和 `tax_number` 会完整保存；`taxwith=3/4` 时税号必填。
- `from_address` 与地址 `ext` 完整保存，FedEx 首期仍使用供应商连接中配置的固定发件人。
- 当前 FedEx Open API 连接未确认税务、交货、报关、清关及物品属性的供应商映射。因此这些字段必须使用默认值：`taxwith=0`、`deliverywith=""`、`exportwith=0`、`importwith=0`、`attrs=[]`；非默认值会返回明确错误，不会被静默忽略。
- 当前仅 `FEDEX_RELAY` 服务可自动生成面单。路由轨迹、运单信息、服务列表、余额、独立运费试算、取消和 Webhook 尚未开放。

## 异步执行

面单任务使用 Redis 队列。Redis 暂时不可用时，订单和预扣仍会持久化为待处理任务；API 启动后会周期检查 Redis，并在恢复后自动投递待处理任务。生产环境必须运行 Redis。
