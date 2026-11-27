import { useState } from 'react';
import { Alert, Button, Card, Divider, Modal, Space, Table, Tag, Typography, Upload, message } from 'antd';
import { DownloadOutlined, UploadOutlined } from '@ant-design/icons';
import { errorText } from './error-dialog';

type ImportResult = { rowNo: number; status: 'READY' | 'ALREADY_CREATED' | 'CREATED' | 'ERROR'; currency?: string; estimatedReceivable?: string; orderNo?: string; labelStatus?: string; message?: string; error?: string };
type ImportRow = { rowNo: number; serviceCode: string; order: Record<string, any> };
type DeclarationFields = { fields?: Array<{ code: string; required: boolean }> } | null;
type Props = { services: { code: string; name: string }[]; request: (path: string, options?: RequestInit) => Promise<Response>; onDone: () => Promise<void> };

const headers = ['导入订单号', '服务代码', '收件人', '收件公司', '收件电话', '国家', '邮编', '城市', '省/州', '地址', '是否住宅地址', '预估收费重(kg)', '箱号', '长(cm)', '宽(cm)', '高(cm)', '中文品名', '英文品名', '材质', '商品净重(kg)', '原产国', 'HS编码', '数量', '单件申报货值', '申报币种'];
const declarationHeaders: Record<string, string> = { weightKg: '预估收费重(kg)', lengthCm: '长(cm)', widthCm: '宽(cm)', heightCm: '高(cm)', chineseName: '中文品名', englishName: '英文品名', material: '材质', originCountryCode: '原产国', harmonizedCode: 'HS编码', quantity: '数量', unitDeclaredValue: '单件申报货值', declaredValueCurrency: '申报币种' };
const baseRequiredHeaders = new Set(['导入订单号', '服务代码', '收件人', '国家', '邮编', '城市', '地址', '预估收费重(kg)', '长(cm)', '宽(cm)', '高(cm)']);
const value = (record: Record<string, unknown>, key: string) => String(record[key] ?? '').trim();
export function importTemplateHeaders(declarationFields: DeclarationFields) {
  const required = new Set([...baseRequiredHeaders, ...(declarationFields?.fields ?? []).filter((field) => field.required).map((field) => declarationHeaders[field.code]).filter((header): header is string => Boolean(header))]);
  return headers.map((header) => required.has(header) ? `${header}*` : header);
}
export function normalizeImportHeaders(record: Record<string, unknown>) {
  const normalized: Record<string, unknown> = {};
  for (const [header, cell] of Object.entries(record)) {
    const key = header.trim().replace(/^[*＊]\s*/, '').replace(/\s*[*＊]\s*$/, '').trim();
    if (Object.hasOwn(normalized, key)) throw new Error(`Excel 中存在重复表头：${key}`);
    normalized[key] = cell;
  }
  return normalized;
}

async function downloadTemplate(services: Props['services'], declarationFields: DeclarationFields) {
  const XLSX = await import('xlsx');
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([importTemplateHeaders(declarationFields)]);
  sheet['!cols'] = headers.map((header) => ({ wch: Math.max(14, header.length * 2 + 2) }));
  XLSX.utils.book_append_sheet(workbook, sheet, '订单导入');
  const instructions = XLSX.utils.aoa_to_sheet([
    ['填写说明', '每行一条申报货品；同一导入订单号为同一票。相同箱号的多行合并为一箱，箱号为空时每行单独生成一箱。'],
    ['服务代码', '仅填写下方客户可用服务代码；供应商连接编号不用填写。'],
    ['国家', '填写已启用国家表中的中文名或 ISO 两位代码。'],
    ['预估收费重(kg)', '按箱填写；不同箱号可不同。同一箱号有多行货品时须一致。系统按每箱数值计价，并汇总为整票预估收费重。填写大于 0 的数字，最多保留 3 位小数。'],
    ['表头星号', '星号提示通用必填和当前系统设置中的必填字段；上传时带星号或不带星号的表头均可识别。承运商线路仍可额外要求未标星的字段。商品净重可留空；填写后会校验并传给承运商。箱号可留空并由系统生成。'],
    ['下单重量', 'Excel 只填写每箱预估收费重；建单时系统以此作为承运商所需的申报重量。最终收费重在后续对账时确定；实际重量的自动回传取决于承运商接口。'],
    ['泛欧线路', '英文品名、HS 编码、数量、单件货值和申报币种必填；商品净重可留空，原产国按系统申报设置校验。'],
    ['可用服务代码', '服务名称'],
    ...services.map((service) => [service.code, service.name]),
  ]);
  instructions['!cols'] = [{ wch: 22 }, { wch: 110 }];
  XLSX.utils.book_append_sheet(workbook, instructions, '填写说明');
  XLSX.writeFileXLSX(workbook, 'movix-customer-order-import-template.xlsx');
}

