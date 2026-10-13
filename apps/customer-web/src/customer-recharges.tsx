import { useCallback, useEffect, useState } from 'react';
import { Button, Card, Image, Modal, Space, Table, Tag, Typography, message } from 'antd';
import { WalletOutlined } from '@ant-design/icons';

type Request = (path: string, options?: RequestInit) => Promise<Response>;
type Recharge = { ledgerId: string; ledgerNo: string; currency: string; amount: string; balanceAfter: string; reason: string; createdAt: string; receipt: { fileName: string } | null };
const errorText = (error: unknown) => error instanceof Error ? error.message : '操作失败';

export function CustomerRecharges({ request }: { request: Request }) {
  const [rows, setRows] = useState<Recharge[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const load = useCallback(async (cursor?: string) => {
    setLoading(true);
    try {
      const page = await (await request(`/customer/v1/recharges${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`)).json();
      setRows((current) => cursor ? [...current, ...page.items] : page.items);
      setNextCursor(page.nextCursor);
    } catch (error) { message.error(errorText(error)); }
    finally { setLoading(false); }
  }, [request]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  const viewReceipt = async (ledgerId: string) => {
    try {
      const blob = await (await request(`/customer/v1/recharges/${ledgerId}/receipt`)).blob();
      setPreview(URL.createObjectURL(blob));
    } catch (error) { message.error(errorText(error)); }
  };
  return <Card className="customer-section" title={<Space><WalletOutlined />充值历史</Space>} extra={<Space><Typography.Text type="secondary">可按流水号核对每次入账与水单</Typography.Text><Button size="small" loading={loading} onClick={() => void load()}>刷新</Button></Space>}>
    <Table size="small" rowKey="ledgerId" loading={loading} dataSource={rows} pagination={false} scroll={{ x: 780 }} locale={{ emptyText: '暂无充值记录；如已转账，请联系管理员核对到账情况' }} columns={[
      { title: '时间', dataIndex: 'createdAt', width: 155, render: (value: string) => new Date(value).toLocaleString() },
      { title: '流水号', dataIndex: 'ledgerNo', width: 200, render: (value: string) => <Typography.Text copyable={{ text: value }}>{value}</Typography.Text> },
      { title: '入账金额', width: 135, render: (_, row) => <b>{row.currency} {row.amount}</b> },
      { title: '入账后余额', dataIndex: 'balanceAfter', width: 125 },
      { title: '备注', dataIndex: 'reason', width: 180, ellipsis: true },
      { title: '水单', width: 100, render: (_, row) => row.receipt ? <Button type="link" onClick={() => void viewReceipt(row.ledgerId)}>查看</Button> : <Tag>无凭证</Tag> },
    ]} />
    {nextCursor && <Button style={{ display: 'block', margin: '14px auto 0' }} loading={loading} onClick={() => void load(nextCursor)}>加载更多记录</Button>}
    <Modal open={Boolean(preview)} title="充值水单" footer={<Button onClick={() => setPreview(null)}>关闭</Button>} onCancel={() => setPreview(null)} width={780}><div className="customer-recharge-preview">{preview && <Image src={preview} alt="充值水单" preview={false} />}</div></Modal>
  </Card>;
}
