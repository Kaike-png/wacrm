/**
 * Regional settings: UI language, formatting locale, time zone and
 * currency (fork, see docs/LOCALIZATION.md).
 *
 * Two levels:
 *   - **Deploy** (build-time env, this file): UI language catalogue and
 *     the fallbacks used before a tenant's settings load or when the
 *     fork migration has not been applied yet.
 *   - **Tenant** (`accounts.locale`, `accounts.timezone`,
 *     `accounts.default_currency`): how dates, numbers and money are
 *     shown and which clock automations use. Read through
 *     `tenant-locale.tsx` (browser) and `server.ts` (route handlers,
 *     automation engine).
 *
 * This file is the only reader of the regional env vars. Everything is
 * plain data so it works on the server, in the browser and in tests.
 */

/** UI catalogues shipped in `messages/<code>.json`. */
export const CATALOGUE_LOCALES = ['en', 'pt', 'es', 'ko'] as const;
export type CatalogueLocale = (typeof CATALOGUE_LOCALES)[number];

/** Deploy UI language when NEXT_PUBLIC_APP_LOCALE is unset. */
export const DEFAULT_APP_LOCALE = 'pt-BR';

/** Intl locale used for formatting when a catalogue is chosen without a region. */
const INTL_LOCALE_FOR: Record<CatalogueLocale, string> = {
  en: 'en-US',
  pt: 'pt-BR',
  es: 'es-419', // upstream es.json is Latin American Spanish
  ko: 'ko-KR',
};

export interface LocaleSettings {
  /** BCP 47 locale for Intl formatting, e.g. `pt-BR`. */
  locale: string;
  /** IANA time zone, e.g. `America/Sao_Paulo`. */
  timeZone: string;
  /** ISO 4217 code, e.g. `BRL`. */
  currency: string;
}

/**
 * Map any spelling of a locale (`pt`, `pt-BR`, `pt_BR`, `PT-br`) onto
 * the catalogue that serves it. Unknown → English, like upstream.
 */
export function catalogueLocale(
  raw: string | null | undefined
): CatalogueLocale {
  const lang = (raw ?? '').trim().toLowerCase().split(/[-_]/)[0];
  return (CATALOGUE_LOCALES as readonly string[]).includes(lang)
    ? (lang as CatalogueLocale)
    : 'en';
}

