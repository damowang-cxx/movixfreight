# UPS 官方接口：荷兰发货、欧盟内 Standard

更新日期：2026-09-16。本文对应当前实现，不代表已经完成 UPS 生产实单验收。

## 范围与实际工作流

在原有“产品与渠道 → 供应商与渠道”的接口列表中选择 `UPS_OFFICIAL`。不新增 UPS 专用打单页面，不覆盖 FedEx。

`UPS 渠道 → UPS 供应商连接 → Standard 国家路由 → 内部计价服务 → 成本/利润报价 → EUR 预扣 → 持久化任务 → OAuth → 单次 Shipping → 逐箱 PDF`

管理员、客户门户、Excel、Open API 都通过供应商与目的国解析同一国家路由。普通客户只能使用生产连接；管理员可选择生产或 Sandbox。首次实单验收按已确认选择使用 Production。

- 首期发件国固定 NL，服务固定 UPS Standard `11`，路由类型 `DEFAULT`，清关模式 `NONE`。
- 国家路由需管理员勾选已启用国家表中的 NL/欧盟目的国；无匹配、重叠、停用、非欧盟目的国及错误服务代码在下单前拒绝。
- 荷兰和其他欧盟国家共用一张供应商成本表、一个 Standard 内部服务及其利润版本，不强制未来 UPS 只能有一个服务。
- 不调用官方运费查询，不实现轨迹、危险品或非欧盟商业发票。

## 1. 配置文件

本地使用 `config/connectors.local.json`；服务器使用只读挂载的 `config/connectors.production.json`。**合并下列分块，不要覆盖 FedEx 配置。** `profiles` 的键必须逐字等于数据库中的供应商编号。

```json
{
  "upsOfficial": {
    "profiles": {
      "UPS_OFFICIAL_PRODUCTION_01": {
        "enabled": false,
        "environment": "production",
        "clientId": "",
        "clientSecret": "",
        "shipperNumber": "",
        "shipper": {
          "name": "", "company": "", "phone": "",
          "streetLines": [""], "city": "", "stateCode": "",
          "postalCode": "", "countryCode": "NL"
        }
      }
    }
  }
}
```

填写公司 UPS Developer App 的 Client ID、Client Secret、6 位寄件账号和真实荷兰发件信息；完成后设 `enabled: true`。不要把密钥发到聊天或提交 Git。旧示例中的 `ups.apiKey` 占位分块不参与此驱动。

生产主机固定 `https://onlinetools.ups.com`，Sandbox 主机固定 `https://wwwcie.ups.com`，不允许在配置文件自定义 URL，不继承根级或 FedEx 配置。OAuth token 按供应商编号、环境、凭据及账号隔离缓存，使用到期前 60 秒的安全余量；并发获取同一 token 共用请求。不会把 token 放入日志或数据库。

供应商详情仅显示字段缺失/环境是否匹配，不显示账号、Client ID、Client Secret。配置就绪只代表本地字段完整，不代表 UPS 已授权账号线路；实际权限由 UPS 响应确认。

## 2. 后台配置步骤

1. 建立或选择尾程渠道 `UPS`。
2. 新增供应商连接，驱动 `UPS_OFFICIAL`、编号与 profile 一致，选择 `PRODUCTION`。在详情核对凭据就绪及环境匹配。
3. 服务管理中绑定此供应商，建立 Standard 内部计价服务，首期选 EUR，根据业务选择按票/按箱和支持多件。实际 UPS 服务代码由路由固定，无需客户选择。
4. 为供应商建立覆盖所需国家/邮编的有效成本表，写入完整价格矩阵；为服务建立有效利润版本，可设置客户专属、分组、等级、默认报价。燃油在 UPS 渠道按时间区间维护。
5. 供应商详情点击“新增 Standard 国家路由”，选择内部服务、实际开通的国家与启用状态。NL 和其他欧盟目的国可放在同一条路由。
6. 在正常创建运单页选择客户与供应商，填写目的国，系统自动解析。试算和提交共用驱动前置校验。

## 3. 字段与边界

