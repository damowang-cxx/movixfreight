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
      <p>为客户 ERP 创建运单、异步获取 FedEx 面单而设计的公开接入文档。内部管理端与客户门户接口不在本页开放范围内。</p>
    </header>
    <div class="content">
      <aside aria-label="文档目录">
        <a href="#start">开始接入</a><a href="#auth">鉴权与幂等</a><a href="#create">创建运单</a><a href="#label">查询与下载面单</a><a href="#rules">字段规则</a><a href="#errors">错误处理</a><a href="#limits">当前边界</a>
      </aside>
      <main>
        <section id="start">
          <h2>开始接入</h2>
          <p>所有请求使用 JSON。创建运单成功只表示系统已受理、完成预扣并进入异步面单队列；请继续查询标签状态后再下载 PDF。</p>
          <div class="url"><code id="base-url">/api/open/v1</code><button type="button" data-copy="base-url">复制地址</button></div>
          <p>API Key 由 Movix 管理员在客户详情中创建或轮换，明文仅显示一次，请由贵司妥善保管。</p>
        </section>
        <section id="auth">
          <h2>鉴权与幂等</h2>
          <p>每个请求均需提供 <code>X-API-Key</code>。创建运单还必须带调用方生成的唯一 <code>Idempotency-Key</code>。</p>
          <div class="code-wrap"><button type="button" data-copy="auth-code">复制</button><pre id="auth-code">X-API-Key: mvx_...
