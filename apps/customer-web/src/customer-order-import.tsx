import { useState } from 'react';
import { Alert, Button, Card, Divider, Modal, Space, Table, Tag, Typography, Upload, message } from 'antd';
import { DownloadOutlined, UploadOutlined } from '@ant-design/icons';

type ImportResult = { rowNo: number; status: 'READY' | 'ALREADY_CREATED' | 'CREATED' | 'ERROR'; currency?: string; estimatedReceivable?: string; orderNo?: string; labelStatus?: string; message?: string; error?: string };
type ImportRow = { rowNo: number; serviceCode: string; order: Record<string, any> };
type Props = { services: { code: string; name: string }[]; request: (path: string, options?: RequestInit) => Promise<Response>; onDone: () => Promise<void> };

const headers = ['导入订单号', '服务代码', '收件人', '收件公司', '收件电话', '国家', '邮编', '城市', '省/州', '地址', '是否住宅地址', '预估收费重(kg)', '箱号', '实重(kg)', '长(cm)', '宽(cm)', '高(cm)', '中文品名', '英文品名', '材质', '商品净重(kg)', '原产国', 'HS编码', '数量', '单件申报货值', '申报币种'];
const value = (record: Record<string, unknown>, key: string) => String(record[key] ?? '').trim();
const errorText = (error: unknown) => error instanceof Error ? error.message : '操作失败';

async function downloadTemplate(services: Props['services']) {
  const XLSX = await import('xlsx');
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([headers]);
  sheet['!cols'] = headers.map((header) => ({ wch: Math.max(14, header.length * 2 + 2) }));
  XLSX.utils.book_append_sheet(workbook, sheet, '订单导入');
  const instructions = XLSX.utils.aoa_to_sheet([
    ['填写说明', '每行一条申报货品；同一导入订单号为同一票。相同箱号的多行合并为一箱，箱号为空时每行单独生成一箱。'],
    ['服务代码', '仅填写下方客户可用服务代码；供应商连接编号不用填写。'],
    ['国家', '填写已启用国家表中的中文名或 ISO 两位代码。'],
    ['泛欧线路', '商品净重、英文品名、原产国、HS 编码、数量、单件货值和申报币种必填。'],
    ['可用服务代码', '服务名称'],
    ...services.map((service) => [service.code, service.name]),
  ]);
  instructions['!cols'] = [{ wch: 22 }, { wch: 110 }];
  XLSX.utils.book_append_sheet(workbook, instructions, '填写说明');
  XLSX.writeFileXLSX(workbook, 'movix-customer-order-import-template.xlsx');
}

function parseRecords(records: Record<string, unknown>[]): { rows: ImportRow[]; errors: ImportResult[] } {
  const groups = new Map<string, ImportRow>();
  const errors: ImportResult[] = [];
  const orderFields = ['收件人', '收件公司', '收件电话', '国家', '邮编', '城市', '省/州', '地址', '是否住宅地址', '预估收费重(kg)'];
  const boxFields = ['实重(kg)', '长(cm)', '宽(cm)', '高(cm)'];
  const firstRecords = new Map<string, Record<string, unknown>>();
  const firstBoxes = new Map<string, Record<string, unknown>>();
  records.forEach((record, index) => {
    const rowNo = index + 2;
    const reference = value(record, '导入订单号');
    const serviceCode = value(record, '服务代码');
    if (!reference || !serviceCode) { errors.push({ rowNo, status: 'ERROR', error: !reference ? '缺少导入订单号' : '缺少服务代码' }); return; }
    const previous = firstRecords.get(reference);
    if (previous && (serviceCode !== value(previous, '服务代码') || orderFields.some((field) => value(record, field) !== value(previous, field)))) {
      errors.push({ rowNo, status: 'ERROR', error: '同一导入订单号的服务或收件信息不一致' }); return;
    }
    const quantity = value(record, '数量');
    if (quantity && (!/^\d+$/.test(quantity) || Number(quantity) < 1)) { errors.push({ rowNo, status: 'ERROR', error: '数量必须为正整数' }); return; }
    const existing = groups.get(reference);
    const group: ImportRow = existing ?? { rowNo, serviceCode, order: {
      clientReference: reference,
      recipientName: value(record, '收件人'), recipientCompany: value(record, '收件公司') || undefined,
      recipientPhone: value(record, '收件电话'), recipientCountryCode: value(record, '国家') || value(record, '国家代码'),
      recipientPostcode: value(record, '邮编'), recipientCity: value(record, '城市'), recipientState: value(record, '省/州') || undefined,
      recipientAddress: value(record, '地址'), recipientResidential: ['是', 'Y', 'YES', 'TRUE', '1'].includes(value(record, '是否住宅地址').toUpperCase()),
      estimatedChargeableKg: value(record, '预估收费重(kg)'), boxes: [],
    } };
    const boxNo = value(record, '箱号');
    const boxKey = `${reference}\u0000${boxNo}`;
    const previousBox = boxNo ? firstBoxes.get(boxKey) : undefined;
    if (previousBox && boxFields.some((field) => value(record, field) !== value(previousBox, field))) {
      errors.push({ rowNo, status: 'ERROR', error: `箱号 ${boxNo} 的重量或尺寸不一致` }); return;
    }
    let box = boxNo ? group.order.boxes.find((item: any) => item.boxNo === boxNo) : undefined;
    if (!box) {
      box = { boxNo: boxNo || undefined, weightKg: value(record, '实重(kg)'), lengthCm: value(record, '长(cm)'), widthCm: value(record, '宽(cm)'), heightCm: value(record, '高(cm)'), items: [] };
      group.order.boxes.push(box);
      if (boxNo) firstBoxes.set(boxKey, record);
    }
    box.items.push({
      chineseName: value(record, '中文品名') || undefined, englishName: value(record, '英文品名') || undefined,
      material: value(record, '材质') || undefined, itemWeightKg: value(record, '商品净重(kg)') || undefined,
      originCountryCode: value(record, '原产国').toUpperCase() || undefined, harmonizedCode: value(record, 'HS编码') || undefined,
      quantity: quantity ? Number(quantity) : undefined, unitDeclaredValue: value(record, '单件申报货值') || undefined,
      declaredValueCurrency: value(record, '申报币种').toUpperCase() || undefined,
    });
    firstRecords.set(reference, previous ?? record);
    groups.set(reference, group);
  });
  return { rows: [...groups.values()], errors };
}