- 地址按完整单词合并切分，UPS 最多 3 行，每行 35 字符；FedEx 仍为每行 20 字符。所有入口一致。
- 收件人、公司各最多 35 字符，城市最多 30 字符，邮编最多 9 字符。电话规范为 6–15 位数字。省/州代码最多 5 字符；IE 必填，其他当前目的国可选。
- 1–200 箱，仍受服务件数限制。每箱重量/长宽高大于零，最大 70 kg、最长边 274 cm、长加围长不超过 400 cm。
- 每条货品英文品名必填，为可打印英文字符；同箱品名按逗号空格合并后最多 35 字符。其他申报字段由全局设置控制；不生成清关商业发票。
- 运费付款方固定公司 UPS 账号，包装固定自备普通包裹 `02`。税务、DDP/DDU、报关清关、税号和特殊货物选项不开放，提交非默认值会明确拒绝。
- 欧盟国家不是所有地区都免额外清关。代码拦截已知特殊目的地（如西班牙 Canary/Ceuta/Melilla、芬兰 Åland、法国部分海外邮编等）；这不是全球海关区域数据库。管理员仍须向 UPS 核对实际目的地，不能仅因国家在欧盟就宣称任意邮编均可下单。

## 4. Shipping、状态与原始数据

OAuth：`POST /security/v1/oauth/token`，Basic Client ID/Secret，表单 `grant_type=client_credentials`。

创建：`POST /api/shipments/v2409/ship`，`RequestOption=validate`。**此请求本身创建运单，绝不能再调用一次作为“正式创建”。** HTTP 202 是系统已受理和预扣，UPS 运单号随后从任务状态获取。

Open API 幂等键/请求哈希与订单、钱包预扣、持久化任务在同一数据库事务内保存，同键异体返回冲突。队列和订单分别原子抢占，调用次数不随重复提交、重复投递或 Worker 重启增加。OAuth 失败在审计中明确标记未发出 Shipping；明确业务拒绝为 FAILED；网络/超时/未知响应为 UNKNOWN，不自动重试、不自动退款。

订单快照保存供应商、驱动、环境、路由、实际服务代码、包裹顺序及账号指纹。配置改变不能改变历史订单所属连接；环境/账号被修改时拒绝错环境调用。新旧 FedEx 数据保留兼容，不补发历史订单。

UPS 明确成功后先在事务里保存整票 `ShipmentIdentificationNumber`、每箱 TrackingNumber、GIF 原图及审计，再转换 PDF。审计记录 method/path、transactionId、HTTP 状态和脱敏报文，不含密钥和完整标签。

## 5. 逐箱面单与 PDF 失败恢复

- 订单列表转单号展示整票 ID；详情箱表显示各箱 TrackingNumber，标签显示对应箱号。
- 每箱保存 GIF 原图，使用 Sharp 无损解码为 PNG，pdf-lib 等比嵌入 4×6 PDF，保留约 2 mm 白边，不裁掉条码或套用 FedEx 裁切逻辑。
- PDF 成功后可在当前页面预览、打印和下载；UPS 模板页只提供已实现的标准 4×6 PDF，无自定义热敏布局。
- 转换失败仍保留 `GENERATED` 和原图。任务返回 `LABEL_PROCESSING_FAILED`，显示“运单已生成，PDF 处理失败”。再次预览/下载仅重做本地转换，不调用 UPS Shipping。
- Open API 标签项增加 `box_no` 与 `pdf_ready`。多标签不传 `label_id` 返回错误，不默认下载第一箱。原图不对外提供。

## 6. 整票取消与退款

管理员统一接口：`POST /api/admin/v1/orders/:orderId/cancel`。旧 `/fedex/cancel` 仍保留且只能处理 FedEx。

UPS 使用 `DELETE /api/shipments/v2409/void/cancel/{ShipmentIdentificationNumber}`，不带单箱筛选。只在响应与整票结果均明确成功、且返回的逐箱结果也全部成功时标记 CANCELLED；不明确、超时或部分取消不退款，需人工核查。已取消/已交运/未知状态不能重复触发此操作。

