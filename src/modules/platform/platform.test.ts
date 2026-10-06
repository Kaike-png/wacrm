import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';

import messages from '@/custom/i18n/messages/pt.json';

import { describeAudit } from './audit-text';
import type { AuditEntry } from './types';
import { formatTaxIdAuto } from './ui';

const t = createTranslator({
  locale: 'pt-BR',
  messages,
  namespace: 'Custom.platform',
});
const PLAN_NAMES: Record<string, string> = { pro: 'Pro', start: 'Start' };
const fmt = {
  date: () => '05/10/2026',
  time: () => '14:30',
  planName: (code: string | null) => (code ? (PLAN_NAMES[code] ?? code) : null),
};

function entry(partial: Partial<AuditEntry>): AuditEntry {
  return {
    id: 1,
    created_at: '2026-10-05T17:30:00Z',
    actor_user_id: 'u',
    actor_email: 'ana@empresa.com',
    action: 'organization.suspended',
    target_account_id: 'a',
    target_account_name: 'Padaria Pão Quente',
    reason: null,
    details: {},
    ip: null,
    user_agent: null,
    ...partial,
  };
}

describe('audit sentences', () => {
  const say = (e: AuditEntry) =>
    describeAudit(e, (k, v) => t(k as never, v as never), fmt);

  it('reads like the requirement example', () => {
    expect(say(entry({ details: { from: 'active', to: 'suspended' } }))).toBe(
      'Admin ana@empresa.com suspendeu a organização Padaria Pão Quente em 05/10/2026 às 14:30.'
    );
  });

  it('describes reactivation with the statuses', () => {
    expect(
      say(
        entry({
          action: 'organization.reactivated',
          details: { from: 'suspended', to: 'trial' },
        })
      )
    ).toBe(
      'Admin ana@empresa.com reativou a organização Padaria Pão Quente em 05/10/2026 às 14:30 (Suspensa → Trial).'
    );
  });

  it('describes plan changes with plan names', () => {
    expect(
      say(
        entry({
          action: 'organization.plan_changed',
          details: { from: null, to: 'pro' },
        })
      )
    ).toBe(
      'Admin ana@empresa.com alterou o plano da organização Padaria Pão Quente de sem plano para Pro em 05/10/2026 às 14:30.'
    );
  });

  it('describes plan edits', () => {
    expect(
      say(
        entry({
          action: 'billing_plan.updated',
          target_account_id: null,
          target_account_name: null,
          details: { plan: 'pro' },
        })
      )
    ).toBe('Admin ana@empresa.com alterou o plano Pro em 05/10/2026 às 14:30.');
  });

  it('describes admin grants by the operator', () => {
    expect(
      say(
        entry({
          action: 'platform_admin.granted',
          actor_email: 'kaike@servidor',
          target_account_id: null,
          target_account_name: null,
          details: { email: 'ana@empresa.com' },
        })
      )
    ).toBe(
      'kaike@servidor concedeu acesso de admin da plataforma a ana@empresa.com em 05/10/2026 às 14:30.'
    );
  });

  it('has a sentence for every audit action in the migration', () => {
    const sql = readFileSync(
      join(process.cwd(), 'supabase/migrations/906_platform_admin.sql'),
      'utf8'
    );
    const block =
      /action\s+TEXT NOT NULL CHECK \(action IN \(([\s\S]*?)\)\)/.exec(
        sql
      )?.[1] ?? '';
    const actions = [...block.matchAll(/'([a-z_.]+)'/g)].map((m) => m[1]);
    expect(actions.length).toBeGreaterThan(5);
    const sentences = (
      messages as {
        Custom: { platform: { audit: { sentence: Record<string, string> } } };
      }
    ).Custom.platform.audit.sentence;
    for (const a of actions)
      expect(sentences[a.replace('.', '_')], a).toBeTruthy();
  });
});

describe('documents', () => {
  it('masks CPF and CNPJ', () => {
    expect(formatTaxIdAuto('52998224725')).toBe('529.982.247-25');
    expect(formatTaxIdAuto('11222333000181')).toBe('11.222.333/0001-81');
    expect(formatTaxIdAuto(null)).toBe('');
  });
});

describe('the platform panel never handles WhatsApp secrets', () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name))
        out.push(full);
    }
    return out;
  }

  it('no platform file reads token columns or decrypts', () => {
    const roots = [
      'src/modules/platform',
      'src/app/(fork)/platform',
      'src/app/api/(fork)/platform',
    ];
    const offenders: string[] = [];
    for (const root of roots) {
      for (const file of walk(join(process.cwd(), root))) {
        const text = readFileSync(file, 'utf8');
        if (
          /(?<!has_)\b(access_token|verify_token)\b|\bdecrypt\(|whatsapp\/encryption|config-store/.test(
            text
          )
        ) {
          offenders.push(relative(process.cwd(), file));
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('plan price input (909)', async () => {
  const { parsePriceCents } = await import('./plans-editor');
  it('accepts BR and plain formats, empty = not sold online', () => {
    expect(parsePriceCents('199,90')).toBe(19990);
    expect(parsePriceCents('R$ 1.299,90')).toBe(129990);
    expect(parsePriceCents('99.9')).toBe(9990);
    expect(parsePriceCents('49')).toBe(4900);
    expect(parsePriceCents('  ')).toBeNull();
    expect(parsePriceCents('-5')).toBeUndefined();
    expect(parsePriceCents('abc')).toBeUndefined();
    expect(parsePriceCents('1,999')).toBeUndefined();
  });
});
