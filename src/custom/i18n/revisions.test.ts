/**
 * Guards for the fork's translation revisions (src/custom/i18n/revisions,
 * docs/LOCALIZATION.md) and the PT-BR glossary.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';
import {
  parse,
  TYPE,
  type MessageFormatElement,
} from '@formatjs/icu-messageformat-parser';
import {
  BRAND_OVERRIDES,
  TRANSLATION_REVISIONS,
  withCustomMessages,
} from './merge';

type Catalogue = Record<string, unknown>;

const ROOT = process.cwd();
const read = (...p: string[]): Catalogue =>
  JSON.parse(readFileSync(join(ROOT, ...p), 'utf8'));

function flatten(
  node: unknown,
  prefix = '',
  out: Record<string, unknown> = {}
) {
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    for (const [k, v] of Object.entries(node))
      flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else {
    out[prefix] = node;
  }
  return out;
}

/** Argument names (+ type) and tag names an ICU message uses, or null if it does not parse. */
function skeleton(message: string): string[] | null {
  let ast: MessageFormatElement[];
  try {
    ast = parse(message, { ignoreTag: false });
  } catch {
    return null;
  }
  const out = new Set<string>();
  const walk = (els: MessageFormatElement[]) => {
    for (const el of els) {
      switch (el.type) {
        case TYPE.argument:
          out.add(`arg:${el.value}`);
          break;
        case TYPE.number:
        case TYPE.date:
        case TYPE.time:
          out.add(`${TYPE[el.type]}:${el.value}`);
          break;
        case TYPE.plural:
        case TYPE.select:
          out.add(
            `${TYPE[el.type]}:${el.value}:${Object.keys(el.options).sort().join('|')}`
          );
          for (const opt of Object.values(el.options)) walk(opt.value);
          break;
        case TYPE.tag:
          out.add(`tag:${el.value}`);
          walk(el.children);
          break;
        default:
          break;
      }
    }
  };
  walk(ast);
  return [...out].sort();
}

/**
 * A revision may turn a plain numeric `{count}` of the original into
 * `{count, plural, =1 {…} other {…}}` (Portuguese agreement: "1 contato",
 * "2 contatos"). Only for keys listed in `PLURALIZED`, whose callers were
 * checked to pass a number (ICU plural throws on strings).
 */
const PLURALIZED = new Set<string>([
  'Contacts.page.subtitle',
  'Contacts.page.selectedCount',
  'Contacts.page.toastBulkDeleted',
  'Contacts.importModal.resultImported',
  'Contacts.importModal.resultSkipped',
  'Broadcasts.detail.resumeHint',
  'Broadcasts.detail.resumeStalledHint',
  'Broadcasts.detail.toastResumeStarted',
  'Broadcasts.detail.toastResumeStartedCapped',
  'Dashboard.conversationsChart.tooltipIncoming',
  'Dashboard.conversationsChart.tooltipOutgoing',
  'Settings.invite.whatsappMessage',
  'Settings.aiKnowledge.reindexSuccess',
]);
function pluralizedOnly(key: string, got: string[], want: string[]): string[] {
  if (!PLURALIZED.has(key)) return got;
  return [
    ...new Set(
      got.map((entry) => {
        const m = /^plural:(\w+):/.exec(entry);
        return m && want.includes(`arg:${m[1]}`) ? `arg:${m[1]}` : entry;
      })
    ),
  ].sort();
}

/** For strings next-intl reads raw (`t.raw`): the literal `{…}` / `<…>` tokens. */
function rawTokens(message: string): string[] {
  return [...message.matchAll(/\{[^{}]*\}|<\/?[a-z][\w-]*>/gi)]
    .map((m) => m[0])
    .sort();
}