系统订单尚未出单且结果明确时可本地取消。成功取消在同一事务中保留订单及原面单、创建唯一 `CancellationRefundCase`；会计确认后才产生退款流水。钱包不会因点击取消立即变化。

## 7. 服务器升级（首次含数据库变更）

本次 `update-production.sh` 会因 `apps/api/prisma/` 有变更而安全停止，不能只重复运行该脚本。先审阅增量 SQL，维护窗口中备份并手动迁移。不要运行 `db push --accept-data-loss`、清库或 `docker compose down -v`。

在 Ubuntu 项目根目录，先拉取已提交版本并构建（仍不触发真实 UPS 请求）：

```bash
cd ~/movixfreight
git status --short                    # 必须先处理真实未提交改动
git pull --ff-only origin main
dc() { docker compose --env-file .env.production -f docker-compose.server.yml "$@"; }
dc build api worker admin-web customer-web
```

进入维护窗口：停 API 阻止新单，等 Worker 把已有队列处理完；以下计数必须归零。如果长时间不归零，先核查，不能直接终止正在向承运商发送的请求。若放弃升级，可 `dc start api` 恢复旧容器。

```bash
dc stop api
dc exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
SELECT count(*) AS unfinished FROM "ShipmentDispatchJob"
WHERE status IN ('PENDING', 'PROCESSING');
SELECT count(*) AS carrier_inflight FROM "Order" WHERE "shipmentStatus" = 'GENERATING';
SQL
```

确认两项计数归零后再逐条执行；任何命令失败都应停止并排查：

```bash
dc stop worker
BACKUP_DIR="$HOME/movix-backups" bash infra/scripts/backup-production.sh
dc exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  < apps/api/prisma/migrate-ups-official-labels.sql
dc up -d --no-deps api worker admin-web customer-web
curl -fsS http://127.0.0.1:3340/api/health/ready
dc logs --tail=80 api worker
```

数据库和 Redis 卷保留不动；不修改宿主机现有其他站点 Nginx。备份仍只有本机副本，无异地灾备。

SQL 仅给 OrderBox 新增可空承运商运单号，给 ShipmentLabel 新增可空箱关联和原始文件字段/唯一索引，不改历史面单和账务流水，可重复执行。镜像增加 Sharp 原生依赖；应验证目标服务器 Linux 构建，不要复制 Windows node_modules 上服务器。`.dockerignore` 已排除本地凭据、环境文件、备份及构建产物。

## 8. 验证记录与待验收

已通过 34 项 API/订单测试、8 项计价引擎测试、全仓类型检查与构建；Linux Docker 镜像及编译后 GIF → PDF 冒烟测试通过。Vite 仍提示现有前端包体积较大，不阻断构建。

已使用模拟 UPS 响应验证 OAuth 缓存隔离、主机与 HTTP 契约、单次创建锁、多箱映射、未知结果保护、本地 PDF 恢复、整票取消及唯一会计待办。订单入口测试覆盖管理员/门户/Excel/Open API 的路由、字段、预扣和标签归属。

本地数据库已在备份后执行增量 SQL 并重复验证；备份位于被 Git/Docker 排除的 `tmp/movix-before-ups-20260916.dump`。没有调用任何真实 UPS Shipping/Cancel，没有擅自新增生产客户、报价、服务或供应商记录。

实单验收尚需管理员完成：填写生产 profile → 配置实际价格及线路 → 使用指定客户和真实收件/箱货数据创建 NL 单箱及欧盟跨境多箱 → 检查逐箱 PDF 和打印质量 → 未交运整票取消 → 会计确认退款。记录 shipment_id、transactionId、时间及结果，勿复制密钥或完整原始报文到外部。

## 官方依据

- [UPS OAuth Client Credentials](https://github.com/UPS-API/api-documentation/blob/main/OAuthClientCredentials.yaml)
- [UPS Shipping / Void Shipment 定义](https://github.com/UPS-API/api-documentation/blob/main/Shipping.yaml)
- [UPS Developer Portal](https://developer.ups.com/get-started)
