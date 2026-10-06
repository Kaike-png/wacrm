/**
 * Brazilian phone numbers (fork, docs/BRAZILIAN_CONTACTS.md).
 *
 * Storage: E.164 with the `+` (`+5521999999999`). The core keeps a
 * digits-only `phone_normalized` column generated from `phone`
 * (migration 022), so `+5521999999999` and the `5521999999999` Meta's
 * webhook stores dedupe to the same contact.
 *
 * Input rules (`normalizePhoneInput`):
 *   - With `+`: international, accepted for any country (the core rule,
 *     `parseInternationalPhone`). `+55` numbers must also have a valid
 *     Brazilian shape (DDD + 8/9 digits).
 *   - Without `+`, only when the account's default country is Brazil
 *     (formatting locale `pt-BR`): read as a Brazilian number. Needs the
 *     DDD: we never assume one (`99999-9999` is rejected, not turned into
 *     `+5521…`). Trunk `0` and carrier codes (`0 21 21 9…`) are dropped,
 *     a typed `55` country code without `+` is accepted.
 *   - Otherwise (no `+`, account not Brazilian): rejected, exactly as
 *     upstream does (issue #586: a national number is ambiguous).
 */
import { parseInternationalPhone } from '@/custom/core/shared';
import { getActiveLocaleSettings } from '@/custom/locale/format';

/** Every DDD (código de área) in use in Brazil (Anatel). */
export const BRAZIL_AREA_CODES: ReadonlySet<string> = new Set([
  '11',
  '12',
  '13',
  '14',
  '15',
  '16',
  '17',
  '18',
  '19',
  '21',
  '22',
  '24',
  '27',
  '28',
  '31',
  '32',
  '33',
  '34',
  '35',
  '37',
  '38',
  '41',
  '42',
  '43',
  '44',
  '45',
  '46',
  '47',
  '48',
  '49',
  '51',
  '53',
  '54',
  '55',
  '61',
  '62',
  '63',
  '64',
  '65',
  '66',
  '67',
  '68',
  '69',
  '71',
  '73',
  '74',
  '75',
  '77',
  '79',
  '81',
  '82',
  '83',
  '84',
  '85',
  '86',
  '87',
  '88',
  '89',
  '91',
  '92',
  '93',
  '94',
  '95',
  '96',
  '97',
  '98',
  '99',
]);

export type PhoneInputError =
  | 'empty'
  /** No `+` and the account is not Brazilian: country code required. */
  | 'needsCountryCode'
  /** Brazilian number without the DDD (8–9 digits). */
  | 'missingAreaCode'
  | 'invalidAreaCode'
  /** Has a DDD but the rest is not a Brazilian landline/mobile. */
  | 'invalidBrazilianNumber'
  | 'invalid';

export type PhoneInputResult =
  | { ok: true; e164: string; brazilian: boolean }
  | { ok: false; error: PhoneInputError };

/**
 * National significant number (DDD + subscriber, no country code) that
 * is a valid Brazilian landline or mobile: 11 digits with the mobile
 * `9`, or 10 digits (landline 2–5, or a pre-2016 8-digit mobile 6–9,
 * still how WhatsApp identifies some accounts).
 */
export function isBrazilianNationalNumber(national: string): boolean {
  if (!/^\d{10,11}$/.test(national)) return false;
  if (!BRAZIL_AREA_CODES.has(national.slice(0, 2))) return false;
  const first = national[2];
  return national.length === 11 ? first === '9' : first >= '2' && first <= '9';
}

/** ISO country whose national format applies to numbers typed without `+`. */
export function defaultPhoneCountry(
  locale: string = getActiveLocaleSettings().locale
): string | null {
  const region = locale.split(/[-_]/)[1];
  return region ? region.toUpperCase() : null;
}

