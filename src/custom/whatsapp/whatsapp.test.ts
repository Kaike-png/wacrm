import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  WHATSAPP_CONFIG_PUBLIC_COLUMNS,
  WHATSAPP_SECRET_COLUMNS,
} from './columns';
import {
  installConsoleRedaction,
  redactSecrets,
  redactValue,
  safeMessage,
  tokenHint,
} from './redact';
import {
  computeConnectionStatus,
  statusFromChecks,
  type ConnectionChecks,
} from './status';

const META_TOKEN = 'EAAGm0PX4ZCpsBAKZCeH3x9QWE12345abcdeFGHIJklmnopQRS';

describe('redactSecrets', () => {
  it.each([
    [`token ${META_TOKEN} failed`, META_TOKEN],
    [`Authorization: Bearer ${META_TOKEN}`, META_TOKEN],
    [
      'GET /webhook?hub.mode=subscribe&hub.verify_token=s3cr3t-verify&hub.challenge=1',
      's3cr3t-verify',
    ],
    [
      'https://graph.facebook.com/v21.0/123?access_token=abc123secret',
      'abc123secret',
    ],
    ['{"access_token":"plain-secret","phone_number_id":"123"}', 'plain-secret'],
    ['{"pin":"123456"}', '123456'],
    [
      'stored a1b2c3d4e5f6a1b2c3d4e5f6:deadbeefdeadbeef:00112233445566778899aabbccddeeff',
      'deadbeefdeadbeef',
    ],
    [
      'key sk-proj-abcdefghijklmnopqrstuvwxyz012345',
      'abcdefghijklmnopqrstuvwxyz012345',
    ],
    ['wacrm_live_AbCdEf1234567890', 'AbCdEf1234567890'],
    [
      'jwt eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2lnbmF0dXJlLXZhbHVl',
      'c2lnbmF0dXJlLXZhbHVl',
    ],
  ])('removes the secret from: %s', (text, secret) => {
    const out = redactSecrets(text);
    expect(out).not.toContain(secret);
    expect(out).toContain('[redacted]');
  });

  it('keeps non-secret identifiers readable', () => {
    const text =
      'phone_number_id 1110001110001 waba 2220002220002 account 9ae6d706-610b-416b-8efb-edf3a2a2c972';
    expect(redactSecrets(text)).toBe(text);
  });
});

describe('redactValue', () => {
  it('drops secret-named keys and redacts nested strings and errors', () => {
    const err = new Error(`Meta said: invalid ${META_TOKEN}`);
    const out = redactValue({
      phone_number_id: '123',
      access_token: META_TOKEN,
      nested: { verify_token: 'v', note: `Bearer ${META_TOKEN}` },
      err,
    }) as Record<string, unknown>;
    const text =
      JSON.stringify(out) +
      String((out.err as Error).message) +
      String((out.err as Error).stack);
    expect(text).not.toContain(META_TOKEN);
    expect(out.phone_number_id).toBe('123');
    expect(out.access_token).toBe('[redacted]');
    expect((out.nested as Record<string, unknown>).verify_token).toBe(
      '[redacted]'
    );
  });

  it('console redaction wraps every method', () => {
    const lines: unknown[][] = [];
    const fake = {
      log: (...a: unknown[]) => lines.push(a),
      info: (...a: unknown[]) => lines.push(a),
      warn: (...a: unknown[]) => lines.push(a),
      error: (...a: unknown[]) => lines.push(a),
      debug: (...a: unknown[]) => lines.push(a),
    } as unknown as Console;
    installConsoleRedaction(fake);
    fake.error(
      '[whatsapp/config] save failed',
      { access_token: META_TOKEN },
      new Error(META_TOKEN)
    );
    expect(
      JSON.stringify(lines) + String((lines[0][2] as Error).message)
    ).not.toContain(META_TOKEN);
  });
});

describe('hints and messages', () => {
  it('shows at most the last 4 characters of a token', () => {
    expect(tokenHint(META_TOKEN)).toBe('••••pQRS');
    expect(tokenHint('short')).toBe('••••');
    expect(tokenHint(null)).toBeNull();
  });

  it('truncates and redacts stored messages', () => {
    expect(safeMessage(`x ${META_TOKEN}`)).not.toContain(META_TOKEN);
    expect(safeMessage('a'.repeat(900))!.length).toBe(500);
    expect(safeMessage(null)).toBeNull();
  });
});