export function CustomerOrderImport({ services, request, onDone }: Props) {
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [results, setResults] = useState<ImportResult[]>([]);
  const [sourceFileName, setSourceFileName] = useState('');
  const [busy, setBusy] = useState(false);
  const [committed, setCommitted] = useState(false);
  const [validated, setValidated] = useState(false);
  const parseFile = async (file: File) => {
    setRows([]); setResults([]); setCommitted(false); setValidated(false); setSourceFileName(''); setBusy(true);
    try {
      if (!/\.xlsx?$/i.test(file.name)) throw new Error('请选择 .xlsx 或 .xls 文件');
      if (file.size > 2_000_000) throw new Error('Excel 文件不能超过 2 MB，请拆分导入');
      const XLSX = await import('xlsx');
      const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      if (!sheet) throw new Error('工作簿不包含可读取的工作表');
      const records = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });
      if (!records.length) throw new Error('工作表没有导入数据');
      const parsed = parseRecords(records);
      if (parsed.rows.length > 100) throw new Error('单次最多导入 100 票订单，请拆分文件');
      if (!parsed.rows.length) throw new Error('没有可导入的订单，请检查导入订单号和服务代码');
      const payload = JSON.stringify({ sourceFileName: file.name, rows: parsed.rows });
      if (new TextEncoder().encode(payload).length > 1_800_000) throw new Error('导入内容超过 1.8 MB，请拆分文件');
      const preview = await (await request('/customer/v1/orders/import/preview', { method: 'POST', body: payload })).json() as ImportResult[];
      setRows(parsed.rows); setSourceFileName(file.name);
      setResults([...parsed.errors, ...preview].sort((a, b) => a.rowNo - b.rowNo));
      setValidated(parsed.errors.length === 0 && preview.length === parsed.rows.length && preview.every((item) => ['READY', 'ALREADY_CREATED'].includes(item.status)));
      message.success(`已读取 ${records.length} 行，聚合为 ${parsed.rows.length} 票订单`);
    } catch (error) { message.error(errorText(error)); } finally { setBusy(false); }
  };
  const ready = rows.length > 0 && validated && !committed;
  const commit = () => Modal.confirm({
    title: '确认批量创建订单',
    content: `将创建 ${rows.length} 票订单，逐票预扣对应币种余额并自动进入面单生成队列。余额或线路若在预览后变化，部分订单可能失败。`,
    okText: '确认创建', cancelText: '返回检查',
    onOk: async () => {
      setBusy(true);
      try {
        const result = await (await request('/customer/v1/orders/import/commit', { method: 'POST', body: JSON.stringify({ sourceFileName, rows }) })).json() as ImportResult[];
        setResults(result); setCommitted(result.every((item) => item.status === 'CREATED'));
        const created = result.filter((item) => item.status === 'CREATED').length;
        Modal.info({ title: 'Excel 导入结果', content: `成功 ${created} 票，失败 ${result.length - created} 票。成功订单已预扣并等待面单生成；请在订单列表查看后续状态。`, okText: '我知道了' });
        await onDone();
      } catch (error) { Modal.error({ title: '导入未完成', content: errorText(error), okText: '我知道了' }); }
      finally { setBusy(false); }
    },
  });
  return <div className="customer-import">
    <Alert showIcon type="info" message="先解析预览，确认后才扣费" description="模板中每行是一条货品明细；相同导入订单号合并为一票。只有全部预校验通过才能提交。重复提交同一文件内容不会重复扣费。" />
    <div className="customer-import__actions">
      <Space wrap><Button icon={<DownloadOutlined />} onClick={() => { void downloadTemplate(services).catch((error) => message.error(errorText(error))); }}>下载 Excel 模板</Button><Upload accept=".xlsx,.xls" maxCount={1} showUploadList={false} beforeUpload={(file) => { void parseFile(file); return false; }}><Button type="primary" icon={<UploadOutlined />} loading={busy}>选择并预校验</Button></Upload><Button disabled={!ready || busy} onClick={commit}>{results.some((item) => item.status === 'CREATED') ? '重试未成功订单' : `确认创建 ${rows.length || ''} 票订单`}</Button></Space>
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
