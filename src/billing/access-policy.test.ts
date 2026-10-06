import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  restrictionBody,
  restrictionMessage,
  tenantRestrictionOf,
  TenantRestrictedError,
} from './access-errors';
import {
  ACCESS_POLICY,
  ALWAYS_ALLOWED,
  canPerform,
  graceDaysFromEnv,
  paymentReopens,
  RESTRICTABLE_ACTIONS,
  statusesBlocking,
} from './access-policy';
import { ACCOUNT_STATUSES } from './account-status';
import pt from '../custom/i18n/messages/pt.json';
import en from '../custom/i18n/messages/en.json';

const migrations = join(process.cwd(), 'supabase/migrations');

describe('delinquency policy (single matrix)', () => {
  it('past_due keeps everything working (warning + payment only)', () => {
    for (const a of RESTRICTABLE_ACTIONS)
      expect(canPerform('past_due', a)).toBe(true);
    expect(ACCESS_POLICY.past_due.notice).toBe('payment_due');
  });

  it('suspended blocks sending, campaigns, automations and new integrations — nothing else', () => {
    expect([...ACCESS_POLICY.suspended.blocks].sort()).toEqual(
      [
        'automations.run',
        'campaigns.send',
        'integrations.create',
        'messages.send',
      ].sort()
    );
    expect(ACCESS_POLICY.suspended.receivesInbound).toBe(true);
    // login, data, export, billing and payment are never restrictable
    for (const a of ALWAYS_ALLOWED)
      expect((RESTRICTABLE_ACTIONS as readonly string[]).includes(a)).toBe(
        false
      );
  });

  it('active and trial block nothing; every status has a policy', () => {
    for (const s of ACCOUNT_STATUSES) expect(ACCESS_POLICY[s]).toBeDefined();
    expect(ACCESS_POLICY.active.blocks).toEqual([]);
    expect(ACCESS_POLICY.trial.blocks).toEqual([]);
    expect(statusesBlocking('messages.send')).toEqual([
      'suspended',
      'cancelled',
    ]);
  });

  it('a payment lifts a billing suspension, never a suspension by the team nor a cancellation', () => {
    expect(paymentReopens('past_due', null)).toBe(true);
    expect(paymentReopens('trial', null)).toBe(true);
    expect(paymentReopens('suspended', 'billing')).toBe(true);
    expect(paymentReopens('suspended', 'platform')).toBe(false);
    expect(paymentReopens('cancelled', 'billing')).toBe(false);
  });

  it('grace period comes from BILLING_GRACE_DAYS (default 7, invalid ignored)', () => {
    expect(graceDaysFromEnv({} as NodeJS.ProcessEnv)).toBe(7);
    expect(
      graceDaysFromEnv({
        BILLING_GRACE_DAYS: '15',
      } as unknown as NodeJS.ProcessEnv)
    ).toBe(15);
    expect(
      graceDaysFromEnv({
        BILLING_GRACE_DAYS: '0',
      } as unknown as NodeJS.ProcessEnv)
    ).toBe(0);
    expect(
      graceDaysFromEnv({
        BILLING_GRACE_DAYS: '-3',
      } as unknown as NodeJS.ProcessEnv)
    ).toBe(7);
    expect(
      graceDaysFromEnv({
        BILLING_GRACE_DAYS: 'x',
      } as unknown as NodeJS.ProcessEnv)
    ).toBe(7);
  });
});

