import { describe, expect, it } from 'vitest';

import {
  formatCnpj,
  formatCpf,
  isValidCnpj,
  isValidCpf,
  maskCnpjInput,
  maskCpfInput,
  normalizeCnpj,
  normalizeCpf,
} from './documents';

/** Generates the check digits, to build valid documents in tests. */
function cpfWithCheckDigits(base9: string): string {
  const d = [...base9].map(Number);
  const dv = (len: number) => {
    const sum = d
      .slice(0, len)
      .reduce((acc, v, i) => acc + v * (len + 1 - i), 0);
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  d.push(dv(9));
  d.push(dv(10));
  return d.join('');
}

describe('CPF', () => {
  it.each([
    '529.982.247-25',
    '52998224725',
    '111.444.777-35',
    ' 529 982 247 25 ',
  ])('accepts a valid CPF: %s', (cpf) => expect(isValidCpf(cpf)).toBe(true));

  it.each([
    ['wrong check digit', '529.982.247-24'],
    ['wrong first check digit', '529.982.247-15'],
    ['all digits equal (passes the checksum)', '111.111.111-11'],
    ['zeros', '000.000.000-00'],
    ['too short', '529.982.247-2'],
    ['too long', '529.982.247-251'],
    ['letters', '529.982.247-2A'],
    ['empty', ''],
  ])('rejects an invalid CPF (%s)', (_why, cpf) =>
    expect(isValidCpf(cpf)).toBe(false)
  );

  it('rejects null/undefined', () => {
    expect(isValidCpf(null)).toBe(false);
    expect(isValidCpf(undefined)).toBe(false);
  });

  it('agrees with an independent check-digit generator', () => {
    for (let i = 0; i < 200; i++) {
      const base = String(100_000_000 + ((i * 7_919_373) % 899_999_999)).slice(
        0,
        9
      );
      const cpf = cpfWithCheckDigits(base);
      if (/^(\d)\1+$/.test(cpf)) continue;
      expect(isValidCpf(cpf), cpf).toBe(true);
      const wrong = cpf.slice(0, 10) + ((Number(cpf[10]) + 1) % 10);
      expect(isValidCpf(wrong), wrong).toBe(false);
    }
  });

  it('stores without mask and displays with it', () => {
    expect(normalizeCpf('529.982.247-25')).toBe('52998224725');
    expect(formatCpf('52998224725')).toBe('529.982.247-25');
    expect(formatCpf('123')).toBe('123');
    expect(maskCpfInput('5299822')).toBe('529.982.2');
    expect(maskCpfInput('52998224725999')).toBe('529.982.247-25');
  });
});

describe('CNPJ', () => {
  it.each([
    '11.222.333/0001-81',
    '11222333000181',
    '11.444.777/0001-61',
    // Alphanumeric CNPJ (IN RFB 2.229/2024) — Receita's published example.
    '12.ABC.345/01DE-35',
    '12abc34501de35',
  ])('accepts a valid CNPJ: %s', (cnpj) =>
    expect(isValidCnpj(cnpj)).toBe(true)
  );

  it.each([
    ['wrong check digit', '11.222.333/0001-82'],
    ['wrong alphanumeric check digit', '12.ABC.345/01DE-36'],
    ['all equal (passes the checksum)', '00.000.000/0000-00'],
    ['all equal ones', '11.111.111/1111-11'],
    ['letter in the check digits', '12.ABC.345/01DE-3A'],
    ['too short', '11.222.333/0001-8'],
    ['too long', '11.222.333/0001-811'],
    ['symbols', '11.222.333/0001-8#'],
    ['empty', ''],
  ])('rejects an invalid CNPJ (%s)', (_why, cnpj) =>
    expect(isValidCnpj(cnpj)).toBe(false)
  );

  it('stores without mask (uppercase) and displays with it', () => {
    expect(normalizeCnpj('12.abc.345/01de-35')).toBe('12ABC34501DE35');
    expect(formatCnpj('11222333000181')).toBe('11.222.333/0001-81');
    expect(formatCnpj('12ABC34501DE35')).toBe('12.ABC.345/01DE-35');
    expect(maskCnpjInput('11222333')).toBe('11.222.333');
    expect(maskCnpjInput('112223330001')).toBe('11.222.333/0001');
    expect(maskCnpjInput('11222333000181')).toBe('11.222.333/0001-81');
  });

  it('CPF and CNPJ are not interchangeable', () => {
    expect(isValidCnpj('52998224725')).toBe(false);
    expect(isValidCpf('11222333000181')).toBe(false);
  });
});
