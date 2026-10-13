# 客户门户 Excel 批量导入

普通客户登录客户门户后，点击顶部“Excel 批量导入”。先下载模板、填写并上传预校验，全部通过后确认创建。导入使用客户可见的**服务代码**，不填写供应商连接编号或客户编号。

## 模板规则

- 第一张工作表为“订单导入”，第二张“填写说明”列出当前客户可用的生产服务代码；每次使用前建议重新下载模板。
- 一行代表一条申报货品；相同“导入订单号”的行合并为一票。同票每行都要重复服务代码和收件信息，且这些字段必须一致。
- 同票相同非空箱号的行合并为一箱；箱号空白时每行作为独立箱，由系统生成箱号。同箱重量和尺寸必须一致。
- 国家可填写启用国家表中的中文名称或 ISO 两字代码。表格字段仍受当前全局申报规则和对应承运商线路规则约束；例如 FedEx 泛欧线路必须填写商品净重、英文品名、原产国、HS 编码、数量、单件货值及币种。
- 单次最多 100 票；文件最多 2 MB，解析后的请求不超过 1.8 MB。超出时拆分文件导入。

## 客户认证接口

两个接口均需客户门户登录后签发的 `Authorization: Bearer <customer JWT>`。客户身份仅取自 JWT，不允许在请求体中指定客户、供应商连接或幂等键。接口接收浏览器从 Excel 解析出的 JSON，不接收原始二进制文件。

```http
POST /api/customer/v1/orders/import/preview
Content-Type: application/json
Authorization: Bearer <customer JWT>
```

```json
{
  "sourceFileName": "orders.xlsx",
  "rows": [
    {
      "rowNo": 2,
      "serviceCode": "客户可见服务代码",
      "order": {
        "clientReference": "IMPORT-001",
        "recipientName": "Jane Doe",
        "recipientPhone": "+31201234567",
        "recipientCountryCode": "荷兰",
        "recipientPostcode": "1012JS",
        "recipientCity": "Amsterdam",
        "recipientAddress": "Dam 1",
        "estimatedChargeableKg": "1.000",
        "boxes": [{
          "weightKg": "1.000", "lengthCm": "20", "widthCm": "15", "heightCm": "10",
          "items": [{ "chineseName": "样品", "englishName": "Sample", "quantity": 1,
            "unitDeclaredValue": "1.00", "declaredValueCurrency": "EUR" }]
        }]
      }
    }
  ]
}
```

预览按每票返回 `READY`（含币种、预计应收）、`ALREADY_CREATED`（该行先前已导入）或 `ERROR`（错误说明）。预览不创建订单、不扣款；会按币种累计本批待创建订单的预扣额检查余额。报价、可用国家、服务状态或余额在预览后仍可能变化，因此确认创建时逐票重新校验。

```http
POST /api/customer/v1/orders/import/commit
Content-Type: application/json
Authorization: Bearer <customer JWT>
```

提交使用与预览相同的请求体，逐票返回 `CREATED`（含订单号、订单 ID 和等待面单状态）或 `ERROR`。成功的每票在正式订单事务中完成预扣并创建持久化面单任务；失败票不扣款。相同客户、文件名、Excel 行号、服务代码与订单内容生成相同幂等键，重复提交不会重复扣费或重复打单。允许对部分失败的批次再次提交；已成功的行会返回原订单。

这两个接口属于**客户门户 JWT 接口**，不是对外 API Key 的 `/api/open/v1`。外部 ERP 打单仍使用在线 Open API 的单票创建契约。
