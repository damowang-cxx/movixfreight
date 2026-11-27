# DPD 英国本土渠道商接口

驱动代码：`DPD_RELAY_UK`。现阶段仅接收 GB 目的国、一票一件的普通货物。管理员先建 DPD 尾程渠道，再建立供应商连接、单件服务、GB 默认路由、成本表和利润表。路由的承运商服务代码填写渠道商确认的 `ProductCode`。

连接配置位于被 Git 忽略的 `config/connectors.local.json`，格式见 `config/connectors.local.example.json` 的 `dpdRelay.profiles`。profile 键必须等于供应商连接编号，环境必须一致。用户提供的英国发件仓联系人、地址、邮编和邮箱已预填在示例中；发件公司名、完整电话和渠道账号仍需填入。`44` 只是区号，不能作为完整手机号。生产 profile 还需在确认英国本土字段与产品代码后显式设置 `ukDomesticConfirmed: true`，否则在预扣前拒绝下单。`ProductCode` 只在 GB 国家路由中配置；普通国内货物的文档代码为 `NDOC`，`DOMESTIC SPX` 是产品名称。

目前渠道商文档仅列出 HTTP 地址。本驱动默认要求生产环境使用 HTTPS；若渠道商确实只能提供 HTTP，需在该 profile 中显式设置 `allowInsecureHttp: true`，这会让账号和收发件资料以明文在网络上传输。优先向渠道商索取 HTTPS 地址。

当前系统建单映射仍是初版：系统订单号 → `CustomerRefNo`；profile → 账号、发件公司及 AJWW 发件地址、`VendorName`/`ServiceName`；发件公司名 → `OriginName`；每票订单的英国收件人姓名 → `DestinationName`。实测可成功建单的直连请求则使用 `DestinationName=UNITED KINGDOM`，且省略了尺寸和商品明细等可选字段；这套实测结果尚未写入系统建单映射。GB 国家路由 → `ProductCode`；申报币种与订单运费结算币种分开。`Dox_Spx` 固定 `SPX`。不发送文档中的印度出口、FedEx 或 UPS 专属字段。

实测成功响应把 `ResponseCode=RT01`、`ErrorCode=0`、`Status=Success`、`AWBNo`、`ForwardingNo` 和 PDF 放在 `Response` 对象内。当前系统解析器仍需按该结构调整，且必须先确认 PDF 是否为可交付的 DPD 面单。若建单已返回 `AWBNo` 但面单缺失，系统记录该号码并标记结果待核查，不重复建单；管理员可调用 `POST /api/admin/v1/orders/:orderId/dpd/print` 补打。作废使用 `AWBNo`，只在渠道明确返回 `Response.StatusCode=0` 后进入待财务确认退款。轨迹按渠道商 `Tracking` 数组同步。

建单请求和渠道响应的诊断内容保存在该订单的 `ConnectorCallLog`，管理员可在订单详情的“DPD 接口请求与响应日志”查看。账号密码、账号代码、PDF/Base64 附件会脱敏或省略，长文本和大数组会截断；HTTP 错误与非 JSON 响应也保存可用摘要。建单 HTTP 200 但响应格式不符合成功协议且未明确拒绝时，订单保持“结果待核查”，不得自动重试。日志只对新请求生效，无法补回旧订单缺失的原始响应。

2026-11-25 实测渠道拒单响应将 `Status=Fail`、`ErrorCode=1` 和 `Error[].Description` 放在 `Response` 对象内。驱动已将这类明确拒单识别为失败，并把错误描述展示在订单诊断中。此测试返回 `Invalid Vendor Code/Name`、`Invalid Service Name`、`Destination Cannot be Empty`；请求中对应发送了 `AJERDPD`、`DPD Next Day`、收件人姓名，需渠道商确认三者在其账号下的准确取值及字段含义。