describe('policy-sync: TypeScript matrix == SQL matrix (migration 911)', () => {
  const sql = readFileSync(
    join(migrations, '911_billing_delinquency.sql'),
    'utf8'
  );
  const fn =
    /FUNCTION public\.account_status_blocks[\s\S]*?\$\$([\s\S]*?)\$\$/.exec(
      sql
    )![1];

  it('account_status_blocks lists exactly what ACCESS_POLICY blocks', () => {
    const sqlBlocks: Record<string, string[]> = {};
    for (const m of fn.matchAll(/WHEN '([a-z_]+)' THEN ARRAY\[([^\]]*)\]/g)) {
      sqlBlocks[m[1]] = [...m[2].matchAll(/'([a-z.]+)'/g)]
        .map((x) => x[1])
        .sort();
    }
    for (const s of ACCOUNT_STATUSES) {
      expect(sqlBlocks[s] ?? [], s).toEqual(
        [...ACCESS_POLICY[s].blocks].sort()
      );
    }
  });

  it('no later migration puts a status check back into is_account_member', () => {
    // Data access must not depend on the status (suspended keeps login,
    // data and export). An upstream migration redefining the function
    // after 911 must keep it that way.
    const defining = readdirSync(migrations)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .filter((f) =>
        /CREATE OR REPLACE FUNCTION\s+(public\.)?is_account_member\s*\(/i.test(
          readFileSync(join(migrations, f), 'utf8')
        )
      );
    const last = defining.at(-1)!;
    expect(last >= '911').toBe(true);
    const body = readFileSync(join(migrations, last), 'utf8');
    const def =
      /FUNCTION public\.is_account_member[\s\S]*?\$\$([\s\S]*?)\$\$/.exec(
        body
      )![1];
    expect(def.replace(/--.*$/gm, '')).not.toMatch(/\bstatus\b/i);
  });

  it('no source outside the policy compares an organization status to decide access', () => {
    const root = join(process.cwd(), 'src');
    const files: string[] = [];
    const walk = (d: string) =>
      readdirSync(d, { withFileTypes: true }).forEach((e) =>
        e.isDirectory()
          ? walk(join(d, e.name))
          : /\.(ts|tsx)$/.test(e.name) &&
            !/\.test\./.test(e.name) &&
            files.push(join(d, e.name))
      );
    walk(root);
    // The policy itself, the billing domain (subscription lifecycle, not
    // access) and the operator panel (shows / changes the status).
    const allowed =
      /src\/billing\/(access-policy|account-status)\.ts$|src\/billing\/payments\/|src\/billing\/subscription-card\.tsx$|src\/modules\/platform\//;
    const offenders = files.filter((f) => {
      if (allowed.test(f)) return false;
      const src = readFileSync(f, 'utf8');
      return /(status|accountStatus|subscription\??\.status)\s*[!=]==?\s*['"](suspended|cancelled|past_due)['"]/.test(
        src
      );
    });
    expect(offenders.map((f) => f.replace(process.cwd() + '/', ''))).toEqual(
      []
    );
  });
});

describe('refusals', () => {
  // next-intl semantics: dots are nesting.
  const get = (o: unknown, path: string): unknown =>
    path
      .split('.')
      .reduce<unknown>(
        (x, part) => (x as Record<string, unknown> | undefined)?.[part],
        o
      );
  const t = (k: string) => get(pt, `Custom.billing.access.${k}`) as string;

  it('database refusal (TR403 + hint) and TenantRestrictedError read the same', () => {
    const db = {
      code: 'TR403',
      message: 'tenant_restricted',
      details: 'campaigns.send',
      hint: '{"action": "campaigns.send", "status": "suspended"}',
    };
    expect(tenantRestrictionOf(db)).toEqual({
      action: 'campaigns.send',
      status: 'suspended',
    });
    expect(
      tenantRestrictionOf(
        new TenantRestrictedError('messages.send', 'cancelled')
      )
    ).toEqual({ action: 'messages.send', status: 'cancelled' });
    expect(tenantRestrictionOf({ code: '23505' })).toBeNull();
    expect(tenantRestrictionOf(new Error('x'))).toBeNull();
  });

  it('friendly pt-BR message and 403 body', () => {
    const msg = restrictionMessage(
      { action: 'messages.send', status: 'suspended' },
      t
    );
    expect(msg).toMatch(/^Envio de mensagens bloqueado/);
    expect(msg).toMatch(/pagamento/i);
    expect(
      restrictionBody(
        new TenantRestrictedError('campaigns.send', 'suspended'),
        t
      )
    ).toMatchObject({
      code: 'tenant_restricted',
      action: 'campaigns.send',
      status: 'suspended',
    });
  });

  it('every action and reason has a message in pt and en', () => {
    for (const cat of [pt, en]) {
      const a = (path: string) => get(cat, `Custom.billing.access.${path}`);
      for (const action of RESTRICTABLE_ACTIONS)
        expect(a(`blocked.${action}`), action).toBeTruthy();
      for (const st of ['past_due', 'suspended', 'cancelled'])
        expect(a(`reason.${st}`), st).toBeTruthy();
      for (const n of ['payment_due', 'suspended', 'cancelled'])
        expect(a(`notice.${n}.title`), n).toBeTruthy();
    }
  });
});
