import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { DpdRelayConfig, type DpdRelayProfile } from '../src/connectors/dpd-relay.config';
import { DpdRelayConnector, DpdRequestError, DPD_PATHS } from '../src/connectors/dpd-relay.connector';
import { buildDpdShipment, dpdPdf, dpdRejection, dpdSuccess } from '../src/connectors/dpd-relay.mapper';

const repoRoot = resolve(__dirname, '../../..');
// 只需要修改这里，然后执行 pnpm dpd:test。账号密码从 config/connectors.local.json 读取。
const TEST_VALUES = {
  send: true, // 运行 pnpm dpd:test 会实际向渠道商建一票；相同请求内容仍会被防重拦截。
  allowRepeatSamePayload: false, // 默认也拦截只改参考号、其他请求字段完全相同的重发。
  mode: 'create' as 'create' | 'print', // print 只用现有 AWB 补打，不会重新建单。
  awbNoToPrint: '5678081',
  profileCode: 'DPD-TEST',
  orderFile: 'config/dpd-test-order.local.json', // 收件人、地址和箱货数据在这个被 Git 忽略的文件中。
  vendorName: 'AD11', // 已由这次直连接口测试验证可建单；正式使用前仍需核对渠道授权。
  serviceName: 'DPD Next Day',
  destinationName: 'UNITED KINGDOM', // 该值的直连测试可建单；最终 DPD 面单仍需确认。
  originName: 'MVF',
  productCode: 'NDOC',
};

const usage = '直接修改 test-dpd-relay.ts 顶部的 TEST_VALUES，然后运行 pnpm dpd:test；send=false 只预览，send=true 实际发送一次。';

function args() {
  const result: Record<string, string | boolean> = {};
  const allowed = new Set(['help', 'send', 'profile', 'order-file', 'vendor-name', 'service-name', 'destination-name', 'origin-name', 'product-code', 'reference']);
  for (let i = 2; i < process.argv.length; i++) {
    const key = process.argv[i]!.replace(/^--/, '');
    if (!process.argv[i]!.startsWith('--') || !allowed.has(key) || key in result) throw new Error(`未知或重复参数：${process.argv[i]}`);
    if (key === 'help' || key === 'send') { result[key] = true; continue; }
    const value = process.argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`参数 --${key} 缺少值`);
    result[key] = value;
  }
  return result;
}

function sanitize(value: unknown, profile: DpdRelayProfile, response = false): unknown {
  const secrets = [profile.userId, profile.password, profile.customerCode].filter(Boolean);
  const visit = (item: unknown, depth: number): unknown => {
    if (item === null || item === undefined || typeof item === 'number' || typeof item === 'boolean') return item ?? null;
    if (typeof item === 'string') {
      if (item.length > 800 && /^[A-Za-z0-9+/]+={0,2}$/.test(item)) return `[省略疑似 Base64，${item.length} 字符]`;
      let text = item;
      for (const secret of secrets) text = text.replaceAll(secret, '[已脱敏]');
      return text.length > 2000 ? `${text.slice(0, 2000)}…[已截断]` : text;
    }
    if (depth >= 6) return '[嵌套层级已截断]';
    if (Array.isArray(item)) return item.slice(0, 40).map(value => visit(value, depth + 1));
    if (typeof item === 'object') return Object.fromEntries(Object.entries(item).slice(0, 80).map(([key, value]) => [key,
      /password|secret|token|authorization|api.?key|^userid$|^customercode$/i.test(key) ? '[已脱敏]'
        : /pdfdownload|pdflabel|base64|labelcontent|filecontent/i.test(key) || (response && /^(label|auxlbl|performa)$/i.test(key)) ? '[已省略附件内容]'
          : visit(value, depth + 1)]));
    return String(item);
  };
  return visit(value, 0);
}

function loadOrder(file: string, reference: string, productCode: string) {
  const input = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(input.boxes) || input.boxes.length !== 1) throw new Error('测试订单必须恰好有一箱');
  return {
    orderNo: reference, recipientCountryCode: 'GB', recipientName: input.recipientName,
    recipientPhone: input.recipientPhone, recipientPostcode: input.recipientPostcode,
    recipientCity: input.recipientCity, recipientState: input.recipientState ?? null,
    recipientAddressLine1: input.recipientAddressLine1,
    recipientAddressLine2: input.recipientAddressLine2 ?? null,
    recipientAddressLine3: null, supplierRouteSnapshot: { carrierServiceType: productCode },
    boxes: input.boxes.map((box: any) => ({
      weightKg: new Prisma.Decimal(box.weightKg), lengthCm: new Prisma.Decimal(box.lengthCm),
      widthCm: new Prisma.Decimal(box.widthCm), heightCm: new Prisma.Decimal(box.heightCm),
      items: box.items.map((item: any) => ({ ...item,
        unitDeclaredValue: new Prisma.Decimal(item.unitDeclaredValue),
        itemWeightKg: item.itemWeightKg ? new Prisma.Decimal(item.itemWeightKg) : null,
      })),
    })),
  } as any;
}

