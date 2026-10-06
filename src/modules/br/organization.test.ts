import { describe, expect, it } from 'vitest';

import {
  EMPTY_ORGANIZATION,
  organizationDraftFromRow,
  organizationRowFromDraft,
  validateOrganization,
  type BrAccountProfileRow,
} from './organization';

const BR = { defaultCountry: 'BR' };

const draft = {
  ...EMPTY_ORGANIZATION,
  personType: 'PJ' as const,
  taxId: '11.222.333/0001-81',
  legalName: 'Padaria Pão Quente Ltda',
  tradeName: 'Pão Quente',
  phone: '(21) 3456-7890',
  email: 'Contato@PaoQuente.com.br ',
  postalCode: '20040-002',
  street: 'Rua da Assembleia',
  streetNumber: '10',
  district: 'Centro',
  city: 'Rio de Janeiro',
  state: 'RJ' as const,
};

describe('organization registration data', () => {
  it('stores CNPJ, phone (E.164), CEP without mask and e-mail lowercased', () => {
    expect(validateOrganization(draft, BR)).toEqual({});
    expect(organizationRowFromDraft(draft, BR)).toEqual({
      person_type: 'PJ',
      tax_id: '11222333000181',
      legal_name: 'Padaria Pão Quente Ltda',
      trade_name: 'Pão Quente',
      phone: '+552134567890',
      email: 'contato@paoquente.com.br',
      postal_code: '20040002',
      street: 'Rua da Assembleia',
      street_number: '10',
      complement: null,
      district: 'Centro',
      city: 'Rio de Janeiro',
      state: 'RJ',
    });
  });

  it('shows them masked again', () => {
    const row = {
      account_id: 'a',
      ...organizationRowFromDraft(draft, BR),
    } as BrAccountProfileRow;
    expect(organizationDraftFromRow(row)).toMatchObject({
      taxId: '11.222.333/0001-81',
      phone: '+55 (21) 3456-7890',
      postalCode: '20040-002',
    });
    expect(validateOrganization(organizationDraftFromRow(row), BR)).toEqual({});
  });

  it('validates every field', () => {
    expect(
      validateOrganization(
        {
          ...draft,
          taxId: '11.222.333/0001-82',
          phone: '99999-9999',
          email: 'not-an-email',
          postalCode: '2004',
          legalName: 'x'.repeat(201),
        },
        BR
      )
    ).toEqual({
      taxId: 'invalidCnpj',
      phone: 'missingAreaCode',
      email: 'invalidEmail',
      postalCode: 'invalidCep',
      legalName: 'tooLong',
    });
  });

  it('accepts an international phone and a CPF (pessoa física)', () => {
    const pf = {
      ...draft,
      personType: 'PF' as const,
      taxId: '529.982.247-25',
      phone: '+351 912 345 678',
    };
    expect(validateOrganization(pf, BR)).toEqual({});
    expect(organizationRowFromDraft(pf, BR)).toMatchObject({
      tax_id: '52998224725',
      phone: '+351912345678',
    });
  });

  it('an empty form stores nothing', () => {
    expect(
      Object.values(organizationRowFromDraft(EMPTY_ORGANIZATION, BR)).every(
        (v) => v === null
      )
    ).toBe(true);
  });
});
