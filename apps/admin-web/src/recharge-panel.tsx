import { useCallback, useEffect, useState } from 'react';
import type { ClipboardEvent } from 'react';
import { DownloadOutlined, PaperClipOutlined, UploadOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Col, Form, Image, Input, Modal, Row, Select, Space, Table, Tag, Typography, Upload, message } from 'antd';

type Request = (path: string, options?: RequestInit) => Promise<Response>;
type Recharge = { ledgerId: string; ledgerNo: string; currency: 'EUR' | 'GBP'; amount: string; balanceBefore: string; balanceAfter: string; reason: string; createdAt: string; operatorName?: string; receipt: { id: string; fileName: string; mimeType: string; byteSize: number; sha256: string } | null };
type Props = { customer: any; canAdjust: boolean; request: Request; onSaved: () => Promise<void> };
const errorText = (error: unknown) => error instanceof Error ? error.message : '操作失败';

export function RechargePanel({ customer, canAdjust, request, onSaved }: Props) {
  const [form] = Form.useForm();
  const direction = Form.useWatch('direction', form);
  const [proof, setProof] = useState<File | null>(null);
  const [proofPreview, setProofPreview] = useState<string | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [history, setHistory] = useState<Recharge[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const loadHistory = useCallback(async (cursor?: string) => {
    setLoading(true);
    try {
      const path = `/admin/v1/customers/${customer.id}/recharges${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`;
      const page = await (await request(path)).json();
      setHistory((current) => cursor ? [...current, ...page.items] : page.items);
      setNextCursor(page.nextCursor);
    } catch (error) { message.error(errorText(error)); }
    finally { setLoading(false); }
  }, [customer.id, request]);
  useEffect(() => { void loadHistory(); }, [loadHistory]);
  useEffect(() => {
    if (!proof) { setProofPreview(null); return; }
    const url = URL.createObjectURL(proof); setProofPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [proof]);
  useEffect(() => () => { if (imagePreview) URL.revokeObjectURL(imagePreview); }, [imagePreview]);

  const chooseProof = (file: File) => {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { message.error('请选择 PNG、JPG 或 WebP 水单图片'); return; }
    if (!file.size || file.size > 5 * 1024 * 1024) { message.error('水单图片不能超过 5 MB，且不能为空'); return; }
    setProof(file);
  };
  const pasteProof = (event: ClipboardEvent<HTMLDivElement>) => {
    if (direction !== 'CREDIT') return;
    const image = [...event.clipboardData.items].find((item) => item.type.startsWith('image/'))?.getAsFile();
    if (!image) return;
    event.preventDefault();
    chooseProof(new File([image], `recharge-paste-${new Date().toISOString().slice(0, 10)}.${image.type === 'image/jpeg' ? 'jpg' : image.type === 'image/webp' ? 'webp' : 'png'}`, { type: image.type }));
  };
  const save = async (value: { currency: string; amount: string; direction: 'CREDIT' | 'DEBIT'; reason: string }) => {
    setSaving(true);
    try {
      const path = `/admin/v1/customers/${customer.id}/wallet-adjustments`;
      const body = value.direction === 'CREDIT' && proof ? new FormData() : null;
      if (body && proof) {
        body.set('currency', value.currency); body.set('amount', value.amount); body.set('direction', 'CREDIT'); body.set('reason', value.reason);
        body.set('receipt', proof);
      }
      const response = await request(path, { method: 'POST', body: body ?? JSON.stringify(value) });
      const ledger = await response.json();
      setProof(null); form.resetFields();
      await Promise.all([loadHistory(), onSaved()]);
      Modal.success({ title: value.direction === 'CREDIT' ? '充值已入账' : '余额已扣减', content: `流水号：${ledger.ledgerNo}。${value.direction === 'CREDIT' ? proof ? '水单已与本次充值一同保存，可在下方历史中查看。' : '本次未上传水单，可在充值历史中查看入账记录。' : '本次扣减已记录在钱包流水中。'}` });
    } catch (error) { Modal.error({ title: '余额调整未完成', content: errorText(error) }); }
    finally { setSaving(false); }
  };
  const openReceipt = async (entry: Recharge, download = false) => {
    try {
      const blob = await (await request(`/admin/v1/customers/${customer.id}/recharges/${entry.ledgerId}/receipt`)).blob();
      const url = URL.createObjectURL(blob);
      if (download) {
        const anchor = document.createElement('a'); anchor.href = url; anchor.download = entry.receipt?.fileName ?? `${entry.ledgerNo}.png`; anchor.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
      } else setImagePreview(url);
    } catch (error) { message.error(errorText(error)); }
  };
  const wallet = (currency: string) => customer.wallets?.find((item: any) => item.currency === currency)?.balance ?? '0.00';

  return <Card className="recharge-panel" size="small" title="客户充值与余额调整" extra={<Typography.Text type="secondary">充值水单与资金流水关联保存</Typography.Text>}>
    <div className="recharge-panel__balances"><span>EUR 余额 <strong>€ {wallet('EUR')}</strong></span><span>GBP 余额 <strong>£ {wallet('GBP')}</strong></span></div>
    {canAdjust ? <div onPaste={pasteProof}>
      <Form form={form} layout="vertical" initialValues={{ currency: 'EUR', direction: 'CREDIT' }} onFinish={(value) => void save(value)}>
        <Row gutter={12}><Col span={8}><Form.Item name="currency" label="币种" rules={[{ required: true }]}><Select options={[{ value: 'EUR' }, { value: 'GBP' }]} /></Form.Item></Col><Col span={8}><Form.Item name="direction" label="操作" rules={[{ required: true }]}><Select options={[{ value: 'CREDIT', label: '客户充值入账' }, { value: 'DEBIT', label: '人工扣减' }]} onChange={() => setProof(null)} /></Form.Item></Col><Col span={8}><Form.Item name="amount" label="金额" rules={[{ required: true, pattern: /^\d+(\.\d{1,2})?$/, message: '请输入大于零的金额，最多两位小数' }]}><Input inputMode="decimal" placeholder="0.00" /></Form.Item></Col></Row>
        <Form.Item name="reason" label={direction === 'DEBIT' ? '扣减原因' : '充值备注'} rules={[{ required: true, message: '请填写操作原因' }]}><Input.TextArea rows={2} maxLength={500} showCount placeholder="例如：银行转账，到账日期及付款方" /></Form.Item>
        {direction !== 'DEBIT' && <div className="recharge-panel__proof" tabIndex={0} role="group" aria-label="充值水单：可选择文件或按 Ctrl+V 粘贴截图" onClick={(event) => { if (event.target === event.currentTarget) event.currentTarget.focus(); }}>
          <div className="recharge-panel__proof-copy"><PaperClipOutlined /><div><b>充值水单图片（可选）</b><small>选择文件，或点击此处按 Ctrl+V 粘贴截图。不上传也可入账；支持 PNG、JPG、WebP，最多 5 MB。</small></div></div>
          <Upload accept="image/png,image/jpeg,image/webp" showUploadList={false} beforeUpload={(file) => { chooseProof(file); return false; }}><Button icon={<UploadOutlined />}>选择图片</Button></Upload>
          {proof && <div className="recharge-panel__proof-selected"><img src={proofPreview ?? ''} alt="待上传充值水单预览" /><div><b>{proof.name}</b><small>{(proof.size / 1024).toFixed(0)} KB</small><Button type="link" danger size="small" onClick={() => setProof(null)}>移除图片</Button></div></div>}
        </div>}
        <Button type="primary" htmlType="submit" loading={saving} style={{ marginTop: 16 }}>{direction === 'DEBIT' ? '确认扣减' : '确认充值入账'}</Button>
      </Form>
    </div> : <Alert type="info" showIcon message="仅财务或超级管理员可调整余额" description="充值历史和水单可供查看与对账。" />}
    <div className="recharge-panel__history-head"><b>充值历史</b><Typography.Text type="secondary">金额、余额变化、操作人和水单可逐笔核对</Typography.Text></div>
    <Table size="small" rowKey="ledgerId" loading={loading} dataSource={history} pagination={false} scroll={{ x: 820 }} locale={{ emptyText: '暂无客户充值记录' }} columns={[
      { title: '入账时间', dataIndex: 'createdAt', width: 150, render: (value: string) => new Date(value).toLocaleString() },
      { title: '流水号', dataIndex: 'ledgerNo', width: 190, render: (value: string) => <Typography.Text copyable={{ text: value }}>{value}</Typography.Text> },
      { title: '充值金额', width: 125, render: (_, item) => <strong>{item.currency} {item.amount}</strong> },
      { title: '余额变化', width: 150, render: (_, item) => `${item.balanceBefore} → ${item.balanceAfter}` },
      { title: '操作人', dataIndex: 'operatorName', width: 95 },
      { title: '备注', dataIndex: 'reason', width: 180, ellipsis: true },
      { title: '水单', width: 170, render: (_, item) => item.receipt ? <Space size={0}><Button type="link" size="small" onClick={() => void openReceipt(item)}>查看</Button><Button type="link" size="small" icon={<DownloadOutlined />} onClick={() => void openReceipt(item, true)}>下载</Button></Space> : <Tag>未上传水单</Tag> },
    ]} />
    {nextCursor && <Button className="recharge-panel__more" loading={loading} onClick={() => void loadHistory(nextCursor)}>加载更多记录</Button>}
    <Modal open={Boolean(imagePreview)} title="充值水单" footer={<Button onClick={() => setImagePreview(null)}>关闭</Button>} onCancel={() => setImagePreview(null)} width={780}><div className="recharge-panel__image-view">{imagePreview && <Image src={imagePreview} alt="客户充值水单" preview={false} />}</div></Modal>
  </Card>;
}
