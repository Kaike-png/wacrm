'use client';

/**
 * Settings card: tenant formatting locale + time zone (fork). Rendered
 * under the currency card in Configurações → Região e moeda
 * (FORK-PATCH(P-004) in src/app/(dashboard)/settings/page.tsx).
 *
 * Writes `accounts.locale` / `accounts.timezone`; the existing
 * `accounts_update` RLS policy limits that to admins, mirrored here by
 * `canEditSettings`.
 */
import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Globe2, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { createBrowserSupabase, useAuth } from '../core/client';
import {
  BRAZIL_TIME_ZONES,
  FORMAT_LOCALES,
  intlLocale,
  regionalDefaults,
  type LocaleSettings,
} from './config';
import { formatDateTime, formatMoney, formatNumber } from './format';
import { useLocaleSettings } from './tenant-locale';

const selectClass =
  'h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-60';

export function allTimeZones(): string[] {
  const supported =
    typeof Intl.supportedValuesOf === 'function'
      ? Intl.supportedValuesOf('timeZone')
      : [];
  const brazil = new Set<string>(BRAZIL_TIME_ZONES);
  return supported.filter((tz) => !brazil.has(tz));
}

/** IANA ids drop accents; show the Brazilian city names properly. */
const BRAZIL_CITY_NAMES: Record<string, string> = {
  Sao_Paulo: 'São Paulo',
  Belem: 'Belém',
  Maceio: 'Maceió',
  Araguaina: 'Araguaína',
  Santarem: 'Santarém',
  Cuiaba: 'Cuiabá',
  Eirunepe: 'Eirunepé',
  Noronha: 'Fernando de Noronha',
};

export function timeZoneLabel(tz: string, locale: string): string {
  try {
    const name = new Intl.DateTimeFormat(locale, {
      timeZone: tz,
      timeZoneName: 'longGeneric',
    })
      .formatToParts(new Date())
      .find((p) => p.type === 'timeZoneName')?.value;
    const offset = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      timeZoneName: 'shortOffset',
    })
      .formatToParts(new Date())
      .find((p) => p.type === 'timeZoneName')?.value;
    const id = tz.split('/').pop() ?? tz;
    const city = BRAZIL_CITY_NAMES[id] ?? id.replace(/_/g, ' ');
    return `${offset ?? ''} · ${city} (${name ?? tz})`;
  } catch {
    return tz;
  }
}

export function localeLabel(code: string, displayLocale: string): string {
  try {
    return (
      new Intl.DisplayNames([displayLocale], { type: 'language' }).of(code) ??
      code
    );
  } catch {
    return code;
  }
}

export function RegionalSettings() {
  const t = useTranslations('Custom.locale.settings');
  const { accountId, canEditSettings, profileLoading } = useAuth();
  const { settings, tenant, available, refresh } = useLocaleSettings();

  const current = {
    locale: tenant?.locale ?? settings.locale,
    timezone: tenant?.timezone ?? settings.timeZone,
  };
  // Drafts: null = untouched, so the selects follow the saved values
  // once they load (no state syncing in effects).
  const [draftLocale, setLocale] = useState<string | null>(null);
  const [draftTimezone, setTimezone] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const locale = draftLocale ?? current.locale;
  const timezone = draftTimezone ?? current.timezone;

  const zones = useMemo(() => allTimeZones(), []);
  const dirty = locale !== current.locale || timezone !== current.timezone;
  const disabled = !canEditSettings || profileLoading || !available;

  const preview: LocaleSettings = {
    locale: intlLocale(locale),
    timeZone: timezone,
    currency: settings.currency,
  };

  async function handleSave() {
    if (!accountId || !dirty) return;
    setSaving(true);
    const { error } = await createBrowserSupabase()
      .from('accounts')
      .update({ locale, timezone })
      .eq('id', accountId);
    setSaving(false);
    if (error) {
      toast.error(t('saveFailed'));
      return;
    }
    toast.success(t('saveSuccess'));
    setLocale(null);
    setTimezone(null);
    // Re-keys the dashboard so every timestamp re-renders.
    await refresh();
  }

  return (
    <Card className="mt-6 max-w-2xl">
      <CardHeader>
        <CardTitle className="text-foreground flex items-center gap-2">
          <Globe2 className="text-primary size-4" />
          {t('title')}
        </CardTitle>
        <CardDescription className="text-muted-foreground">
          {t('description')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!available && !profileLoading && (
          <p className="border-border bg-muted text-muted-foreground rounded-lg border p-3 text-xs">
            {t('unavailable', {
              timezone: regionalDefaults.timeZone,
              locale: regionalDefaults.locale,
            })}
          </p>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label className="text-muted-foreground">{t('formatLabel')}</Label>
            <select
              value={locale}
              onChange={(e) => setLocale(e.target.value)}
              disabled={disabled}
              className={selectClass}
            >
              {(FORMAT_LOCALES as readonly string[]).includes(locale) ? null : (
                <option value={locale}>{locale}</option>
              )}
              {FORMAT_LOCALES.map((code) => (
                <option key={code} value={code}>
                  {localeLabel(code, settings.locale)} ({code})
                </option>
              ))}
            </select>
          </div>

          <div className="grid gap-2">
            <Label className="text-muted-foreground">
              {t('timezoneLabel')}
            </Label>
            <select
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              disabled={disabled}
              className={selectClass}
            >
              <optgroup label={t('timezoneBrazil')}>
                {[...BRAZIL_TIME_ZONES, ...zones].includes(timezone) ? null : (
                  <option value={timezone}>{timezone}</option>
                )}
                {BRAZIL_TIME_ZONES.map((tz) => (
                  <option key={tz} value={tz}>
                    {timeZoneLabel(tz, settings.locale)}
                  </option>
                ))}
              </optgroup>
              <optgroup label={t('timezoneOthers')}>
                {zones.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz.replace(/_/g, ' ')}
                  </option>
                ))}
              </optgroup>
            </select>
          </div>
        </div>

        <p className="text-muted-foreground text-xs">
          {t('preview', {
            datetime: formatDateTime(new Date(), 'short', preview),
            number: formatNumber(1234.5, { maximumFractionDigits: 2 }, preview),
            money: formatMoney(1234.56, preview.currency, {}, preview),
          })}
        </p>
        <p className="text-muted-foreground text-xs">{t('languageHint')}</p>

        {!canEditSettings && (
          <p className="text-muted-foreground text-xs">{t('adminOnlyHint')}</p>
        )}
        {canEditSettings && (
          <Button
            onClick={handleSave}
            disabled={saving || !dirty || !available}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {saving ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {t('saving')}
              </>
            ) : (
              t('save')
            )}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
