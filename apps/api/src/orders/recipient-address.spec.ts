import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeRecipientAddress } from './recipient-address';

test('keeps a short address in its first FedEx line', () => {
  assert.deepEqual(normalizeRecipientAddress(['Dam 1']), { raw: 'Dam 1', line1: 'Dam 1', line2: null, line3: null, lines: ['Dam 1'] });
});

test('merges sources and packs only complete words into FedEx lines', () => {
  assert.deepEqual(normalizeRecipientAddress(['Kerkstraat 123', 'Amsterdam Centre', '1012 JS']), {
    raw: 'Kerkstraat 123 Amsterdam Centre 1012 JS',
    line1: 'Kerkstraat 123',
    line2: 'Amsterdam Centre',
    line3: '1012 JS',
    lines: ['Kerkstraat 123', 'Amsterdam Centre', '1012 JS'],
  });
});

test('rejects an oversized single word and addresses exceeding three lines', () => {
  assert.throws(() => normalizeRecipientAddress(['   ', undefined, '']), /不能为空/);
  assert.throws(() => normalizeRecipientAddress(['abcdefghijklmnopqrstu']), /超过 20 个字符/);
  assert.throws(() => normalizeRecipientAddress(['1234567890 1234567890 1234567890 1234567890']), /最多 3 段/);
});
