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

请求体根字段为 `shipment`。必填业务字段：`supplier`、`parcel_count`、`to_address`、`parcels`、`declaration_currency`。`supplier` 是供应商连接编号，而非内部服务代码；系统会按目的国家匹配该供应商启用的国家路由。对于 FedEx Relay，荷兰和泛欧路由自动共用该供应商唯一的统一计价服务，调用方无需也不能指定底层 serviceType。目的国家可使用已启用国家表中的中文名、ISO 两位代码或既有英文名称，系统会转换为 ISO 两位代码。旧 `service` 字段不再作为下单依据。

`to_address` 必须提供姓名、城市、国家、邮编、至少一个地址字段（`address_1`、`address_2`、`address_3`），并至少提供电话或手机。三段地址会按单个空格合并后重新分配为 FedEx 的最多三段地址；每段最多 20 个 Unicode 字符，系统绝不拆分完整单词。单个单词超过 20 个字符或总地址无法容纳时会明确拒绝请求。

`parcels` 中的 `number` 为可选；留空后，系统在创建订单时生成 `ORD-…-001` 形式的箱号。`client_weight`、`client_length`、`client_width`、`client_height` 必填，且 `parcel_count` 必须等于数组长度。

### FedEx 国家路由

| 命中线路 | 目的国 | 实际 FedEx 服务 | 额外申报规则 |
| --- | --- | --- | --- |
| 荷兰本土 | `NL` | `FEDEX_PRIORITY` | 不建立跨境 `customsClearanceDetail`；申报字段仅受系统全局必填设置约束。 |
| 泛欧经济型 | 管理员为供应商配置的欧洲国家（不含 `NL`） | `FEDEX_REGIONAL_ECONOMY` | 每条申报明细必须有 `name_en`、`weight`（商品净重 kg）、`origin_country`、`hs_code`、`quantity`、`unit_price`、`declaration_currency`。商品净重合计不得超过箱子实重，单箱最多 68 kg。 |

泛欧经济型请求固定按非文件商业货物发送，税费付款方固定为发件人（`SENDER`）。`taxwith`、`deliverywith`、`exportwith`、`importwith` 和 `attrs` 当前没有确认的 FedEx Relay 映射，不能在 FedEx 国家路由中使用；传入非默认值会被明确拒绝。

成功返回 HTTP `202`，`data.shipment.shipment_id` 为系统订单号 `ORD-…`。它表示订单已预扣并进入自动 `Validate → Create` 面单任务，不表示已获取转单号或 PDF。初始响应的 `label_status` 为 `PENDING`，并同时返回 `label_status_message: "下单成功，正在等待面单生成"` 与 `dispatch` 状态对象；调用方应保存订单号并轮询标签状态接口。

### 查询标签状态

`GET /shipments/:shipmentId/label`

返回 `PENDING`、`READY`、`FAILED` 或 `UNKNOWN`，并返回可直接展示的 `label_status_message`。`dispatch.status` 进一步区分 `PENDING`（等待队列）、`VALIDATING`、`CREATING`、`READY`、`FAILED`、`UNKNOWN`、`STALLED`（超过 10 分钟待核查）和 `BLOCKED`（当前驱动不支持自动打单）；`dispatch.message` 为安全业务提示，`reasonCode` 便于程序处理。`READY` 时包含 `transfer_number`、每张面单的 `label_id` 与下载地址。`UNKNOWN` 不会自动重试，避免供应商重复创建面单。

### 下载标签

`GET /shipments/:shipmentId/label/download?label_id=...`

标签就绪后返回 PDF 附件。单箱订单可省略 `label_id`；多箱订单必须使用状态接口返回的具体 `label_id`。

## 字段与当前限制

- `attrs` 是数组，仅允许 `elec`、`magnetic`、`danger`、`liquid`、`powder`、`paste`、`sensitive_goods`、`wood`、`textile`；当前 FedEx 两条线路均不接受非空值。
- `taxwith`、`deliverywith`、`exportwith`、`importwith` 和 `tax_number` 会完整保存；但当前 FedEx 两条线路均只能使用默认值，不能把通用字段误认为已下发到 FedEx。
- `from_address` 与地址 `ext` 完整保存，FedEx 首期仍使用供应商连接中配置的固定发件人。
- `to_address.state_code` 优先于 `to_address.state` 保存并下发至 FedEx；两者均为可选。
- 税务、交货、报关、清关及物品属性只在命中国家路由明确启用、且驱动已实现对应承运商映射时可提交；未启用的字段会明确拒绝，不会被静默忽略。
- 当前仅配置了国家路由的 `FEDEX_RELAY` 供应商可自动生成面单。路由轨迹、运单信息、供应商列表、余额、独立运费试算、取消和 Webhook 尚未开放。

## 异步执行

面单任务使用 Redis 队列。Redis 暂时不可用时，订单和预扣仍会持久化为待处理任务，并在状态中说明“等待队列服务恢复”；API 启动后会周期检查 Redis，并在恢复后自动投递待处理任务。供应商明确失败或未知结果不会自动重试。生产环境必须运行 Redis。