渠道商先前确认 `VendorName=AJERDPD`，但实测仍返回无效 Vendor，需其核对当前账号授权的真实代码。`OriginName` 使用公司名，AJWW 发件地址放在发件字段；`DestinationName` 当前使用每票英国收件人姓名，但实测返回目的地为空，也需核对该字段实际允许的取值。文档对 `VendorName` 标注最长 4 字符，与先前确认的 7 字符值不一致。另待确认 SPX 是否仍需要证件及发票字段、`AWBNo` 与 DPD 最终追踪号的关系、真实 PDF 响应格式、产品最大重量和尺寸。接口调用日志只记录非机密摘要，不保存账号密码或面单 Base64。

## 直连测试脚本

先修改 `apps/api/scripts/test-dpd-relay.ts` 顶部的 `TEST_VALUES`：填入渠道商确认的 `vendorName`、`serviceName`、`destinationName`，并核对 `originName`、`productCode`。测试收件人和箱货资料在忽略 Git 的 `config/dpd-test-order.local.json`，可直接编辑该文件。然后从仓库根目录运行：

```powershell
pnpm dpd:test
```

`send: false` 仅预览；`send: true` 会向渠道商发出建单请求。脚本从忽略 Git 的 `config/connectors.local.json` 读取账号和发件仓；不需要本地数据库、Redis、Docker 或系统订单，不会预扣系统钱包。`CustomerRefNo` 在文档中是必填字段，由脚本自动生成，无需手工修改。测试请求省略尺寸、商品明细、COD、额外地址和邮箱等可选字段。实测接口仍要求发件手机号、收件手机号、重量和收件联系人，脚本会发送这些字段。除参考号外请求完全相同会被拦截，避免重复生成运单。脱敏请求、响应字段及状态保存在忽略 Git 的 `tmp/dpd-relay-tests/<参考号>.json`；PDF 保存在同目录。

2026-11-26 直连实测：`VendorName=AD11`、`ServiceName=DPD Next Day` 与 `DestinationName=Mildenhall` 的组合仅返回目的地错误。改为 `DestinationName=UNITED KINGDOM` 后不再报 Vendor、Service、Destination 错误，渠道却返回 `Status=Fail`、`ErrorCode=1`、SQL 数值转换错误，同时给出 `AWBNo=5678079` 和 `PdfLabel`。按该 AWB 补打返回 `RT01/Success/0` 及有效的一页 A4 PDF，面单显示 AJ Worldwide 和 `Service Level: Manual`，尚不能证明已取得 DPD 最终面单或追踪号。因建单响应仍是失败且号码已存在，暂停重复建单，需渠道商按参考号 `DPDTEST-20261126-002` 核实数值转换字段、真实 DPD 转单号及面单获取方式。正式连接参数暂不更新。

同日再次使用相同请求字段但新参考号 `DPDTEST-20261126-003`，得到另一个 `AWBNo=5678080`、相同 SQL 数值转换错误和一页 AJ Worldwide PDF。再次运行同一参考号时脚本会直接显示已保存结果；不得仅换参考号继续重发。

同日最小字段测试首先验证：省略手机号和重量时，接口明确拒绝；补齐后又要求 `ConsigneeContact`。发送必要字段和这四个实测要求的字段后，接口返回 `Response.Status=Success`、`ErrorCode=0`、`AWBNo=5678093`、`ForwardingNo=15505991057771`、`BSShipping_APIName=DPD_UK`，并提供有效 PDF。成功请求参考号为 `DPDTEST-MWX2HVVQ-49C8DA`，脱敏请求与响应见本地 `tmp/dpd-relay-tests`。PDF 的版式仍是 AJ Worldwide 运单，印有 `Service Level: Manual`，没有明显 DPD 标识；需渠道商确认 `ForwardingNo` 是否是最终 DPD 追踪号、能否提供 DPD 最终面单。在确认前，正式渠道映射不应把该 PDF 直接当作 DPD 面单交付。
