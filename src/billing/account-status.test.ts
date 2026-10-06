import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_STATUSES,
  canTransition,
  needsAttention,
  toAccountStatus,
  trialDaysLeft,
} from './account-status';

describe('account status', () => {
  it('has exactly the five lifecycle states, mirrored by migration 902', async () => {
    expect(ACCOUNT_STATUSES).toEqual([
      'trial',
      'active',
      'past_due',
      'suspended',
      'cancelled',
    ]);
    const { readFileSync } = await import('node:fs');
    const sql = readFileSync(
      'supabase/migrations/902_br_organization_profile.sql',
      'utf8'
    );
    expect(sql).toContain(
      "CHECK (status IN ('trial', 'active', 'past_due', 'suspended', 'cancelled'))"
    );
  });

  it('reads unknown values as active (migration not applied yet)', () => {
    expect(toAccountStatus(undefined)).toBe('active');
    expect(toAccountStatus('deleted')).toBe('active');
    expect(toAccountStatus('suspended')).toBe('suspended');
  });

  it("flags the statuses that need the customer's attention", () => {
    expect(ACCOUNT_STATUSES.filter(needsAttention)).toEqual([
      'past_due',
      'suspended',
      'cancelled',
    ]);
  });

  it('allows only the business transitions', () => {
    expect(canTransition('trial', 'active')).toBe(true);
    expect(canTransition('past_due', 'active')).toBe(true);
    expect(canTransition('cancelled', 'active')).toBe(true);
    expect(canTransition('active', 'trial')).toBe(false);
    expect(canTransition('suspended', 'past_due')).toBe(false);
    expect(canTransition('active', 'active')).toBe(false);
  });

  it('counts trial days left', () => {
    const now = new Date('2026-10-05T12:00:00Z');
    expect(trialDaysLeft('trial', '2026-10-19T12:00:00Z', now)).toBe(14);
    expect(trialDaysLeft('trial', '2026-10-05T13:00:00Z', now)).toBe(1);
    expect(trialDaysLeft('trial', '2026-10-01T00:00:00Z', now)).toBe(0);
    expect(trialDaysLeft('active', '2026-10-19T12:00:00Z', now)).toBeNull();
    expect(trialDaysLeft('trial', null, now)).toBeNull();
  });
});
