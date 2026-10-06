'use client';

/**
 * Configurações → Organização (FORK-PATCH(P-006), docs/TENANCY.md).
 *
 * The organization is the tenant's `accounts` row. This screen shows and
 * edits it in one place:
 *   - name: through the upstream PATCH /api/account (its validation);
 *   - registration data: `br_account_profiles` (RLS: members read,
 *     admins write);
 *   - currency / language / time zone: read-only summary, edited in
 *     Configurações → Região e moeda (no duplicated editor);
 *   - status: read-only; only billing can change it (DB guard, 902).
 */
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2, Save } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { SettingsPanelHead } from '@/components/settings/settings-panel-head';
import { createBrowserSupabase, useAuth } from '@/custom/core/client';
import { formatDate } from '@/custom/locale/format';
import {
  needsAttention,
  toAccountStatus,
  trialDaysLeft,
  type AccountStatus,
} from '@/billing/account-status';

import { Field, inputClass } from './contact-fields';
import { OrganizationProfileFields } from './organization-fields';
import {
  BR_ACCOUNT_PROFILE_TABLE,
  EMPTY_ORGANIZATION,
  organizationDraftFromRow,
  organizationRowFromDraft,
  validateOrganization,
  type BrAccountProfileRow,
  type OrganizationDraft,
  type OrganizationErrors,
} from './organization';
import { PlanUsageCard } from '@/billing/plan-ui';
import { MyUsageCard } from '@/billing/usage-ui';
import { SubscriptionCard } from '@/billing/subscription-card';
import { DataExportCard } from '@/custom/export/data-export-card';

interface AccountRow {
  id: string;
  name: string;
  default_currency: string | null;
  locale: string | null;
  timezone: string | null;
  status?: string | null;
  trial_ends_at?: string | null;
}

interface Loaded {
  account: AccountRow | null;
  profileAvailable: boolean;
  draft: OrganizationDraft;
  name: string;
}

const STATUS_STYLE: Record<AccountStatus, string> = {
  trial: 'border-sky-500/40 bg-sky-500/10 text-sky-300',
  active: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
  past_due: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  suspended: 'border-red-500/40 bg-red-500/10 text-red-300',
  cancelled: 'border-zinc-500/40 bg-zinc-500/10 text-zinc-300',
};

async function loadOrganization(accountId: string): Promise<Loaded> {
  const supabase = createBrowserSupabase();
  // status/trial_ends_at exist only after migration 902; retry without them.
  const full = await supabase
    .from('accounts')
    .select(
      'id, name, default_currency, locale, timezone, status, trial_ends_at'
    )
    .eq('id', accountId)
    .maybeSingle();
  const account = full.error
    ? (
        await supabase
          .from('accounts')
          .select('id, name, default_currency')
          .eq('id', accountId)
          .maybeSingle()
      ).data
    : full.data;
  const { data: profile, error: profileError } = await supabase
    .from(BR_ACCOUNT_PROFILE_TABLE)
    .select('*')
    .eq('account_id', accountId)
    .maybeSingle();
  const row = (account as AccountRow | null) ?? null;
  return {
    account: row,
    profileAvailable: !profileError,
    draft: organizationDraftFromRow(
      (profile as BrAccountProfileRow | null) ?? null
    ),
    name: row?.name ?? '',
  };
}

