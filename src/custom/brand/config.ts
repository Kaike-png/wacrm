/**
 * Brand configuration: the single source of truth for product identity.
 *
 * This is the ONLY file that reads brand env vars. Everything else
 * (layout metadata, favicon, sidebar, public pages, auth email
 * templates, i18n rewrites) imports `brand` from here. Enforced by
 * `src/custom/brand/brand.test.ts`.
 *
 * Resolution order per field: env var → `BRAND_DEFAULTS` below.
 * To rebrand a deployment, set the env vars; to change the product's
 * own defaults, edit `BRAND_DEFAULTS`. See docs/BRANDING.md.
 *
 * NEXT_PUBLIC_* values are inlined at BUILD time (client and server):
 * changing them requires a rebuild. Each var must be read with a
 * literal `process.env.NEXT_PUBLIC_X` expression or Next won't inline it.
 */

export type BrandMarkStyle = 'glyph' | 'initial';

export interface BrandConfig {
  /** Product name: browser title, sidebar, public pages, emails. */
  name: string;
  /**
   * Explicit description. When empty, the localized default
   * `Custom.brand.description` from src/custom/i18n is used.
   */
  description: string;
  /** Canonical public origin, no trailing slash. Empty = not configured. */
  url: string;
  /** Support address shown on public pages and in emails. Empty = hidden. */
  supportEmail: string;
  /** Logo image (path under /public or absolute URL). Empty = generated mark. */
  logoUrl: string;
  /** Favicon image (path under /public or absolute URL). Empty = generated mark. */
  faviconUrl: string;
  /** Generated mark: chat glyph or the first letter of `name`. */
  markStyle: BrandMarkStyle;
  /** Brand colours used where CSS theme tokens are unavailable (favicon, emails). */
  colors: { primary: string; onPrimary: string };
}

/** Product defaults. Neutral on purpose until the final identity exists. */
export const BRAND_DEFAULTS: BrandConfig = {
  name: 'CRM',
  description: '',
  url: '',
  supportEmail: '',
  logoUrl: '',
  faviconUrl: '',
  markStyle: 'glyph',
  // Matches the default theme's --primary (src/lib/themes.ts, "violet").
  colors: { primary: '#7c3aed', onPrimary: '#ffffff' },
};

function clean(value: string | undefined): string {
  return (value ?? '').trim();
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function isHexColor(value: string): boolean {
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value);
}

export interface BrandEnv {
  NEXT_PUBLIC_APP_NAME?: string;
  NEXT_PUBLIC_APP_DESCRIPTION?: string;
  NEXT_PUBLIC_APP_URL?: string;
  /** Legacy upstream name for the same value; used when APP_URL is unset. */
  NEXT_PUBLIC_SITE_URL?: string;
  NEXT_PUBLIC_SUPPORT_EMAIL?: string;
  NEXT_PUBLIC_APP_LOGO_URL?: string;
  NEXT_PUBLIC_APP_FAVICON_URL?: string;
  NEXT_PUBLIC_APP_MARK?: string;
  NEXT_PUBLIC_BRAND_COLOR?: string;
}

/** Pure resolver (exported for tests). */
export function resolveBrand(
  env: BrandEnv,
  defaults: BrandConfig = BRAND_DEFAULTS
): BrandConfig {
  const mark = clean(env.NEXT_PUBLIC_APP_MARK);
  const color = clean(env.NEXT_PUBLIC_BRAND_COLOR);
  return {
    name: clean(env.NEXT_PUBLIC_APP_NAME) || defaults.name,
    description: clean(env.NEXT_PUBLIC_APP_DESCRIPTION) || defaults.description,
    url: stripTrailingSlash(
      clean(env.NEXT_PUBLIC_APP_URL) ||
        clean(env.NEXT_PUBLIC_SITE_URL) ||
        defaults.url
    ),
    supportEmail: clean(env.NEXT_PUBLIC_SUPPORT_EMAIL) || defaults.supportEmail,
    logoUrl: clean(env.NEXT_PUBLIC_APP_LOGO_URL) || defaults.logoUrl,
    faviconUrl: clean(env.NEXT_PUBLIC_APP_FAVICON_URL) || defaults.faviconUrl,
    markStyle:
      mark === 'glyph' || mark === 'initial' ? mark : defaults.markStyle,
    colors: {
      primary: isHexColor(color) ? color : defaults.colors.primary,
      onPrimary: defaults.colors.onPrimary,
    },
  };
}

export const brand: BrandConfig = resolveBrand({
  NEXT_PUBLIC_APP_NAME: process.env.NEXT_PUBLIC_APP_NAME,
  NEXT_PUBLIC_APP_DESCRIPTION: process.env.NEXT_PUBLIC_APP_DESCRIPTION,
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
  NEXT_PUBLIC_SUPPORT_EMAIL: process.env.NEXT_PUBLIC_SUPPORT_EMAIL,
  NEXT_PUBLIC_APP_LOGO_URL: process.env.NEXT_PUBLIC_APP_LOGO_URL,
  NEXT_PUBLIC_APP_FAVICON_URL: process.env.NEXT_PUBLIC_APP_FAVICON_URL,
  NEXT_PUBLIC_APP_MARK: process.env.NEXT_PUBLIC_APP_MARK,
  NEXT_PUBLIC_BRAND_COLOR: process.env.NEXT_PUBLIC_BRAND_COLOR,
});

/** Letter used by the 'initial' mark. */
export function brandInitial(config: BrandConfig = brand): string {
  return (config.name.match(/[\p{L}\p{N}]/u)?.[0] ?? '?').toUpperCase();
}

/** Absolute URL for a path on this deployment, or the path itself if no URL is configured. */
export function brandAbsoluteUrl(path: string, config: BrandConfig = brand) {
  if (/^https?:\/\//i.test(path)) return path;
  return config.url
    ? `${config.url}${path.startsWith('/') ? '' : '/'}${path}`
    : path;
}

/**
 * Make a literal safe for insertion into an ICU message (next-intl).
 * Only braces are quoted: next-intl uses ICU's "optional apostrophe"
 * mode, where a lone `'` (as in "Joe's CRM") is already literal, and
 * doubling it would print `''` in strings read with `t.raw()`.
 */
export function escapeIcuLiteral(value: string): string {
  return value.replace(/[{}]/g, (m) => `'${m}'`);
}
