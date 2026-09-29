#!/usr/bin/env node
// Node.js 20+; no dependencies. Never logs or persists the customer API key.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';

export function parseArgs(args) {
  const options = { base: 'https://movixfreight.com', mode: 'query', wait: false, download: false };
  const values = new Set(['base', 'shipment', 'file', 'idempotency-key']);
  for (let i = 0; i < args.length; i++) {
    const name = args[i].replace(/^--/, '');
    if (args[i] === '--create') options.mode = 'create';
    else if (['wait', 'download', 'help'].includes(name) && args[i].startsWith('--')) options[name] = true;
    else if (values.has(name) && args[i].startsWith('--') && args[i + 1] && !args[i + 1].startsWith('--')) options[name] = args[++i];
    else throw new Error(`未知参数或缺少参数值：${args[i]}`);
  }
  const url = new URL(options.base);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('--base 必须是站点根地址，不含凭据、路径或查询参数');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('非本机地址必须使用 HTTPS');
  options.base = url.origin;
  return options;
}

export function validateInput(body) {
  if (/__REPLACE_[A-Z_]+__/.test(JSON.stringify(body))) throw new Error('请先替换请求模板中的全部 __REPLACE_...__ 占位内容');
  const s = body?.shipment;
  if (!s?.supplier || s.service || !s.to_address || !Array.isArray(s.parcels) || !s.parcels.length || s.parcel_count !== s.parcels.length) throw new Error('需要 shipment.supplier、to_address 及与 parcel_count 相符的 parcels；不能使用旧 service 字段');
  for (const p of s.parcels) {
    for (const name of ['client_weight', 'client_length', 'client_width', 'client_height']) {
      if (typeof p[name] !== 'number' || !Number.isFinite(p[name]) || p[name] <= 0) throw new Error(`箱子 ${name} 必须是实际的正数`);
    }
  }
  // Full country, pricing, declaration and driver validation remains on the server.
}

