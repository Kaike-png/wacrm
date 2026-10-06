import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  current: null as null | {
    status: string;
    suspendedBy: 'billing' | 'platform' | null;
    pastDueSince: string | null;
    suspendedAt: string | null;
  },
  phoneAccount: 'acc-1' as string | null,
}));

vi.mock('@/custom/tenancy/access', () => ({
  getTenantState: vi.fn(async () => state.current),
  getAccountIdForPhone: vi.fn(async () => state.phoneAccount),
}));

import {
  assertPhoneCan,
  assertTenantCan,
  getTenantAccess,
  tenantCan,
  TenantRestrictedError,
  tenantReceivesInbound,
} from './enforcement';

const set = (
  status: string,
  suspendedBy: 'billing' | 'platform' | null = null
) => {
  state.current = {
    status,
    suspendedBy,
    pastDueSince: null,
    suspendedAt: null,
  };
};

describe('enforcement (the only API the app uses)', () => {
  beforeEach(() => {
    state.current = null;
    state.phoneAccount = 'acc-1';
  });

  it('past_due: everything allowed, payment notice', async () => {
    set('past_due');
    for (const a of [
      'messages.send',
      'campaigns.send',
      'automations.run',
      'integrations.create',
    ] as const) {
      await expect(assertTenantCan('acc-1', a)).resolves.toBeUndefined();
    }
    expect(await getTenantAccess('acc-1')).toMatchObject({
      status: 'past_due',
      notice: 'payment_due',
      blocked: [],
    });
  });

  it('suspended: refuses the four actions with a typed error, still receives inbound', async () => {
    set('suspended', 'billing');
    await expect(
      assertTenantCan('acc-1', 'campaigns.send')
    ).rejects.toBeInstanceOf(TenantRestrictedError);
    await expect(
      assertTenantCan('acc-1', 'messages.send')
    ).rejects.toMatchObject({
      action: 'messages.send',
      accountStatus: 'suspended',
    });
    expect(await tenantCan('acc-1', 'automations.run')).toBe(false);
    expect(await tenantCan('acc-1', 'integrations.create')).toBe(false);
    expect(await tenantReceivesInbound('acc-1')).toBe(true);
    expect(await getTenantAccess('acc-1')).toMatchObject({
      notice: 'suspended',
      suspendedBy: 'billing',
    });
  });

  it('cancelled: blocked and inbound not stored', async () => {
    set('cancelled');
    expect(await tenantCan('acc-1', 'messages.send')).toBe(false);
    expect(await tenantReceivesInbound('acc-1')).toBe(false);
  });

  it('lowest send layer resolves the organization from the WhatsApp number', async () => {
    set('suspended');
    await expect(assertPhoneCan('123', 'messages.send')).rejects.toBeInstanceOf(
      TenantRestrictedError
    );
    state.phoneAccount = null; // unknown number: nothing to enforce here
    await expect(
      assertPhoneCan('999', 'messages.send')
    ).resolves.toBeUndefined();
  });

  it('fails open when the status cannot be read (the database guards still apply)', async () => {
    state.current = null;
    await expect(
      assertTenantCan('acc-1', 'messages.send')
    ).resolves.toBeUndefined();
    expect(await tenantCan('acc-1', 'campaigns.send')).toBe(true);
  });
});
