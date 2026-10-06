import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  BRAZIL_UFS,
  formatCep,
  getCepLookupProvider,
  isUf,
  isValidCepFormat,
  maskCepInput,
  normalizeCep,
  registerCepLookupProvider,
} from './address';
import {
  EMPTY_BR_PROFILE,
  draftFromRow,
  isEmptyBrProfile,
  rowFromDraft,
  validateBrProfile,
  type BrContactProfileRow,
} from './profile';

describe('CEP', () => {
  it('stores 8 digits and shows 00000-000', () => {
    expect(normalizeCep('01310-100')).toBe('01310100');
    expect(formatCep('01310100')).toBe('01310-100');
    expect(maskCepInput('013101')).toBe('01310-1');
    expect(isValidCepFormat('01310-100')).toBe(true);
    expect(isValidCepFormat('0131010')).toBe(false);
    expect(isValidCepFormat('00000-000')).toBe(false);
  });

  it('has no lookup provider until an integration registers one', async () => {
    expect(getCepLookupProvider()).toBeNull();
    registerCepLookupProvider({
      id: 'fake',
      lookup: async () => ({
        street: 'Avenida Paulista',
        city: 'São Paulo',
        state: 'SP',
      }),
    });
    expect(await getCepLookupProvider()?.lookup('01310100')).toMatchObject({
      state: 'SP',
    });
    registerCepLookupProvider(null);
    expect(getCepLookupProvider()).toBeNull();
  });

  it('knows the 27 UFs', () => {
    expect(BRAZIL_UFS).toHaveLength(27);
    expect(isUf('sp')).toBe(true);
    expect(isUf('XX')).toBe(false);
  });
});

describe('profile draft ↔ row', () => {
  const pj = {
    ...EMPTY_BR_PROFILE,
    personType: 'PJ' as const,
    taxId: '12.abc.345/01de-35',
    legalName: '  Padaria Pão Quente Ltda ',
    postalCode: '01310-100',
    street: 'Avenida Paulista',
    streetNumber: '1000',
    complement: '',
    district: 'Bela Vista',
    city: 'São Paulo',
    state: 'SP' as const,
  };

  it('stores documents and CEP without mask', () => {
    expect(validateBrProfile(pj)).toEqual({});
    expect(rowFromDraft(pj)).toEqual({
      person_type: 'PJ',
      tax_id: '12ABC34501DE35',
      legal_name: 'Padaria Pão Quente Ltda',
      postal_code: '01310100',
      street: 'Avenida Paulista',
      street_number: '1000',
      complement: null,
      district: 'Bela Vista',
      city: 'São Paulo',
      state: 'SP',
    });
  });

  it('shows them masked again', () => {
    const row = {
      contact_id: 'c',
      account_id: 'a',
      ...rowFromDraft(pj),
    } as BrContactProfileRow;
    expect(draftFromRow(row)).toMatchObject({
      taxId: '12.ABC.345/01DE-35',
      postalCode: '01310-100',
      legalName: 'Padaria Pão Quente Ltda',
    });
  });

  it('validates the document of the chosen person type', () => {
    expect(validateBrProfile({ ...pj, taxId: '11.222.333/0001-82' })).toEqual({
      taxId: 'invalidCnpj',
    });
    expect(
      validateBrProfile({
        ...EMPTY_BR_PROFILE,
        personType: 'PF',
        taxId: '529.982.247-24',
      })
    ).toEqual({ taxId: 'invalidCpf' });
    expect(
      validateBrProfile({
        ...EMPTY_BR_PROFILE,
        personType: 'PF',
        taxId: '529.982.247-25',
      })
    ).toEqual({});
    expect(validateBrProfile({ ...pj, postalCode: '0131' })).toEqual({
      postalCode: 'invalidCep',
    });
    expect(validateBrProfile({ ...pj, city: 'x'.repeat(101) })).toEqual({
      city: 'tooLong',
    });
  });

  it('drops the razão social for PF and the document without a person type', () => {
    expect(
      rowFromDraft({ ...pj, personType: 'PF', taxId: '52998224725' })
    ).toMatchObject({
      tax_id: '52998224725',
      legal_name: null,
    });
    expect(rowFromDraft({ ...pj, personType: '' })).toMatchObject({
      person_type: null,
      tax_id: null,
    });
  });

  it('an untouched form is empty (nothing to store)', () => {
    expect(isEmptyBrProfile(rowFromDraft(EMPTY_BR_PROFILE))).toBe(true);
    expect(
      isEmptyBrProfile(rowFromDraft({ ...EMPTY_BR_PROFILE, city: 'Recife' }))
    ).toBe(false);
  });
});

describe('migration 901', () => {
  const sql = readFileSync(
    join(process.cwd(), 'supabase/migrations/901_br_contact_profiles.sql'),
    'utf8'
  );

  it('enforces the same rules as the app', () => {
    expect(sql).toMatch(/br_is_valid_cpf/);
    expect(sql).toMatch(/br_is_valid_cnpj/);
    expect(sql).toMatch(/\^\[0-9A-Z\]\{12\}\[0-9\]\{2\}\$/); // alphanumeric CNPJ
    expect(sql).toMatch(/postal_code ~ '\^\[0-9\]\{8\}\$'/);
    for (const uf of BRAZIL_UFS) expect(sql).toContain(`'${uf}'`);
  });

  it('derives account_id from the contact and mirrors the contacts RLS', () => {
    expect(sql).toMatch(/SELECT c\.account_id INTO NEW\.account_id/);
    expect(sql).toMatch(/ENABLE ROW LEVEL SECURITY/);
    expect(sql).toMatch(
      /FOR SELECT USING \(public\.is_account_member\(account_id\)\)/
    );
    expect(sql).toMatch(/is_account_member\(account_id, 'agent'\)/);
  });

  it('is idempotent and does not touch upstream tables', () => {
    expect(sql).toMatch(
      /CREATE TABLE IF NOT EXISTS public\.br_contact_profiles/
    );
    expect(sql).not.toMatch(/ALTER TABLE public\.contacts\b/);
    for (const stmt of sql.match(/ADD CONSTRAINT (\w+)/g) ?? []) {
      expect(sql).toContain(`DROP CONSTRAINT IF EXISTS ${stmt.split(' ')[2]}`);
    }
  });
});
