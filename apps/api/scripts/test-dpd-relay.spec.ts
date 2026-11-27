import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

test('DPD direct test script sends one request, saves a PDF, and redacts secrets', async () => {
  const pdf = Buffer.from('%PDF-1.4\nMock label\n');
  let request: any;
  let requestCount = 0;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requestCount += 1;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ResponseCode: 'RT01', Status: 'Success', ErrorCode: '0', AWBNo: 'AWB-TEST-1', Pdfdownload: pdf.toString('base64') }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const temp = mkdtempSync(join(tmpdir(), 'dpd-relay-script-'));
  const configFile = join(temp, 'connectors.json');
  const orderFile = join(temp, 'order.json');
  const profile = { enabled: true, environment: 'sandbox', baseUrl: `http://127.0.0.1:${address.port}`,
    userId: 'USER', password: 'SECRET', customerCode: 'C01', vendorName: 'DPD', serviceName: 'UK',
    shipper: { name: `Test Ltd ${randomBytes(3).toString('hex')}`, contact: 'AVA', address1: 'Unit 2', city: 'London', postcode: 'UB78JD', telephone: '441234567890' } };
  writeFileSync(configFile, JSON.stringify({ dpdRelay: { profiles: { TEST: profile } } }));
  writeFileSync(orderFile, JSON.stringify({ recipientName: 'Test Recipient', recipientPhone: '447700900123', recipientPostcode: 'SW1A 1AA', recipientCity: 'London', recipientAddressLine1: '1 Test Street', productCode: 'NDOC', boxes: [{ weightKg: '1', lengthCm: '20', widthCm: '15', heightCm: '10', items: [{ englishName: 'dress', quantity: 1, unitDeclaredValue: '1', declaredValueCurrency: 'GBP' }] }] }));
  try {
    const cwd = resolve(__dirname, '..');
    const command = ['-r', 'ts-node/register', 'scripts/test-dpd-relay.ts', '--profile', 'TEST', '--order-file', orderFile,
      '--vendor-name', 'DPD', '--service-name', 'UK', '--destination-name', 'Test Recipient', '--reference', `DPDTEST-MOCK-${randomBytes(4).toString('hex').toUpperCase()}`, '--send'];
    const run = async (args = command) => {
      const child = spawn(process.execPath, args, { cwd, env: { ...process.env, CONNECTOR_CONFIG_PATH: configFile } });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      const code = await new Promise<number | null>(resolve => child.on('close', resolve));
      assert.equal(code, 0, stderr);
      return JSON.parse(stdout);
    };
    const result = await run();
    assert.equal(result.status, 'SUCCESS_WITH_PDF');
    assert.equal(result.awbNo, 'AWB-TEST-1');
    assert.equal(readFileSync(result.labelFile).subarray(0, 4).toString(), '%PDF');
    assert.equal(request.VendorName, 'DPD');
    assert.ok(request.CustomerRefNo.startsWith('DPDTEST-'));
    for (const optional of ['Dimensions', 'Performa', 'CODAmount', 'RequiredLable', 'RequiredPerforma', 'ShipperContact']) assert.equal(optional in request, false, optional);
    assert.equal(request.ConsigneeContact, 'Test Recipient');
    assert.equal(request.Weight, '1.000');
    assert.equal(request.ShipperMobile, '441234567890');
    assert.equal(request.ConsigneeMobile, '447700900123');
    const log = readFileSync(result.logFile, 'utf8');
    assert.equal(log.includes('SECRET'), false);
    assert.equal(log.includes(pdf.toString('base64')), false);
    const repeated = await run();
    assert.equal(repeated.mode, 'ALREADY_SENT');
    assert.equal(repeated.awbNo, 'AWB-TEST-1');
    assert.equal(repeated.requestChanged, false);
    assert.equal(requestCount, 1);
    const changedReference = [...command];
    changedReference[changedReference.indexOf('--reference') + 1] = `DPDTEST-MOCK-${randomBytes(4).toString('hex').toUpperCase()}`;
    const duplicate = await run(changedReference);
    assert.equal(duplicate.mode, 'DUPLICATE_PAYLOAD_BLOCKED');
    assert.equal(duplicate.previousAwbNo, 'AWB-TEST-1');
    assert.equal(requestCount, 1);
    unlinkSync(result.labelFile);
    unlinkSync(result.logFile);
  } finally {
    server.close();
    unlinkSync(configFile);
    unlinkSync(orderFile);
    rmdirSync(temp);
  }
});
