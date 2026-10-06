import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  catalogueLocale,
  intlLocale,
  isValidTimeZone,
  resolveRegionalDefaults,
  resolveTenantSettings,
  templateLanguageFor,
  type LocaleSettings,
} from './config';
import {
  calendarDaysAgo,
  dayKey,
  formatCalendarDate,
  formatCompact,
  formatDate,
  formatDateTime,
  formatDecimal,
  formatDuration,
  formatListTimestamp,
  formatMoney,
  formatNumber,
  formatRelativeTime,
  formatTime,
  getActiveLocaleSettings,
  minutesOfDay,
  parseLocaleNumber,
  setActiveLocaleSettings,
  toLocaleInputNumber,
} from './format';
import { getAccountLocaleSettings } from './server';

const BR: LocaleSettings = {
  locale: 'pt-BR',
  timeZone: 'America/Sao_Paulo',
  currency: 'BRL',
};
const US: LocaleSettings = {
  locale: 'en-US',
  timeZone: 'America/New_York',
  currency: 'USD',
};
// 2026-10-05 17:30:05 UTC = 14:30:05 in São Paulo (UTC−3, no DST since 2019).
const AT = '2026-10-05T17:30:05Z';
/** Intl uses (narrow) no-break spaces; compare with plain ones. */
const sp = (s: string) => s.replace(/[\u00a0\u202f]/g, ' ');

describe('locale config', () => {
  it('maps every spelling of a locale onto its catalogue', () => {
    for (const raw of ['pt', 'pt-BR', 'pt_BR', 'PT-br', ' pt-PT ']) {
      expect(catalogueLocale(raw)).toBe('pt');
    }
    expect(catalogueLocale('es-MX')).toBe('es');
    expect(catalogueLocale('fr')).toBe('en');
    expect(catalogueLocale(undefined)).toBe('en');
  });

  it('keeps an explicit region and adds the default one otherwise', () => {
    expect(intlLocale('pt')).toBe('pt-BR');
    expect(intlLocale('pt_br')).toBe('pt-BR');
    expect(intlLocale('pt-PT')).toBe('pt-PT');
    expect(intlLocale('en')).toBe('en-US');
    expect(intlLocale('es')).toBe('es-419');
    expect(intlLocale('')).toBe('pt-BR');
  });

  it('defaults a deploy to pt-BR / America/Sao_Paulo / BRL', () => {
    expect(resolveRegionalDefaults({})).toEqual(BR);
    expect(resolveRegionalDefaults({ NEXT_PUBLIC_APP_LOCALE: 'pt' })).toEqual(
      BR
    );
    expect(resolveRegionalDefaults({ NEXT_PUBLIC_APP_LOCALE: 'en' })).toEqual({
      locale: 'en-US',
      timeZone: 'America/Sao_Paulo',
      currency: 'USD',
    });
    expect(
      resolveRegionalDefaults({
        NEXT_PUBLIC_APP_LOCALE: 'en',
        NEXT_PUBLIC_DEFAULT_TIMEZONE: 'Europe/Lisbon',
        NEXT_PUBLIC_DEFAULT_CURRENCY: 'eur',
      })
    ).toEqual({ locale: 'en-US', timeZone: 'Europe/Lisbon', currency: 'EUR' });
    expect(
      resolveRegionalDefaults({ NEXT_PUBLIC_DEFAULT_TIMEZONE: 'Mars/Base' })
        .timeZone
    ).toBe('America/Sao_Paulo');
  });

  it('lets each tenant override the defaults, ignoring invalid values', () => {
    expect(
      resolveTenantSettings(
        {
          locale: 'en-GB',
          timezone: 'America/Manaus',
          default_currency: 'USD',
        },
        BR
      )
    ).toEqual({ locale: 'en-GB', timeZone: 'America/Manaus', currency: 'USD' });
    expect(
      resolveTenantSettings(
        { locale: '???', timezone: 'Mars/Base', default_currency: 'real' },
        BR
      )
    ).toEqual(BR);
    expect(resolveTenantSettings(null, BR)).toEqual(BR);
    expect(isValidTimeZone('America/Sao_Paulo')).toBe(true);
    expect(isValidTimeZone('')).toBe(false);
  });
});

