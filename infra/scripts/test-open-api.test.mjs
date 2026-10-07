import test from 'node:test';
import assert from 'node:assert/strict';
import { makeClient, monitor, parseArgs, validateInput } from './test-open-api.mjs';

const response = (shipment) => ({ status: 1, data: { shipment } });
test('default is read-only; credentials cannot be CLI arguments or remote plain HTTP', () => {
  assert.equal(parseArgs([]).mode, 'query');
  assert.throws(() => parseArgs(['--api-key', 'secret']));
  assert.throws(() => parseArgs(['--base', 'http://example.com']));
  assert.throws(() => parseArgs(['--base', 'https://user:pass@example.com']));
});
test('unfilled production templates cannot be submitted', () => {
  assert.throws(() => validateInput({ shipment: { service: '__REPLACE_SERVICE_CODE__' } }));
  assert.throws(() => validateInput({ shipment: { service: 'UPS_STANDARD', to_address: {}, parcel_count: 1, parcels: [{ client_weight: null }] } }));
});
test('creation sends correct key and idempotency headers without following redirects', async () => {
  let calls = 0;
  const body = { shipment: { service: 'EXAMPLE' } };
  const client = makeClient('https://example.com', 'private-key', async (url, options) => {
    calls++;
    assert.equal(url, 'https://example.com/api/open/v1/shipments');
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['X-API-Key'], 'private-key');
    assert.equal(options.headers['Idempotency-Key'], 'unique-1');
    assert.deepEqual(JSON.parse(options.body), body);
    return Response.json(response({ shipment_id: 'ORD-example' }), { status: 202 });
  });
  assert.equal((await client('/api/open/v1/shipments', { body, idempotencyKey: 'unique-1' })).data.shipment.shipment_id, 'ORD-example');
  assert.equal(calls, 1);
  await assert.rejects(client('//other.example/api/open/v1/shipments'));
});
test('ambiguous create never auto retries; echoed keys are redacted', async () => {
  let calls = 0;
  const client = makeClient('https://example.com', 'private-key', async () => { calls++; throw new Error('network'); });
  await assert.rejects(client('/api/open/v1/shipments', { body: {} }), /不要更换幂等键/);
  assert.equal(calls, 1);
  const denied = makeClient('https://example.com', 'private-key', async () => Response.json({ status: 0, info: { message: 'private-key' } }, { status: 401 }));
  await assert.rejects(denied('/api/open/v1/shipments/x/label'), (error) => !error.message.includes('private-key') && error.message.includes('401'));
});
test('pending to ready polls without creating; preserves multiple labels', async () => {
  let calls = 0;
  const result = await monitor(async (path) => {
    assert.match(path, /\/label$/);
    return response(++calls === 1 ? { label_status: 'PENDING' } : { label_status: 'READY', labels: [{ label_id: 'a' }, { label_id: 'b' }] });
  }, 'ORD-test', { wait: true, sleep: async () => {} });
  assert.equal(calls, 2);
  assert.equal(result.labels.length, 2);
});
test('failed, unknown, stalled, blocked and cancelled stop polling', async () => {
  for (const status of ['FAILED', 'UNKNOWN', 'STALLED', 'BLOCKED', 'CANCELLED']) {
    let calls = 0;
    await assert.rejects(monitor(async () => { calls++; return response({ label_status: 'PENDING', dispatch: { status } }); }, 'ORD-test', { wait: true, sleep: async () => {} }));
    assert.equal(calls, 1);
  }
});
test('polling has a bound; query without wait calls once', async () => {
  let calls = 0;
  const pending = async () => { calls++; return response({ label_status: 'PENDING' }); };
  assert.equal(await monitor(pending, 'ORD-test'), null);
  assert.equal(calls, 1);
  await assert.rejects(monitor(pending, 'ORD-test', { wait: true, maxPolls: 2, sleep: async () => {} }), /停止轮询/);
  assert.equal(calls, 3);
});
test('PDF bytes validated; JSON error never becomes a PDF', async () => {
  const pdf = makeClient('https://example.com', 'private-key', async () => new Response('%PDF-1.4\nexample'));
  assert.equal((await pdf('/api/open/v1/shipments/x/label/download', { pdf: true })).subarray(0, 5).toString(), '%PDF-');
  const invalid = makeClient('https://example.com', 'private-key', async () => Response.json({ status: 0, info: { message: '面单未就绪' } }, { status: 409 }));
  await assert.rejects(invalid('/api/open/v1/shipments/x/label/download', { pdf: true }), /409.*面单未就绪/);
});
