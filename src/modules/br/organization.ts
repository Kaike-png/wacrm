/**
 * Registration data of the organization (= the tenant `accounts` row)
 * (fork, docs/TENANCY.md).
 *
 *   accounts                 name, default_currency, locale (idioma),
 *                            timezone, status — read here, written by
 *                            their own screens / billing
 *   br_account_profiles      razão social, nome fantasia, CPF/CNPJ,
 *   (migration 902)          telefone, e-mail, endereço
 *
 * Pure: draft ↔ row and validation, shared by the settings screen and tests.
 */
import {
  formatCep,
  isUf,
  isValidCepFormat,
  normalizeCep,
  type Uf,
} from './address';
import {
  formatCnpj,
  formatCpf,
  isValidTaxId,
  normalizeTaxId,
  type PersonType,
} from './documents';
import {
  formatPhoneDisplay,
  normalizePhoneInput,
  type PhoneInputError,
} from './phone';

export const BR_ACCOUNT_PROFILE_TABLE = 'br_account_profiles';

export interface BrAccountProfileRow {
  account_id: string;
  person_type: PersonType | null;
  tax_id: string | null;
  legal_name: string | null;
  trade_name: string | null;
  /** E.164 (`+5521999999999`). */
  phone: string | null;
  email: string | null;
  postal_code: string | null;
  street: string | null;
  street_number: string | null;
  complement: string | null;
  district: string | null;
  city: string | null;
  state: Uf | null;
}

export interface OrganizationDraft {
  personType: PersonType | '';
  taxId: string;
  legalName: string;
  tradeName: string;
  phone: string;
  email: string;
  postalCode: string;
  street: string;
  streetNumber: string;
  complement: string;
  district: string;
  city: string;
  state: Uf | '';
}

export const EMPTY_ORGANIZATION: OrganizationDraft = {
  personType: '',
  taxId: '',
  legalName: '',
  tradeName: '',
  phone: '',
  email: '',
  postalCode: '',
  street: '',
  streetNumber: '',
  complement: '',
  district: '',
  city: '',
  state: '',
};

/** Mirrors the CHECK constraints of migration 902. */
export const ORGANIZATION_LIMITS = {
  legalName: 200,
  tradeName: 200,
  street: 200,
  streetNumber: 20,
  complement: 100,
  district: 100,
  city: 100,
  email: 254,
} as const;

export type OrganizationError =
  | 'invalidCpf'
  | 'invalidCnpj'
  | 'invalidCep'
  | 'invalidState'
  | 'invalidEmail'
  | 'tooLong'
  | PhoneInputError;

export type OrganizationErrors = Partial<
  Record<keyof OrganizationDraft, OrganizationError>
>;

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function organizationDraftFromRow(
  row: BrAccountProfileRow | null
): OrganizationDraft {
  if (!row) return { ...EMPTY_ORGANIZATION };
  return {
    personType: row.person_type ?? '',
    taxId:
      row.person_type === 'PF'
        ? formatCpf(row.tax_id)
        : row.person_type === 'PJ'
          ? formatCnpj(row.tax_id)
          : (row.tax_id ?? ''),
    legalName: row.legal_name ?? '',
    tradeName: row.trade_name ?? '',
    phone: row.phone ? formatPhoneDisplay(row.phone) : '',
    email: row.email ?? '',
    postalCode: formatCep(row.postal_code),
    street: row.street ?? '',
    streetNumber: row.street_number ?? '',
    complement: row.complement ?? '',
    district: row.district ?? '',
    city: row.city ?? '',
    state: isUf(row.state) ? (row.state.toUpperCase() as Uf) : '',
  };
}

export function validateOrganization(
  draft: OrganizationDraft,
  { defaultCountry }: { defaultCountry?: string | null } = {}
): OrganizationErrors {
  const errors: OrganizationErrors = {};
  if (
    draft.personType &&
    draft.taxId.trim() &&
    !isValidTaxId(draft.taxId, draft.personType)
  ) {
    errors.taxId = draft.personType === 'PF' ? 'invalidCpf' : 'invalidCnpj';
  }
  if (draft.phone.trim()) {
    const phone = normalizePhoneInput(
      draft.phone,
      defaultCountry === undefined ? {} : { defaultCountry }
    );
    if (!phone.ok) errors.phone = phone.error;
  }
  if (draft.email.trim() && !EMAIL.test(draft.email.trim()))
    errors.email = 'invalidEmail';
  if (draft.postalCode.trim() && !isValidCepFormat(draft.postalCode))
    errors.postalCode = 'invalidCep';
  if (draft.state && !isUf(draft.state)) errors.state = 'invalidState';
  for (const [key, max] of Object.entries(ORGANIZATION_LIMITS)) {
    const k = key as keyof OrganizationDraft;
    if (!errors[k] && draft[k].trim().length > max) errors[k] = 'tooLong';
  }
  return errors;
}

const orNull = (s: string) => (s.trim() ? s.trim() : null);

/** Columns to write (call after `validateOrganization` returned no errors). */
export function organizationRowFromDraft(
  draft: OrganizationDraft,
  { defaultCountry }: { defaultCountry?: string | null } = {}
): Omit<BrAccountProfileRow, 'account_id'> {
  const type = draft.personType || null;
  const phone = draft.phone.trim()
    ? normalizePhoneInput(
        draft.phone,
        defaultCountry === undefined ? {} : { defaultCountry }
      )
    : null;
  return {
    person_type: type,
    tax_id:
      type && draft.taxId.trim() ? normalizeTaxId(draft.taxId, type) : null,
    legal_name: orNull(draft.legalName),
    trade_name: orNull(draft.tradeName),
    phone: phone && phone.ok ? phone.e164 : null,
    email: orNull(draft.email)?.toLowerCase() ?? null,
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
