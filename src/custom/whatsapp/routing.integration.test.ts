/**
 * F-19/F-20 against a real database (opt-in: FORK_DB_INTEGRATION=1,
 * `npm run test:flow`). Two organizations; tenant A owns a message and a
 * broadcast recipient with wamid X; tenant B owns a message with the same
 * wamid. Processing "in B's context" must never see or touch A's rows, and
 * pinning a WABA can never hand one organization another's WABA.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  forgetWabaConfirmations,
  resolveDeliveryTenant,
  tenantBroadcastRecipient,
  tenantMessageRows,
  type RoutingDeps,
} from './routing';

const enabled = process.env.FORK_DB_INTEGRATION === '1';
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const run = Math.random().toString(36).slice(2, 10);
const WAMID = `wamid.F19.${run}`;

describe.skipIf(!enabled)(
  'webhook tenant isolation (integration, real DB)',
  () => {
    let admin: SupabaseClient;
    const users: string[] = [];
    const acc: Record<'A' | 'B', string> = { A: '', B: '' };
    const msg: Record<'A' | 'B', string> = { A: '', B: '' };
    const phone = { A: `9${Date.now()}1`, B: `9${Date.now()}2` };

    async function org(tag: 'A' | 'B') {
      const { data, error } = await admin.auth.admin.createUser({
        email: `f19-${run}-${tag}@flow.test`,
        password: `F19-${run}-${Math.random()}`,
        email_confirm: true,
      });
      if (error) throw error;
      users.push(data.user.id);
      const { data: p } = await admin
        .from('profiles')
        .select('account_id')
        .eq('user_id', data.user.id)
        .single();
      acc[tag] = (p as { account_id: string }).account_id;
      const uid = data.user.id;
      const { data: contact, error: cErr } = await admin
        .from('contacts')
        .insert({
          account_id: acc[tag],
          user_id: uid,
          phone: `+55119${phone[tag].slice(-8)}`,
          name: tag,
        })
        .select('id')
        .single();
      if (cErr) throw cErr;
      const { data: conv, error: vErr } = await admin
        .from('conversations')
        .insert({
          account_id: acc[tag],
          user_id: uid,
          contact_id: (contact as { id: string }).id,
        })
        .select('id')
        .single();
      if (vErr) throw vErr;
      const { data: m, error: mErr } = await admin
        .from('messages')
        .insert({
          conversation_id: (conv as { id: string }).id,
          sender_type: 'agent',
          content_type: 'text',
          content_text: `oi ${tag}`,
          message_id: WAMID,
          status: 'sent',
        })
        .select('id')
        .single();
      if (mErr) throw mErr;
      msg[tag] = (m as { id: string }).id;
      const { error: wErr } = await admin.from('whatsapp_config').insert({
        account_id: acc[tag],
        user_id: uid,
        phone_number_id: phone[tag],
        access_token: 'not-a-real-token',
        waba_id: tag === 'A' ? `WABA-A-${run}` : null,
      });
      if (wErr) throw wErr;
      return { uid, contactId: (contact as { id: string }).id };
    }

    beforeAll(async () => {
      admin = createClient(url, serviceKey, {
        auth: { persistSession: false },
      });
      const a = await org('A');
      await org('B');
      // A broadcast in A whose recipient carries the same wamid
      const { data: b, error: bErr } = await admin
        .from('broadcasts')
        .insert({
          account_id: acc.A,
          user_id: a.uid,
          name: 'F19',
          template_name: 'x',
          status: 'draft',
        })
        .select('id')
        .single();
      if (bErr) throw bErr;
      const { error: rErr } = await admin.from('broadcast_recipients').insert({
        broadcast_id: (b as { id: string }).id,
        contact_id: a.contactId,
        status: 'sent',
        whatsapp_message_id: WAMID,
      });
      if (rErr) throw rErr;
    });

    afterAll(async () => {
      if (!admin) return;
      if (users.length)
        await admin.from('accounts').delete().in('owner_user_id', users);
      for (const id of users) await admin.auth.admin.deleteUser(id);
    });

    it("F-19: in B's context only B's row with the shared wamid is found", async () => {
      const rowsB = await tenantMessageRows(acc.B, WAMID);
      expect(rowsB.map((r) => r.id)).toEqual([msg.B]);
      const rowsA = await tenantMessageRows(acc.A, WAMID);
      expect(rowsA.map((r) => r.id)).toEqual([msg.A]);
    });

    it("F-19: A's broadcast recipient is invisible from B", async () => {
      expect((await tenantBroadcastRecipient(acc.B, WAMID)).data).toBeNull();
      expect((await tenantBroadcastRecipient(acc.A, WAMID)).data).toMatchObject(
        { status: 'sent' }
      );
    });

    it("F-19: applying a status in B's context leaves A unchanged", async () => {
      const ids = (await tenantMessageRows(acc.B, WAMID)).map((r) => r.id);
      await admin.from('messages').update({ status: 'read' }).in('id', ids);
      const { data } = await admin
        .from('messages')
        .select('id, status')
        .in('id', [msg.A, msg.B]);
      const byId = Object.fromEntries(
        (data ?? []).map((r) => [r.id, r.status])
      );
      expect(byId[msg.B]).toBe('read');
      expect(byId[msg.A]).toBe('sent');
    });

    it('F-20: routing uses the real config; B (no WABA saved) is not routed without Meta confirming', async () => {
      forgetWabaConfirmations();
      const refuse: Partial<RoutingDeps> = {
        numberIsUnderWaba: async () => false,
      };
      const deps = await realDeps(refuse);
      expect(
        await resolveDeliveryTenant(phone.A, `WABA-A-${run}`, deps)
      ).toMatchObject({ ok: true, config: { account_id: acc.A } });
      expect(
        await resolveDeliveryTenant(phone.A, `WABA-B-${run}`, deps)
      ).toMatchObject({ ok: false, reason: 'waba_mismatch' });
      expect(
        await resolveDeliveryTenant(phone.B, `WABA-A-${run}`, deps)
      ).toMatchObject({ ok: false, reason: 'waba_unverified' });
    });

    it('F-20: a WABA already pinned by A can never be pinned for B (unique), even if "confirmed"', async () => {
      forgetWabaConfirmations();
      const deps = await realDeps({ numberIsUnderWaba: async () => true });
      const r = await resolveDeliveryTenant(phone.B, `WABA-A-${run}`, deps);
      expect(r).toMatchObject({
        ok: false,
        reason: 'waba_taken',
        accountId: acc.B,
      });
      const { data } = await admin
        .from('whatsapp_config')
        .select('waba_id')
        .eq('account_id', acc.B)
        .single();
      expect((data as { waba_id: string | null }).waba_id).toBeNull();
    });

    it("F-20: B's own WABA, confirmed, is pinned and then routes on the fast path", async () => {
      forgetWabaConfirmations();
      const deps = await realDeps({ numberIsUnderWaba: async () => true });
      expect(
        await resolveDeliveryTenant(phone.B, `WABA-B-${run}`, deps)
      ).toMatchObject({ ok: true, pinned: true });
      const strict = await realDeps({
        numberIsUnderWaba: async () => {
          throw new Error('must not be called');
        },
      });
      expect(
        await resolveDeliveryTenant(phone.B, `WABA-B-${run}`, strict)
      ).toMatchObject({
        ok: true,
        pinned: false,
        config: { account_id: acc.B },
      });
    });

    /** Real DB lookups and pinning; only the Meta call is replaced. */
    async function realDeps(over: Partial<RoutingDeps>): Promise<RoutingDeps> {
      return {
        findConfigs: async (p) => {
          const { data, error } = await admin
            .from('whatsapp_config')
            .select('*')
            .eq('phone_number_id', p);
          return { data: data as never, error };
        },
        numberIsUnderWaba: async () => true,
        pinWaba: async (c, w) => {
          const { error } = await admin
            .from('whatsapp_config')
            .update({ waba_id: w })
            .eq('account_id', c.account_id)
            .eq('phone_number_id', c.phone_number_id)
            .is('waba_id', null);
          return !error;
        },
        ...over,
      };
    }
  }
);
