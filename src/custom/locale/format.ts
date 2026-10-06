/**
 * Locale-, time-zone- and currency-aware formatting (fork, see
 * docs/LOCALIZATION.md).
 *
 * Every function takes an optional `LocaleSettings`; without one it uses
 * the *active* settings: the signed-in tenant's (set by
 * `TenantLocaleProvider` in the browser) or the deploy defaults. Server
 * code should pass the tenant settings explicitly (see `server.ts`):
 * the active settings are only ever set in the browser, so a server
 * process never shares one tenant's settings with another request.
 *
 * Built on `Intl` only (no date-fns locales), so pt-BR gets
 * `05/10/2026`, `14:30`, `R$ 1.234,56`, `1,5 mil`, `há 5 minutos`.
 */
import { regionalDefaults, type LocaleSettings } from './config';

let active: LocaleSettings | null = null;

/** Browser only (TenantLocaleProvider). No-op on the server. */
export function setActiveLocaleSettings(settings: LocaleSettings | null): void {
  if (typeof window === 'undefined') return;
  active = settings;
}

export function getActiveLocaleSettings(): LocaleSettings {
  return active ?? regionalDefaults;
}

type DateInput = Date | string | number;

function toDate(value: DateInput): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

const cache = new Map<string, Intl.DateTimeFormat | Intl.NumberFormat>();

function dtf(
  s: LocaleSettings,
  opts: Intl.DateTimeFormatOptions
): Intl.DateTimeFormat {
  const key = `d|${s.locale}|${s.timeZone}|${JSON.stringify(opts)}`;
  let f = cache.get(key) as Intl.DateTimeFormat | undefined;
  if (!f) {
    f = new Intl.DateTimeFormat(s.locale, { timeZone: s.timeZone, ...opts });
    cache.set(key, f);
  }
  return f;
}

function nf(locale: string, opts: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `n|${locale}|${JSON.stringify(opts)}`;
  let f = cache.get(key) as Intl.NumberFormat | undefined;
  if (!f) {
    f = new Intl.NumberFormat(locale, opts);
    cache.set(key, f);
  }
  return f;
}

export const DATE_PRESETS = {
  /** 05/10/2026 */
  short: { day: '2-digit', month: '2-digit', year: 'numeric' },
  /** 5 de out. de 2026 */
  medium: { day: 'numeric', month: 'short', year: 'numeric' },
  /** 5 de outubro de 2026 */
  long: { day: 'numeric', month: 'long', year: 'numeric' },
  /** 5 de out. */
  dayMonth: { day: 'numeric', month: 'short' },
  /** dom., 5 de out. */
  weekdayDayMonth: { weekday: 'short', day: 'numeric', month: 'short' },
} as const satisfies Record<string, Intl.DateTimeFormatOptions>;

export type DatePreset = keyof typeof DATE_PRESETS;

/** Calendar date in the tenant time zone. Invalid input → ''. */
export function formatDate(
  value: DateInput,
  preset: DatePreset = 'short',
  settings: LocaleSettings = getActiveLocaleSettings()
): string {
  const date = toDate(value);
  return date ? dtf(settings, DATE_PRESETS[preset]).format(date) : '';
}

/** 14:30 (or 14:30:05). 24-hour clock wherever the locale uses it. */
export function formatTime(
  value: DateInput,
  { seconds = false }: { seconds?: boolean } = {},
  settings: LocaleSettings = getActiveLocaleSettings()
): string {
  const date = toDate(value);
  if (!date) return '';
  return dtf(settings, {
    hour: '2-digit',
    minute: '2-digit',
    ...(seconds ? { second: '2-digit' } : {}),
  }).format(date);
}