Idempotency-Key: erp-order-20260824-0001</pre></div>
          <ul><li>同一客户以相同幂等键、相同请求体重试，会返回同一订单，不会重复扣费。</li><li>同一幂等键配合不同请求体，返回 HTTP <code>409</code>。</li><li>API Key 仅能访问自身客户的订单和 PDF 面单。</li></ul>
        </section>
        <section id="create">
          <h2>创建运单</h2>
          <div class="endpoint"><div class="endpoint-title"><span class="method">POST</span><code>/shipments</code></div><div class="endpoint-body"><p>请求根字段固定为 <code>shipment</code>。成功响应 HTTP <code>202</code>，其中 <code>shipment_id</code> 是系统订单号。</p><div class="code-wrap"><button type="button" data-copy="request-code">复制示例</button><pre id="request-code">{
  "shipment": {
    "client_reference": "ERP-20260824-001",
    "supplier": "FEDEX_RELAY_PRODUCTION_01",
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
}</pre></div></div></div>
        </section>
        <section id="label">
          <h2>查询与下载面单</h2>
          <div class="endpoint"><div class="endpoint-title"><span class="method get">GET</span><code>/shipments/:shipmentId/label</code></div><div class="endpoint-body"><p>返回 <code>PENDING</code>、<code>READY</code>、<code>FAILED</code> 或 <code>UNKNOWN</code>，并提供可直接展示的 <code>label_status_message</code>。<code>dispatch.status</code> 进一步表示等待队列、校验中、生成中、已生成、失败、结果未知、超过 10 分钟待核查或当前驱动不支持；<code>dispatch.message</code> 与 <code>reasonCode</code> 可用于页面提示和程序处理。<code>READY</code> 时返回转单号、面单数量和每张面单的下载地址。</p></div></div>
          <div class="endpoint"><div class="endpoint-title"><span class="method get">GET</span><code>/shipments/:shipmentId/label/download?label_id=...</code></div><div class="endpoint-body"><p>仅 <code>READY</code> 状态可下载 PDF。单箱可省略 <code>label_id</code>；多箱必须使用状态接口返回的具体 <code>label_id</code>。</p></div></div>
        </section>
        <section id="rules">
          <h2>字段规则</h2>
          <table><thead><tr><th>字段</th><th>规则</th></tr></thead><tbody>
            <tr><td>supplier</td><td>必填。供应商连接编号，例如 <code>FEDEX_RELAY_PRODUCTION_01</code>。系统会按目的国家匹配该供应商已启用的国家路由，自动选择内部计价服务和实际承运商 serviceType；不接受 <code>service</code> 作为下单依据。</td></tr>
            <tr><td>to_address</td><td>必填。<code>name</code>、<code>city</code>、<code>country</code>、<code>postcode</code>、至少一个地址字段，以及 <code>tel</code>/<code>mobile</code> 至少一个必填。<code>address_1/2/3</code> 会合并后重新分配为最多三段，每段不超过 20 个字符，且不会拆分完整单词。</td></tr>
            <tr><td>country</td><td>支持启用国家表中的中文名、ISO 两位代码及既有英文名称，系统统一映射 ISO 两位代码。</td></tr>
            <tr><td>state / state_code</td><td>均为可选；同时提供时优先使用 <code>state_code</code>，并在 FedEx 请求中传为省/州代码。</td></tr>
            <tr><td>parcels</td><td><code>parcel_count</code> 必须等于数组长度；<code>number</code> 可留空，系统会生成订单号前缀箱号；已填写的箱号不可重复；重量、长、宽、高均大于 0。</td></tr>
            <tr><td>declarations</td><td>每项 <code>name_cn</code>、<code>name_en</code> 必填。是否还需原产国、HS 编码、数量、单价及申报币种，取决于命中的供应商国家路由；路由要求时系统会明确拒绝缺失字段。</td></tr>
            <tr><td>taxwith</td><td>仅 <code>0–4</code>；值为 <code>3</code> 或 <code>4</code> 时必须提供 <code>tax_number</code>。</td></tr>
            <tr><td>declaration_currency</td><td>仅支持 <code>EUR</code>、<code>GBP</code>。</td></tr>
          </tbody></table>
          <h3>物品属性 attrs</h3><div class="chips"><span class="chip">elec</span><span class="chip">magnetic</span><span class="chip">danger</span><span class="chip">liquid</span><span class="chip">powder</span><span class="chip">paste</span><span class="chip">sensitive_goods</span><span class="chip">wood</span><span class="chip">textile</span></div>
        </section>
        <section id="errors">
          <h2>错误处理</h2><p>所有错误统一返回 JSON。请根据 HTTP 状态码和 <code>info.code</code> 处理，不要仅依赖文案。</p>
          <div class="code-wrap"><button type="button" data-copy="error-code">复制</button><pre id="error-code">{
  "status": 0,
  "info": { "code": "INSUFFICIENT_BALANCE", "message": "EUR 余额不足" },
  "time": 1780000000000,
  "data": null
}</pre></div>
          <table><thead><tr><th>HTTP</th><th>含义</th></tr></thead><tbody><tr><td>401</td><td>缺少或无效 API Key。</td></tr><tr><td>403</td><td>客户状态、数据归属或下单权限不满足要求。</td></tr><tr><td>409</td><td>同一幂等键对应不同请求体。</td></tr><tr><td>422</td><td>业务字段、服务能力、余额或供应商能力校验未通过。</td></tr></tbody></table>
        </section>
        <section id="limits">
          <h2>当前边界</h2>
          <div class="notice">当前仅已配置国家路由的 <strong>FEDEX_RELAY</strong> 供应商支持自动生成面单。税务、交货条款、报关、清关与物品属性仅在相应路由已启用且具有明确承运商映射时可提交；未启用的字段不得传入，系统会明确拒绝请求。</div>
          <p style="margin-top:14px">当前未开放：路由轨迹、完整运单信息、服务列表、账户余额、独立运费试算、取消运单与 Webhook。<code>from_address</code> 会保存到订单，但 FedEx 仍使用供应商连接的本地发件人配置。</p>
        </section>
        <footer class="footer">Movix Freight Open API v1 · 技术支持请提供 shipment_id、请求时间及 info.code。开发调试可查看 <a href="/api/docs">Swagger API 文档</a>。</footer>
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
