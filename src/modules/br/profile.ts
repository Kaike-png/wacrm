/**
 * Brazilian registration data of a contact (fork, docs/BRAZILIAN_CONTACTS.md).
 *
 * Table `br_contact_profiles` (migration 901), 1:1 with `contacts`.
 * What already exists in `contacts` is **not** duplicated:
 *
 *   | Dado                 | Onde                                   |
 *   |----------------------|----------------------------------------|
 *   | nome                 | contacts.name                          |
 *   | telefone             | contacts.phone (E.164)                 |
 *   | e-mail               | contacts.email                         |
 *   | nome fantasia (PJ)   | contacts.company                       |
 *   | tipo, CPF/CNPJ       | br_contact_profiles.person_type/tax_id |
 *   | razão social (PJ)    | br_contact_profiles.legal_name         |
 *   | endereço             | br_contact_profiles.postal_code…state  |
 *
 * Pure: the draft ↔ row mapping and validation, shared by the UI hook
 * and tests.
 */
import {
  formatCnpj,
  formatCpf,
  isValidTaxId,
  normalizeTaxId,
  type PersonType,
} from './documents';
import {
  formatCep,
  isUf,
  isValidCepFormat,
  normalizeCep,
  type Uf,
} from './address';

export const BR_PROFILE_TABLE = 'br_contact_profiles';

/** Row as stored (migration 901). */
export interface BrContactProfileRow {
  contact_id: string;
  account_id: string;
  person_type: PersonType | null;
  /** CPF (11 digits) or CNPJ (14, alphanumeric), no mask. */
  tax_id: string | null;
  legal_name: string | null;
  postal_code: string | null;
  street: string | null;
  street_number: string | null;
  complement: string | null;
  district: string | null;
  city: string | null;
  state: Uf | null;
  created_at?: string;
  updated_at?: string;
}

/** Editable form state: strings as shown (masked). */
export interface BrProfileDraft {
  personType: PersonType | '';
  taxId: string;
  legalName: string;
  postalCode: string;
  street: string;
  streetNumber: string;
  complement: string;
  district: string;
  city: string;
  state: Uf | '';
}

export const EMPTY_BR_PROFILE: BrProfileDraft = {
  personType: '',
  taxId: '',
  legalName: '',
  postalCode: '',
  street: '',
  streetNumber: '',
  complement: '',
  district: '',
  city: '',
  state: '',
};

/** Maximum lengths, mirrored by CHECK constraints in migration 901. */
export const BR_PROFILE_LIMITS = {
  legalName: 200,
  street: 200,
  streetNumber: 20,
  complement: 100,
  district: 100,
  city: 100,
} as const;

export type BrProfileError =
  'invalidCpf' | 'invalidCnpj' | 'invalidCep' | 'invalidState' | 'tooLong';

export type BrProfileErrors = Partial<
  Record<keyof BrProfileDraft, BrProfileError>
>;

export function draftFromRow(row: BrContactProfileRow | null): BrProfileDraft {
  if (!row) return { ...EMPTY_BR_PROFILE };
  return {
    personType: row.person_type ?? '',
    taxId:
      row.person_type === 'PF'
        ? formatCpf(row.tax_id)
        : row.person_type === 'PJ'
          ? formatCnpj(row.tax_id)
          : (row.tax_id ?? ''),
    legalName: row.legal_name ?? '',
    postalCode: formatCep(row.postal_code),
    street: row.street ?? '',
    streetNumber: row.street_number ?? '',
    complement: row.complement ?? '',
    district: row.district ?? '',
    city: row.city ?? '',
    state: isUf(row.state) ? (row.state.toUpperCase() as Uf) : '',
  };
}

export function validateBrProfile(draft: BrProfileDraft): BrProfileErrors {
  const errors: BrProfileErrors = {};
  if (draft.personType && draft.taxId.trim()) {
    if (!isValidTaxId(draft.taxId, draft.personType)) {
      errors.taxId = draft.personType === 'PF' ? 'invalidCpf' : 'invalidCnpj';
    }
  }
  if (draft.postalCode.trim() && !isValidCepFormat(draft.postalCode)) {
    errors.postalCode = 'invalidCep';
  }
  if (draft.state && !isUf(draft.state)) errors.state = 'invalidState';
  for (const [key, max] of Object.entries(BR_PROFILE_LIMITS)) {
    const value = draft[key as keyof BrProfileDraft];
    if (value.trim().length > max)
      errors[key as keyof BrProfileDraft] = 'tooLong';
  }
  return errors;
}

const orNull = (s: string) => (s.trim() ? s.trim() : null);

/**
 * Columns to write. The document is dropped when no person type is
 * chosen (there is no way to know CPF from CNPJ otherwise), and the
 * razão social only applies to PJ.
 */
export function rowFromDraft(
  draft: BrProfileDraft
): Omit<BrContactProfileRow, 'contact_id' | 'account_id'> {
  const type = draft.personType || null;
  const taxId =
    type && draft.taxId.trim() ? normalizeTaxId(draft.taxId, type) : null;
  return {
    person_type: type,
    tax_id: taxId,
    legal_name: type === 'PJ' ? orNull(draft.legalName) : null,
    postal_code: draft.postalCode.trim()
      ? normalizeCep(draft.postalCode)
      : null,
    street: orNull(draft.street),
    street_number: orNull(draft.streetNumber),
    complement: orNull(draft.complement),
    district: orNull(draft.district),
    city: orNull(draft.city),
    state: draft.state || null,
  };
}

/** True when there is nothing to store (the row can be deleted). */
export function isEmptyBrProfile(
  row: Omit<BrContactProfileRow, 'contact_id' | 'account_id'>
): boolean {
  return Object.values(row).every((v) => v === null);
}