/** Canonical BCP 47 tag (`pt_br` → `pt-BR`), or null when Intl rejects it. */
export function normalizeLocale(raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim().replace(/_/g, '-');
  if (!value) return null;
  try {
    return Intl.getCanonicalLocales(value)[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * The Intl locale for a raw deploy/tenant value: keeps an explicit
 * region (`pt-PT`, `en-GB`), adds the default one otherwise (`pt` →
 * `pt-BR`).
 */
export function intlLocale(raw: string | null | undefined): string {
  const canonical = normalizeLocale(raw);
  if (canonical && canonical.includes('-')) return canonical;
  return INTL_LOCALE_FOR[catalogueLocale(canonical ?? DEFAULT_APP_LOCALE)];
}

export function isValidTimeZone(tz: string | null | undefined): tz is string {
  if (!tz || !tz.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz.trim() });
    return true;
  } catch {
    return false;
  }
}

export function isValidCurrency(
  code: string | null | undefined
): code is string {
  return !!code && /^[A-Z]{3}$/.test(code.trim());
}

export interface RegionalEnv {
  NEXT_PUBLIC_APP_LOCALE?: string;
  NEXT_PUBLIC_DEFAULT_TIMEZONE?: string;
  NEXT_PUBLIC_DEFAULT_CURRENCY?: string;
}

/** Deploy-level defaults. Pure (takes the env) so tests can exercise it. */
export function resolveRegionalDefaults(env: RegionalEnv): LocaleSettings {
  const appLocale = env.NEXT_PUBLIC_APP_LOCALE?.trim() || DEFAULT_APP_LOCALE;
  const tz = env.NEXT_PUBLIC_DEFAULT_TIMEZONE?.trim();
  const currency = env.NEXT_PUBLIC_DEFAULT_CURRENCY?.trim().toUpperCase();
  return {
    locale: intlLocale(appLocale),
    timeZone: isValidTimeZone(tz) ? tz : 'America/Sao_Paulo',
    // Portuguese deploys default to BRL; others keep upstream's USD.
    currency: isValidCurrency(currency)
      ? currency
      : catalogueLocale(appLocale) === 'pt'
        ? 'BRL'
        : 'USD',
  };
}

// Each NEXT_PUBLIC_* var is referenced literally so Next.js inlines it
// into the browser bundle.
export const APP_LOCALE_RAW =
  process.env.NEXT_PUBLIC_APP_LOCALE?.trim() || DEFAULT_APP_LOCALE;

export const regionalDefaults: LocaleSettings = resolveRegionalDefaults({
  NEXT_PUBLIC_APP_LOCALE: process.env.NEXT_PUBLIC_APP_LOCALE,
  NEXT_PUBLIC_DEFAULT_TIMEZONE: process.env.NEXT_PUBLIC_DEFAULT_TIMEZONE,
  NEXT_PUBLIC_DEFAULT_CURRENCY: process.env.NEXT_PUBLIC_DEFAULT_CURRENCY,
});

/** Merge raw tenant columns over the deploy defaults, dropping invalid values. */
export function resolveTenantSettings(
  row: {
    locale?: string | null;
    timezone?: string | null;
    default_currency?: string | null;
  } | null,
  defaults: LocaleSettings = regionalDefaults
): LocaleSettings {
  return {
    locale:
      row?.locale && normalizeLocale(row.locale)
        ? intlLocale(row.locale)
        : defaults.locale,
    timeZone: isValidTimeZone(row?.timezone)
      ? row!.timezone!.trim()
      : defaults.timeZone,
    currency: isValidCurrency(row?.default_currency)
      ? row!.default_currency!.trim()
      : defaults.currency,
  };
}

/**
 * Formatting locales offered in the tenant settings. The UI language is
 * per deploy; this only changes how dates and numbers look.
 */
export const FORMAT_LOCALES = [
  'pt-BR',
  'pt-PT',
  'en-US',
  'en-GB',
  'es-419',
  'es-ES',
  'es-MX',
  'es-AR',
  'ko-KR',
] as const;

/** Brazilian time zones first in the picker (IANA ids). */
export const BRAZIL_TIME_ZONES = [
  'America/Sao_Paulo',
  'America/Bahia',
  'America/Fortaleza',
  'America/Recife',
  'America/Maceio',
  'America/Belem',
  'America/Araguaina',
  'America/Santarem',
  'America/Manaus',
  'America/Cuiaba',
  'America/Campo_Grande',
  'America/Porto_Velho',
  'America/Boa_Vista',
  'America/Rio_Branco',
  'America/Eirunepe',
  'America/Noronha',
] as const;

/**
 * WhatsApp template language code (Meta's `pt_BR` style) that matches a
 * formatting locale: the default for new templates, so a Brazilian
 * account does not submit Portuguese copy tagged `en_US`.
 */
export function templateLanguageFor(locale: string): string {
  const canonical = normalizeLocale(locale) ?? DEFAULT_APP_LOCALE;
  const [lang, region] = canonical.split('-');
  const byLocale: Record<string, string> = {
    'pt-BR': 'pt_BR',
    'pt-PT': 'pt_PT',
    'en-US': 'en_US',
    'en-GB': 'en_GB',
    'es-ES': 'es_ES',
    'es-MX': 'es_MX',
    'es-AR': 'es_AR',
    'ko-KR': 'ko',
  };
  if (byLocale[canonical]) return byLocale[canonical];
  if (lang === 'pt') return 'pt_BR';
  if (lang === 'en') return 'en_US';
  return region && /^[A-Z]{2}$/.test(region) ? `${lang}_${region}` : lang;
}
