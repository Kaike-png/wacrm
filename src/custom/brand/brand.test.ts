import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';
import {
  BRAND_DEFAULTS,
  brand,
  brandAbsoluteUrl,
  brandInitial,
  escapeIcuLiteral,
  resolveBrand,
} from './config';
import { EMAIL_TEMPLATES, emailHtml, emailSubject } from './email-templates';

const ROOT = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mts)$/.test(name)) out.push(full);
  }
  return out;
}

const sources = walk(join(ROOT, 'src')).map((file) => ({
  rel: relative(ROOT, file).split('\\').join('/'),
  text: readFileSync(file, 'utf8'),
}));

describe('resolveBrand', () => {
  it('falls back to the product defaults', () => {
    expect(resolveBrand({})).toEqual(BRAND_DEFAULTS);
  });

  it('prefers NEXT_PUBLIC_APP_URL over the legacy NEXT_PUBLIC_SITE_URL', () => {
    expect(
      resolveBrand({
        NEXT_PUBLIC_APP_URL: 'https://app.example.com/',
        NEXT_PUBLIC_SITE_URL: 'https://old.example.com',
      }).url
    ).toBe('https://app.example.com');
    expect(
      resolveBrand({ NEXT_PUBLIC_SITE_URL: 'https://old.example.com//' }).url
    ).toBe('https://old.example.com');
  });

  it('trims values and ignores invalid mark styles and colours', () => {
    const b = resolveBrand({
      NEXT_PUBLIC_APP_NAME: '  Atende  ',
      NEXT_PUBLIC_SUPPORT_EMAIL: ' ajuda@example.com ',
      NEXT_PUBLIC_APP_MARK: 'banana',
      NEXT_PUBLIC_BRAND_COLOR: 'red',
    });
    expect(b.name).toBe('Atende');
    expect(b.supportEmail).toBe('ajuda@example.com');
    expect(b.markStyle).toBe(BRAND_DEFAULTS.markStyle);
    expect(b.colors.primary).toBe(BRAND_DEFAULTS.colors.primary);
    expect(
      resolveBrand({
        NEXT_PUBLIC_APP_MARK: 'initial',
        NEXT_PUBLIC_BRAND_COLOR: '#0a7',
      })
    ).toMatchObject({ markStyle: 'initial', colors: { primary: '#0a7' } });
  });

  it('derives the initial and absolute URLs', () => {
    expect(brandInitial({ ...BRAND_DEFAULTS, name: '  ölá crm' })).toBe('Ö');
    const b = { ...BRAND_DEFAULTS, url: 'https://x.io' };
    expect(brandAbsoluteUrl('/brand/logo.svg', b)).toBe(
      'https://x.io/brand/logo.svg'
    );
    expect(brandAbsoluteUrl('https://cdn.io/l.png', b)).toBe(
      'https://cdn.io/l.png'
    );
    expect(brandAbsoluteUrl('/l.svg', BRAND_DEFAULTS)).toBe('/l.svg');
  });
});

describe('escapeIcuLiteral', () => {
  it('lets next-intl render awkward brand names verbatim', () => {
    for (const name of ["Joe's CRM", 'CRM {beta}', 'Ca$h & Co', "'quoted'"]) {
      const t = createTranslator({
        locale: 'en',
        messages: { M: { m: `Welcome to ${escapeIcuLiteral(name)}, {who}` } },
      });
      expect(t('M.m' as never, { who: 'Ana' } as never)).toBe(
        `Welcome to ${name}, Ana`
      );
    }
  });
});

describe('brand configuration is centralised', () => {
  const BRAND_ENV =
    /process\.env\.(NEXT_PUBLIC_(APP_NAME|APP_DESCRIPTION|APP_URL|SITE_URL|SUPPORT_EMAIL|APP_LOGO_URL|APP_FAVICON_URL|APP_MARK|BRAND_COLOR))\b/;

  it('reads brand env vars only in src/custom/brand/config.ts', () => {
    const offenders = sources
      .filter(({ rel }) => rel !== 'src/custom/brand/config.ts')
      .filter(({ rel }) => !rel.endsWith('.test.ts'))
      .filter(({ text }) => BRAND_ENV.test(text))
      .map(({ rel }) => rel);
    expect(offenders).toEqual([]);
  });

  it('has no upstream product name in user-facing source strings', () => {
    // String/JSX-text occurrences of the upstream name. Technical
    // identifiers stay on purpose (docs/BRANDING.md → "O que NÃO muda"):
    // storage keys `wacrm.x` / `wacrm:x`, the API key prefix
    // `wacrm_live_`, `X-Wacrm-*` headers, `wacrm-test-notification`.
    const visible = /(['"`>][^'"`<\n]*)\bwacrm\b(?![_.:-])/i;
    const offenders: string[] = [];
    for (const { rel, text } of sources) {
      if (rel.endsWith('.test.ts') || rel.endsWith('.test.tsx')) continue;
      // Blank out block comments (incl. multi-line JSX `{/* … */}`),
      // keeping line numbers, then drop `// …` line comments.
      const code = text.replace(/\/\*[\s\S]*?\*\//g, (m) =>
        m.replace(/[^\n]/g, ' ')
      );
      code.split('\n').forEach((raw, i) => {
        const line = raw.replace(/(^|\s)\/\/.*$/, '').trim();
        if (visible.test(line)) offenders.push(`${rel}:${i + 1}: ${line}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});

describe('auth email templates', () => {
  it.each(EMAIL_TEMPLATES)(
    '%s is branded and keeps the Supabase link',
    (tpl) => {
      const html = emailHtml(tpl);
      expect(html).toContain(brand.name);
      expect(html).toContain('{{ .ConfirmationURL }}');
      expect(html).not.toMatch(/wacrm/i);
      expect(emailSubject(tpl)).toContain(brand.name);
    }
  );
});
