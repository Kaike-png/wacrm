/**
 * Commercial flow, end to end against a real database (fork,
 * docs/MVP_FOUNDATION_AUDIT.md §29). Skipped unless FORK_DB_INTEGRATION=1:
 *
 *   npm run test:flow        (scripts/fork/test-flow.sh — local Supabase)
 *
 * Runs the REAL BillingService (rules → billing_apply_effects), the real
 * triggers (plan limits, delinquency guards) and the real enforcement
 * module, with the mock gateway and its signed webhooks. Creates a
 * throwaway organization and deletes it at the end (the immutable
 * platform audit log keeps its 'sistema' entries, by design).
 *
 *   user → organization → plan → subscription → payment (webhook ×10)
 *   → active → WhatsApp → 2nd user (3rd refused) → contacts up to the
 *   limit (+1 refused) → renewal overdue → past_due → suspended (grace 0)
 *   → blocks → payment → active → everything works again.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { forgetTenantStatus } from '@/custom/tenancy/access';

import { assertPhoneCan, assertTenantCan, tenantCan } from '../enforcement';
import { forgetEntitlements } from '../entitlements';
import { getBillingProvider } from '../providers';
import { MockBillingProvider, MOCK_PROVIDER_ID } from '../providers/mock';
import { BillingService } from './service';

const enabled = process.env.FORK_DB_INTEGRATION === '1';
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';

const run = Math.random().toString(36).slice(2, 10);
const password = `Flow-${run}-${Math.random().toString(36).slice(2)}`;

describe.skipIf(!enabled)('commercial flow (integration, real DB)', () => {
  let admin: SupabaseClient;
  let owner: SupabaseClient;
  const userIds: string[] = [];
  let accountId = '';
  let mock: MockBillingProvider;
  let subscriptionExternalId = '';
  let renewalPaymentId = '';
  const phoneNumberId = `flow${Date.now()}`;

  async function createUser(tag: string): Promise<string> {
    const { data, error } = await admin.auth.admin.createUser({
      email: `flow-${run}-${tag}@flow.test`,
      password,
      email_confirm: true,
    });
    if (error) throw error;
    userIds.push(data.user.id);
    return data.user.id;
  }

  async function accountStatus(): Promise<string> {
    const { data } = await admin
      .from('accounts')
      .select('status')
      .eq('id', accountId)
      .single();
    return (data as { status: string }).status;
  }

  async function subscription() {
    const { data } = await admin
      .from('billing_subscriptions')
      .select('plan_code, status, external_id, pending_external_id')
      .eq('account_id', accountId)
      .single();
    return data as {
      plan_code: string;
      status: string;
      external_id: string | null;
      pending_external_id: string | null;
    };
  }

  async function deliver(webhook: { rawBody: string; headers: Headers }) {
    return BillingService.handleWebhook(MOCK_PROVIDER_ID, webhook);
  }

  function fresh() {
    forgetTenantStatus();
    forgetEntitlements();
  }

  beforeAll(async () => {
    admin = createClient(url, serviceKey, { auth: { persistSession: false } });
    mock = getBillingProvider(MOCK_PROVIDER_ID) as MockBillingProvider;
  });

  afterAll(async () => {
    if (!admin) return;
    // Every organization these users own (incl. the signup organizations
    // of the users moved into the test organization), then the users.
    if (userIds.length > 0)
      await admin.from('accounts').delete().in('owner_user_id', userIds);
    if (accountId) await admin.from('accounts').delete().eq('id', accountId);
    for (const id of userIds) {
      const { error } = await admin.auth.admin.deleteUser(id);
      if (error) console.error('[flow] cleanup: could not delete user', id);
    }
  });

  it('1-2. signup creates the user and its organization (trial, default plan)', async () => {
    const uid = await createUser('owner');
    const { data: profile } = await admin
      .from('profiles')
      .select('account_id, account_role')
      .eq('user_id', uid)
      .single();
    accountId = (profile as { account_id: string }).account_id;
    expect(accountId).toBeTruthy();
    expect((profile as { account_role: string }).account_role).toBe('owner');
    expect(await accountStatus()).toBe('trial');
    expect((await subscription()).plan_code).toBe('start');
    const { data: acc } = await admin
      .from('accounts')
      .select('trial_ends_at')
      .eq('id', accountId)
      .single();
    // 912: the trial has an end date (expired by the billing cron)
    expect(
      (acc as { trial_ends_at: string | null }).trial_ends_at
    ).toBeTruthy();

    owner = createClient(url, anonKey, { auth: { persistSession: false } });
    const { error } = await owner.auth.signInWithPassword({
      email: `flow-${run}-owner@flow.test`,
      password,
    });
    expect(error).toBeNull();
  });

  it('3-4. selecting a plan creates the subscription and its first charge', async () => {
    const { payment } = await BillingService.subscribe(
      accountId,
      'start',
      'pix'
    );
    expect(payment.status).toBe('pending');
    expect(payment.pix_copy_paste).toBeTruthy();
    const sub = await subscription();
    expect(sub.pending_external_id).toBeTruthy();
    subscriptionExternalId = sub.pending_external_id!;

    // 5-6. payment confirmed (signed webhook) — delivered 10 times
    const webhook = mock.simulate(payment.external_id, 'paid');
    const results = [];
    for (let i = 0; i < 10; i++) results.push(await deliver(webhook));
    expect(results[0].processed).toBe(1);
    expect(results.slice(1).every((r) => r.duplicates === 1)).toBe(true);

    expect(await subscription()).toMatchObject({
      plan_code: 'start',
      status: 'active',
      external_id: subscriptionExternalId,
      pending_external_id: null,
    });
    expect(await accountStatus()).toBe('active');
    const { count } = await admin
      .from('billing_payments')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId);
    expect(count).toBe(1);
  });

  it('7. connects a WhatsApp number (mock)', async () => {
    const { error } = await admin.from('whatsapp_config').insert({
      account_id: accountId,
      user_id: userIds[0],
      phone_number_id: phoneNumberId,
      access_token: 'not-a-real-token',
    });
    expect(error).toBeNull();
    fresh();
    await expect(
      assertPhoneCan(phoneNumberId, 'messages.send')
    ).resolves.toBeUndefined();
  });

  it('8. adds a second user; the third exceeds START (2 seats)', async () => {
    const second = await createUser('member');
    const third = await createUser('extra');
    // move them from their own signup organizations into this one
    const { error: ok } = await admin
      .from('profiles')
      .update({ account_id: accountId, account_role: 'agent' })
      .eq('user_id', second);
    expect(ok).toBeNull();
    const { error: refused } = await admin
      .from('profiles')
      .update({ account_id: accountId, account_role: 'agent' })
      .eq('user_id', third);
    expect(refused?.code).toBe('53400');
  });

  it('9-10. creates contacts up to the limit; the next one is refused', async () => {
    const rows = Array.from({ length: 1999 }, (_, i) => ({
      account_id: accountId,
      user_id: userIds[0],
      phone: `+55119${String(i).padStart(8, '0')}`,
      name: `Contato ${i}`,
    }));
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await admin
        .from('contacts')
        .insert(rows.slice(i, i + 500));
      expect(error).toBeNull();
    }
    // through the customer's own session (the limit applies to browser inserts)
    const last = await owner.from('contacts').insert({
      account_id: accountId,
      user_id: userIds[0],
      phone: '+5511988887777',
      name: 'Contato 2000',
    });
    expect(last.error).toBeNull();
    const over = await owner.from('contacts').insert({
      account_id: accountId,
      user_id: userIds[0],
      phone: '+5511988886666',
      name: 'Contato 2001',
    });
    expect(over.error?.code).toBe('53400');
  });

  it('11-12. renewal overdue → subscription and organization past_due', async () => {
    const webhook = mock.simulateRenewal(subscriptionExternalId, 'overdue');
    renewalPaymentId = webhook.event.payment!.id;
    expect((await deliver(webhook)).processed).toBe(1);
    expect((await subscription()).status).toBe('past_due');
    expect(await accountStatus()).toBe('past_due');
    fresh();
    // past_due blocks nothing
    expect(await tenantCan(accountId, 'messages.send')).toBe(true);
  });

  it('13-14. grace period over → suspended; sending/campaigns/automations blocked, data kept', async () => {
    const suspended = await BillingService.enforceDelinquency(0);
    expect(suspended).toBeGreaterThanOrEqual(1);
    expect(await accountStatus()).toBe('suspended');
    fresh();
    await expect(
      assertTenantCan(accountId, 'messages.send')
    ).rejects.toMatchObject({ code: 'tenant_restricted' });
    await expect(
      assertPhoneCan(phoneNumberId, 'messages.send')
    ).rejects.toMatchObject({ code: 'tenant_restricted' });

    const automation = await owner.from('automations').insert({
      account_id: accountId,
      user_id: userIds[0],
      name: 'Bloqueada',
      trigger_type: 'new_contact_created',
    });
    expect(automation.error?.code).toBe('TR403');
    const apiKeyBlocked = await admin.rpc('tenant_assert_can', {
      p_account: accountId,
      p_action: 'integrations.create',
    });
    expect(apiKeyBlocked.error?.code).toBe('TR403');

    // login + data read still work
    const { count } = await owner
      .from('contacts')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId);
    expect(count).toBe(2000);
  });

  it('15-17. payment confirmed → reactivated, limits re-evaluated, features back', async () => {
    const webhook = mock.simulate(renewalPaymentId, 'paid');
    expect((await deliver(webhook)).processed).toBe(1);
    expect((await deliver(webhook)).duplicates).toBe(1);
    expect(await accountStatus()).toBe('active');
    expect((await subscription()).status).toBe('active');
    fresh();
    await expect(
      assertPhoneCan(phoneNumberId, 'messages.send')
    ).resolves.toBeUndefined();
    const automation = await owner.from('automations').insert({
      account_id: accountId,
      user_id: userIds[0],
      name: 'Volta a funcionar',
      trigger_type: 'new_contact_created',
    });
    expect(automation.error).toBeNull();
    // limits still apply after reactivation (nothing was reset)
    const over = await owner.from('contacts').insert({
      account_id: accountId,
      user_id: userIds[0],
      phone: '+5511988885555',
      name: 'Contato 2001',
    });
    expect(over.error?.code).toBe('53400');
    // WhatsApp configuration survived the suspension
    const { data: wa } = await admin
      .from('whatsapp_config')
      .select('phone_number_id')
      .eq('account_id', accountId);
    expect(wa).toHaveLength(1);
  });
});
