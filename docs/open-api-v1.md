# Open API v1

客户 ERP 使用独立前缀 `https://{host}/api/open/v1`，不得调用管理端或客户门户接口。

## 本地接口验收脚本

### Windows Python 脚本（调用线上系统）

`infra/scripts/test_open_api.py` 在本地 Windows PowerShell/CMD 运行，默认访问 `https://movixfreight.com`。需要 Python 3.10+，仅用标准库，无需安装 requests、Node.js 或启动本地后端/Docker，也不需要更新服务器。订单、预扣和面单生成在服务器执行，下载的 PDF 存在本机。

以下命令在项目根目录运行。若没有 `py` 命令，将其替换为 `python`。

先查询同一客户名下已存在的系统订单（不是 FedEx/UPS 转单号），确认 API Key 与下载可用：

```powershell
py -3 infra/scripts/test_open_api.py --shipment ORD-实际订单号 --wait --download
```

准备创建请求（此命令只复制模板，不访问接口；已有文件不会被覆盖）：

```powershell
py -3 infra/scripts/test_open_api.py --init
notepad tmp/open-api-test/request.json
```

编辑模板：`service` 填客户可见的线上服务代码，填真实收件人、电话、国家、地址、箱重尺寸与申报数据；替换全部 `__REPLACE_...__` 占位符和 null 数值。不使用的可选字段可删除。请勿向客户提供后台供应商连接编号。FedEx 泛欧净重、原产国、HS 编码等要求仍由线上规则强制校验，UPS 英文描述等限制见下文。

提交一票真实订单并等待逐箱 PDF：

```powershell
py -3 infra/scripts/test_open_api.py --create --file tmp/open-api-test/request.json --idempotency-key ups-python-validation-001 --wait --download
```

先输入 `CREATE` 确认真实预扣和打单，再在隐藏提示中粘贴**线上客户 API Key**（不要加 Bearer，也不是 UPS/FedEx 凭据）。也支持 `MOVIX_API_KEY` 环境变量，但不接受命令行密钥。FedEx 和 UPS 分别使用对客户公开的实际服务代码，并为不同订单选不同幂等键。不要把此前在聊天等渠道公开的密钥硬编码到脚本，建议先轮换。

每次运行保存到项目 `tmp/open-api-test/python-时间戳-随机编号/`。创建前保留原请求与幂等键，成功后保存订单号和最新状态，失败时保存安全错误信息；不保存密钥。结果文件含客户个人信息，虽然已忽略 Git，仍须自行保护。创建 POST 只发送一次，查询每 5 秒一次，最多约 10 分钟；失败、未知或异常状态停止，不自动重试下单、取消或退款。下载检查 `%PDF-` 文件头，并按 `label_id` 下载所有箱子的面单。

断网或超时可能发生在服务器已受理之后：先在后台核查，保留原请求和原幂等键，不要换新键下单。已获得 `ORD-…` 时使用上面的查询命令继续查看，不能再次创建。Windows 脚本本地运行**不代表供应商 Sandbox**，所选线上供应商是生产环境就会产生真实运单。

离线模拟测试（不访问服务器）：

```powershell
py -3 infra/scripts/test_open_api_test.py
```

### Node.js 脚本（保留）

仓库提供 `infra/scripts/test-open-api.mjs`（Node.js 20+，无需额外依赖，Windows/Linux 均可运行）。默认连接 `https://movixfreight.com`，可用 `--base https://实际域名` 修改。每次运行隐藏输入客户 API Key，也可读取 `MOVIX_API_KEY` 环境变量；不要将密钥写进脚本、JSON 或命令行历史。

先用同一客户名下的现有系统订单号验证鉴权与下载，不产生新订单：

```sh
node infra/scripts/test-open-api.mjs --shipment ORD-实际系统订单号 --wait --download
```

创建真实验证单前，在项目根目录创建 `tmp/open-api-test` 文件夹，将 `infra/scripts/open-api-request.example.json` 复制为 `tmp/open-api-test/request.json`。替换所有占位内容和 null 数值，填写真实客户收件地址、箱重尺寸与货品资料；可选字段不使用时删除，不要提交模板虚构数据。`service` 是客户可见的服务代码。API Key 决定扣款客户，不能通过 JSON 指定其他客户。

```sh
node infra/scripts/test-open-api.mjs --create --file tmp/open-api-test/request.json --idempotency-key ups-validation-001 --wait --download
```

创建前必须在终端输入 `CREATE` 确认真实预扣与打单，然后隐藏输入密钥。该请求不是试算，也不会自动取消或退款。FedEx 与 UPS 分别使用对应服务代码；每个有意创建的新订单使用不同幂等键。网络中断时禁止换新键重发：先核查后台，必要时用相同客户、原请求体、原幂等键恢复。

