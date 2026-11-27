type Request = (path: string, options?: RequestInit) => Promise<Response>;
type AssistSession = { accessToken: string; assistedBy: { username: string } };

export function openCustomerAssist(customerId: string, request: Request): Promise<void> {
  const nonce = crypto.randomUUID();
  const portalUrl = new URL('/', window.location.origin);
  if (import.meta.env.DEV) portalUrl.port = String(Number(window.location.port) + 1);
  portalUrl.searchParams.set('admin_assist', nonce);
  const tab = window.open('about:blank', '_blank');
  if (!tab) return Promise.reject(new Error('浏览器阻止了新标签页，请允许本站打开弹窗后重试。'));

  return new Promise<void>((resolve, reject) => {
    let ready = false;
    let session: AssistSession | null = null;
    const cleanup = () => { window.clearTimeout(timer); window.removeEventListener('message', onMessage); };
    const fail = (error: unknown) => { cleanup(); tab.close(); reject(error); };
    const send = () => {
      if (ready && session) tab.postMessage({ type: 'MOVIX_CUSTOMER_ASSIST_SESSION', nonce, accessToken: session.accessToken, assistedBy: session.assistedBy }, portalUrl.origin);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== tab || event.origin !== portalUrl.origin || event.data?.nonce !== nonce) return;
      if (event.data?.type === 'MOVIX_CUSTOMER_ASSIST_READY') { ready = true; send(); }
      if (event.data?.type === 'MOVIX_CUSTOMER_ASSIST_ACK' && session) { cleanup(); resolve(); }
    };
    const timer = window.setTimeout(() => fail(new Error('客户页面连接超时，请确认客户门户可以打开后重试。')), 20_000);
    window.addEventListener('message', onMessage);
    tab.location.href = portalUrl.href;
    void request(`/admin/v1/customers/${customerId}/assist-session`, { method: 'POST' })
      .then((response) => response.json())
      .then((result: AssistSession) => {
        if (!result.accessToken) throw new Error('服务器没有返回协助会话令牌');
        session = result;
        send();
      })
      .catch(fail);
  });
}
