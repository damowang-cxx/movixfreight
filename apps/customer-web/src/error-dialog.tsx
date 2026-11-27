import { Modal, Space, Typography } from 'antd';

export function errorText(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  const fields = (error as { errorFields?: Array<{ name?: Array<string | number>; errors?: string[] }> } | null)?.errorFields;
  if (Array.isArray(fields) && fields.length) return fields.slice(0, 8).map(field => field.errors?.join('；') || `${field.name?.join('.') ?? '表单字段'}填写有误`).join('\n');
  return '操作失败，请稍后重试。';
}

export function showOperationError(error: unknown, title = '操作未完成', guidance?: string) {
  const status = (error as { status?: number } | null)?.status;
  const raw = errorText(error);
  const detail = error instanceof TypeError && /fetch|network/i.test(raw) ? '网络连接失败，请检查网络后重试。' : raw;
  const nextStep = guidance ?? (status === 401 ? '请重新登录后再操作。' : status && status >= 500 ? '请稍后重试；如已提交订单，请先查看订单列表，避免重复提交。' : undefined);
  Modal.error({
    title,
    okText: '我知道了',
    width: 520,
    content: <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Typography.Text style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{detail}</Typography.Text>
      {nextStep && <Typography.Text type="secondary">{nextStep}</Typography.Text>}
    </Space>,
  });
}

export function showDispatchError(order: { orderNo?: string; dispatch?: { status?: string; message?: string } }) {
  const status = order.dispatch?.status;
  const guidance = status === 'UNKNOWN' || status === 'STALLED'
    ? '结果尚未确认。请联系管理员按订单号核查，确认前不要重复下单。'
    : status === 'BLOCKED' ? '当前线路暂不能自动出单，请联系管理员处理。'
    : '请核对订单信息，或联系管理员处理。';
  showOperationError(order.dispatch?.message || '面单生成未完成。', `订单 ${order.orderNo ?? ''} · 面单${status === 'FAILED' ? '生成失败' : '待核查'}`, guidance);
}

export function showDispatchFailures(orders: Array<{ orderNo?: string; dispatch?: { status?: string; message?: string } }>) {
  if (orders.length === 1) return showDispatchError(orders[0]);
  showOperationError(orders.slice(0, 5).map(order => `${order.orderNo ?? '未知订单'}：${order.dispatch?.message ?? '面单未生成'}`).join('\n') + (orders.length > 5 ? `\n另有 ${orders.length - 5} 票，请到订单列表查看。` : ''), `${orders.length} 票订单面单异常`, '请联系管理员按订单号核查；结果未知的订单在确认前不要重复下单。');
}