export function parseRecords(records: Record<string, unknown>[]): { rows: ImportRow[]; errors: ImportResult[] } {
  const groups = new Map<string, ImportRow>();
  const errors: ImportResult[] = [];
  const orderFields = ['收件人', '收件公司', '收件电话', '国家', '邮编', '城市', '省/州', '地址', '是否住宅地址'];
  const boxFields = ['预估收费重(kg)', '长(cm)', '宽(cm)', '高(cm)'];
  const firstRecords = new Map<string, { record: Record<string, unknown>; rowNo: number }>();
  const firstBoxes = new Map<string, Record<string, unknown>>();
  records.forEach((record, index) => {
    const rowNo = index + 2;
    const reference = value(record, '导入订单号');
    const serviceCode = value(record, '服务代码');
    if (!reference || !serviceCode) { errors.push({ rowNo, status: 'ERROR', error: !reference ? '缺少导入订单号' : '缺少服务代码' }); return; }
    const previous = firstRecords.get(reference);
    const changedFields = previous ? ['服务代码', ...orderFields].filter((field) => value(record, field) !== value(previous.record, field)) : [];
    if (previous && changedFields.length) {
      const details = changedFields.slice(0, 3).map((field) => `${field}（第 ${previous.rowNo} 行：${value(previous.record, field) || '空'}；本行：${value(record, field) || '空'}）`).join('；');
      errors.push({ rowNo, status: 'ERROR', error: `导入订单号 ${reference} 与第 ${previous.rowNo} 行不一致：${details}${changedFields.length > 3 ? `；另有 ${changedFields.length - 3} 列不同` : ''}。同一票请统一填写；若要分别下单，请使用不同的导入订单号。` }); return;
    }
    const quantity = value(record, '数量');
    if (quantity && (!/^\d+$/.test(quantity) || Number(quantity) < 1)) { errors.push({ rowNo, status: 'ERROR', error: '数量必须为正整数' }); return; }
    const estimatedChargeableKg = value(record, '预估收费重(kg)');
    if (!/^\d+(\.\d{1,3})?$/.test(estimatedChargeableKg) || Number(estimatedChargeableKg) <= 0) {
      errors.push({ rowNo, status: 'ERROR', error: '预估收费重(kg)必须为大于 0 的数字，最多保留 3 位小数' }); return;
    }
    const existing = groups.get(reference);
    const group: ImportRow = existing ?? { rowNo, serviceCode, order: {
      clientReference: reference,
      recipientName: value(record, '收件人'), recipientCompany: value(record, '收件公司') || undefined,
      recipientPhone: value(record, '收件电话'), recipientCountryCode: value(record, '国家') || value(record, '国家代码'),
      recipientPostcode: value(record, '邮编'), recipientCity: value(record, '城市'), recipientState: value(record, '省/州') || undefined,
      recipientAddress: value(record, '地址'), recipientResidential: ['是', 'Y', 'YES', 'TRUE', '1'].includes(value(record, '是否住宅地址').toUpperCase()),
      estimatedChargeableKg: '0.000', boxes: [],
    } };
    const boxNo = value(record, '箱号');
    const boxKey = `${reference}\u0000${boxNo}`;
    const previousBox = boxNo ? firstBoxes.get(boxKey) : undefined;
    const changedBoxFields = previousBox ? boxFields.filter((field) => value(record, field) !== value(previousBox, field)) : [];
    if (changedBoxFields.length) {
      errors.push({ rowNo, status: 'ERROR', error: `箱号 ${boxNo} 的${changedBoxFields.join('、')}与此前货品行不一致` }); return;
    }
    let box = boxNo ? group.order.boxes.find((item: any) => item.boxNo === boxNo) : undefined;
    if (!box) {
      box = { boxNo: boxNo || undefined, estimatedChargeableKg, weightKg: estimatedChargeableKg, lengthCm: value(record, '长(cm)'), widthCm: value(record, '宽(cm)'), heightCm: value(record, '高(cm)'), items: [] };
      group.order.boxes.push(box);
      const thousandths = group.order.boxes.reduce((sum: number, item: any) => sum + Math.round(Number(item.estimatedChargeableKg) * 1000), 0);
      group.order.estimatedChargeableKg = (thousandths / 1000).toFixed(3);
      if (boxNo) firstBoxes.set(boxKey, record);
    }
    box.items.push({
      chineseName: value(record, '中文品名') || undefined, englishName: value(record, '英文品名') || undefined,
      material: value(record, '材质') || undefined, itemWeightKg: value(record, '商品净重(kg)') || undefined,
      originCountryCode: value(record, '原产国').toUpperCase() || undefined, harmonizedCode: value(record, 'HS编码') || undefined,
      quantity: quantity ? Number(quantity) : undefined, unitDeclaredValue: value(record, '单件申报货值') || undefined,
      declaredValueCurrency: value(record, '申报币种').toUpperCase() || undefined,
    });
    firstRecords.set(reference, previous ?? { record, rowNo });
    groups.set(reference, group);
  });
  return { rows: [...groups.values()], errors };
}