/** 05/10/2026 14:30 (`preset` picks the date part). */
export function formatDateTime(
  value: DateInput,
  preset: DatePreset = 'short',
  settings: LocaleSettings = getActiveLocaleSettings()
): string {
  const date = toDate(value);
  if (!date) return '';
  return dtf(settings, {
    ...DATE_PRESETS[preset],
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

/**
 * A date-only value (`2026-10-05`, e.g. a deal's expected close date).
 * Formatted as a calendar date, never shifted by the time zone:
 * `new Date('2026-10-05')` is UTC midnight, which is still the 4th in
 * São Paulo.
 */
export function formatCalendarDate(
  value: string | null | undefined,
  preset: DatePreset = 'short',
  settings: LocaleSettings = getActiveLocaleSettings()
): string {
  if (!value) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return formatDate(value, preset, settings);
  const utc = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12));
  return dtf({ ...settings, timeZone: 'UTC' }, DATE_PRESETS[preset]).format(
    utc
  );
}

/** `YYYY-MM-DD` of `value` in the tenant time zone (for day grouping). */
export function dayKey(
  value: DateInput,
  settings: LocaleSettings = getActiveLocaleSettings()
): string {
  const date = toDate(value);
  if (!date) return '';
  const parts = dtf(
    { ...settings, locale: 'en-CA' },
    {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }
  ).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Minutes since local midnight in the tenant time zone (0–1439). */
export function minutesOfDay(
  value: DateInput,
  settings: LocaleSettings = getActiveLocaleSettings()
): number {
  const date = toDate(value);
  if (!date) return 0;
  const parts = dtf(
    { ...settings, locale: 'en-GB' },
    {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }
  ).formatToParts(date);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return (h % 24) * 60 + m;
}

/** Days between the calendar day of `value` and today (tenant TZ): 0 today, 1 yesterday. */
export function calendarDaysAgo(
  value: DateInput,
  now: DateInput = new Date(),
  settings: LocaleSettings = getActiveLocaleSettings()
): number {
  const a = dayKey(value, settings);
  const b = dayKey(now, settings);
  if (!a || !b) return NaN;
  return Math.round(
    (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000
  );
}

const RELATIVE_STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['second', 60],
  ['minute', 60],
  ['hour', 24],
  ['day', 30],
  ['month', 12],
  ['year', Number.POSITIVE_INFINITY],
];

/** "há 5 minutos", "em 2 dias", "ontem". */
export function formatRelativeTime(
  value: DateInput,
  now: DateInput = new Date(),
  settings: LocaleSettings = getActiveLocaleSettings()
): string {
  const date = toDate(value);
  const ref = toDate(now);
  if (!date || !ref) return '';
  let delta = (date.getTime() - ref.getTime()) / 1000;
  for (const [unit, size] of RELATIVE_STEPS) {
    if (Math.abs(delta) < size || unit === 'year') {
      const rtf = new Intl.RelativeTimeFormat(settings.locale, {
        numeric: 'auto',
      });
      // Under a minute reads better as "agora" than "há 12 segundos".
      if (unit === 'second') return rtf.format(0, 'second');
      return rtf.format(Math.round(delta), unit);
    }
    delta /= size;
  }
  return '';
}

/** 1.234 / 1.234,5 — grouping and decimal separator of the locale. */
export function formatNumber(
  value: number,
  opts: Intl.NumberFormatOptions = {},
  settings: LocaleSettings = getActiveLocaleSettings()
): string {
  return nf(settings.locale, opts).format(Number(value) || 0);
}

/** Fixed decimals with the locale separator: `formatDecimal(1.5, 1)` → `1,5`. */
export function formatDecimal(
  value: number,
  digits = 1,
  settings: LocaleSettings = getActiveLocaleSettings()
): string {
  return formatNumber(
    value,
    { minimumFractionDigits: digits, maximumFractionDigits: digits },
    settings
  );
}

/** `0.42` → `42%`. */
export function formatPercent(
  ratio: number,
  digits = 0,
  settings: LocaleSettings = getActiveLocaleSettings()
): string {
  return formatNumber(
    ratio,
    { style: 'percent', maximumFractionDigits: digits },
    settings
  );
}

/** 1,5 mil / 2,3 mi (pt-BR); 1.5K / 2.3M (en-US). */
export function formatCompact(
  value: number,
  settings: LocaleSettings = getActiveLocaleSettings()
): string {
  return formatNumber(
    value,
    { notation: 'compact', maximumFractionDigits: 1 },
    settings
  );
}

/**
 * R$ 1.234,56. `decimals` defaults to the currency's own minor unit
 * (2 for BRL, 0 for JPY); pass 0 for whole-number totals.
 */
export function formatMoney(
  value: number,
  currency: string = getActiveLocaleSettings().currency,
  { decimals, compact = false }: { decimals?: number; compact?: boolean } = {},
  settings: LocaleSettings = getActiveLocaleSettings()
): string {
  const code = (currency || settings.currency).trim().toUpperCase();
  const amount = Number(value) || 0;
  const opts: Intl.NumberFormatOptions = {
    style: 'currency',
    currency: code,
    ...(compact ? { notation: 'compact', maximumFractionDigits: 1 } : {}),
    ...(decimals !== undefined && !compact
      ? { minimumFractionDigits: decimals, maximumFractionDigits: decimals }
      : {}),
  };
  try {
    return nf(settings.locale, opts).format(amount);
  } catch {
    // Unknown ISO code: still legible instead of throwing.
    return `${code} ${formatNumber(amount, { maximumFractionDigits: 2 }, settings)}`;
  }
}

/** File size in MB with the locale decimal separator (`1,5`). */
export function formatMegabytes(
  bytes: number,
  settings: LocaleSettings = getActiveLocaleSettings()
): string {
  return formatDecimal(bytes / 1024 / 1024, 1, settings);
}

/** Decimal and grouping separators of a locale (`,` and `.` for pt-BR). */
export function numberSeparators(
  settings: LocaleSettings = getActiveLocaleSettings()
): { decimal: string; group: string } {
  const parts = nf(settings.locale, {}).formatToParts(1234567.5);
  return {
    decimal: parts.find((p) => p.type === 'decimal')?.value ?? '.',
    group: parts.find((p) => p.type === 'group')?.value ?? ',',
  };
}

/**
 * Parse a number typed by a person: `1.500,50`, `1500,5`, `R$ 1.500`
 * (pt-BR) and also the "international" `1500.50` / `1,500.50`.
 *
 * Rules: with both separators present the last one is the decimal.
 * With only one kind, the locale's decimal separator is a decimal; the
 * other one is a thousands separator when it repeats or is followed by
 * exactly three digits (`1.500` → 1500 in pt-BR), a decimal otherwise
 * (`1.5` → 1,5). Returns `null` for empty / non-numeric input.
 */
export function parseLocaleNumber(
  input: string | number | null | undefined,
  settings: LocaleSettings = getActiveLocaleSettings()
): number | null {
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;
  const raw = (input ?? '').replace(/[\s\u00a0\u202f]/g, '');
  const negative = /^-|^\(.*\)$|-$/.test(raw.replace(/[^\d,.()-]/g, ''));
  const s = raw.replace(/[^\d,.]/g, '');
  if (!/\d/.test(s)) return null;

  const { decimal } = numberSeparators(settings);
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  let decimalChar: string | null = null;
  if (lastDot >= 0 && lastComma >= 0) {
    decimalChar = lastDot > lastComma ? '.' : ',';
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? '.' : ',';
    const count = s.split(sep).length - 1;
    const after = s.length - s.lastIndexOf(sep) - 1;
    const looksGrouped = count > 1 || after === 3;
    decimalChar =
      sep === decimal ? (count > 1 ? null : sep) : looksGrouped ? null : sep;
  }

  const normalized = decimalChar
    ? s
        .split(decimalChar)
        .map((part, i, all) =>
          i === all.length - 1 ? part : part.replace(/[,.]/g, '')
        )
    : [s.replace(/[,.]/g, '')];
  const text =
    normalized.length > 1
      ? `${normalized.slice(0, -1).join('')}.${normalized[normalized.length - 1]}`
      : normalized[0];
  const n = Number(text);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

/**
 * A number as an editable string: no grouping, locale decimal
 * separator (`1500,5` in pt-BR). Round-trips with {@link parseLocaleNumber}.
 */
export function toLocaleInputNumber(
  value: number | null | undefined,
  settings: LocaleSettings = getActiveLocaleSettings()
): string {
  if (value === null || value === undefined || !Number.isFinite(Number(value)))
    return '';
  return formatNumber(
    Number(value),
    { useGrouping: false, maximumFractionDigits: 20 },
    settings
  );
}

/**
 * Compact timestamp for lists, WhatsApp style: `14:30` today, `ontem`,
 * the weekday within a week (`seg.`), else `05/10/2026`.
 */
export function formatListTimestamp(
  value: DateInput,
  now: DateInput = new Date(),
  settings: LocaleSettings = getActiveLocaleSettings()
): string {
  const date = toDate(value);
  if (!date) return '';
  const days = calendarDaysAgo(date, now, settings);
  if (days <= 0) return formatTime(date, {}, settings);
  if (days === 1) {
    return new Intl.RelativeTimeFormat(settings.locale, {
      numeric: 'auto',
    }).format(-1, 'day');
  }
  if (days < 7) return dtf(settings, { weekday: 'short' }).format(date);
  return formatDate(date, 'short', settings);
}

/** Elapsed time in the largest sensible unit: `45 segundos`, `5 minutos`, `2 horas`. */
export function formatDuration(
  ms: number,
  settings: LocaleSettings = getActiveLocaleSettings()
): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  const [value, unit] =
    sec < 60
      ? [sec, 'second']
      : sec < 3600
        ? [Math.round(sec / 60), 'minute']
        : sec < 86_400
          ? [Math.round(sec / 360) / 10, 'hour']
          : [Math.round(sec / 8640) / 10, 'day'];
  return formatNumber(
    value as number,
    {
      style: 'unit',
      unit: unit as string,
      unitDisplay: 'long',
      maximumFractionDigits: 1,
    },
    settings
  );
}

/** Calendar-day heading: "Hoje" / "Ontem" are left to the caller; this is the date part. */
export function isTodayInTz(
  value: DateInput,
  settings: LocaleSettings = getActiveLocaleSettings()
): boolean {
  return calendarDaysAgo(value, new Date(), settings) === 0;
}

export function isYesterdayInTz(
  value: DateInput,
  settings: LocaleSettings = getActiveLocaleSettings()
): boolean {
  return calendarDaysAgo(value, new Date(), settings) === 1;
}
