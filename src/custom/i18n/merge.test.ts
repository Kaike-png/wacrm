import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';
import { brand } from '../brand/config';
import {
  CORE_ADDITIONS,
  CUSTOM_NAMESPACES,
  TRANSLATION_REVISIONS,
  UPSTREAM_BRAND_PATTERN,
  brandOverrides,
  customCatalogue,
  deepMerge,
  withCustomMessages,
} from './merge';

const CUSTOM_DIR = join(process.cwd(), 'src', 'custom', 'i18n', 'messages');
const CORE_DIR = join(process.cwd(), 'messages');

type Catalogue = Record<string, unknown>;

function read(dir: string, locale: string): Catalogue {
  return JSON.parse(readFileSync(join(dir, `${locale}.json`), 'utf8'));
}

function leaves(node: unknown, path = '', out = new Set<string>()) {
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    for (const [k, v] of Object.entries(node)) {
      leaves(v, path ? `${path}.${k}` : k, out);
    }
  } else {
    out.add(path);
  }
  return out;
}

const customLocales = readdirSync(CUSTOM_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/, ''));

describe('deepMerge', () => {
  it('merges nested objects with override winning on leaves', () => {
    const base = { A: { x: '1', y: '2' }, B: 'b' };
    const merged = deepMerge(base, { A: { y: '3', z: '4' }, C: 'c' });
    expect(merged).toEqual({ A: { x: '1', y: '3', z: '4' }, B: 'b', C: 'c' });
  });

  it('does not mutate its inputs', () => {
    const base = { A: { x: '1' } };
    const override = { A: { y: '2' } };
    deepMerge(base, override);
    expect(base).toEqual({ A: { x: '1' } });
    expect(override).toEqual({ A: { y: '2' } });
  });
});

function leafMap(node: unknown, path = '', out = new Map<string, unknown>()) {
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    for (const [k, v] of Object.entries(node)) {
      leafMap(v, path ? `${path}.${k}` : k, out);
    }
  } else {
    out.set(path, node);
  }
  return out;
}

const LOCALES = ['en', 'pt', 'es', 'ko'];
const OVERRIDES_DIR = join(process.cwd(), 'src', 'custom', 'i18n', 'overrides');

/**
 * Upstream English text of every overridden core key, at the time the
 * override was written. If upstream rewords one of these keys this test
 * fails: re-read the new upstream text and update the override + this
 * baseline together (docs/BRANDING.md → "Merges do upstream").
 */
const OVERRIDE_BASELINE_EN: Record<string, string> = {
  'Sidebar.title': 'CRM Template for WhatsApp',
  'SignupPage.desc': 'Get started with CRM Template for WhatsApp',
  'Metadata.description': 'Self-hostable CRM template for WhatsApp.',
  // P-004: the deals panel also hosts the regional settings card.
  'Settings.sections.deals': 'Deals & currency',
  'Settings.deals.title': 'Deals & currency',
  'Settings.deals.description':
    'The currency used for new deals and for pipeline and dashboard totals.',
};

describe('withCustomMessages', () => {
  it('only changes core keys that are overridden, revised or carry the upstream brand', () => {
    for (const locale of LOCALES) {
      const core = read(CORE_DIR, locale);
      const merged = leafMap(withCustomMessages(locale, core));
      const overridden = new Set(leafMap(brandOverrides(locale)).keys());
      const revised = leafMap(TRANSLATION_REVISIONS[locale] ?? {});
      for (const [key, value] of leafMap(core)) {
        if (overridden.has(key)) continue;
        const source = revised.has(key) ? revised.get(key) : value;
        const expected =
          typeof source === 'string'
            ? source.replace(UPSTREAM_BRAND_PATTERN, () => brand.name)
            : source;
        expect(merged.get(key), `${locale}:${key}`).toEqual(expected);
      }
    }
  });

  it('leaves no upstream product name in any locale', () => {
    const upstreamPhrases =
      /\bwacrm\b(?![_-]|\.[a-z])|CRM Template|Modelo de CRM|Plantilla de CRM|CRM 템플릿/i;
    for (const locale of LOCALES) {
      const merged = withCustomMessages(locale, read(CORE_DIR, locale));
      const hits = [...leafMap(merged)]
        .filter(([, v]) => typeof v === 'string' && upstreamPhrases.test(v))
        .map(([k]) => `${locale}:${k}`);
      expect(hits).toEqual([]);
    }
  });

  it('produces messages next-intl can format in every locale', () => {
    for (const locale of LOCALES) {
      const messages = withCustomMessages(locale, read(CORE_DIR, locale));
      const t = createTranslator({ locale, messages });
      expect(t('Sidebar.title' as never)).toBe(brand.name);
      expect(String(t('SignupPage.desc' as never))).toContain(brand.name);
    }
  });

  it('is cached per (locale, base) and does not mutate the base', () => {
    const core = read(CORE_DIR, 'pt');
    const snapshot = JSON.stringify(core);
    expect(withCustomMessages('pt', core)).toBe(withCustomMessages('pt', core));
    expect(JSON.stringify(core)).toBe(snapshot);
  });

  it('falls back to the English custom catalogue for other locales', () => {
    expect(customCatalogue('xx')).toEqual(customCatalogue('en'));
  });
});