function previewErrorText(error: unknown, rows: ImportRow[]) {
  return errorText(error).replace(/rows\.(\d+)\.order\.estimatedChargeableKg must match [^；\n]+/g, (_message, index: string) =>
    `Excel 第 ${rows[Number(index)]?.rowNo ?? Number(index) + 2} 行：预估收费重(kg)必须为大于 0 的数字，最多保留 3 位小数`);
}

export function CustomerOrderImport({ services, request, onDone }: Props) {
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [results, setResults] = useState<ImportResult[]>([]);
  const [sourceFileName, setSourceFileName] = useState('');
  const [busy, setBusy] = useState(false);
  const [committed, setCommitted] = useState(false);
  const [commitAttempted, setCommitAttempted] = useState(false);
  const [validated, setValidated] = useState(false);
  const [importError, setImportError] = useState('');
  const [errorDialogOpen, setErrorDialogOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [completion, setCompletion] = useState<{ created: number; failures: ImportResult[] } | null>(null);
  const showImportError = (detail: string) => { setImportError(detail); setErrorDialogOpen(true); };
  const parseFile = async (file: File) => {
    setRows([]); setResults([]); setCommitted(false); setCommitAttempted(false); setValidated(false); setSourceFileName(''); setImportError(''); setErrorDialogOpen(false); setConfirmOpen(false); setCompletion(null); setBusy(true);
    let parsedRows: ImportRow[] = [];
    try {
      if (!/\.xlsx?$/i.test(file.name)) throw new Error('请选择 .xlsx 或 .xls 文件');
      if (file.size > 2_000_000) throw new Error('Excel 文件不能超过 2 MB，请拆分导入');
      const XLSX = await import('xlsx');
      const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      if (!sheet) throw new Error('工作簿不包含可读取的工作表');
      const records = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' }).map(normalizeImportHeaders);
      if (!records.length) throw new Error('工作表没有导入数据');
      const parsed = parseRecords(records);
      parsedRows = parsed.rows;
      if (parsed.rows.length > 100) throw new Error('单次最多导入 100 票订单，请拆分文件');
      if (parsed.errors.length) {
        setRows(parsed.rows); setSourceFileName(file.name); setResults(parsed.errors);
        showImportError(parsed.errors.slice(0, 5).map((item) => `Excel 第 ${item.rowNo} 行：${item.error}`).join('\n') + (parsed.errors.length > 5 ? `\n另有 ${parsed.errors.length - 5} 处错误，请查看下方结果表。` : ''));
        return;
      }
      if (!parsed.rows.length) throw new Error('没有可导入的订单，请检查导入订单号和服务代码');
      const payload = JSON.stringify({ sourceFileName: file.name, rows: parsed.rows });
      if (new TextEncoder().encode(payload).length > 1_800_000) throw new Error('导入内容超过 1.8 MB，请拆分文件');
      const preview = await (await request('/customer/v1/orders/import/preview', { method: 'POST', body: payload })).json() as ImportResult[];
      setRows(parsed.rows); setSourceFileName(file.name);
      setResults([...parsed.errors, ...preview].sort((a, b) => a.rowNo - b.rowNo));
      setValidated(parsed.errors.length === 0 && preview.length === parsed.rows.length && preview.every((item) => ['READY', 'ALREADY_CREATED'].includes(item.status)));
      const failures = [...parsed.errors, ...preview.filter((item) => !['READY', 'ALREADY_CREATED'].includes(item.status))];
      if (failures.length) showImportError(failures.slice(0, 5).map((item) => `Excel 第 ${item.rowNo} 行：${item.error ?? item.message ?? '请检查该订单'}`).join('\n') + (failures.length > 5 ? `\n另有 ${failures.length - 5} 票未通过，请查看下方结果表。` : ''));
      else message.success(`已读取 ${records.length} 行，聚合为 ${parsed.rows.length} 票订单`);
    } catch (error) { showImportError(previewErrorText(error, parsedRows)); } finally { setBusy(false); }
  };
  const newOrderCount = results.filter((item) => item.status === 'READY' || commitAttempted && item.status === 'ERROR').length;
  const alreadyCreatedCount = results.filter((item) => item.status === 'ALREADY_CREATED' || commitAttempted && item.status === 'CREATED').length;
  const ready = rows.length > 0 && validated && !committed && newOrderCount > 0;
  const downloadCurrentTemplate = async () => {
    try {
      const latest = await (await request('/customer/v1/declaration-fields')).json() as DeclarationFields;
      await downloadTemplate(services, latest);
    } catch (error) { showImportError(errorText(error)); }
  };
  const commit = async () => {
    setBusy(true);
    try {
      const result = await (await request('/customer/v1/orders/import/commit', { method: 'POST', body: JSON.stringify({ sourceFileName, rows }) })).json() as ImportResult[];
      setResults(result); setCommitAttempted(true); setCommitted(result.every((item) => item.status === 'CREATED'));
      const created = result.filter((item) => item.status === 'CREATED').length;
      const failures = result.filter((item) => item.status !== 'CREATED');
      setConfirmOpen(false); setCompletion({ created, failures });
      await onDone();
    } catch (error) { setConfirmOpen(false); showImportError(errorText(error)); }
    finally { setBusy(false); }
  };
  const requestCommit = () => {
    if (!ready) { showImportError(!rows.length ? '请先选择 Excel 文件并完成预校验。' : validated && alreadyCreatedCount === rows.length ? '该文件中的订单均已导入且尚未取消，不会重复创建或扣费。' : '当前文件尚未全部通过预校验，请查看下方结果并重新选择文件。'); return; }
    setConfirmOpen(true);
  };
  return <div className="customer-import">
    <Alert showIcon type="info" message="先解析预览，确认后才扣费" description="模板中每行是一条货品明细；相同导入订单号合并为一票。星号反映通用和系统设置的必填项；所选线路还可能要求额外字段；商品净重可留空。只有全部预校验通过才能提交。" />
    {importError && <Alert showIcon type="error" message="Excel 预校验或导入未完成" description={<span style={{ whiteSpace: 'pre-wrap' }}>{importError}</span>} style={{ marginTop: 12 }} />}
    <Modal title="Excel 预校验或导入未完成" open={errorDialogOpen} zIndex={1300} okText="我知道了" onOk={() => setErrorDialogOpen(false)} onCancel={() => setErrorDialogOpen(false)} cancelButtonProps={{ style: { display: 'none' } }}><Typography.Text style={{ whiteSpace: 'pre-wrap' }}>{importError}</Typography.Text></Modal>
    <Modal title="确认批量创建订单" open={confirmOpen} zIndex={1200} okText="确认创建" cancelText="返回检查" confirmLoading={busy} okButtonProps={{ disabled: !ready }} onOk={() => { void commit(); }} onCancel={() => setConfirmOpen(false)}>本次将新建 {newOrderCount} 票订单并逐票预扣余额；已有 {alreadyCreatedCount} 票未取消订单会跳过。新订单将进入面单生成队列。余额或线路若在预览后变化，部分订单可能失败。</Modal>
    <Modal title={completion?.failures.length ? '部分订单导入失败' : 'Excel 导入结果'} open={Boolean(completion)} zIndex={1200} okText="我知道了" onOk={() => setCompletion(null)} onCancel={() => setCompletion(null)} cancelButtonProps={{ style: { display: 'none' } }}>{completion && <Space direction="vertical"><div>成功 {completion.created} 票，失败 {completion.failures.length} 票。成功订单已预扣并等待面单生成。</div>{completion.failures.slice(0, 5).map((item) => <div key={item.rowNo}>第 {item.rowNo} 行：{item.error ?? item.message ?? '请检查该订单'}</div>)}{completion.failures.length > 5 && <div>其余失败原因请在下方结果表查看。</div>}</Space>}</Modal>
    <div className="customer-import__actions">
      <Space wrap><Button icon={<DownloadOutlined />} onClick={() => { void downloadCurrentTemplate(); }}>下载 Excel 模板</Button><Upload accept=".xlsx,.xls" maxCount={1} showUploadList={false} beforeUpload={(file) => { void parseFile(file); return false; }}><Button type="primary" icon={<UploadOutlined />} loading={busy}>选择并预校验</Button></Upload><Button disabled={busy || committed} onClick={requestCommit}>{committed ? '已全部创建' : validated && alreadyCreatedCount === rows.length ? '已全部导入' : results.some((item) => item.status === 'CREATED') ? '重试未成功订单' : `确认创建 ${newOrderCount || rows.length || ''} 票订单`}</Button></Space>
      {sourceFileName && <Typography.Text type="secondary">当前文件：{sourceFileName}</Typography.Text>}
    </div>
    <Card size="small" className="customer-import__services" title="可用服务代码"><Space wrap>{services.length ? services.map((service) => <Tag key={service.code}>{service.name} · {service.code}</Tag>) : <Typography.Text type="secondary">暂无可下单服务</Typography.Text>}</Space></Card>
    <Divider orientation="left">预校验与导入结果</Divider>
    <Table size="small" rowKey={(item) => `${item.rowNo}-${item.status}`} dataSource={results} pagination={{ pageSize: 20 }} scroll={{ x: 780 }} locale={{ emptyText: '请下载模板并上传填写后的 Excel 文件' }} columns={[
      { title: 'Excel 行号', dataIndex: 'rowNo', width: 100 },
      { title: '结果', dataIndex: 'status', width: 105, render: (status: string) => <Tag color={status === 'READY' || status === 'CREATED' ? 'green' : status === 'ALREADY_CREATED' ? 'blue' : 'red'}>{status === 'READY' ? '可创建' : status === 'ALREADY_CREATED' ? '已导入' : status === 'CREATED' ? '已创建' : '错误'}</Tag> },
      { title: '预计应收', width: 130, render: (_, item) => item.estimatedReceivable != null ? `${item.currency} ${item.estimatedReceivable}` : '—' },
      { title: '订单号', dataIndex: 'orderNo', width: 210, render: (value: string) => value ?? '—' },
      { title: '说明', render: (_, item) => item.error ?? item.message ?? '校验通过' },
    ]} />
  </div>;
}
