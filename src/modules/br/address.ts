/**
 * Brazilian addresses and CEP (fork, docs/BRAZILIAN_CONTACTS.md).
 *
 * CEP is stored as 8 digits (`01310100`), shown as `01310-100`. The
 * lookup is a **seam only** in this stage: `CepLookupProvider` is the
 * contract a future integration (ViaCEP, BrasilAPI, Correios…) will
 * implement under `src/integrations/`, registered with
 * `registerCepLookupProvider`. With no provider registered the UI shows
 * no "buscar" button and nothing leaves the browser.
 */

/** The 27 federative units (26 states + DF). */
export const BRAZIL_UFS = [
  'AC',
  'AL',
  'AP',
  'AM',
  'BA',
  'CE',
  'DF',
  'ES',
  'GO',
  'MA',
  'MT',
  'MS',
  'MG',
  'PA',
  'PB',
  'PR',
  'PE',
  'PI',
  'RJ',
  'RN',
  'RS',
  'RO',
  'RR',
  'SC',
  'SP',
  'SE',
  'TO',
] as const;
export type Uf = (typeof BRAZIL_UFS)[number];

export function isUf(value: string | null | undefined): value is Uf {
  return (BRAZIL_UFS as readonly string[]).includes(
    (value ?? '').toUpperCase()
  );
}

export function normalizeCep(raw: string | null | undefined): string {
  return (raw ?? '').replace(/\D/g, '');
}

/** Format only — a CEP's existence can only be checked by a lookup. */
export function isValidCepFormat(raw: string | null | undefined): boolean {
  return /^\d{8}$/.test(normalizeCep(raw)) && normalizeCep(raw) !== '00000000';
}

/** `01310100` → `01310-100`; other input unchanged. */
export function formatCep(value: string | null | undefined): string {
  const cep = normalizeCep(value);
  return cep.length === 8
    ? `${cep.slice(0, 5)}-${cep.slice(5)}`
    : (value ?? '');
}

/** Progressive mask while typing: `013101` → `01310-1`. */
export function maskCepInput(raw: string): string {
  const d = normalizeCep(raw).slice(0, 8);
  return d.length <= 5 ? d : `${d.slice(0, 5)}-${d.slice(5)}`;
}

export interface BrazilianAddress {
  /** 8 digits. */
  postalCode: string;
  street: string;
  number: string;
  complement: string;
  district: string;
  city: string;
  state: Uf | '';
}

/** What a CEP lookup can fill in (number/complement never come from a CEP). */
export type CepLookupResult = Partial<
  Pick<
    BrazilianAddress,
    'street' | 'district' | 'city' | 'state' | 'complement'
  >
>;

export interface CepLookupProvider {
  /** Short id for logs, e.g. `viacep`. */
  readonly id: string;
  /** `cep` is 8 digits. Resolve `null` when the CEP does not exist. */
  lookup(cep: string, signal?: AbortSignal): Promise<CepLookupResult | null>;
}

let provider: CepLookupProvider | null = null;

/** Called once by an integration module at startup. `null` unregisters. */
export function registerCepLookupProvider(
  next: CepLookupProvider | null
): void {
  provider = next;
}

export function getCepLookupProvider(): CepLookupProvider | null {
  return provider;
}
