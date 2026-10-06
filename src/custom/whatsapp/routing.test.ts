/**
 * Meta webhook tenant routing (audit F-20). The decision is made with
 * injected lookups, so every branch is covered without a database or Meta.
 * The account-scoped status lookups (F-19) are covered against a real
 * database in routing.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  forgetWabaConfirmations,
  resolveDeliveryTenant,
  wabaDecision,
  type RoutedConfig,
  type RoutingDeps,
} from './routing';

const cfg = (over: Partial<RoutedConfig> = {}): RoutedConfig => ({
  account_id: 'acc-A',
  user_id: 'user-A',
  phone_number_id: '111',
  waba_id: 'WABA-A',
  access_token: 'enc',
  ...over,
});

function deps(over: Partial<RoutingDeps> = {}, rows: RoutedConfig[] = [cfg()]) {
  return {
    findConfigs: vi.fn(async () => ({ data: rows, error: null })),
    numberIsUnderWaba: vi.fn(async () => true),
    pinWaba: vi.fn(async () => true),
    ...over,
  } satisfies RoutingDeps;
}

beforeEach(() => forgetWabaConfirmations());

describe('wabaDecision (pure)', () => {
  it('requires the delivery WABA and compares it with the saved one', () => {
    expect(wabaDecision('W', 'W')).toBe('match');
    expect(wabaDecision('W', 'X')).toBe('mismatch');
    expect(wabaDecision(null, 'X')).toBe('unpinned');
    expect(wabaDecision('W', undefined)).toBe('missing_delivery');
    expect(wabaDecision(null, null)).toBe('missing_delivery');
  });
});

describe('resolveDeliveryTenant', () => {
  it('saved WABA equal to the delivery WABA → that organization, no Meta call', async () => {
    const d = deps();
    const r = await resolveDeliveryTenant('111', 'WABA-A', d);
    expect(r).toMatchObject({
      ok: true,
      pinned: false,
      config: { account_id: 'acc-A' },
    });
    expect(d.numberIsUnderWaba).not.toHaveBeenCalled();
  });

  it('different WABA → dropped', async () => {
    const r = await resolveDeliveryTenant('111', 'WABA-B', deps());
    expect(r).toEqual({
      ok: false,
      reason: 'waba_mismatch',
      accountId: 'acc-A',
    });
  });

  it('delivery without entry.id → dropped, even when the config has a WABA', async () => {
    const r = await resolveDeliveryTenant('111', undefined, deps());
    expect(r).toMatchObject({ ok: false, reason: 'missing_delivery_waba' });
  });

  it('F-20: config WITHOUT waba_id is not a free pass — the delivery WABA must be confirmed by Meta', async () => {
    const d = deps({ numberIsUnderWaba: vi.fn(async () => false) }, [
      cfg({ waba_id: null }),
    ]);
    const r = await resolveDeliveryTenant('111', 'WABA-EVIL', d);
    expect(r).toEqual({
      ok: false,
      reason: 'waba_unverified',
      accountId: 'acc-A',
    });
    expect(d.numberIsUnderWaba).toHaveBeenCalledWith(
      expect.objectContaining({ account_id: 'acc-A' }),
      'WABA-EVIL'
    );
    expect(d.pinWaba).not.toHaveBeenCalled();
  });

  it('F-20: Meta error while confirming → dropped (fails closed)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const d = deps(
      {
        numberIsUnderWaba: vi.fn(async () => {
          throw new Error('(#100) boom');
        }),
      },
      [cfg({ waba_id: null })]
    );
    const r = await resolveDeliveryTenant('111', 'WABA-A', d);
    expect(r).toMatchObject({ ok: false, reason: 'waba_unverified' });
    warn.mockRestore();
  });

  it('F-20: a refused confirmation is cached — no Graph call per forged delivery', async () => {
    const d = deps({ numberIsUnderWaba: vi.fn(async () => false) }, [
      cfg({ waba_id: null }),
    ]);
    await resolveDeliveryTenant('111', 'WABA-EVIL', d);
    await resolveDeliveryTenant('111', 'WABA-EVIL', d);
    expect(d.numberIsUnderWaba).toHaveBeenCalledTimes(1);
  });

  it('F-20: confirmed by Meta → WABA pinned on the config, then the fast path applies', async () => {
    const d = deps({}, [cfg({ waba_id: null })]);
    const r = await resolveDeliveryTenant('111', 'WABA-A', d);
    expect(r).toMatchObject({
      ok: true,
      pinned: true,
      config: { waba_id: 'WABA-A' },
    });
    expect(d.pinWaba).toHaveBeenCalledWith(
      expect.objectContaining({ account_id: 'acc-A' }),
      'WABA-A'
    );
  });

  it('F-20: WABA already linked to another organization (unique) → dropped, never shared', async () => {
    const d = deps({ pinWaba: vi.fn(async () => false) }, [
      cfg({ waba_id: null }),
    ]);
    const r = await resolveDeliveryTenant('111', 'WABA-B', d);
    expect(r).toEqual({ ok: false, reason: 'waba_taken', accountId: 'acc-A' });
  });

  it('unknown, ambiguous or missing number, or lookup error → dropped without an organization', async () => {
    expect(await resolveDeliveryTenant(undefined, 'W', deps())).toMatchObject({
      ok: false,
      reason: 'missing_phone_number_id',
      accountId: null,
    });
    expect(await resolveDeliveryTenant('111', 'W', deps({}, []))).toMatchObject(
      { reason: 'unknown_number', accountId: null }
    );
    expect(
      await resolveDeliveryTenant(
        '111',
        'WABA-A',
        deps({}, [cfg(), cfg({ account_id: 'acc-B' })])
      )
    ).toMatchObject({ reason: 'ambiguous_number', accountId: null });
    expect(
      await resolveDeliveryTenant(
        '111',
        'WABA-A',
        deps({
          findConfigs: vi.fn(async () => ({
            data: null,
            error: { message: 'x' },
          })),
        })
      )
    ).toMatchObject({ reason: 'lookup_failed' });
  });

  it('multi-WABA: each number routes by its own saved WABA', async () => {
    const rows: Record<string, RoutedConfig> = {
      '111': cfg(),
      '222': cfg({
        account_id: 'acc-B',
        phone_number_id: '222',
        waba_id: 'WABA-B',
      }),
    };
    const d = deps({
      findConfigs: vi.fn(async (p: string) => ({
        data: rows[p] ? [rows[p]] : [],
        error: null,
      })),
    });
    expect(await resolveDeliveryTenant('111', 'WABA-A', d)).toMatchObject({
      ok: true,
      config: { account_id: 'acc-A' },
    });
    expect(await resolveDeliveryTenant('222', 'WABA-B', d)).toMatchObject({
      ok: true,
      config: { account_id: 'acc-B' },
    });
    expect(await resolveDeliveryTenant('222', 'WABA-A', d)).toMatchObject({
      ok: false,
      reason: 'waba_mismatch',
    });
  });
});

describe('routeWebhookDelivery logging', () => {
  it('logs ids and the reason only — never the token', async () => {
    vi.resetModules();
    vi.doMock('@/lib/flows/admin-client', () => ({
      supabaseAdmin: () => ({
        from: () => ({
          select: () => ({
            eq: async () => ({
              data: [
                cfg({
                  waba_id: 'WABA-A',
                  access_token: 'EAAsecretTOKENvalue123456',
                }),
              ],
              error: null,
            }),
          }),
          insert: async () => ({ error: null }),
        }),
      }),
    }));
    const { routeWebhookDelivery } = await import('./routing');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await routeWebhookDelivery('111', 'WABA-X')).toBeNull();
    const line = warn.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(line).toContain('reason=waba_mismatch');
    expect(line).toContain('phone_number_id=111');
    expect(line).not.toContain('EAAsecret');
    warn.mockRestore();
    vi.doUnmock('@/lib/flows/admin-client');
  });
});