describe('templateLanguageFor', () => {
  it('maps the tenant locale onto a Meta template language code', () => {
    expect(templateLanguageFor('pt-BR')).toBe('pt_BR');
    expect(templateLanguageFor('pt')).toBe('pt_BR');
    expect(templateLanguageFor('pt-PT')).toBe('pt_PT');
    expect(templateLanguageFor('en-US')).toBe('en_US');
    expect(templateLanguageFor('es-419')).toBe('es');
    expect(templateLanguageFor('es-MX')).toBe('es_MX');
    expect(templateLanguageFor('ko-KR')).toBe('ko');
    expect(templateLanguageFor('fr-FR')).toBe('fr_FR');
  });
});

describe('formatting (pt-BR)', () => {
  it('dates and times in the tenant time zone', () => {
    expect(sp(formatDate(AT, 'short', BR))).toBe('05/10/2026');
    expect(sp(formatDate(AT, 'medium', BR))).toBe('5 de out. de 2026');
    expect(sp(formatDate(AT, 'long', BR))).toBe('5 de outubro de 2026');
    expect(sp(formatTime(AT, {}, BR))).toBe('14:30');
    expect(sp(formatTime(AT, { seconds: true }, BR))).toBe('14:30:05');
    expect(sp(formatDateTime(AT, 'short', BR))).toBe('05/10/2026, 14:30');
    expect(sp(formatDate('not a date', 'short', BR))).toBe('');
  });

  it('the same instant on another tenant', () => {
    expect(sp(formatDateTime(AT, 'short', US))).toBe('10/05/2026, 01:30 PM');
  });

  it('never shifts date-only values', () => {
    // new Date('2026-10-05') is UTC midnight = 4 Oct 21:00 in São Paulo.
    expect(sp(formatCalendarDate('2026-10-05', 'short', BR))).toBe(
      '05/10/2026'
    );
    expect(sp(formatCalendarDate('2026-10-05', 'dayMonth', BR))).toBe(
      '5 de out.'
    );
    expect(sp(formatCalendarDate(null, 'short', BR))).toBe('');
  });

  it('groups by calendar day in the tenant time zone', () => {
    // 02:00 UTC on the 6th is still the 5th in São Paulo.
    expect(dayKey('2026-10-06T02:00:00Z', BR)).toBe('2026-10-05');
    expect(dayKey('2026-10-06T02:00:00Z', { ...BR, timeZone: 'UTC' })).toBe(
      '2026-10-06'
    );
    expect(
      calendarDaysAgo('2026-10-05T02:59:00Z', '2026-10-05T03:01:00Z', BR)
    ).toBe(1);
    expect(minutesOfDay(AT, BR)).toBe(14 * 60 + 30);
    expect(minutesOfDay('2026-10-06T02:59:00Z', BR)).toBe(23 * 60 + 59);
  });

  it('relative times read naturally', () => {
    const now = new Date(AT);
    const ago = (ms: number) => new Date(now.getTime() - ms);
    expect(sp(formatRelativeTime(ago(10_000), now, BR))).toBe('agora');
    expect(sp(formatRelativeTime(ago(5 * 60_000), now, BR))).toBe(
      'há 5 minutos'
    );
    expect(sp(formatRelativeTime(ago(3 * 3_600_000), now, BR))).toBe(
      'há 3 horas'
    );
    expect(sp(formatRelativeTime(ago(26 * 3_600_000), now, BR))).toBe('ontem');
    expect(sp(formatListTimestamp(ago(60_000), now, BR))).toBe('14:29');
    expect(sp(formatListTimestamp(ago(24 * 3_600_000), now, BR))).toBe('ontem');
    expect(sp(formatListTimestamp(ago(3 * 86_400_000), now, BR))).toBe('sex.');
    expect(sp(formatListTimestamp(ago(30 * 86_400_000), now, BR))).toBe(
      '05/09/2026'
    );
    expect(sp(formatDuration(45_000, BR))).toBe('45 segundos');
    expect(sp(formatDuration(5 * 60_000, BR))).toBe('5 minutos');
    expect(sp(formatDuration(90 * 60_000, BR))).toBe('1,5 hora');
  });

  it('numbers and money use the Brazilian separators', () => {
    expect(sp(formatNumber(1234567, {}, BR))).toBe('1.234.567');
    expect(sp(formatDecimal(1.5, 1, BR))).toBe('1,5');
    expect(sp(formatCompact(1500, BR))).toBe('1,5 mil');
    expect(sp(formatCompact(2_300_000, BR))).toBe('2,3 mi');
    expect(sp(formatMoney(1234.5, 'BRL', {}, BR))).toBe('R$ 1.234,50');
    expect(sp(formatMoney(1234.5, 'BRL', { decimals: 0 }, BR))).toBe(
      'R$ 1.235'
    );
    expect(sp(formatMoney(1500, 'BRL', { compact: true }, BR))).toBe(
      'R$ 1,5 mil'
    );
    expect(sp(formatMoney(10, 'USD', {}, BR))).toBe('US$ 10,00');
    expect(() => formatMoney(10, 'United States', {}, BR)).not.toThrow();
  });
});

