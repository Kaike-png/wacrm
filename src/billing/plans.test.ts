import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';

import messages from '@/custom/i18n/messages/pt.json';

import {
  limitContextOf,
  parseLimitHint,
  PlanLimitError,
  planLimitBody,
  planLimitFeature,
  planLimitMessage,
  type LimitContext,
} from './errors';
import {
  FLAG_FEATURES,
  flagEnabled,
  LIMIT_FEATURES,
  limitOf,
  parseFeatureValue,
  usageRatio,
  type Entitlements,
} from './features';

const t = createTranslator({
  locale: 'pt-BR',
  messages,
  namespace: 'Custom.billing',
});
const tr = (key: string, values?: Record<string, string | number>) =>
  t(key as never, values as never);

const ent: Entitlements = {
  plan: {
    code: 'start',
    name: 'Start',
    started_at: '2026-10-06T00:00:00Z',
    current_period_end: null,
  },
  features: [
    { key: 'max_users', kind: 'limit', value: 2, used: 2 },
    { key: 'max_contacts', kind: 'limit', value: 2000, used: 150 },
    { key: 'max_automations', kind: 'limit', value: null, used: 40 },
    { key: 'ai_enabled', kind: 'flag', value: false, used: null },
  ],
};

describe('features', () => {
  it('reads limits and flags by key', () => {
    expect(limitOf(ent, 'max_users')).toEqual({
      limit: 2,
      used: 2,
      reached: true,
    });
    expect(limitOf(ent, 'max_contacts').reached).toBe(false);
    expect(limitOf(ent, 'max_automations')).toEqual({
      limit: null,
      used: 40,
      reached: false,
    });
    expect(flagEnabled(ent, 'ai_enabled')).toBe(false);
    // unknown / not loaded → do not hide anything (the server decides)
    expect(flagEnabled(ent, 'api_enabled')).toBe(true);
    expect(flagEnabled(null, 'ai_enabled')).toBe(true);
  });

  it('computes usage ratio', () => {
    expect(usageRatio(2000, 150)).toBeCloseTo(0.075);
    expect(usageRatio(null, 999)).toBe(0);
    expect(usageRatio(0, 0)).toBe(1);
    expect(usageRatio(5, 9)).toBe(1);
  });

  it('validates editor values by kind', () => {
    expect(parseFeatureValue('limit', '')).toEqual({ ok: true, value: null });
    expect(parseFeatureValue('limit', '2000')).toEqual({
      ok: true,
      value: 2000,
    });
    expect(parseFeatureValue('limit', '-1')).toEqual({ ok: false });
    expect(parseFeatureValue('limit', '1.5')).toEqual({ ok: false });
    expect(parseFeatureValue('flag', true)).toEqual({ ok: true, value: true });
    expect(parseFeatureValue('flag', 'yes')).toEqual({ ok: false });
  });
});