脚本每次只发送一次创建请求，最多每 5 秒查询一次、约 10 分钟停止；失败、未知、超时待核查或取消均停止。查询网络失败也停止，可以再次查询相同订单号。`--download` 在 READY 时逐张下载并验证 PDF 文件头；未就绪不保存伪 PDF。UPS 本地 PDF 处理失败时脚本保留诊断并退出，不重新创建。

结果保存到 `tmp/open-api-test/时间戳-随机编号/`：创建前保存 `request.json`、`request-meta.json`（含幂等键，不含密钥），创建成功保存 `accepted.json`，查询保存最新 `status.json`，面单为 `label-001.pdf` 等。此目录已被 Git 忽略，但仍包含个人信息，应妥善保管和清理。不要覆盖首次成功请求的资料后再使用原幂等键。

本地模拟测试（不调用任何生产接口）：

```sh
node --test infra/scripts/test-open-api.test.mjs
```

## 在线页面

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

请求体根字段为 `shipment`。必填业务字段：`service`、`parcel_count`、`to_address`、`parcels`、`declaration_currency`。`service` 是客户可见的服务代码；系统内部反查生产供应商连接，并按目的国家匹配该服务的国家路由和底层 serviceType。调用方不能传入 `supplier`或底层承运商 serviceType。目的国家可使用已启用国家表中的中文名、ISO 两位代码或既有英文名称，系统会转换为 ISO 两位代码。

`to_address` 必须提供姓名、城市、国家、邮编、至少一个地址字段（`address_1`、`address_2`、`address_3`），并至少提供电话或手机。三段地址会按单个空格合并后重新分配为最多三段地址；FedEx 每段最多 20 个 Unicode 字符，UPS 每段最多 35 个字符，系统绝不拆分完整单词。单个单词超过所选驱动的行字符上限或总地址无法容纳时会明确拒绝请求。

`parcels` 中的 `number` 为可选；留空后，系统在创建订单时生成 `ORD-…-001` 形式的箱号。`client_weight`、`client_length`、`client_width`、`client_height` 必填，且 `parcel_count` 必须等于数组长度。

### FedEx 国家路由

| 命中线路 | 目的国 | 实际 FedEx 服务 | 额外申报规则 |
| --- | --- | --- | --- |
| 荷兰本土 | `NL` | `FEDEX_PRIORITY` | 不建立跨境 `customsClearanceDetail`；申报字段仅受系统全局必填设置约束。 |
| 泛欧经济型 | 管理员为供应商配置的欧洲国家（不含 `NL`） | `FEDEX_REGIONAL_ECONOMY` | 每条申报明细必须有 `name_en`、`weight`（商品净重 kg）、`origin_country`、`hs_code`、`quantity`、`unit_price`、`declaration_currency`。商品净重合计不得超过箱子实重，单箱最多 68 kg。 |

泛欧经济型请求固定按非文件商业货物发送，税费付款方固定为发件人（`SENDER`）。`taxwith`、`deliverywith`、`exportwith`、`importwith` 和 `attrs` 当前没有确认的 FedEx Relay 映射，不能在 FedEx 国家路由中使用；传入非默认值会被明确拒绝。

成功返回 HTTP `202`，`data.shipment.shipment_id` 为系统订单号 `ORD-…`。它表示订单已预扣并进入自动面单任务（FedEx：Validate → Create；UPS：OAuth → 一次 Shipping，请求中的 validate 不是独立预校验），不表示已获取转单号或 PDF。初始响应的 `label_status` 为 `PENDING`，并同时返回 `label_status_message: "下单成功，正在等待面单生成"` 与 `dispatch` 状态对象；调用方应保存订单号并轮询标签状态接口。

### 查询标签状态

`GET /shipments/:shipmentId/label`

返回 `PENDING`、`READY`、`FAILED` 或 `UNKNOWN`，并返回可直接展示的 `label_status_message`。`dispatch.status` 进一步区分 `PENDING`（等待队列）、`VALIDATING`、`CREATING`、`READY`、`FAILED`、`UNKNOWN`、`STALLED`（超过 10 分钟待核查）和 `BLOCKED`（当前驱动不支持自动打单）；`dispatch.message` 为安全业务提示，`reasonCode` 便于程序处理。`READY` 时包含 `transfer_number`、每张面单的 `label_id` 与下载地址。`UNKNOWN` 不会自动重试，避免供应商重复创建面单。

### 下载标签

`GET /shipments/:shipmentId/label/download?label_id=...`

标签就绪后返回 PDF 附件。单箱订单可省略 `label_id`；多箱订单必须使用状态接口返回的具体 `label_id`。

## 字段与当前限制