function pdfFrom(body: any): Buffer | null {
  for (const candidate of [body, body?.Response, { Pdfdownload: body?.Label }, { Pdfdownload: body?.Response?.Label },
    { Pdfdownload: body?.PdfLabel }, { Pdfdownload: body?.Response?.PdfLabel }]) {
    const pdf = dpdPdf(candidate);
    if (pdf) return pdf;
  }
  return null;
}

function value(body: any, key: string): string {
  return String(body?.[key] ?? body?.Response?.[key] ?? '').trim();
}

function minimalShipmentPayload(full: ReturnType<typeof buildDpdShipment>) {
  // 文档 M 字段、这票 SPX 已有的条件申报值，以及实测接口强制要求的手机、重量和收件联系人。
  const fields = ['UserID', 'Password', 'CustomerCode', 'CustomerRefNo', 'OriginName', 'DestinationName',
    'ShipperName', 'ShipperAdd1', 'ShipperCity', 'ShipperPin', 'ShipperTelno', 'ShipperMobile',
    'ConsigneeName', 'ConsigneeContact', 'ConsigneeAdd1', 'ConsigneeCity', 'ConsigneePin', 'ConsigneeTelno', 'ConsigneeMobile',
    'VendorName', 'ServiceName', 'ProductCode', 'Dox_Spx', 'Pieces',
    'Weight', 'Content', 'Currency', 'ShipmentValue'] as const;
  return Object.fromEntries(fields.map(key => [key, full[key]])) as Pick<typeof full, typeof fields[number]>;
}

function reserveLogFile(logFile: string, currentRequest?: unknown) {
  try {
    const fd = openSync(logFile, 'wx'); closeSync(fd);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    try {
      const previous = JSON.parse(readFileSync(logFile, 'utf8'));
      console.log(JSON.stringify({ mode: 'ALREADY_SENT', reference: previous.reference,
        status: previous.status, httpStatus: previous.httpStatus ?? null, awbNo: previous.awbNo ?? null,
        errors: previous.errors ?? [], labelFile: previous.labelFile ?? previous.unconfirmedLabelFile ?? null,
        requestChanged: currentRequest === undefined ? null : JSON.stringify(previous.request) !== JSON.stringify(currentRequest),
        logFile, message: '该测试编号已有日志，本次未再次请求渠道商。若结果未知或已有 AWB，先向渠道商核查。' }, null, 2));
    } catch {
      console.log(JSON.stringify({ mode: 'ALREADY_SENT', logFile, message: '该测试编号已有日志但无法解析；本次未再次请求渠道商，请人工检查文件。' }, null, 2));
    }
    return false;
  }
}

function sameRequestExceptReference(left: any, right: any) {
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const a = { ...left }; const b = { ...right };
  delete a.CustomerRefNo; delete b.CustomerRefNo;
  return JSON.stringify(a) === JSON.stringify(b);
}

function findPriorSameRequest(directory: string, request: unknown): { reference: string; status: string; awbNo?: string } | null {
  for (const name of readdirSync(directory)) {
    if (!/^DPDTEST-.*\.json$/.test(name) || name.endsWith('-print.json')) continue;
    try {
      const previous = JSON.parse(readFileSync(resolve(directory, name), 'utf8'));
      if (sameRequestExceptReference(previous.request, request)) return previous;
    } catch { throw new Error(`无法解析已有测试日志 ${name}，为防重复已停止发送`); }
  }
  return null;
}

