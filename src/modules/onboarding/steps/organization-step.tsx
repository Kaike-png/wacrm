'use client';

/**
 * 1 de 4 — Organização: the organization was created with the account
 * (handle_new_user); here it gets its name and regional settings.
 */
import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { Input } from '@/components/ui/input';
import { createBrowserSupabase } from '@/custom/core/client';
import { CURRENCIES } from '@/custom/core/shared';
import { BRAZIL_TIME_ZONES, FORMAT_LOCALES } from '@/custom/locale/config';
import {
  allTimeZones,
  localeLabel,
  timeZoneLabel,
} from '@/custom/locale/regional-settings';
import { Field, inputClass, selectClass } from '@/modules/br/contact-fields';

import { StepFooter } from '../step-footer';

export interface OrganizationBasics {
  name: string;
  locale: string;
  timezone: string;
  currency: string;
}

const MAX_NAME = 80; // PATCH /api/account limit

export function OrganizationStep({
  accountId,
  initial,
  onSaved,
}: {
  accountId: string;
  initial: OrganizationBasics;
  onSaved: (basics: OrganizationBasics) => void;
}) {
  const t = useTranslations('Custom.onboarding.organization');
  const [form, setForm] = useState(initial);
  const [nameError, setNameError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const otherZones = useMemo(() => allTimeZones(), []);

  async function save() {
    const name = form.name.trim();
    if (!name) return setNameError(t('nameRequired'));
    if (name.length > MAX_NAME)
      return setNameError(t('nameTooLong', { max: MAX_NAME }));
    setBusy(true);
    try {
      if (name !== initial.name) {
        const res = await fetch('/api/account', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(body.error || t('saveFailed'));
        }
      }
      const { error } = await createBrowserSupabase()
        .from('accounts')
        .update({
          locale: form.locale,
          timezone: form.timezone,
          default_currency: form.currency,
        })
        .eq('id', accountId);
      if (error) throw new Error(t('saveFailed'));
      onSaved({ ...form, name });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('saveFailed'));
    } finally {
      setBusy(false);
    }
  }

  const locales = (FORMAT_LOCALES as readonly string[]).includes(form.locale)
    ? FORMAT_LOCALES
    : [form.locale, ...FORMAT_LOCALES];

  return (
    <div className="space-y-5">
      <Field id="ob-org-name" label={t('name')} error={nameError ?? undefined}>
        <Input
          id="ob-org-name"
          autoFocus
          value={form.name}
          maxLength={MAX_NAME}
          placeholder={t('namePlaceholder')}
          onChange={(e) => {
            setNameError(null);
            setForm({ ...form, name: e.target.value });
          }}
          className={inputClass}
          aria-invalid={!!nameError}
        />
        <p className="text-muted-foreground text-xs">{t('nameHint')}</p>
      </Field>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field id="ob-org-locale" label={t('locale')}>
          <select
            id="ob-org-locale"
            value={form.locale}
            onChange={(e) => setForm({ ...form, locale: e.target.value })}
            className={selectClass}
          >
            {locales.map((code) => (
              <option key={code} value={code}>
                {localeLabel(code, form.locale)}
              </option>
            ))}
          </select>
        </Field>
        <Field id="ob-org-timezone" label={t('timezone')}>
          <select
            id="ob-org-timezone"
            value={form.timezone}
            onChange={(e) => setForm({ ...form, timezone: e.target.value })}
            className={selectClass}
          >
            <optgroup label={t('timezoneBrazil')}>
              {BRAZIL_TIME_ZONES.map((tz) => (
                <option key={tz} value={tz}>
                  {timeZoneLabel(tz, form.locale)}
                </option>
              ))}
            </optgroup>
            <optgroup label={t('timezoneOthers')}>
              {otherZones.map((tz) => (
                <option key={tz} value={tz}>
                  {timeZoneLabel(tz, form.locale)}
                </option>
              ))}
            </optgroup>
          </select>
        </Field>
        <Field id="ob-org-currency" label={t('currency')}>
          <select
            id="ob-org-currency"
            value={form.currency}
            onChange={(e) => setForm({ ...form, currency: e.target.value })}
            className={selectClass}
          >
            {CURRENCIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.code} — {c.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <p className="text-muted-foreground text-xs">{t('regionalHint')}</p>

      <StepFooter onContinue={save} busy={busy} />
    </div>
  );
}
