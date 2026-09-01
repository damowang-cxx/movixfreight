import { BadRequestException } from '@nestjs/common';

export const RECIPIENT_ADDRESS_LINE_LIMIT = 20;
export const RECIPIENT_ADDRESS_LINE_COUNT = 3;

export type NormalizedRecipientAddress = {
  raw: string;
  line1: string;
  line2: string | null;
  line3: string | null;
  lines: string[];
};

function characterCount(value: string) {
  return Array.from(value).length;
}

/**
 * Converts one or more user supplied address fields into the maximum three
 * FedEx street lines. Segments are deliberately reflowed so integrations
 * cannot bypass the carrier's 20-character line limit with a long address_1.
 */
export function normalizeRecipientAddress(parts: Array<string | null | undefined>): NormalizedRecipientAddress {
  const raw = parts
    .map((part) => typeof part === 'string' ? part.trim() : '')
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/gu, ' ')
    .trim();

  if (!raw) throw new BadRequestException('收件地址不能为空');

  const words = raw.split(' ');
  if (words.some((word) => characterCount(word) > RECIPIENT_ADDRESS_LINE_LIMIT)) {
    throw new BadRequestException(`收件地址包含超过 ${RECIPIENT_ADDRESS_LINE_LIMIT} 个字符的完整单词，请修改地址后重试`);
  }

  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (characterCount(candidate) <= RECIPIENT_ADDRESS_LINE_LIMIT) {
      current = candidate;
      continue;
    }
    lines.push(current);
    current = word;
    if (lines.length >= RECIPIENT_ADDRESS_LINE_COUNT) {
      throw new BadRequestException(`收件地址超过 FedEx 限制：最多 ${RECIPIENT_ADDRESS_LINE_COUNT} 段、每段 ${RECIPIENT_ADDRESS_LINE_LIMIT} 个字符`);
    }
  }
  if (current) lines.push(current);

  return { raw, line1: lines[0]!, line2: lines[1] ?? null, line3: lines[2] ?? null, lines };
}