export function OrganizationSettings() {
  const t = useTranslations('Br.organization');
  const tStatus = useTranslations('Billing.status');
  const router = useRouter();
  const { accountId, canEditSettings, profileLoading } = useAuth();

  const [loaded, setLoaded] = useState<(Loaded & { accountId: string }) | null>(
    null
  );
  const [draft, setDraft] = useState<OrganizationDraft>(EMPTY_ORGANIZATION);
  const [name, setName] = useState('');
  const [errorCodes, setErrorCodes] = useState<OrganizationErrors>({});
  const [saving, setSaving] = useState(false);

  const apply = useCallback((id: string, data: Loaded) => {
    setLoaded({ ...data, accountId: id });
    setDraft(data.draft);
    setName(data.name);
    setErrorCodes({});
  }, []);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    void loadOrganization(accountId).then((data) => {
      if (!cancelled) apply(accountId, data);
    });
    return () => {
      cancelled = true;
    };
  }, [accountId, apply]);

  const current = loaded && loaded.accountId === accountId ? loaded : null;
  if (!current) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="text-muted-foreground size-5 animate-spin" />
      </div>
    );
  }

  const disabled = !canEditSettings || profileLoading || saving;
  const status = toAccountStatus(current.account?.status);
  const daysLeft = trialDaysLeft(status, current.account?.trial_ends_at);
  const update = (patch: Partial<OrganizationDraft>) => {
    setDraft((prev) => ({ ...prev, ...patch }));
    setErrorCodes((prev) => {
      const next = { ...prev };
      for (const k of Object.keys(patch))
        delete next[k as keyof OrganizationDraft];
      return next;
    });
  };

  async function handleSave() {
    if (!accountId) return;
    const found = validateOrganization(draft);
    const trimmedName = name.trim();
    if (!trimmedName) {
      toast.error(t('errors.nameRequired'));
      return;
    }
    setErrorCodes(found);
    if (Object.keys(found).length > 0) {
      toast.error(t('errors.fix'));
      return;
    }
    setSaving(true);
    try {
      if (trimmedName !== current!.name) {
        const res = await fetch('/api/account', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: trimmedName }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(body.error || t('saveFailed'));
        }
      }
      if (current!.profileAvailable) {
        const { error } = await createBrowserSupabase()
          .from(BR_ACCOUNT_PROFILE_TABLE)
          .upsert(
            { account_id: accountId, ...organizationRowFromDraft(draft) },
            { onConflict: 'account_id' }
          );
        if (error) throw new Error(t('saveFailed'));
      }
      toast.success(t('saved'));
      apply(accountId, await loadOrganization(accountId));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  const account = current.account;
  return (
    <div className="space-y-6">
      <SettingsPanelHead title={t('title')} description={t('description')} />

      <Card className="border-border bg-card">
        <CardContent className="space-y-4 p-5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground text-sm">{t('status')}</span>
            <Badge variant="outline" className={STATUS_STYLE[status]}>
              {tStatus(`${status}.label`)}
            </Badge>
            {daysLeft !== null && (
              <span className="text-muted-foreground text-xs">
                {t('trialDaysLeft', { days: daysLeft })}
              </span>
            )}
          </div>
          <p
            className={
              needsAttention(status)
                ? 'text-sm text-amber-300'
                : 'text-muted-foreground text-sm'
            }
          >
            {tStatus(`${status}.description`)}
            {status === 'trial' && account?.trial_ends_at
              ? ` ${t('trialEndsOn', { date: formatDate(account.trial_ends_at, 'long') })}`
              : ''}
          </p>

          <Field id="org-name" label={t('name')}>
            <Input
              id="org-name"
              value={name}
              disabled={disabled}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
              className={inputClass}
            />
          </Field>

          <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-muted-foreground text-xs">{t('currency')}</dt>
              <dd className="text-foreground">
                {account?.default_currency ?? '—'}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">{t('language')}</dt>
              <dd className="text-foreground">{account?.locale ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">{t('timezone')}</dt>
              <dd className="text-foreground">{account?.timezone ?? '—'}</dd>
            </div>
          </dl>
          {canEditSettings && (
            <button
              type="button"
              onClick={() => router.push('/onboarding?step=organization')}
              className="text-primary mr-4 text-xs font-medium hover:underline"
            >
              {t('wizardLink')}
            </button>
          )}
          <button
            type="button"
            onClick={() => router.push('/settings?tab=deals')}
            className="text-primary text-xs font-medium hover:underline"
          >
            {t('regionalLink')}
          </button>
        </CardContent>
      </Card>

      {current.profileAvailable ? (
        <Card className="border-border bg-card">
          <CardContent className="space-y-3 p-5">
            <p className="text-foreground text-sm font-medium">
              {t('registration')}
            </p>
            <OrganizationProfileFields
              draft={draft}
              update={update}
              errorCodes={errorCodes}
              disabled={disabled}
            />
          </CardContent>
        </Card>
      ) : (
        <p className="text-muted-foreground text-sm">{t('unavailable')}</p>
      )}

      {canEditSettings ? (
        <Button onClick={handleSave} disabled={disabled}>
          {saving ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Save className="size-4" />
          )}
          {t('save')}
        </Button>
      ) : (
        <p className="text-muted-foreground text-xs">{t('adminOnly')}</p>
      )}

      <PlanUsageCard />
      <SubscriptionCard />
      <MyUsageCard />
      {canEditSettings && <DataExportCard />}
    </div>
  );
}