for (const locale of Object.keys(TRANSLATION_REVISIONS)) {
  describe(`translation revisions (${locale})`, () => {
    const core = flatten(read('messages', `${locale}.json`));
    const revisions = flatten(TRANSLATION_REVISIONS[locale]);
    const base = read(
      'src',
      'custom',
      'i18n',
      'revisions',
      `${locale}.base.json`
    ) as Record<string, string>;
    const overrides = flatten(BRAND_OVERRIDES[locale] ?? {});

    it('only revise existing core keys, never brand-override keys', () => {
      expect(Object.keys(revisions).filter((k) => !(k in core))).toEqual([]);
      expect(Object.keys(revisions).filter((k) => k in overrides)).toEqual([]);
    });

    it('are pinned to the upstream text they replace (run scripts/fork/i18n-revisions.mjs after review)', () => {
      expect(Object.keys(base).sort()).toEqual(Object.keys(revisions).sort());
      const drifted = Object.keys(revisions)
        .filter((k) => base[k] !== core[k])
        .map((k) => `${k}\n    pinned:   ${base[k]}\n    upstream: ${core[k]}`);
      expect(drifted).toEqual([]);
    });

    it('keep the ICU arguments, plural branches and tags of the original', () => {
      const broken: string[] = [];
      for (const [key, value] of Object.entries(revisions)) {
        if (typeof value !== 'string' || !value.trim()) {
          broken.push(`${key}: empty`);
          continue;
        }
        const ref = String(core[key]);
        const want = skeleton(ref);
        if (want === null) {
          // Raw string (t.raw): compare the literal tokens instead.
          if (rawTokens(value).join() !== rawTokens(ref).join())
            broken.push(`${key}: raw tokens differ`);
          continue;
        }
        const got = skeleton(value);
        if (got === null) broken.push(`${key}: does not parse as ICU`);
        else if (pluralizedOnly(key, got, want).join() !== want.join()) {
          broken.push(`${key}: ${want.join(' ')} → ${got.join(' ')}`);
        }
      }
      expect(broken).toEqual([]);
    });
  });
}

/**
 * PT-BR glossary (docs/LOCALIZATION.md). Checked on the *merged* catalogue,
 * so an upstream string that arrives in a merge with old terminology fails
 * here until it is revised.
 */
const PT_BANNED: [RegExp, string][] = [
  [/\bpipelines?\b/i, 'Pipeline → Funil'],
  [/\bbroadcasts?\b/i, 'Broadcast → Campanha'],
  [/\binbox\b/i, 'Inbox → Caixa de entrada'],
  [/\bdashboard\b/i, 'Dashboard → Painel'],
  [/\bworkspace\b/i, 'Workspace → Espaço de trabalho'],
  [/\bdeals?\b/i, 'Deal → Negócio'],
  [/\bcontactos?\b/i, 'Contacto (pt-PT) → Contato'],
  [/\bdelet(ar|e|ado|ada)\b/i, 'Deletar → Excluir'],
  [/\b(logar|deslogar)\b/i, 'Logar → Entrar'],
  [/\bcustomiz/i, 'Customizar → Personalizar'],
  [/\bsetar\b/i, 'Setar → Definir'],
  [/\butilizador/i, 'Utilizador (pt-PT) → Usuário'],
  [/\bregisto\b/i, 'Registo (pt-PT) → Registro'],
  [/(^|[^\p{L}])nó(?!\p{L})/iu, 'Nó → Bloco'],
  [/\bemail\b/i, 'Email → E-mail'],
];

/** Keys whose value is identifiers, not prose (reason documented). */
const GLOSSARY_EXCEPTIONS: Record<string, string> = {
  'Flows.builder.form.varKeyPlaceholder':
    'example variable keys (name, email, company)',
};

/** Code spans, identifiers and API scope names are not prose. */
function prose(text: string): string {
  return text
    .replace(/<(\w*code)>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/\{[^{}]*\}/g, ' ')
    .replace(/[\w.-]*[_:/][\w.:/-]*/g, ' ');
}

describe('PT-BR glossary', () => {
  it('the merged pt catalogue uses the product terms', () => {
    const merged = flatten(
      withCustomMessages('pt', read('messages', 'pt.json'))
    );
    const hits: string[] = [];
    for (const [key, value] of Object.entries(merged)) {
      if (typeof value !== 'string' || key in GLOSSARY_EXCEPTIONS) continue;
      const text = prose(value);
      for (const [rx, rule] of PT_BANNED) {
        if (rx.test(text)) hits.push(`${key}: ${rule} — ${value.slice(0, 90)}`);
      }
    }
    expect(hits).toEqual([]);
  });
});

describe('pluralized revisions', () => {
  it('agree in number for 1 and many, and format the count (1.234)', () => {
    const messages = withCustomMessages('pt', read('messages', 'pt.json'));
    const t = createTranslator({ locale: 'pt-BR', messages }) as unknown as (
      key: string,
      values: Record<string, string | number>
    ) => string;
    expect(t('Contacts.page.selectedCount', { count: 1 })).toBe(
      '1 selecionado'
    );
    expect(t('Contacts.page.selectedCount', { count: 1234 })).toBe(
      '1.234 selecionados'
    );
    for (const key of PLURALIZED) {
      const one = t(key, {
        count: 1,
        expiresInDays: 1,
        remaining: 2,
        accountName: 'Acme',
        url: 'u',
      });
      const many = t(key, {
        count: 2,
        expiresInDays: 2,
        remaining: 2,
        accountName: 'Acme',
        url: 'u',
      });
      expect(one, key).not.toBe(many);
      expect(one, key).toMatch(/\b1\b/);
    }
  });
});