describe('parsing typed numbers', () => {
  it('reads what a Brazilian types', () => {
    const cases: [string, number | null][] = [
      ['1.500,50', 1500.5],
      ['1500,5', 1500.5],
      ['1.500', 1500],
      ['1.234.567', 1234567],
      ['R$ 1.500,00', 1500],
      ['0,99', 0.99],
      ['1,500', 1.5], // comma is the pt-BR decimal separator
      ['1500.50', 1500.5], // "international" style still works
      ['1,234.56', 1234.56],
      ['1.5', 1.5],
      ['-10,5', -10.5],
      ['', null],
      ['abc', null],
    ];
    for (const [input, want] of cases) {
      expect(parseLocaleNumber(input, BR), input).toBe(want);
    }
  });

  it('follows the en-US separators for an en-US tenant', () => {
    expect(parseLocaleNumber('1,500', US)).toBe(1500);
    expect(parseLocaleNumber('1.500', US)).toBe(1.5);
    expect(parseLocaleNumber('1,500.25', US)).toBe(1500.25);
  });

  it('round-trips through the editable form', () => {
    expect(toLocaleInputNumber(1500.5, BR)).toBe('1500,5');
    expect(toLocaleInputNumber(1234567, BR)).toBe('1234567');
    expect(toLocaleInputNumber(null, BR)).toBe('');
    for (const n of [0, 1500.5, 1234567.89, 0.01]) {
      expect(parseLocaleNumber(toLocaleInputNumber(n, BR), BR)).toBe(n);
      expect(parseLocaleNumber(toLocaleInputNumber(n, US), US)).toBe(n);
    }
  });
});

describe('active settings', () => {
  it('fall back to the deploy defaults and are never set on the server', () => {
    // vitest runs in node: no `window`, so the setter is a no-op.
    setActiveLocaleSettings(US);
    expect(getActiveLocaleSettings()).not.toEqual(US);
    expect(getActiveLocaleSettings().timeZone).toBe('UTC'); // vitest.config env
  });
});

describe('getAccountLocaleSettings', () => {
  const db = (result: { data: unknown; error: unknown } | Error) => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            if (result instanceof Error) throw result;
            return result;
          },
        }),
      }),
    }),
  });

  it('reads the tenant row', async () => {
    const s = await getAccountLocaleSettings(
      db({
        data: {
          locale: 'pt-BR',
          timezone: 'America/Manaus',
          default_currency: 'BRL',
        },
        error: null,
      }),
      'acc-1'
    );
    expect(s).toEqual({
      locale: 'pt-BR',
      timeZone: 'America/Manaus',
      currency: 'BRL',
    });
  });

  it('falls back to the defaults when the migration is missing or the call fails', async () => {
    const defaults = getActiveLocaleSettings();
    expect(
      await getAccountLocaleSettings(
        db({ data: null, error: { code: '42703' } }),
        'a'
      )
    ).toEqual(defaults);
    expect(
      await getAccountLocaleSettings(db(new Error('network')), 'a')
    ).toEqual(defaults);
    expect(
      await getAccountLocaleSettings(db({ data: null, error: null }), null)
    ).toEqual(defaults);
  });
});

describe('migration 900', () => {
  const sql = readFileSync(
    join(
      process.cwd(),
      'supabase',
      'migrations',
      '900_custom_account_locale.sql'
    ),
    'utf8'
  );

  it('is idempotent and defaults new accounts to pt-BR / São Paulo / BRL', () => {
    expect(sql).toMatch(
      /ADD COLUMN IF NOT EXISTS locale TEXT NOT NULL DEFAULT 'pt-BR'/
    );
    expect(sql).toMatch(
      /ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'America\/Sao_Paulo'/
    );
    expect(sql).toMatch(/default_currency SET DEFAULT 'BRL'/);
    expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS accounts_locale_format/);
    expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS accounts_timezone_valid/);
  });
});