describe('brand overrides', () => {
  it('only target existing core keys, in every locale', () => {
    for (const locale of LOCALES) {
      const core = leafMap(read(CORE_DIR, locale));
      const missing = [...leafMap(read(OVERRIDES_DIR, locale)).keys()].filter(
        (k) => !core.has(k)
      );
      expect(missing, locale).toEqual([]);
    }
  });

  it('cover the same keys in every locale, all pinned to a baseline', () => {
    const en = [...leafMap(read(OVERRIDES_DIR, 'en')).keys()].sort();
    expect(en).toEqual(Object.keys(OVERRIDE_BASELINE_EN).sort());
    for (const locale of LOCALES) {
      expect([...leafMap(read(OVERRIDES_DIR, locale)).keys()].sort()).toEqual(
        en
      );
    }
  });

  it('still match the upstream English text they replace', () => {
    const core = leafMap(read(CORE_DIR, 'en'));
    for (const [key, text] of Object.entries(OVERRIDE_BASELINE_EN)) {
      expect(core.get(key), key).toBe(text);
    }
  });
});

describe('custom catalogues', () => {
  it('ship an English source catalogue', () => {
    expect(customLocales).toContain('en');
  });

  it('only use fork-reserved top-level namespaces', () => {
    for (const locale of customLocales) {
      const bad = Object.keys(read(CUSTOM_DIR, locale)).filter(
        (ns) => !(CUSTOM_NAMESPACES as readonly string[]).includes(ns)
      );
      expect(bad, `${locale}.json`).toEqual([]);
    }
  });

  it('never collide with core namespaces', () => {
    const core = Object.keys(read(CORE_DIR, 'en'));
    const clash = CUSTOM_NAMESPACES.filter((ns) => core.includes(ns));
    expect(clash).toEqual([]);
  });

  it('keep key parity with English (pt is the product language)', () => {
    const source = leaves(read(CUSTOM_DIR, 'en'));
    const pt = leaves(read(CUSTOM_DIR, 'pt'));
    expect([...source].filter((k) => k && !pt.has(k))).toEqual([]);
    expect([...pt].filter((k) => k && !source.has(k))).toEqual([]);
  });
});

describe('core additions', () => {
  const ADDITIONS_DIR = join(
    process.cwd(),
    'src',
    'custom',
    'i18n',
    'additions'
  );

  it('only add keys that core does not have, in every locale', () => {
    for (const locale of LOCALES) {
      const core = leafMap(read(CORE_DIR, locale));
      const clash = [...leafMap(read(ADDITIONS_DIR, locale)).keys()].filter(
        (k) => core.has(k)
      );
      expect(clash, locale).toEqual([]);
    }
  });

  it('cover the same keys in every locale and reach the merged catalogue', () => {
    const en = [...leafMap(CORE_ADDITIONS.en).keys()].sort();
    for (const locale of LOCALES) {
      expect(
        [...leafMap(read(ADDITIONS_DIR, locale)).keys()].sort(),
        locale
      ).toEqual(en);
      const merged = leafMap(
        withCustomMessages(locale, read(CORE_DIR, locale))
      );
      for (const key of en)
        expect(typeof merged.get(key), `${locale}:${key}`).toBe('string');
    }
  });
});
