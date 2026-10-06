/**
 * Fork i18n seam (core patch P-002, see docs/UPSTREAM_STRATEGY.md).
 *
 * Product / BR / billing / integration strings live in this layer's own
 * catalogues (`./messages/<locale>.json`) instead of `messages/*.json`,
 * which upstream edits in almost every release. The two core loaders
 * (`src/i18n/request.ts` for next-intl, `src/lib/i18n/translate.ts` for
 * server-side `getT`) pass their catalogue through `withCustomMessages`.
 *
 * Pipeline, applied once per (locale, base catalogue):
 *   0. Translation revisions (`./revisions/<locale>.json`): the fork's
 *      review of the upstream translation of a locale (today: pt-BR,
 *      see docs/LOCALIZATION.md). Only rewords existing core keys; each
 *      one is pinned to the upstream text it replaces
 *      (`./revisions/<locale>.base.json`), so when upstream rewrites a
 *      string the revision test fails and the new text gets reviewed.
 *   0b. Additions (`./additions/<locale>.json`): NEW keys inside a core
 *      namespace, for fork features that plug into a core list that
 *      looks its labels up by id (e.g. the settings rail renders
 *      `Settings.sections.<id>` for the fork's `organization` section).
 *      A key may only be added if core does not have it (merge.test.ts),
 *      so an upstream key with the same name fails CI for review.
 *   1. Brand overrides (`./overrides/<locale>.json`): a short, explicit
 *      list of CORE keys whose wording is the upstream product's
 *      identity ("CRM Template for WhatsApp"). Every key must exist in
 *      core and is pinned to the upstream English text it replaces
 *      (merge.test.ts), so an upstream rewording fails CI for review.
 *   2. Fork catalogues (`./messages/<locale>.json`): only the namespaces
 *      in `CUSTOM_NAMESPACES`; never core keys.
 *   3. Brand rewrite over every string: the upstream product name
 *      (`wacrm` as a word, not identifiers like `wacrm_live_`,
 *      `wacrm-mcp` or `wacrm.tech`) and the `%APP_NAME%` /
 *      `%APP_DESCRIPTION%` tokens become the configured brand (see
 *      src/custom/brand/config.ts), ICU-escaped.
 *
 * English is the fallback for fork keys and overrides, mirroring the
 * core rule. The base catalogue is never mutated (it is a cached module
 * object shared by every request).
 */
import { brand, escapeIcuLiteral } from '../brand/config';
import en from './messages/en.json';
import pt from './messages/pt.json';
import overridesEn from './overrides/en.json';
import overridesEs from './overrides/es.json';
import overridesKo from './overrides/ko.json';
import overridesPt from './overrides/pt.json';
import revisionsPt from './revisions/pt.json';
import additionsEn from './additions/en.json';
import additionsEs from './additions/es.json';
import additionsKo from './additions/ko.json';
import additionsPt from './additions/pt.json';

export type Catalogue = Record<string, unknown>;

/** Top-level namespaces reserved for fork-owned strings. */
export const CUSTOM_NAMESPACES = [
  'Custom',
  'Br',
  'Billing',
  'Integrations',
] as const;

const CUSTOM_CATALOGUES: Record<string, Catalogue> = { en, pt };

export const BRAND_OVERRIDES: Record<string, Catalogue> = {
  en: overridesEn,
  pt: overridesPt,
  es: overridesEs,
  ko: overridesKo,
};

/** New keys in core namespaces, per catalogue locale (step 0b). */
export const CORE_ADDITIONS: Record<string, Catalogue> = {
  en: additionsEn,
  pt: additionsPt,
  es: additionsEs,
  ko: additionsKo,
};

/** Reviewed translations of core keys, per catalogue locale (step 0). */
export const TRANSLATION_REVISIONS: Record<string, Catalogue> = {
  pt: revisionsPt,
};

/** The upstream product name as a word (see header, step 3). */
export const UPSTREAM_BRAND_PATTERN = /\bwacrm\b(?![_-]|\.[a-z])/gi;

function isPlainObject(value: unknown): value is Catalogue {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Recursive merge; `override` wins on leaves. Inputs are not mutated. */
export function deepMerge(base: Catalogue, override: Catalogue): Catalogue {
  const out: Catalogue = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = out[key];
    out[key] =
      isPlainObject(current) && isPlainObject(value)
        ? deepMerge(current, value)
        : value;
  }
  return out;
}

function withEnglishFallback(
  catalogues: Record<string, Catalogue>,
  locale: string
): Catalogue {
  const localized = catalogues[locale];
  if (!localized || locale === 'en') return catalogues.en;
  return deepMerge(catalogues.en, localized);
}

/** Custom catalogue for `locale`, with English as the per-key fallback. */
export function customCatalogue(locale: string): Catalogue {
  return withEnglishFallback(CUSTOM_CATALOGUES, locale);
}

/** Brand overrides for `locale`, with English as the per-key fallback. */
export function brandOverrides(locale: string): Catalogue {
  return withEnglishFallback(BRAND_OVERRIDES, locale);
}

function mapStrings(node: unknown, fn: (s: string) => string): unknown {
  if (typeof node === 'string') return fn(node);
  if (!isPlainObject(node)) return node;
  const out: Catalogue = {};
  for (const [k, v] of Object.entries(node)) out[k] = mapStrings(v, fn);
  return out;
}

function brandDescription(custom: Catalogue): string {
  if (brand.description) return brand.description;
  const fromCatalogue = (custom.Custom as { brand?: { description?: unknown } })
    ?.brand?.description;
  return typeof fromCatalogue === 'string' ? fromCatalogue : brand.name;
}

const cache = new Map<string, WeakMap<object, Catalogue>>();

/** Layer the fork's overrides, catalogue and brand onto a core catalogue. */
export function withCustomMessages<T extends Catalogue>(
  locale: string,
  base: T
): T {
  let perLocale = cache.get(locale);
  const hit = perLocale?.get(base);
  if (hit) return hit as T;

  const custom = customCatalogue(locale);
  const name = escapeIcuLiteral(brand.name);
  const description = escapeIcuLiteral(brandDescription(custom));

  const revised = TRANSLATION_REVISIONS[locale]
    ? deepMerge(base, TRANSLATION_REVISIONS[locale])
    : base;
  const added = deepMerge(revised, withEnglishFallback(CORE_ADDITIONS, locale));
  const merged = deepMerge(deepMerge(added, brandOverrides(locale)), custom);
  // Replacer functions, not strings: a `$` in the brand must stay literal.
  const branded = mapStrings(merged, (s) =>
    s
      .replace(UPSTREAM_BRAND_PATTERN, () => name)
      .replace(/%APP_NAME%/g, () => name)
      .replace(/%APP_DESCRIPTION%/g, () => description)
  ) as T;

  if (!perLocale) cache.set(locale, (perLocale = new WeakMap()));
  perLocale.set(base, branded);
  return branded;
}