export function normalizePhoneInput(
  raw: string | null | undefined,
  {
    defaultCountry = defaultPhoneCountry(),
  }: { defaultCountry?: string | null } = {}
): PhoneInputResult {
  const text = (raw ?? '').trim();
  if (!text) return { ok: false, error: 'empty' };

  if (text.startsWith('+')) {
    const digits = parseInternationalPhone(text);
    if (!digits) return { ok: false, error: 'invalid' };
    if (digits.startsWith('55')) {
      const national = digits.slice(2);
      if (national.length <= 9) return { ok: false, error: 'missingAreaCode' };
      if (!BRAZIL_AREA_CODES.has(national.slice(0, 2)))
        return { ok: false, error: 'invalidAreaCode' };
      if (!isBrazilianNationalNumber(national))
        return { ok: false, error: 'invalidBrazilianNumber' };
      return { ok: true, e164: `+${digits}`, brazilian: true };
    }
    return { ok: true, e164: `+${digits}`, brazilian: false };
  }

  if (defaultCountry !== 'BR') return { ok: false, error: 'needsCountryCode' };
  // Only digits and the usual separators — no letters, no extensions.
  if (!/^[\d\s().\-/]+$/.test(text)) return { ok: false, error: 'invalid' };
  let digits = text.replace(/\D/g, '');

  // "00…" is an international call from Brazil (00 + carrier + country):
  // too ambiguous to guess, ask for the `+` form.
  if (digits.startsWith('00')) return { ok: false, error: 'needsCountryCode' };
  // Trunk prefix "0" (+ optional 2-digit carrier code): 0 21 99999-9999,
  // 0 41 21 99999-9999.
  if (digits.startsWith('0')) {
    if (digits.length === 13 || digits.length === 14) digits = digits.slice(3);
    else if (digits.length === 11 || digits.length === 12)
      digits = digits.slice(1);
  }
  // Country code typed without `+`: 55 21 99999-9999. No Brazilian national
  // number has 12–13 digits, so this cannot be misread.
  if (
    (digits.length === 12 || digits.length === 13) &&
    digits.startsWith('55')
  ) {
    digits = digits.slice(2);
  }

  if (digits.length === 8 || digits.length === 9)
    return { ok: false, error: 'missingAreaCode' };
  if (digits.length !== 10 && digits.length !== 11)
    return { ok: false, error: 'needsCountryCode' };
  if (!BRAZIL_AREA_CODES.has(digits.slice(0, 2)))
    return { ok: false, error: 'invalidAreaCode' };
  if (!isBrazilianNationalNumber(digits))
    return { ok: false, error: 'invalidBrazilianNumber' };
  return { ok: true, e164: `+55${digits}`, brazilian: true };
}

/**
 * Display form: Brazilian numbers as `+55 (21) 99999-9999` (also the
 * digits-only `5521999999999` the webhook stores); anything else is
 * returned unchanged.
 */
export function formatPhoneDisplay(phone: string | null | undefined): string {
  const value = (phone ?? '').trim();
  if (!/^\+?\d+$/.test(value)) return phone ?? '';
  const digits = value.replace(/^\+/, '');
  if (!digits.startsWith('55')) return phone ?? '';
  const n = digits.slice(2);
  if (!isBrazilianNationalNumber(n)) return phone ?? '';
  const split = n.length === 11 ? 7 : 6;
  return `+55 (${n.slice(0, 2)}) ${n.slice(2, split)}-${n.slice(split)}`;
}

/**
 * For bulk paths (CSV import): only **national Brazilian** input (no
 * `+`, account in Brazil) is rewritten to E.164. Numbers that already
 * carry `+` are left exactly as the file has them (the core parses and
 * dedupes those), and unrecognisable text stays as-is so the core still
 * reports it as invalid instead of it vanishing.
 */
export function normalizePhoneOrKeep(raw: string): string {
  if (raw.trim().startsWith('+')) return raw;
  const result = normalizePhoneInput(raw);
  return result.ok ? result.e164 : raw;
}

/**
 * What to store for a phone typed in a form: E.164 when it parses,
 * otherwise the trimmed text (the caller has already rejected it, or
 * left an untouched legacy value alone).
 */
export function phoneForStorage(raw: string): string {
  const result = normalizePhoneInput(raw);
  return result.ok ? result.e164 : raw.trim();
}
