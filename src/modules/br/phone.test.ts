import { describe, expect, it } from 'vitest';

import {
  defaultPhoneCountry,
  formatPhoneDisplay,
  normalizePhoneInput,
  normalizePhoneOrKeep,
  phoneForStorage,
} from './phone';

const BR = { defaultCountry: 'BR' };
const US = { defaultCountry: 'US' };

describe('Brazilian phone input (account in Brazil)', () => {
  it.each([
    ['(21) 99999-9999', '+5521999999999'],
    ['21 99999-9999', '+5521999999999'],
    ['21999999999', '+5521999999999'],
    ['(11) 3456-7890', '+551134567890'], // landline, 8 digits
    ['(31) 8765-4321', '+553187654321'], // pre-2016 8-digit mobile
    ['021 99999-9999', '+5521999999999'], // trunk 0
    ['0 41 21 99999-9999', '+5521999999999'], // trunk 0 + carrier code
    ['55 21 99999-9999', '+5521999999999'], // country code without +
    ['+55 (21) 99999-9999', '+5521999999999'],
    ['(85) 98888-7777', '+5585988887777'],
  ])('%s → %s', (input, e164) => {
    expect(normalizePhoneInput(input, BR)).toEqual({
      ok: true,
      e164,
      brazilian: true,
    });
  });

  it('never assumes a DDD', () => {
    expect(normalizePhoneInput('99999-9999', BR)).toEqual({
      ok: false,
      error: 'missingAreaCode',
    });
    expect(normalizePhoneInput('3456-7890', BR)).toEqual({
      ok: false,
      error: 'missingAreaCode',
    });
    expect(normalizePhoneInput('+55 99999-9999', BR)).toEqual({
      ok: false,
      error: 'missingAreaCode',
    });
  });

  it.each([
    ['(20) 99999-9999', 'invalidAreaCode'], // DDD 20 does not exist
    ['(10) 3456-7890', 'invalidAreaCode'],
    ['(21) 89999-9999', 'invalidBrazilianNumber'], // 9 digits must start with 9
    ['(21) 1234-5678', 'invalidBrazilianNumber'], // landlines start with 2–5
    ['+55 21 1234-5678', 'invalidBrazilianNumber'],
    ['(21) 9999-99999-9', 'needsCountryCode'], // 12 digits, not 55-prefixed
    ['21 9999-99999 ramal 2', 'invalid'],
    ['', 'empty'],
    ['   ', 'empty'],
  ])('rejects %s (%s)', (input, error) => {
    expect(normalizePhoneInput(input, BR)).toEqual({ ok: false, error });
  });

  it('asks for + instead of guessing an "00" international prefix', () => {
    expect(normalizePhoneInput('00 1 415 555 0123', BR)).toEqual({
      ok: false,
      error: 'needsCountryCode',
    });
  });
});

describe('international numbers are never blocked', () => {
  it.each([
    ['+1 (415) 555-0123', '+14155550123'],
    ['+44 20 7946 0958', '+442079460958'],
    ['+351 912 345 678', '+351912345678'],
    ['+54 9 11 2345-6789', '+5491123456789'],
  ])('%s → %s, also in a Brazilian account', (input, e164) => {
    expect(normalizePhoneInput(input, BR)).toEqual({
      ok: true,
      e164,
      brazilian: false,
    });
    expect(normalizePhoneInput(input, US)).toEqual({
      ok: true,
      e164,
      brazilian: false,
    });
  });

  it('a non-Brazilian account keeps the upstream rule: + is required', () => {
    expect(normalizePhoneInput('(21) 99999-9999', US)).toEqual({
      ok: false,
      error: 'needsCountryCode',
    });
    expect(normalizePhoneInput('4155550123', US)).toEqual({
      ok: false,
      error: 'needsCountryCode',
    });
    expect(normalizePhoneInput('+55 21 99999-9999', US)).toEqual({
      ok: true,
      e164: '+5521999999999',
      brazilian: true,
    });
  });

  it('rejects malformed + numbers', () => {
    expect(normalizePhoneInput('+12', BR)).toEqual({
      ok: false,
      error: 'invalid',
    });
    expect(normalizePhoneInput('+1 415 CALL NOW', BR)).toEqual({
      ok: false,
      error: 'invalid',
    });
  });
});

describe('default country', () => {
  it('comes from the region of the formatting locale', () => {
    expect(defaultPhoneCountry('pt-BR')).toBe('BR');
    expect(defaultPhoneCountry('pt_BR')).toBe('BR');
    expect(defaultPhoneCountry('en-US')).toBe('US');
    expect(defaultPhoneCountry('pt')).toBeNull();
  });

  it('is not Brazil in the test env (en-US deploy), so upstream behaviour holds', () => {
    expect(defaultPhoneCountry()).not.toBe('BR');
    expect(normalizePhoneInput('(21) 99999-9999').ok).toBe(false);
  });
});

describe('display', () => {
  it.each([
    ['+5521999999999', '+55 (21) 99999-9999'],
    ['5521999999999', '+55 (21) 99999-9999'], // digits-only, as the webhook stores
    ['+551134567890', '+55 (11) 3456-7890'],
    ['+14155550123', '+14155550123'], // other countries unchanged
    ['+55 21 99999-9999', '+55 21 99999-9999'], // already formatted: unchanged
    ['', ''],
  ])('%s → %s', (input, shown) =>
    expect(formatPhoneDisplay(input)).toBe(shown)
  );
});

describe('storage helpers', () => {
  it('phoneForStorage returns E.164 or the trimmed text', () => {
    expect(phoneForStorage('+1 (415) 555-0123')).toBe('+14155550123');
    expect(phoneForStorage('  abc ')).toBe('abc');
  });

  it('normalizePhoneOrKeep leaves + numbers exactly as typed', () => {
    expect(normalizePhoneOrKeep('+1 (555) 123-0000')).toBe('+1 (555) 123-0000');
    expect(normalizePhoneOrKeep('não é telefone')).toBe('não é telefone');
  });
});