async function main() {
  const options = args();
  if (options.help) { console.log(usage); return; }
  const send = options.send === true || TEST_VALUES.send;
  const profileCode = String(options.profile ?? TEST_VALUES.profileCode);
  const config = new DpdRelayConfig(new ConfigService());
  const status = config.status(profileCode);
  if (!status.configured) throw new Error(`DPD profile 未就绪：${status.missing.join('、')}`);
  const profile = config.connection(profileCode, status.environment!.toUpperCase());
  if (TEST_VALUES.mode === 'print') {
    const awbNo = TEST_VALUES.awbNoToPrint.trim();
    if (!awbNo) throw new Error('print 模式必须填写 awbNoToPrint');
    if (!send) { console.log(JSON.stringify({ mode: 'PRINT_PREVIEW_ONLY', awbNo, endpoint: new URL(DPD_PATHS.PRINT, profile.baseUrl).toString() }, null, 2)); return; }
    const directory = resolve(repoRoot, 'tmp/dpd-relay-tests');
    mkdirSync(directory, { recursive: true });
    const logFile = resolve(directory, `DPDPRINT-${awbNo}.json`);
    if (!reserveLogFile(logFile)) return;
    const log: Record<string, unknown> = { awbNo, operation: 'PRINT_EXISTING_AWB',
      sentAt: new Date().toISOString(), status: 'UNKNOWN' };
    const save = () => writeFileSync(logFile, `${JSON.stringify(log, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    save();
    try {
      const result = await new DpdRelayConnector().print(profile, awbNo);
      log.httpStatus = result.status;
      log.response = sanitize(result.body, profile, true);
      const pdf = pdfFrom(result.body);
      if (pdf && value(result.body, 'AWBNo') === awbNo) {
        const pdfFile = resolve(directory, `DPDPRINT-${awbNo}.pdf`);
        writeFileSync(pdfFile, pdf, { flag: 'wx', mode: 0o600 });
        log.labelFile = pdfFile;
        log.labelBytes = pdf.length;
        log.status = 'PDF_FOUND';
      } else {
        log.status = 'NO_VERIFIED_PDF';
        log.errors = dpdRejection(result.body).messages;
      }
    } catch (error) {
      log.error = error instanceof Error ? error.message : String(error);
      if (error instanceof DpdRequestError) {
        log.httpStatus = error.upstreamStatus;
        log.response = sanitize(error.responseBody, profile, true);
      }
    } finally {
      save();
      console.log(JSON.stringify({ mode: 'PRINT_EXISTING_AWB', awbNo, status: log.status, httpStatus: log.httpStatus ?? null,
        labelFile: log.labelFile ?? null, errors: log.errors ?? [], logFile }, null, 2));
      if (log.status !== 'PDF_FOUND') process.exitCode = 2;
    }
    return;
  }
  const orderFile = resolve(repoRoot, String(options['order-file'] ?? TEST_VALUES.orderFile));
  if (!existsSync(orderFile)) throw new Error(`测试订单文件不存在：${orderFile}；可从 config/dpd-test-order.example.json 复制`);
  const reference = String(options.reference ?? `DPDTEST-${Date.now().toString(36).toUpperCase()}-${randomBytes(3).toString('hex').toUpperCase()}`);
  if (!/^DPDTEST-[A-Za-z0-9-]+$/.test(reference) || reference.length > 30) throw new Error('测试参考号必须以 DPDTEST- 开头，且最长 30 字符');
  const productCode = String(options['product-code'] ?? TEST_VALUES.productCode).trim();
  const fullPayload = buildDpdShipment(loadOrder(orderFile, reference, productCode), profile);
  fullPayload.VendorName = String(options['vendor-name'] ?? TEST_VALUES.vendorName).trim();
  fullPayload.ServiceName = String(options['service-name'] ?? TEST_VALUES.serviceName).trim();
  fullPayload.DestinationName = String(options['destination-name'] ?? TEST_VALUES.destinationName).trim();
  fullPayload.OriginName = String(options['origin-name'] ?? TEST_VALUES.originName).trim();
  const payload = minimalShipmentPayload(fullPayload);
  payload.ShipperTelno = payload.ShipperTelno.replace(/\D/g, '');
  payload.ShipperMobile = (payload.ShipperMobile || payload.ShipperTelno).replace(/\D/g, '');
  if (send && [payload.VendorName, payload.ServiceName, payload.DestinationName].some(value => value.startsWith('填写'))) throw new Error('真实发送前请在脚本顶部填写渠道商确认的 VendorName、ServiceName、DestinationName');
  for (const [name, limit] of [['VendorName', 50], ['ServiceName', 50], ['DestinationName', 30], ['OriginName', 30], ['ProductCode', 5]] as const) {
    if (!payload[name] || Array.from(payload[name]).length > limit) throw new Error(`${name} 缺失或超过 ${limit} 字符`);
  }
  const request = sanitize(payload, profile);
  if (!send) {
    console.log(JSON.stringify({ mode: 'PREVIEW_ONLY', endpoint: new URL(DPD_PATHS.CREATE, profile.baseUrl).toString(), profile: profileCode, request }, null, 2));
    console.log('\n未发送。CustomerRefNo 为文档必填字段，脚本会自动生成；本次排错已省略可选字段。');
    return;
  }
  const directory = resolve(repoRoot, 'tmp/dpd-relay-tests');
  mkdirSync(directory, { recursive: true });
  const logFile = resolve(directory, `${reference}.json`);
  if (existsSync(logFile)) { reserveLogFile(logFile, request); return; }
  if (!TEST_VALUES.allowRepeatSamePayload) {
    const previous = findPriorSameRequest(directory, request);
    if (previous) {
      console.log(JSON.stringify({ mode: 'DUPLICATE_PAYLOAD_BLOCKED', reference, previousReference: previous.reference,
        previousStatus: previous.status, previousAwbNo: previous.awbNo ?? null,
        message: '仅参考号不同，其余请求字段与之前的测试完全相同；本次未请求渠道商。请先核查已有 AWB 或修改实际待测字段。' }, null, 2));
      return;
    }
  }
  if (!reserveLogFile(logFile, request)) return;
  const log: Record<string, unknown> = { reference, sentAt: new Date().toISOString(), profile: profileCode,
    endpoint: new URL(DPD_PATHS.CREATE, profile.baseUrl).toString(), status: 'SENDING_OR_UNKNOWN', request };
  const save = () => writeFileSync(logFile, `${JSON.stringify(log, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  save();
  try {
    const connector = new DpdRelayConnector();
    const created = await connector.create(profile, payload);
    log.httpStatus = created.status;
    log.response = sanitize(created.body, profile, true);
    const awbNo = value(created.body, 'AWBNo');
    const forwardingNo = value(created.body, 'ForwardingNo');
    if (awbNo) log.awbNo = awbNo;
    if (forwardingNo) log.forwardingNo = forwardingNo;
    const success = dpdSuccess(created.body) || dpdSuccess(created.body?.Response);
    if (!success || !awbNo) {
      const rejection = dpdRejection(created.body);
      log.status = rejection.explicit && !awbNo ? 'REJECTED' : 'UNKNOWN';
      log.errors = rejection.messages;
      const diagnosticPdf = pdfFrom(created.body);
      if (diagnosticPdf && awbNo) {
        const pdfFile = resolve(directory, `${reference}-unconfirmed.pdf`);
        writeFileSync(pdfFile, diagnosticPdf, { flag: 'wx', mode: 0o600 });
        log.unconfirmedLabelFile = pdfFile;
        log.unconfirmedLabelBytes = diagnosticPdf.length;
      }
    } else {
      let pdf = pdfFrom(created.body);
      if (!pdf) {
        try {
          const printed = await connector.print(profile, awbNo);
          log.printHttpStatus = printed.status;
          log.printResponse = sanitize(printed.body, profile, true);
          if (value(printed.body, 'AWBNo') === awbNo) pdf = pdfFrom(printed.body);
        } catch (error) {
          log.printError = error instanceof Error ? error.message : String(error);
        }
      }
      if (pdf) {
        const pdfFile = resolve(directory, `${reference}.pdf`);
        writeFileSync(pdfFile, pdf, { flag: 'wx', mode: 0o600 });
        log.labelFile = pdfFile;
        log.labelBytes = pdf.length;
        log.status = 'SUCCESS_WITH_PDF';
      } else log.status = 'AWB_WITHOUT_PDF';
    }
  } catch (error) {
    log.status = 'UNKNOWN';
    log.error = error instanceof Error ? error.message : String(error);
    if (error instanceof DpdRequestError) {
      log.httpStatus = error.upstreamStatus;
      log.response = sanitize(error.responseBody, profile, true);
      log.errors = dpdRejection(error.responseBody).messages;
    }
  } finally {
    save();
    console.log(JSON.stringify({ reference, status: log.status, httpStatus: log.httpStatus ?? null,
      awbNo: log.awbNo ?? null, forwardingNo: log.forwardingNo ?? null, errors: log.errors ?? [],
      labelFile: log.labelFile ?? null, unconfirmedLabelFile: log.unconfirmedLabelFile ?? null, logFile }, null, 2));
    if (log.status !== 'SUCCESS_WITH_PDF') process.exitCode = 2;
  }
}

void main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
