import { describe, expect, it } from 'vitest';

import { parseContactCsv } from '@/lib/contacts/parse-contact-csv';

import { decodeCsvBytes, detectCsvDelimiter, normalizeCsvText } from './csv';

describe('normalizeCsvText', () => {
  it('leaves an upstream-style CSV unchanged', () => {
    const csv = 'phone,name\n+5511987654321,Maria\n';
    expect(normalizeCsvText(csv)).toBe(csv);
  });

  it('detects the separator from the header row', () => {
    expect(detectCsvDelimiter('telefone;nome;empresa')).toBe(';');
    expect(detectCsvDelimiter('phone,name')).toBe(',');
    expect(detectCsvDelimiter('"a;b",c')).toBe(',');
    expect(detectCsvDelimiter('phone\tname')).toBe('\t');
  });

  it('reads an Excel pt-BR export: BOM, semicolons, Portuguese headers', () => {
    const csv =
      '\uFEFFTelefone;Nome;E-mail;Empresa;Etiquetas\r\n' +
      '+5511987654321;Maria Souza;maria@exemplo.com.br;Padaria Pão Quente, Ltda;"vip,atacado"\r\n' +
      '+5521912345678;João Lima;;;\r\n';
    const { rows, hasPhoneColumn, hasTagsColumn, hasCompanyColumn } =
      parseContactCsv(csv);
    expect({ hasPhoneColumn, hasTagsColumn, hasCompanyColumn }).toEqual({
      hasPhoneColumn: true,
      hasTagsColumn: true,
      hasCompanyColumn: true,
    });
    expect(rows).toEqual([
      {
        phone: '+5511987654321',
        name: 'Maria Souza',
        email: 'maria@exemplo.com.br',
        company: 'Padaria Pão Quente, Ltda',
        tagNames: ['vip', 'atacado'],
      },
      {
        phone: '+5521912345678',
        name: 'João Lima',
        email: undefined,
        company: undefined,
        tagNames: [],
      },
    ]);
  });

  it('maps header aliases regardless of accents and case', () => {
    const { hasPhoneColumn, rows } = parseContactCsv(
      'Número do WhatsApp,NOME COMPLETO\n+5511987654321,Ana\n'
    );
    expect(hasPhoneColumn).toBe(true);
    expect(rows[0]).toMatchObject({ phone: '+5511987654321', name: 'Ana' });
  });
});

describe('decodeCsvBytes', () => {
  it('reads UTF-8 and falls back to Windows-1252', () => {
    expect(decodeCsvBytes(new TextEncoder().encode('São Paulo'))).toBe(
      'São Paulo'
    );
    // "São Paulo" in Windows-1252: ã = 0xE3
    const cp1252 = new Uint8Array([
      0x53, 0xe3, 0x6f, 0x20, 0x50, 0x61, 0x75, 0x6c, 0x6f,
    ]);
    expect(decodeCsvBytes(cp1252)).toBe('São Paulo');
  });
});
