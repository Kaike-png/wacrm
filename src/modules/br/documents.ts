/**
 * CPF and CNPJ (fork, docs/BRAZILIAN_CONTACTS.md).
 *
 * Storage form: **no mask**. CPF = 11 digits. CNPJ = 14 characters,
 * uppercase: the first 12 may be letters or digits (alphanumeric CNPJ,
 * Receita Federal IN RFB 2.229/2024, issued since July 2026), the last
 * 2 are always the numeric check digits.
 *
 * Validation is the real check-digit algorithm (módulo 11), the same one
 * implemented in SQL by migration 901 (`br_is_valid_cpf` /
 * `br_is_valid_cnpj`), which the database enforces with a CHECK.
 */

export type PersonType = 'PF' | 'PJ';

const ALL_SAME = /^(.)\1+$/;

/** Strip the mask: `529.982.247-25` → `52998224725`. Keeps only digits. */
export function normalizeCpf(raw: string | null | undefined): string {
  return (raw ?? '').replace(/\D/g, '');
}

/**
 * Strip the mask and uppercase: `12.abc.345/01de-35` → `12ABC34501DE35`.
 * Keeps letters (alphanumeric CNPJ) and digits.
 */
export function normalizeCnpj(raw: string | null | undefined): string {
  return (raw ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');
}

/** Check digit for módulo 11 with the given weights over `values`. */
function mod11(values: number[], weights: number[]): number {
  const sum = values.reduce((acc, v, i) => acc + v * weights[i], 0);
  const rest = sum % 11;
  return rest < 2 ? 0 : 11 - rest;
}

export function isValidCpf(raw: string | null | undefined): boolean {
  // Reject anything that is not exactly a masked or bare CPF (letters, extra digits).
  if (!/^[\d.\-\s]*$/.test(raw ?? '')) return false;
  const cpf = normalizeCpf(raw);
  if (cpf.length !== 11 || ALL_SAME.test(cpf)) return false;
  const digits = [...cpf].map(Number);
  const d1 = mod11(digits.slice(0, 9), [10, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = mod11(digits.slice(0, 10), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  return d1 === digits[9] && d2 === digits[10];
}

const CNPJ_W1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const CNPJ_W2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

export function isValidCnpj(raw: string | null | undefined): boolean {
  if (!/^[0-9A-Za-z.\-/\s]*$/.test(raw ?? '')) return false;
  const cnpj = normalizeCnpj(raw);
  if (!/^[0-9A-Z]{12}\d{2}$/.test(cnpj) || ALL_SAME.test(cnpj)) return false;
  // Each character's value is its ASCII code minus 48: '0'..'9' → 0..9,
  // 'A' → 17 … 'Z' → 42. For an all-digit CNPJ this is the classic rule.
  const values = [...cnpj].map((c) => c.charCodeAt(0) - 48);
  const d1 = mod11(values.slice(0, 12), CNPJ_W1);
  const d2 = mod11(values.slice(0, 13), CNPJ_W2);
  return d1 === values[12] && d2 === values[13];
}

/** `52998224725` → `529.982.247-25`. Returns the input unchanged if it is not 11 digits. */
export function formatCpf(value: string | null | undefined): string {
  const cpf = normalizeCpf(value);
  if (cpf.length !== 11) return value ?? '';
  return `${cpf.slice(0, 3)}.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-${cpf.slice(9)}`;
}

/** `11222333000181` → `11.222.333/0001-81` (also alphanumeric). */
export function formatCnpj(value: string | null | undefined): string {
  const cnpj = normalizeCnpj(value);
  if (cnpj.length !== 14) return value ?? '';
  return `${cnpj.slice(0, 2)}.${cnpj.slice(2, 5)}.${cnpj.slice(5, 8)}/${cnpj.slice(8, 12)}-${cnpj.slice(12)}`;
}

export function formatTaxId(
  value: string | null | undefined,
  type: PersonType | null | undefined
): string {
  if (!value) return '';
  if (type === 'PF') return formatCpf(value);
  if (type === 'PJ') return formatCnpj(value);
  return value;
}

/** Progressive mask while typing a CPF: `5299822` → `529.982.2`. */
export function maskCpfInput(raw: string): string {
  const d = normalizeCpf(raw).slice(0, 11);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `${d.slice(0, 3)}.${d.slice(3)}`;
  if (d.length <= 9) return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6)}`;
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

/** Progressive mask while typing a CNPJ (letters allowed in the first 12). */
export function maskCnpjInput(raw: string): string {
  const c = normalizeCnpj(raw).slice(0, 14);
  const parts = [
    c.slice(0, 2),
    c.slice(2, 5),
    c.slice(5, 8),
    c.slice(8, 12),
    c.slice(12, 14),
  ];
  let out = parts[0];
  if (c.length > 2) out += `.${parts[1]}`;
  if (c.length > 5) out += `.${parts[2]}`;
  if (c.length > 8) out += `/${parts[3]}`;
  if (c.length > 12) out += `-${parts[4]}`;
  return out;
}

/** Storage form for a document of the given person type. */
export function normalizeTaxId(
  raw: string | null | undefined,
  type: PersonType
): string {
  return type === 'PF' ? normalizeCpf(raw) : normalizeCnpj(raw);
}

export function isValidTaxId(
  raw: string | null | undefined,
  type: PersonType
): boolean {
  return type === 'PF' ? isValidCpf(raw) : isValidCnpj(raw);
}