- `attrs` 是数组，仅允许 `elec`、`magnetic`、`danger`、`liquid`、`powder`、`paste`、`sensitive_goods`、`wood`、`textile`；当前 FedEx 两条线路均不接受非空值。
- `taxwith`、`deliverywith`、`exportwith`、`importwith` 和 `tax_number` 会完整保存；但当前 FedEx 两条线路均只能使用默认值，不能把通用字段误认为已下发到 FedEx。
- `from_address` 与地址 `ext` 完整保存，FedEx / UPS 均使用供应商连接中配置的固定发件人，不向承运商发送 from_address。
- `to_address.state_code` 优先于 `to_address.state` 保存并下发至 FedEx；UPS 爱尔兰线路要求省/州代码（最多 5 字符）；其他当前线路可选。
- 税务、交货、报关、清关及物品属性只在命中国家路由明确启用、且驱动已实现对应承运商映射时可提交；未启用的字段会明确拒绝，不会被静默忽略。
- 配置了国家路由的 `FEDEX_RELAY`、`UPS_OFFICIAL` 供应商可自动生成面单。路由轨迹、运单信息、供应商列表、余额、独立运费试算、取消和 Webhook 尚未开放。

## 异步执行

面单任务使用 Redis 队列。Redis 暂时不可用时，订单和预扣仍会持久化为待处理任务，并在状态中说明“等待队列服务恢复”；API 启动后会周期检查 Redis，并在恢复后自动投递待处理任务。供应商明确失败或未知结果不会自动重试。生产环境必须运行 Redis。

## UPS_OFFICIAL（2026-09-16）

- 通过 `shipment.service` 指定管理员向客户公开的 UPS 服务代码。发件人、UPS 账号和供应商连接均由系统内部解析，不向客户公开；仅开放已启用 Standard 国家路由的荷兰及欧盟目的国，不接受特殊清关区域。
- 官方 Shipping 版本 v2409；UPS Standard 固定服务 11、普通自备包装、运费由公司 UPS 账号支付。客户不填写底层 serviceType。
- UPS 创建前校验地址、配置、路由、尺寸和英文品名。英文品名必填，每箱多个品名以逗号空格合并最多 35 个可打印英文字符；其他申报项按全局配置校验。
- 件数 1–200，仍受服务设置约束。单箱最大 70 kg，最长边 274 cm，长加围长最多 400 cm。地址最多三行，每行 35 字符；城市最多 30 字符、邮编 9 字符、收件人/公司 35 字符、电话规范为 6–15 位数字。
- 税务/贸易/报关/清关和 attrs 只允许默认值，tax_number 为空；不生成商业发票。实际开通线路须由管理员向 UPS 核实，欧盟成员国不等于该国所有地区都免清关。
- 生产请求会产生真实运单和预扣。不要将网页示例中的虚构地址直接用于生产验证。

### 标签状态的 UPS 扩展

`transfer_number` 保存整票 ShipmentIdentificationNumber。每个 labels 元素新增：

| 字段 | 含义 |
| --- | --- |
| box_no | 系统箱号，旧 FedEx 标签可为 null |
| label_id | 下载指定标签的 ID |
| tracking_number | 该箱 UPS TrackingNumber |
| pdf_ready | 该标签是否已转换为 PDF |
| download_url | 带 label_id 的下载地址 |

每箱 GIF 原图保存后无损转换 PNG，再等比嵌入 4×6 PDF，约 2 mm 白边，不使用 FedEx 裁切规则。

如果已取得 UPS 运单号而 PDF 转换失败，订单仍为已生成，`label_status=FAILED`，`dispatch.reasonCode=LABEL_PROCESSING_FAILED`，继续返回转单号与逐箱 labels。可重试指定 label_id 下载，仅重做本地 PDF 转换，绝不再次调用 Shipping；转换再次失败返回 HTTP 503 和同名 info.code。正常未知/拒绝状态不触发这种修复。

多箱下载必须提供 label_id。建议每 5 秒轮询未完成任务；终态停止，超过 10 分钟 STALLED 交管理员核查。未知创建/取消不自动重试、失败不自动退款。整票取消仅由管理员使用内部统一取消入口，退款仍由会计确认。

### 错误约定

配置/环境未就绪：503；字段不支持：400；无路由/多路由等业务冲突：409 BUSINESS_CONFLICT；幂等冲突：409 IDEMPOTENCY_CONFLICT；余额或客户状态不允许：403 ORDER_CREATION_FORBIDDEN。供应商异步错误看 dispatch 的安全提示及 reasonCode；不会返回密钥、原始 GIF 或技术堆栈。
UPS 发件国从供应商本地 profile 的 `shipper.countryCode` 读取，支持 `NL` 和 `BE`，不会使用调用方的 `from_address` 覆盖；比利时发件人 `stateCode` 可为空。新订单保存始发国快照，若排队期间修改始发国，将阻止错误出单。