describe('plan-limit errors', () => {
  const hint = JSON.stringify({
    feature: 'max_contacts',
    limit: 2000,
    used: 2000,
    plan: 'Start',
    upgrade: 'Pro',
    upgrade_value: 10000,
  });
  const dbError = {
    code: '53400',
    message: 'plan_limit_exceeded',
    details: 'max_contacts',
    hint,
  };

  it('recognizes database, thrown and API errors', () => {
    expect(planLimitFeature(dbError)).toBe('max_contacts');
    expect(
      planLimitFeature(new PlanLimitError('max_users', { limit: 2 }))
    ).toBe('max_users');
    expect(
      planLimitFeature({ code: 'plan_limit_exceeded', feature: 'api_enabled' })
    ).toBe('api_enabled');
    expect(planLimitFeature({ code: '23505' })).toBeNull();
    expect(planLimitFeature(new Error('boom'))).toBeNull();
  });

  it('parses the JSON hint (908) and the legacy one (907)', () => {
    expect(parseLimitHint(hint)).toEqual({
      limit: 2000,
      used: 2000,
      plan: 'Start',
      upgrade: 'Pro',
      upgradeValue: 10000,
    });
    expect(parseLimitHint('limit=2000 used=1999')).toMatchObject({
      limit: 2000,
      used: 1999,
      plan: null,
    });
    expect(parseLimitHint('{broken')).toMatchObject({ limit: null });
    expect(parseLimitHint(undefined)).toMatchObject({
      limit: null,
      upgrade: null,
    });
  });

  it('says the limit, the plan and suggests an upgrade', () => {
    expect(planLimitBody(dbError, tr)).toEqual({
      error:
        'Você atingiu o limite de 2.000 contatos do plano Start. Faça upgrade para o plano Pro (até 10.000).',
      code: 'plan_limit_exceeded',
      feature: 'max_contacts',
      limit: 2000,
      used: 2000,
      plan: 'Start',
      upgrade: 'Pro',
      upgrade_value: 10000,
    });
    const msg = (feature: string, ctx: Partial<LimitContext>) =>
      planLimitMessage(feature, ctx, tr);
    expect(
      msg('max_users', {
        limit: 2,
        plan: 'Start',
        upgrade: 'Pro',
        upgradeValue: 5,
      })
    ).toBe(
      'Você atingiu o limite de 2 usuários do plano Start (convites pendentes contam). Faça upgrade para o plano Pro (até 5).'
    );
    expect(
      msg('max_whatsapp_accounts', {
        limit: 1,
        plan: 'Pro',
        upgrade: 'Business',
        upgradeValue: 3,
      })
    ).toBe(
      'Você atingiu o limite de 1 número de WhatsApp do plano Pro. Faça upgrade para o plano Business (até 3).'
    );
    expect(
      msg('max_automations', {
        limit: 30,
        plan: 'Pro',
        upgrade: 'Business',
        upgradeValue: null,
      })
    ).toBe(
      'Você atingiu o limite de 30 automações do plano Pro. Faça upgrade para o plano Business (sem limite).'
    );
    expect(
      msg('ai_enabled', { plan: 'Start', upgrade: 'Pro', upgradeValue: true })
    ).toBe(
      'A inteligência artificial não está incluída no plano Start. Disponível a partir do plano Pro.'
    );
    // Top plan / no plan: no upgrade to offer
    expect(msg('max_contacts', { limit: 50000, plan: 'Business' })).toBe(
      'Você atingiu o limite de 50.000 contatos do plano Business. Fale com o suporte para ampliar seu plano.'
    );
    expect(msg('api_enabled', {})).toBe(
      'A API pública não está incluída no seu plano. Fale com o suporte para ampliar seu plano.'
    );
    expect(
      planLimitBody({ code: '53400', details: 'max_seats' }, tr).error
    ).toBe('Esta ação ultrapassa o limite do seu plano.');
  });

  it('reads the context from an API body too (client side)', () => {
    const body = planLimitBody(dbError, tr);
    expect(limitContextOf(body)).toEqual(parseLimitHint(hint));
  });
});

describe('catalog stays in sync', () => {
  const sql = readFileSync(
    join(process.cwd(), 'supabase/migrations/907_billing_plans.sql'),
    'utf8'
  );
  const seeded = [...sql.matchAll(/^\s+\('([a-z_]+)',\s+'(limit|flag)'/gm)].map(
    (m) => ({ key: m[1], kind: m[2] })
  );

  it('every feature key the code enforces is seeded with the right kind', () => {
    expect(seeded.filter((f) => f.kind === 'limit').map((f) => f.key)).toEqual([
      ...LIMIT_FEATURES,
    ]);
    expect(seeded.filter((f) => f.kind === 'flag').map((f) => f.key)).toEqual([
      ...FLAG_FEATURES,
    ]);
  });

  it('every feature has a label, notice / limit message in both languages', () => {
    for (const lang of ['pt', 'en']) {
      const m = JSON.parse(
        readFileSync(
          join(process.cwd(), `src/custom/i18n/messages/${lang}.json`),
          'utf8'
        )
      ).Custom.billing;
      for (const { key, kind } of seeded) {
        expect(m.features[key], `${lang} features.${key}`).toBeTruthy();
        expect(m.limitReached[key], `${lang} limitReached.${key}`).toBeTruthy();
        if (kind === 'flag')
          expect(m.notice[key]?.title, `${lang} notice.${key}`).toBeTruthy();
      }
    }
  });
});

describe('no plan-name conditionals', () => {
  // The app asks for features by key; branching on a plan code would
  // silently break when plans are renamed or edited in the panel.
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name))
        out.push(full);
    }
    return out;
  }

  it('no source file compares a plan code to a literal', () => {
    const pattern =
      /(?<!typeof )(plan_?[cC]ode|plan\??\.code|\bplan)\s*(===?|!==?)\s*['"][a-z]|['"](start|pro|business|starter|enterprise)['"]\s*(===?|!==?)\s*\w*plan/i;
    const offenders = walk(join(process.cwd(), 'src'))
      .filter((f) => pattern.test(readFileSync(f, 'utf8')))
      .map((f) => relative(process.cwd(), f));
    expect(offenders).toEqual([]);
  });
});
