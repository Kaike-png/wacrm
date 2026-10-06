import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTranslator } from 'next-intl';

import messages from '@/custom/i18n/messages/pt.json';

// The service talks to the database only through these two RPCs; the
// rules themselves are covered by supabase/tests/database/*.test.sql.
const rpc = vi.fn();
vi.mock('@/custom/core/admin', () => ({ supabaseAdmin: () => ({ rpc }) }));
vi.mock('@/custom/core/server', () => ({
  getT: (ns: string) => {
    const t = createTranslator({
      locale: 'pt-BR',
      messages,
      namespace: ns as never,
    });
    return (key: string, values?: Record<string, unknown>) =>
      t(key as never, values as never);
  },
}));

const { UsageService } = await import('./usage');
const { assertWithinLimit, forgetEntitlements } =
  await import('./entitlements');
const { PlanLimitError } = await import('./errors');

const ACCOUNT = '2b4348f3-5fd5-4b28-abff-5b651031d1a5';

beforeEach(() => {
  rpc.mockReset();
  forgetEntitlements();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('UsageService.canUseFeature', () => {
  it('refuses with the requirement example and an upgrade suggestion', async () => {
    rpc.mockResolvedValue({
      data: {
        feature: 'max_contacts',
        kind: 'limit',
        allowed: false,
        limit: 2000,
        used: 2000,
        remaining: 0,
        plan: { code: 'start', name: 'Start' },
        upgrade: { code: 'pro', name: 'Pro', value: 10000 },
      },
      error: null,
    });
    const r = await UsageService.canUseFeature(ACCOUNT, 'max_contacts');
    expect(rpc).toHaveBeenCalledWith('billing_can_use', {
      p_account: ACCOUNT,
      p_key: 'max_contacts',
      p_increment: 1,
    });
    expect(r.allowed).toBe(false);
    expect(r.message).toBe(
      'Você atingiu o limite de 2.000 contatos do plano Start. Faça upgrade para o plano Pro (até 10.000).'
    );
  });

  it('allows without a message and reports what is left', async () => {
    rpc.mockResolvedValue({
      data: {
        feature: 'max_contacts',
        kind: 'limit',
        allowed: true,
        limit: 2000,
        used: 150,
        remaining: 1850,
      },
      error: null,
    });
    const r = await UsageService.canUseFeature(ACCOUNT, 'max_contacts', 500);
    expect(r).toMatchObject({ allowed: true, remaining: 1850, message: null });
    expect(rpc).toHaveBeenCalledWith('billing_can_use', {
      p_account: ACCOUNT,
      p_key: 'max_contacts',
      p_increment: 500,
    });
  });

  it('flags: names the plan that has it', async () => {
    rpc.mockResolvedValue({
      data: {
        feature: 'ai_enabled',
        kind: 'flag',
        allowed: false,
        limit: false,
        plan: { code: 'start', name: 'Start' },
        upgrade: { code: 'pro', name: 'Pro', value: true },
      },
      error: null,
    });
    const r = await UsageService.canUseFeature(ACCOUNT, 'ai_enabled');
    expect(r.message).toBe(
      'A inteligência artificial não está incluída no plano Start. Disponível a partir do plano Pro.'
    );
  });

  it('fails open when the database cannot answer (triggers still guard writes)', async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { message: 'connection refused' },
    });
    expect(
      await UsageService.canUseFeature(ACCOUNT, 'max_users')
    ).toMatchObject({ allowed: true, message: null });
    rpc.mockRejectedValue(new Error('network'));
    expect(
      (await UsageService.canUseFeature(ACCOUNT, 'max_users')).allowed
    ).toBe(true);
  });
});

describe('assertWithinLimit', () => {
  it('throws a PlanLimitError carrying plan and upgrade', async () => {
    rpc.mockResolvedValue({
      data: {
        feature: 'max_users',
        kind: 'limit',
        allowed: false,
        limit: 2,
        used: 2,
        plan: { code: 'start', name: 'Start' },
        upgrade: { code: 'pro', name: 'Pro', value: 5 },
      },
      error: null,
    });
    const err = await assertWithinLimit(ACCOUNT, 'max_users').catch((e) => e);
    expect(err).toBeInstanceOf(PlanLimitError);
    expect(err.context).toEqual({
      limit: 2,
      used: 2,
      plan: 'Start',
      upgrade: 'Pro',
      upgradeValue: 5,
    });
  });
});

describe('UsageService.getUsage', () => {
  it('returns the report of the organization', async () => {
    const report = {
      plan: { code: 'start', name: 'Start' },
      messages: { sent_period: 12, received_period: 30 },
    };
    rpc.mockResolvedValue({ data: report, error: null });
    expect(await UsageService.getUsage(ACCOUNT)).toEqual(report);
    expect(rpc).toHaveBeenCalledWith('billing_usage_report', {
      p_account: ACCOUNT,
    });
  });

  it('surfaces errors (a report is not a gate, nothing to fail open)', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    await expect(UsageService.getUsage(ACCOUNT)).rejects.toThrow(
      'usage report failed: boom'
    );
  });
});

describe('isFeatureEnabled (hot path)', () => {
  it('caches the flag per organization', async () => {
    rpc.mockResolvedValue({ data: false, error: null });
    expect(await UsageService.isFeatureEnabled(ACCOUNT, 'api_enabled')).toBe(
      false
    );
    expect(await UsageService.isFeatureEnabled(ACCOUNT, 'api_enabled')).toBe(
      false
    );
    expect(rpc).toHaveBeenCalledTimes(1);
    forgetEntitlements(ACCOUNT);
    rpc.mockResolvedValue({ data: true, error: null });
    expect(await UsageService.isFeatureEnabled(ACCOUNT, 'api_enabled')).toBe(
      true
    );
  });
});