export function makeClient(base, key, fetcher = fetch) {
  const redact = (text) => String(text).split(key).join('[REDACTED]');
  return async (path, { body, idempotencyKey, pdf = false } = {}) => {
    // Only construct same-origin paths locally; never follow URLs returned by suppliers.
    if (!path.startsWith('/api/open/v1/') || new URL(path, base).origin !== base) throw new Error('禁止向其他站点发送 API Key');
    let response;
    let bytes;
    try {
      response = await fetcher(`${base}${path}`, {
        method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { 'X-API-Key': key, ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      bytes = Buffer.from(await response.arrayBuffer());
    } catch {
      throw new Error(body
        ? '创建请求网络失败/超时/重定向：可能已经受理！不要更换幂等键，不自动重发；保留本次 request.json 与幂等键并核查后台。'
        : '查询或下载网络失败/超时/重定向；可以重新查询同一订单。');
    }
    if (pdf && response.ok && bytes.subarray(0, 5).toString('ascii') === '%PDF-') return bytes;
    let json;
    try { json = JSON.parse(bytes.toString('utf8')); } catch { /* Do not print HTML/proxy bodies. */ }
    if (!response.ok || json?.status !== 1 || pdf) {
      const detail = json?.info?.message ?? json?.message ?? (pdf ? '响应不是 PDF，未保存为面单' : '响应不是预期的 Open API JSON');
      throw new Error(redact(`HTTP ${response.status} ${json?.info?.code ?? ''}：${Array.isArray(detail) ? detail.join('；') : detail}`));
    }
    return JSON.parse(redact(JSON.stringify(json)));
  };
}

export async function monitor(client, shipmentId, { wait = false, save, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), maxPolls = 120 } = {}) {
  const path = `/api/open/v1/shipments/${encodeURIComponent(shipmentId)}/label`;
  for (let i = 0; i < (wait ? maxPolls : 1); i++) {
    const result = await client(path);
    const shipment = result.data?.shipment;
    if (!shipment?.label_status) throw new Error('状态响应缺少 data.shipment.label_status');
    await save?.(result);
    console.log(`${shipmentId} | ${shipment.label_status} / ${shipment.dispatch?.status ?? ''} | ${shipment.dispatch?.message ?? shipment.label_status_message ?? ''}`);
    if (shipment.transfer_number) console.log(`转单号：${shipment.transfer_number}`);
    if (shipment.label_status === 'READY') return shipment;
    if (['FAILED', 'UNKNOWN'].includes(shipment.label_status) || ['FAILED', 'UNKNOWN', 'STALLED', 'BLOCKED', 'CANCELLED'].includes(shipment.dispatch?.status)) {
      throw new Error(`停止轮询：${shipment.dispatch?.reasonCode ?? ''} ${shipment.failure_reason ?? shipment.dispatch?.message ?? shipment.label_status_message ?? ''}。不要重新创建运单，请核查后台。`);
    }
    if (wait && i < maxPolls - 1) await sleep(5000);
  }
  if (wait) throw new Error('已等待约 10 分钟，停止轮询；可再次查询此订单，不要重新下单。');
  return null;
}

async function secret() {
  if (process.env.MOVIX_API_KEY?.trim()) return process.env.MOVIX_API_KEY.trim();
  if (!process.stdin.isTTY) throw new Error('请在交互终端运行，或通过 MOVIX_API_KEY 环境变量提供密钥');
  process.stdout.write('客户 API Key（隐藏输入，粘贴后回车）：');
  return new Promise((done, reject) => {
    let value = '';
    const finish = (error) => {
      process.stdin.off('data', onData); process.stdin.setRawMode(false); process.stdin.pause();
      process.stdout.write('\n');
      if (error) reject(error); else done(value.trim());
    };
    const onData = (chunk) => {
      for (const c of chunk.toString()) {
        if (c === '\u0003') { finish(new Error('已取消')); return; }
        if (c === '\r' || c === '\n') { finish(); return; }
        if (c === '\u007f' || c === '\b') value = value.slice(0, -1);
        else if (c >= ' ') value += c;
      }
    };
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on('data', onData);
  });
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) {
    console.log('查询：node infra/scripts/test-open-api.mjs --shipment ORD-实际订单号 [--wait] [--download]\n创建：node infra/scripts/test-open-api.mjs --create --file tmp/open-api-test/request.json --idempotency-key 自定唯一键 [--wait] [--download]\n默认站点 https://movixfreight.com；可用 --base 修改。密钥隐藏输入或 MOVIX_API_KEY 环境变量；不接受命令行密钥。Node.js 20+。');
    return;
  }
  let body;
  if (o.mode === 'create') {
    if (!o.file || !o['idempotency-key']?.trim() || o['idempotency-key'].length > 256) throw new Error('创建必须指定 --file 和 --idempotency-key（1–256 字符）；重试必须保持原键与原请求体');
    body = JSON.parse((await readFile(resolve(o.file), 'utf8')).replace(/^\uFEFF/, ''));
    validateInput(body);
    console.log(`站点：${o.base}\n供应商：${body.shipment.supplier}\n目的国：${body.shipment.to_address.country}\n箱数：${body.shipment.parcel_count}\n幂等键：${o['idempotency-key']}\n警告：可能真实扣费并创建运单，不是试算。请确认 JSON 中的实际收件地址、重量与申报信息。`);
    if (!process.stdin.isTTY) throw new Error('创建操作必须在交互终端确认；不支持无人值守创建');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let answer;
    try { answer = await rl.question('确认提交请输入 CREATE，其他输入取消：'); } finally { rl.close(); }
    if (answer !== 'CREATE') throw new Error('已取消，未发送请求');
  } else if (!o.shipment?.startsWith('ORD-')) throw new Error('查询必须指定 --shipment ORD-系统订单号（不是承运商转单号）');
  const key = await secret();
  if (!/^mvx_[a-f0-9]+\.[A-Za-z0-9_-]+$/i.test(key)) throw new Error('API Key 格式错误；直接填写客户密钥，不加 Bearer');
  const client = makeClient(o.base, key);
  const dir = resolve('tmp/open-api-test', `${Date.now()}-${randomUUID().slice(0, 8)}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const save = (name, value) => writeFile(resolve(dir, name), JSON.stringify(value, null, 2).split(key).join('[REDACTED]'), { mode: 0o600 });
  console.log(`本次结果目录：${dir}（含个人信息，请勿分享或提交 Git）`);
  let shipmentId = o.shipment;
  if (body) {
    // Persist before POST so an interrupted/ambiguous response retains the exact request and key.
    await save('request.json', body);
    await save('request-meta.json', { base: o.base, idempotencyKey: o['idempotency-key'], createdAt: new Date().toISOString() });
    const accepted = await client('/api/open/v1/shipments', { body, idempotencyKey: o['idempotency-key'] });
    await save('accepted.json', accepted);
    shipmentId = accepted.data?.shipment?.shipment_id;
    if (!shipmentId?.startsWith('ORD-')) throw new Error('创建响应缺少订单号，请核查后台，不要换键重发');
    console.log(`已受理：${shipmentId}。已受理不等于面单已生成。`);
  }
  const shipment = await monitor(client, shipmentId, { wait: o.wait, save: (r) => save('status.json', r) });
  if (o.download && shipment) {
    if (!shipment.labels?.length) throw new Error('READY 但未返回标签列表，请核查后台');
    for (const [index, label] of shipment.labels.entries()) {
      if (!label.label_id) throw new Error('标签缺少 label_id');
      const pdf = await client(`/api/open/v1/shipments/${encodeURIComponent(shipmentId)}/label/download?label_id=${encodeURIComponent(label.label_id)}`, { pdf: true });
      const filename = `label-${String(index + 1).padStart(3, '0')}.pdf`;
      await writeFile(resolve(dir, filename), pdf, { flag: 'wx', mode: 0o600 });
      console.log(`已下载 ${filename}，箱号 ${label.box_no ?? '—'}，转单号 ${label.tracking_number ?? '—'}`);
    }
  } else if (o.download) console.log('面单未就绪，未下载。请用相同订单号加 --wait --download 查询。');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
