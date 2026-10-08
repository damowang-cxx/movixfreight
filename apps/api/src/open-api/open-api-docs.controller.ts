import { Controller, Get, Header, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../auth/decorators';

const documentHtml = String.raw`<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="description" content="Movix Freight Open API v1 对接文档" />
    <title>Movix Freight · Open API v1</title>
    <style>
      :root { color-scheme: light; --ink:#17212b; --muted:#617180; --line:#dbe3e8; --paper:#f6f8f9; --panel:#fff; --blue:#126c91; --aqua:#d9f3f3; --orange:#d96b2b; --code:#10242e; --code-ink:#e7f0f3; }
      * { box-sizing:border-box; }
      html { scroll-behavior:smooth; }
      body { margin:0; background:var(--paper); color:var(--ink); font:15px/1.65 Inter, "Microsoft YaHei", "PingFang SC", system-ui, sans-serif; }
      .masthead { background:linear-gradient(112deg,#10374d 0%,#176b88 60%,#168a91 100%); color:#fff; padding:36px max(24px,calc((100vw - 1180px)/2)); border-bottom:5px solid #f2a65a; }
      .eyebrow { letter-spacing:.12em; font-size:12px; font-weight:700; text-transform:uppercase; color:#b7e7e4; }
      h1 { font-size:clamp(30px,5vw,50px); line-height:1.08; margin:8px 0 12px; letter-spacing:-.045em; }
      .masthead p { max-width:680px; margin:0; color:#def0f2; font-size:16px; }
      .content { display:grid; grid-template-columns:220px minmax(0,880px); gap:48px; max-width:1180px; margin:0 auto; padding:42px 24px 70px; }
      aside { align-self:start; position:sticky; top:20px; padding-left:16px; border-left:2px solid #bfd8dd; }
      aside a { color:var(--muted); text-decoration:none; display:block; padding:5px 0; font-size:14px; }
      aside a:hover { color:var(--blue); font-weight:700; }
      main { min-width:0; }
      section { margin-bottom:50px; scroll-margin-top:20px; }
      h2 { font-size:26px; line-height:1.2; letter-spacing:-.025em; margin:0 0 16px; }
      h3 { font-size:17px; margin:28px 0 10px; }
      p { margin:0 0 14px; }
      .notice { padding:15px 18px; border-left:4px solid var(--orange); background:#fff5ea; color:#71411e; }
      .url { display:flex; align-items:center; justify-content:space-between; gap:12px; margin:18px 0; border:1px solid #b8dce0; background:var(--aqua); padding:13px 15px; border-radius:4px; }
      code, pre { font-family:"Cascadia Code", "SFMono-Regular", Consolas, monospace; }
      .url code { color:#084a61; font-size:14px; word-break:break-all; }
      button { cursor:pointer; border:1px solid #7eb7c5; background:#fff; color:#07536d; border-radius:4px; padding:5px 9px; font:inherit; white-space:nowrap; }
      button:hover { background:#eaf7f7; }
      .endpoint { border:1px solid var(--line); background:var(--panel); border-radius:6px; margin:18px 0; overflow:hidden; }
      .endpoint-title { display:flex; align-items:center; gap:10px; padding:14px 16px; border-bottom:1px solid var(--line); font-weight:700; }
      .method { color:#fff; background:#168a75; border-radius:3px; padding:2px 7px; font:700 12px/1.45 monospace; }
      .get { background:#2878ab; }
      .endpoint-body { padding:16px; }
      .endpoint-body p:last-child { margin-bottom:0; }
      pre { overflow:auto; background:var(--code); color:var(--code-ink); padding:17px; border-radius:5px; font-size:12.5px; line-height:1.6; margin:14px 0; }
      .code-wrap { position:relative; }
      .code-wrap button { position:absolute; right:9px; top:8px; color:#bbebf2; background:#183844; border-color:#4b7681; font-size:12px; }
      table { width:100%; border-collapse:collapse; font-size:14px; margin:12px 0; }
      th,td { text-align:left; vertical-align:top; padding:10px 8px; border-bottom:1px solid var(--line); }
      th { color:#426170; font-weight:700; background:#f4f8f9; }
      td:first-child { font-family:"Cascadia Code", Consolas, monospace; color:#07536d; font-size:13px; }
      ul { padding-left:22px; margin:10px 0; }
      .chips { display:flex; flex-wrap:wrap; gap:7px; }
      .chip { border:1px solid #b9d8df; border-radius:999px; padding:3px 9px; color:#25596a; background:#f8ffff; font:12px/1.4 monospace; }
      .footer { color:var(--muted); border-top:1px solid var(--line); padding-top:20px; font-size:13px; }
      @media (max-width:760px) { .content { display:block; padding-top:28px; } aside { display:flex; overflow:auto; gap:14px; position:static; border-left:0; border-bottom:1px solid var(--line); padding:0 0 12px; margin-bottom:30px; white-space:nowrap; } aside a { padding:0; } .masthead { padding-top:28px; padding-bottom:28px; } .url { align-items:flex-start; flex-direction:column; } }
    </style>
  </head>
  <body>
    <header class="masthead">
      <div class="eyebrow">Movix Freight · Integration reference</div>
      <h1>Open API v1</h1>
      <p>为客户 ERP 创建运单、异步获取 FedEx / UPS 面单及查询物流轨迹而设计的公开接入文档。内部管理端与客户门户接口不在本页开放范围内。</p>
    </header>
    <div class="content">
      <aside aria-label="文档目录">
        <a href="#start">开始接入</a><a href="#auth">鉴权与幂等</a><a href="#create">创建运单</a><a href="#fields">完整字段表</a><a href="#label">查询与下载面单</a><a href="#tracking">查询物流轨迹</a><a href="#ups">UPS 官方接口</a><a href="#rules">线路规则</a><a href="#errors">错误处理</a><a href="#limits">当前边界</a>
      </aside>
      <main>
        <section id="start">
          <h2>开始接入</h2>
          <p>创建和状态查询使用 JSON；面单下载返回 PDF 二进制。创建运单成功只表示系统已受理、完成预扣并进入异步面单队列，不表示已取得承运商运单号或标签。</p>
          <div class="url"><code id="base-url">/api/open/v1</code><button type="button" data-copy="base-url">复制地址</button></div>
          <ol><li>向 Movix 管理员领取贵司客户专属 API Key、可下单的生产服务代码、服务币种和所需申报字段。</li><li>在本系统客户钱包中准备足额 EUR/GBP 余额，并使用真实收寄件资料提交订单。</li><li>保存返回的 <code>shipment_id</code>，轮询标签状态；READY 后按 <code>label_id</code> 下载每箱 PDF。</li><li>使用同一 <code>shipment_id</code> 查询后台同步的轨迹；轨迹接口不会实时请求承运商。</li></ol>
          <div class="notice">公开 Open API 当前仅接受已启用的生产服务；请求会真实预扣并可能生成承运商面单。不要用本页示例地址直接提交。Sandbox 仅在管理员内部使用，当前没有供客户 ERP 直接打单的公开 Sandbox 端点。</div>
          <p style="margin-top:14px">API Key 由 Movix 管理员在客户详情中创建或轮换，明文仅显示一次。请存放在服务端密钥管理中，不要放入浏览器代码、URL、日志或工单。</p>
        </section>
        <section id="auth">
          <h2>鉴权与幂等</h2>
          <p>每个请求均需提供 <code>X-API-Key</code>。创建运单还必须带调用方生成的唯一 <code>Idempotency-Key</code>。</p>
          <div class="code-wrap"><button type="button" data-copy="auth-code">复制</button><pre id="auth-code">X-API-Key: mvx_...
Idempotency-Key: erp-order-20260824-0001</pre></div>
          <ul><li><code>Idempotency-Key</code> 为 1–256 字符；每个有意创建的新订单使用新键。客户参考号 <code>client_reference</code> 可以重复，不能代替幂等键。</li><li>同一客户以相同键、相同请求体重试，会返回同一个订单号，不会重复扣费；重试响应仍是受理格式，要调用面单状态接口获取当前结果。</li><li>同一键配合不同请求体返回 HTTP <code>409</code>。若创建请求超时，保留原请求体和原键，先核查订单；不得直接换键重发。</li><li>API Key 决定客户身份，请求体不能指定其他客户。查询其他客户订单返回 <code>404</code>，不会泄露其是否存在。</li></ul>
        </section>
        <section id="create">
          <h2>创建运单</h2>
          <div class="endpoint"><div class="endpoint-title"><span class="method">POST</span><code>/shipments</code></div><div class="endpoint-body"><p>请求头：<code>Content-Type: application/json</code>、<code>X-API-Key</code>、<code>Idempotency-Key</code>。请求根字段固定为 <code>shipment</code>。成功响应 HTTP <code>202</code>，其中 <code>shipment_id</code> 是系统订单号。以下地址和服务代码仅用于说明格式，不可直接提交生产。</p><div class="code-wrap"><button type="button" data-copy="request-code">复制示例</button><pre id="request-code">{
  "shipment": {
    "client_reference": "ERP-20260824-001",
    "service": "YOUR_SERVICE_CODE",
    "parcel_count": 1,
    "taxwith": 0,
    "tax_number": null,
    "deliverywith": "",
    "exportwith": 0,
    "importwith": 0,
    "attrs": [],
    "declaration_currency": "EUR",
    "to_address": {
      "name": "Jane Doe", "company": null, "tel": null,
      "mobile": "+31612345678", "city": "Amsterdam",
      "state": null, "state_code": null, "country": "荷兰",
      "postcode": "1012JS", "email": null, "ext": {},
      "address_1": "Dam 1", "address_2": null, "address_3": null
    },
    "from_address": {},
    "parcels": [{
      "reference": "FBA-BOX-001",
      "client_weight": 1.2, "client_length": 20,
      "client_width": 15, "client_height": 10,
      "declarations": [{
        "weight": 0.2, "length": 10, "width": 8, "height": 3,
        "sku": "SKU-001", "name_cn": "手机壳", "name_en": "Phone case",
        "unit_price": 5.5, "quantity": 1,
        "material": null, "origin_country": "CN", "hs_code": "392690"
      }]
    }]
  }
}</pre></div><div class="code-wrap"><button type="button" data-copy="accepted-code">复制响应</button><pre id="accepted-code">{
  "status": 1,
  "info": null,
  "time": 1780000000000,
  "data": { "shipment": {
    "shipment_id": "ORD-20260824-XXXXXXXX",
    "client_reference": "ERP-20260824-001",
    "label_status": "PENDING",
    "label_status_message": "下单成功，正在等待面单生成",
    "dispatch": {
      "status": "PENDING", "stage": "QUEUED",
      "message": "下单成功，正在等待面单生成",
      "reasonCode": "QUEUED", "retryAllowed": false
    },
    "label_status_url": "/api/open/v1/shipments/ORD-.../label",
    "label_download_url": "/api/open/v1/shipments/ORD-.../label/download"
  }}
}</pre></div><p>系统根据箱重量和尺寸、所选服务的计费方式、国家/邮编成本表与客户利润表试算并预扣；本接口没有独立的“预估收费重”输入字段，也不提供正式下单前的公开试算端点。若报价、线路或余额不满足要求，将拒绝建单且不会创建运单。</p></div></div>
        </section>
        <section id="fields">
          <h2>完整字段表</h2>
          <p>以下“可选”只表示请求结构允许省略；管理员配置的全局申报规则和实际命中的服务线路可能增加必填项。JSON 中不要传入未列出的字段：服务端会拒绝未知属性。</p>
          <h3>shipment</h3>
          <table><thead><tr><th>字段</th><th>类型 / 必填</th><th>含义与约束</th></tr></thead><tbody>
            <tr><td>service</td><td>string / 必填</td><td>客户可见的生产服务代码，由管理员提供；不是供应商编号。</td></tr>
            <tr><td>client_reference</td><td>string / 可选</td><td>贵司内部参考号，可重复；系统订单号仍以响应的 shipment_id 为准。</td></tr>
            <tr><td>parcel_count</td><td>integer / 必填</td><td>箱数，至少 1，必须与 parcels 数组长度相同，并满足服务件数限制。</td></tr>
            <tr><td>declaration_currency</td><td>EUR 或 GBP / 必填</td><td>这一票全部申报货品使用的币种；运费预扣币种由服务决定。</td></tr>
            <tr><td>to_address</td><td>Address / 必填</td><td>收件地址，见下表。</td></tr>
            <tr><td>from_address</td><td>Address / 可选</td><td>仅保存为订单数据；当前不覆盖供应商连接预设的发件人。</td></tr>
            <tr><td>parcels</td><td>Parcel[] / 必填</td><td>至少一箱；每箱至少一条申报明细。</td></tr>
            <tr><td>taxwith</td><td>integer / 可选，默认 0</td><td>结构允许 0–4；当前 FedEx/UPS 线路只接受 0。</td></tr>
            <tr><td>tax_number</td><td>string / 可选</td><td>taxwith 为 3/4 时结构上必填，但当前线路不支持非默认税务方式或税号。</td></tr>
            <tr><td>deliverywith</td><td>string / 可选，默认空</td><td>结构允许空、ddu、ddp；当前线路只接受空。</td></tr>
            <tr><td>exportwith</td><td>integer / 可选，默认 0</td><td>结构允许 0–7；当前线路只接受 0。</td></tr>
            <tr><td>importwith</td><td>integer / 可选，默认 0</td><td>结构允许 0–2；当前线路只接受 0。</td></tr>
            <tr><td>attrs</td><td>string[] / 可选，默认 []</td><td>结构允许下文枚举；当前线路只接受空数组，非空不会被静默忽略。</td></tr>
          </tbody></table>
          <h3>Address（to_address / from_address）</h3>
          <table><thead><tr><th>字段</th><th>类型 / 收件方要求</th><th>说明</th></tr></thead><tbody>
            <tr><td>name</td><td>string / 必填</td><td>收件人名称；UPS 最多 35 字符。</td></tr>
            <tr><td>company</td><td>string / 可选</td><td>公司名；UPS 最多 35 字符。</td></tr>
            <tr><td>tel / mobile</td><td>string / 至少一个</td><td>收件电话，二选一；同时提供时优先使用 mobile。UPS 要求规范为 6–15 位数字。</td></tr>
            <tr><td>city</td><td>string / 必填</td><td>城市；UPS 最多 30 字符。</td></tr>
            <tr><td>state / state_code</td><td>string / 通常可选</td><td>省州名称或代码；两者都有时优先 state_code。UPS 爱尔兰线路要求省/州代码。</td></tr>
            <tr><td>country</td><td>string / 必填</td><td>目的国中文名、ISO 两字代码或系统已支持的英文名；必须在启用国家表和该服务线路范围内。</td></tr>
            <tr><td>postcode</td><td>string / 必填</td><td>邮编参与国家价格列匹配；UPS 最多 9 字符。</td></tr>
            <tr><td>address_1 / 2 / 3</td><td>string / 至少一段非空</td><td>系统将非空段按单空格合并，再不拆单词地重分为最多三段；FedEx 每段 20 字符、UPS 每段 35 字符。</td></tr>
            <tr><td>email</td><td>string / 可选</td><td>联系邮箱；当前不保证会发送承运商通知。</td></tr>
            <tr><td>ext</td><td>object / 可选</td><td>客户附加信息，作为订单数据保存；不作为承运商参数透传。</td></tr>
          </tbody></table>
          <h3>Parcel（parcels[]）与 Declaration（declarations[]）</h3>
          <table><thead><tr><th>字段</th><th>类型 / 必填</th><th>说明</th></tr></thead><tbody>
            <tr><td>number</td><td>string / 可选</td><td>箱号；空值由系统生成 ORD-…-001 等编号，已填写箱号不得重复。</td></tr>
            <tr><td>reference</td><td>string / 可选</td><td>箱子参考号，例如 FBA 编号；与箱号不同。</td></tr>
            <tr><td>client_weight</td><td>number / 必填</td><td>该箱重量，kg，必须大于 0。</td></tr>
            <tr><td>client_length / client_width / client_height</td><td>number / 必填</td><td>该箱长、宽、高，cm，均须大于 0；同时受所选线路尺寸限制。</td></tr>
            <tr><td>declarations</td><td>Declaration[] / 必填</td><td>每箱至少一条；下列字段逐项填写。</td></tr>
            <tr><td>name_cn / name_en</td><td>string / 按规则</td><td>中、英文品名；UPS 必须有可打印英文描述，FedEx 泛欧必须有英文品名，其他按管理员全局申报规则。</td></tr>
            <tr><td>weight</td><td>number / 按规则</td><td>单条商品净重，kg；FedEx 泛欧必须大于 0，且每箱商品净重合计不得超过箱重。</td></tr>
            <tr><td>length / width / height</td><td>number / 可选</td><td>单条商品尺寸，cm；与箱体尺寸字段不同。</td></tr>
            <tr><td>sku / material</td><td>string / 按规则</td><td>商品 SKU 与材质；材质是否必填由全局申报规则决定。</td></tr>
            <tr><td>origin_country / hs_code</td><td>string / 按规则</td><td>原产国与 HS 编码；FedEx 泛欧必填。原产国可用中文国名、英文国名或两字代码。</td></tr>
            <tr><td>quantity</td><td>integer / 按规则</td><td>申报数量，填写时必须为不小于 1 的整数；FedEx 泛欧必填。</td></tr>
            <tr><td>unit_price</td><td>number / 按规则</td><td>单件申报货值；填写时须大于 0，FedEx 泛欧必填。币种使用 shipment.declaration_currency。</td></tr>
          </tbody></table>
        </section>
        <section id="label">
          <h2>查询与下载面单</h2>
          <div class="endpoint"><div class="endpoint-title"><span class="method get">GET</span><code>/shipments/:shipmentId/label</code></div><div class="endpoint-body"><p>使用系统订单号（不是 UPS/FedEx 运单号）。<code>label_status</code> 为 PENDING、READY、FAILED 或 UNKNOWN；<code>dispatch.status</code> 提供更细的 PENDING、VALIDATING、CREATING、READY、FAILED、UNKNOWN、STALLED、BLOCKED、CANCELLED。<code>failure_reason</code> 在失败、未知或超时待核查时给出安全提示。</p><div class="code-wrap"><button type="button" data-copy="label-status-code">复制响应</button><pre id="label-status-code">{
  "status": 1, "info": null, "time": 1780000000000,
  "data": { "shipment": {
    "shipment_id": "ORD-...", "client_reference": "ERP-001",
    "label_status": "READY", "label_status_message": "面单已生成，可下载",
    "dispatch": { "retryAllowed": false, "status": "READY", "stage": "READY",
      "message": "面单已生成，可预览或下载 PDF", "reasonCode": "LABEL_READY",
      "lastActivityAt": "2026-10-08T08:00:00.000Z" },
    "transfer_number": "1Z...", "label_count": 1,
    "labels": [{ "label_id": "实际标签 ID", "box_no": "ORD-...-001",
      "pdf_ready": true, "tracking_number": "1Z...",
      "download_url": "/api/open/v1/shipments/ORD-.../label/download?label_id=实际标签 ID" }],
    "label_download_url": "/api/open/v1/shipments/ORD-.../label/download",
    "failure_reason": null
  }}
}</pre></div></div></div>
          <div class="endpoint"><div class="endpoint-title"><span class="method get">GET</span><code>/shipments/:shipmentId/label/download?label_id=...</code></div><div class="endpoint-body"><p>携带同一客户 API Key。READY 后返回 <code>Content-Type: application/pdf</code>、<code>Content-Disposition: attachment</code> 的二进制 PDF；不要按 JSON 解析成功响应。单箱可省略 <code>label_id</code>；多箱必须逐一使用状态接口返回的标签 ID。未就绪返回 JSON 错误。</p><p>特例：UPS 已创建运单但本地 PDF 转换失败时，<code>label_status=FAILED</code>、<code>dispatch.reasonCode=LABEL_PROCESSING_FAILED</code>，仍可对具体 <code>label_id</code> 再次下载以触发仅限本地的 PDF 修复；绝不再次请求 UPS 创建运单。</p></div></div>
          <p>推荐处理：PENDING / VALIDATING / CREATING 每约 5 秒查询一次；READY 下载全部面单；FAILED / UNKNOWN / BLOCKED / CANCELLED 停止轮询并展示 <code>dispatch.message</code>。STALLED 表示超过 10 分钟未正常完成，应停止密集查询并联系管理员，不要换幂等键重复下单。<code>label_status</code> 在取消后可能仍为 PENDING，请以 <code>dispatch.status=CANCELLED</code> 判定取消。</p>
        </section>
        <section id="tracking">
          <h2>查询物流轨迹</h2>
          <div class="endpoint"><div class="endpoint-title"><span class="method get">GET</span><code>/shipments/:shipmentId/tracking</code></div><div class="endpoint-body"><p>使用系统订单号 <code>ORD-…</code> 查询；只需 <code>X-API-Key</code>，无需幂等键。系统后台自动查询 FedEx / UPS，客户请求读取已保存的结果，不会同步请求承运商。UPS 多箱逐箱返回，FedEx 历史面单的 <code>box_no</code> 可以为 null。</p></div></div>
          <pre>{
  "status": 1, "info": null, "time": 1780000000000,
  "data": { "shipment": {
    "shipment_id": "ORD-...", "transfer_number": "1Z...",
    "status": "IN_TRANSIT", "sync_status": "READY",
    "last_synced_at": "2026-10-08T08:00:00.000Z", "message": null,
    "packages": [{
      "box_no": "ORD-...-001", "tracking_number": "1Z...",
      "status": "IN_TRANSIT", "carrier_status_code": "I",
      "carrier_description": "On the Way", "sync_status": "READY",
      "last_synced_at": "2026-10-08T08:00:00.000Z",
      "next_sync_at": "2026-10-08T09:00:00.000Z", "message": null,
      "events": [{ "occurred_at": "2026-10-08T07:30:00.000Z",
        "status": "IN_TRANSIT", "carrier_status_code": "I",
        "description": "Arrived at Facility", "city": "Brussels",
        "state": null, "country_code": "BE" }]
    }]
  }}
}</pre>
          <p><code>status</code> 为独立轨迹状态：PENDING、LABEL_CREATED、IN_TRANSIT、OUT_FOR_DELIVERY、DELIVERED、EXCEPTION、RETURNING、RETURNED、UNKNOWN、CANCELLED；不会修改订单或费用状态。<code>sync_status</code> 为 PENDING、PROCESSING、READY、NO_EVENTS、ERROR、STOPPED。无扫描记录时 packages/events 可为空，或显示 LABEL_CREATED；ERROR 时会保留上次成功轨迹，并通过 <code>message</code> 说明暂时无法更新。时间均为 UTC ISO 8601。</p>
          <p>待揽收默认约 2 小时、运输中默认约 1 小时自动同步；客户可以约每 10–15 分钟查询本接口，不需要每 5 秒查询。无效 API Key 返回 401，其他客户的订单统一返回 404。</p>
        </section>
        <section id="ups">
          <h2>UPS 官方接口：荷兰/比利时发货、欧盟 Standard</h2>
          <div class="notice">生产环境请求会创建真实运单并预扣账户余额。下方为字段格式说明，不要使用虚构地址进行生产试单。真实收寄件人及箱货数据必须由管理员确认。</div>
          <p>填写管理员向客户公开的 <code>shipment.service</code> 服务代码和目的国家。系统内部反查承载该服务的生产连接、发件国与 Standard 国家路由，对外不暴露供应商连接编号。目的国必须在该服务的可用路由内。成本、利润、燃油与邮编报价全部使用系统报价，不调用 UPS Rating。</p>
          <table><thead><tr><th>字段/阶段</th><th>UPS 规则</th></tr></thead><tbody>
          <tr><td>to_address</td><td>姓名/公司最多 35 字符、城市最多 30 字符、邮编最多 9 字符；电话规范为 6–15 位数字。地址合并后按完整单词切成最多三行，每行 35 字符。爱尔兰需要省/州代码。</td></tr>
          <tr><td>parcels</td><td>1–200 箱（仍受服务件数限制）；每箱最大 70 kg，最长边 274 cm，长加围长不超过 400 cm。重量为 kg、尺寸为 cm，自备普通包装。</td></tr>
          <tr><td>declarations[].name_en</td><td>每项需填写可打印英文描述，单箱所有描述以逗号空格合并后最多 35 字符。其余申报字段依全局规则；不生成清关商业发票。</td></tr>
          <tr><td>taxwith / deliverywith / exportwith / importwith / tax_number / attrs</td><td>只能使用 0 / 空字符串 / 空数组。运费固定由公司寄件账号支付；DDP/DDU、危险品及额外清关本期不支持。特殊税务/清关区域会被拦截，管理员不得开通尚未核实的线路。</td></tr>
          <tr><td>异步执行</td><td>本地预校验 → OAuth → 单次 Shipping（RequestOption=validate）。此 Shipping 请求直接创建运单，不再另外调用一次作为预校验。失败/未知结果不自动重试、不自动退款。</td></tr>
          </tbody></table>
          <h3>逐箱面单与本地 PDF 修复</h3>
          <p>订单 <code>transfer_number</code> 是整票 ShipmentIdentificationNumber；每项 <code>labels</code> 返回 <code>box_no</code>、<code>label_id</code>、该箱 <code>tracking_number</code>、<code>pdf_ready</code> 与 <code>download_url</code>。FedEx 历史面单的 box_no 可为 null。多箱不传 label_id 会明确报错，不默认返回第一箱。</p>
          <p>完整 JSON 响应外层为 <code>{ status, info, time, data: { shipment } }</code>，请以“查询与下载面单”章节的示例为准；这里的 <code>transfer_number</code> 和逐箱 <code>labels[].tracking_number</code> 不能混用。</p>
          <p>UPS GIF 原图保存于数据库，转换为 4×6 PDF，保留约 2 mm 白边。若 dispatch.reasonCode 为 <code>LABEL_PROCESSING_FAILED</code>，说明 UPS 运单已生成而本地 PDF 未就绪，label_status 为 FAILED；转单号和 labels 仍返回。使用 label_id 重试下载即可尝试本地修复，不要重建订单。其他 UNKNOWN/FAILED 不允许借此下载接口再次调用承运商。</p>
          <p>建议每 5 秒轮询 PENDING/VALIDATING/CREATING；READY、FAILED、UNKNOWN、BLOCKED 后停止。STALLED 超过 10 分钟需联系管理员核查，不代表已取消。</p>
        </section>
        <section id="rules">
          <h2>字段规则</h2>
          <table><thead><tr><th>字段</th><th>规则</th></tr></thead><tbody>
            <tr><td>service</td><td>必填。客户可见的服务代码。系统会由服务内部反查生产连接，并按目的国家匹配国家路由和底层 serviceType。调用方不能传入 <code>supplier</code>、供应商连接编号或底层承运商 serviceType。</td></tr>
            <tr><td>to_address</td><td>必填。<code>name</code>、<code>city</code>、<code>country</code>、<code>postcode</code>、至少一个地址字段，以及 <code>tel</code>/<code>mobile</code> 至少一个必填。<code>address_1/2/3</code> 会合并后重新分配为最多三段，FedEx 每段最多 20 个 Unicode 字符；UPS 每段最多 35 个字符。不会拆分完整单词。</td></tr>
            <tr><td>country</td><td>支持启用国家表中的中文名、ISO 两位代码及既有英文名称，系统统一映射 ISO 两位代码。</td></tr>
            <tr><td>state / state_code</td><td>同时提供时优先使用 <code>state_code</code>。UPS 爱尔兰线路必填省/州代码（最多 5 字符），其他当前线路可选。</td></tr>
            <tr><td>parcels</td><td><code>parcel_count</code> 必须等于数组长度；<code>number</code> 可留空，系统会生成订单号前缀箱号；已填写的箱号不可重复；重量、长、宽、高均大于 0。</td></tr>
            <tr><td>FedEx 荷兰本土</td><td>目的国 <code>NL</code> 自动进入本土线路，不下发跨境清关货品；调用方仍只提交客户可见服务代码。</td></tr>
            <tr><td>FedEx 泛欧经济型</td><td>管理员已配置的非 NL 欧洲目的国自动进入泛欧线路。每条申报明细必须有 <code>name_en</code>、<code>weight</code>（商品净重 kg）、<code>origin_country</code>、<code>hs_code</code>、<code>quantity</code>、<code>unit_price</code> 与申报币种；商品净重合计不得超过箱重，单箱最多 68 kg。税费固定由发件人支付。</td></tr>
            <tr><td>declarations</td><td>必填项由全局申报规则及所选供应商路由共同确定。UPS 必须填写可打印英文 <code>name_en</code>；FedEx 泛欧经济型还要求上述清关字段。路由要求时系统会明确拒绝缺失或无效字段。</td></tr>
            <tr><td>税务/贸易字段</td><td>当前 FedEx 和 UPS 线路仅接受默认值；<code>taxwith</code>、<code>deliverywith</code>、<code>exportwith</code>、<code>importwith</code> 与 <code>attrs</code> 的非默认值会被拒绝，避免静默丢失。</td></tr>
            <tr><td>declaration_currency</td><td>仅支持 <code>EUR</code>、<code>GBP</code>。</td></tr>
          </tbody></table>
          <h3>物品属性 attrs</h3><div class="chips"><span class="chip">elec</span><span class="chip">magnetic</span><span class="chip">danger</span><span class="chip">liquid</span><span class="chip">powder</span><span class="chip">paste</span><span class="chip">sensitive_goods</span><span class="chip">wood</span><span class="chip">textile</span></div>
        </section>
        <section id="errors">
          <h2>错误处理</h2><p>所有错误统一返回 JSON。请根据 HTTP 状态码和 <code>info.code</code> 处理，不要仅依赖文案。</p>
          <div class="code-wrap"><button type="button" data-copy="error-code">复制</button><pre id="error-code">{
  "status": 0,
  "info": { "code": "ORDER_CREATION_FORBIDDEN", "message": "EUR 余额不足，无法创建订单" },
  "time": 1780000000000,
  "data": null
}</pre></div>
          <table><thead><tr><th>HTTP / info.code</th><th>何时出现及调用方处理</th></tr></thead><tbody>
            <tr><td>400 / INVALID_REQUEST</td><td>JSON 字段、地址、箱货或线路参数不合法；修正请求。若不确定此前是否受理，先保留原幂等键核查。</td></tr>
            <tr><td>401 / API_KEY_INVALID</td><td>缺少、已轮换或无效 API Key；联系管理员核查。</td></tr>
            <tr><td>403 / ORDER_CREATION_FORBIDDEN</td><td>客户状态或服务币种钱包余额不允许建单；先处理账户状态/充值，不要自动重复请求。</td></tr>
            <tr><td>404 / OPEN_API_ERROR</td><td>服务不可用、报价缺失，或订单不存在/不属于当前 API Key；仅订单归属查询返回相同 404，不能据此判断别人的订单是否存在。</td></tr>
            <tr><td>409 / IDEMPOTENCY_CONFLICT</td><td>同一 Idempotency-Key 对应了不同请求内容；不要换键盲目重发，先核查原订单。</td></tr>
            <tr><td>409 / BUSINESS_CONFLICT</td><td>路由/报价冲突、标签未就绪或多箱下载缺少 label_id 等；按 message 处理。</td></tr>
            <tr><td>503 / LABEL_PROCESSING_FAILED</td><td>UPS 已生成运单但本地 PDF 处理失败；可按原 label_id 再次下载，仅修复 PDF，不再建单。</td></tr>
            <tr><td>500/503 / OPEN_API_ERROR</td><td>系统或连接服务暂时不可用。创建请求发生超时或无法确认结果时，保留原幂等键并人工核查，不要换键重复打单。</td></tr>
          </tbody></table>
          <p><code>info.code</code> 是当前实现中的通用分类，部分业务原因仍需结合 <code>info.message</code> 与 HTTP 状态理解；异步供应商拒绝不会追溯改变创建接口的 HTTP 202，应在标签接口读取 <code>dispatch.reasonCode</code> 与安全提示。</p>
        </section>
        <section id="limits">
          <h2>当前边界</h2>
          <div class="notice">已开通并配置目的国线路的 FedEx 与 UPS 服务支持自动生成面单。UPS 本期仅开放荷兰或比利时发出的欧盟内 Standard 普通包裹。税务、交货条款、报关、清关与物品属性仅在相应线路已启用且具有明确映射时可提交；未启用的字段不得传入，系统会明确拒绝请求。</div>
          <p style="margin-top:14px">当前未开放：完整运单信息、服务列表、账户余额、独立运费试算、取消运单与 Webhook。<code>from_address</code> 会保存到订单，但 FedEx / UPS 均使用供应商连接的本地发件人配置，不会把此字段发送给承运商。</p>
        </section>
        <footer class="footer">Movix Freight Open API v1 · 技术支持请提供 shipment_id、请求时间及 info.code；不要发送 API Key、完整收件人资料或面单 PDF。本页仅描述已开放的客户接口，内部 Swagger 页面不属于对外契约。</footer>
      </main>
    </div>
    <script>
      document.getElementById('base-url').textContent = window.location.origin + '/api/open/v1';
      document.querySelectorAll('[data-copy]').forEach(function (button) {
        button.addEventListener('click', function () {
          var value = document.getElementById(button.getAttribute('data-copy')).textContent;
          navigator.clipboard.writeText(value).then(function () {
            var original = button.textContent; button.textContent = '已复制'; setTimeout(function () { button.textContent = original; }, 1500);
          });
        });
      });
    </script>
  </body>
</html>`;

@Public()
@Controller('open/v1/docs')
export class OpenApiDocsController {
  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  document(@Res() response: Response) {
    response.send(documentHtml);
  }
}