describe('connection status', () => {
  const now = new Date('2026-10-05T12:00:00Z');
  it('maps the row to connected / pending / error / disconnected', () => {
    expect(computeConnectionStatus(null, now)).toBe('disconnected');
    expect(
      computeConnectionStatus(
        { status: 'connected', waba_id: '1', subscribed_apps_at: 'x' },
        now
      )
    ).toBe('connected');
    expect(
      computeConnectionStatus(
        { status: 'connected', waba_id: '1', subscribed_apps_at: null },
        now
      )
    ).toBe('pending');
    expect(computeConnectionStatus({ status: 'pending' }, now)).toBe('pending');
    expect(
      computeConnectionStatus(
        { status: 'connected', last_check_error: 'token expired' },
        now
      )
    ).toBe('error');
    expect(
      computeConnectionStatus(
        { status: 'disconnected', last_registration_error: 'bad PIN' },
        now
      )
    ).toBe('error');
    // Meta is delivering webhooks: connected even without a recorded subscription.
    expect(
      computeConnectionStatus(
        {
          status: 'pending',
          waba_id: '1',
          last_webhook_at: '2026-10-04T12:00:00Z',
        },
        now
      )
    ).toBe('connected');
  });

  it('derives the test result from the checks', () => {
    const ok: ConnectionChecks = {
      credentials: true,
      wabaMatch: true,
      subscribed: true,
      appIdMatch: null,
      registered: true,
      webhookRecent: false,
    };
    expect(statusFromChecks(ok)).toBe('connected');
    expect(statusFromChecks({ ...ok, subscribed: false })).toBe('pending');
    expect(statusFromChecks({ ...ok, appIdMatch: false })).toBe('pending');
    expect(statusFromChecks({ ...ok, wabaMatch: false })).toBe('error');
    expect(statusFromChecks({ ...ok, credentials: false })).toBe('error');
    expect(statusFromChecks({ ...ok, subscribed: null })).toBe('connected');
  });
});

describe('secrets stay on the server', () => {
  it('the public column list never includes a secret', () => {
    const cols = WHATSAPP_CONFIG_PUBLIC_COLUMNS.split(',').map((c) => c.trim());
    for (const secret of WHATSAPP_SECRET_COLUMNS)
      expect(cols).not.toContain(secret);
  });

  it('matches the GRANT in migration 905', () => {
    const sql = readFileSync(
      join(process.cwd(), 'supabase/migrations/905_whatsapp_saas.sql'),
      'utf8'
    );
    const grant =
      /GRANT SELECT \(([\s\S]*?)\) ON public\.whatsapp_config TO authenticated/.exec(
        sql
      )?.[1] ?? '';
    const granted = grant
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean)
      .sort();
    expect(granted).toEqual(
      WHATSAPP_CONFIG_PUBLIC_COLUMNS.split(',')
        .map((c) => c.trim())
        .sort()
    );
  });

  // Regression guard for upstream merges: browser code must not ask for
  // secrets, and server code reads whatsapp_config through config-store
  // (which uses the service role) instead of `select('*')` on a user client.
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name))
        out.push(full);
    }
    return out;
  }
  const files = walk(join(process.cwd(), 'src')).map((f) => ({
    rel: relative(process.cwd(), f).split('\\').join('/'),
    text: readFileSync(f, 'utf8'),
  }));

  it('no client component reads a WhatsApp secret column or select(*)', () => {
    const offenders = files
      .filter(({ text }) => /^['"]use client['"]/m.test(text))
      .filter(({ text }) =>
        /from\(['"]whatsapp_config['"]\)[\s\S]{0,120}\.select\(\s*['"](\*|[^'"]*(access_token|verify_token|\bpin\b))/.test(
          text
        )
      )
      .map(({ rel }) => rel);
    expect(offenders).toEqual([]);
  });

  it('server code does not select * from whatsapp_config outside the reviewed paths', () => {
    // The webhook and the engines run with the service role already.
    const allowed = new Set([
      'src/custom/whatsapp/config-store.ts',
      'src/app/api/whatsapp/webhook/route.ts',
      'src/lib/automations/meta-send.ts',
    ]);
    const offenders = files
      .filter(({ rel }) => !allowed.has(rel))
      .filter(({ text }) =>
        /from\(['"]whatsapp_config['"]\)\s*\n?\s*\.select\(['"]\*['"]\)/.test(
          text
        )
      )
      .map(({ rel }) => rel);
    expect(offenders).toEqual([]);
  });
});
