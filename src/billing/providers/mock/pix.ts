/**
 * Pix "copia e cola" (BR Code, EMV QRCPS-MPM) for the mock gateway — a
 * structurally valid payload with a correct CRC16, so the UI and any
 * parser downstream see the real format. The key is random: paying it
 * in a bank app goes nowhere.
 */

function field(id: string, value: string): string {
  return `${id}${String(value.length).padStart(2, '0')}${value}`;
}

/** CRC16/CCITT-FALSE (poly 0x1021, init 0xFFFF), as required by the BR Code spec. */
export function crc16(payload: string): string {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let b = 0; b < 8; b++)
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function ascii(text: string, max: number): string {
  return (
    text
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^A-Za-z0-9 ]/g, '')
      .toUpperCase()
      .slice(0, max)
      .trim() || 'CRM'
  );
}

export function buildPixCopyPaste(input: {
  key: string;
  amountCents: number;
  merchantName: string;
  merchantCity: string;
  txid: string;
}): string {
  const amount = (input.amountCents / 100).toFixed(2);
  const body =
    field('00', '01') +
    field('26', field('00', 'br.gov.bcb.pix') + field('01', input.key)) +
    field('52', '0000') +
    field('53', '986') +
    field('54', amount) +
    field('58', 'BR') +
    field('59', ascii(input.merchantName, 25)) +
    field('60', ascii(input.merchantCity, 15)) +
    field(
      '62',
      field('05', input.txid.replace(/[^A-Za-z0-9]/g, '').slice(0, 25) || '***')
    ) +
    '6304';
  return body + crc16(body);
}

/** True when the last 4 chars are the CRC of the rest (sanity check for tests / parsers). */
export function hasValidCrc(code: string): boolean {
  return code.length > 8 && crc16(code.slice(0, -4)) === code.slice(-4);
}
