'use client';

/**
 * Plan UI (fork, docs/PLANS.md): the organization's plan with every
 * feature and its usage, and small notices for gated sections. Display
 * only — limits are enforced by the database and the server. Labels come
 * from i18n by feature key; no plan code appears here.
 */
import { useTranslations } from 'next-intl';
import { Lock, Sparkles } from 'lucide-react';

import { Card, CardContent } from '@/components/ui/card';
import { brand } from '@/custom/brand/config';
import { formatNumber } from '@/custom/locale/format';

import {
  featureState,
  flagEnabled,
  limitOf,
  usageRatio,
  type Entitlements,
  type FeatureState,
  type FlagFeature,
  type LimitFeature,
} from './features';
import { planLimitMessage } from './errors';
import { useEntitlements } from './use-entitlements';

function UsageBar({ ratio }: { ratio: number }) {
  const color =
    ratio >= 1 ? 'bg-red-500' : ratio >= 0.8 ? 'bg-amber-500' : 'bg-primary';
  return (
    <div className="bg-muted h-1.5 w-full overflow-hidden rounded-full">
      <div
        className={`h-full ${color}`}
        style={{ width: `${Math.round(ratio * 100)}%` }}
      />
    </div>
  );
}

function FeatureRow({ f }: { f: FeatureState }) {
  const t = useTranslations('Custom.billing');
  const label = t.has(`features.${f.key}`) ? t(`features.${f.key}`) : f.key;
  if (f.kind === 'flag') {
    return (
      <div
        className="flex items-center justify-between gap-3 py-1.5 text-sm"
        data-feature={f.key}
      >
        <span className="text-muted-foreground">{label}</span>
        <span
          className={f.value ? 'text-emerald-400' : 'text-muted-foreground'}
        >
          {f.value ? t('included') : t('notIncluded')}
        </span>
      </div>
    );
  }
  const limit = typeof f.value === 'number' ? f.value : null;
  const used = f.used ?? 0;
  return (
    <div className="space-y-1 py-1.5" data-feature={f.key}>
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className="text-foreground tabular-nums">
          {limit === null
            ? t('usageUnlimited', { used: formatNumber(used) })
            : t('usageOf', {
                used: formatNumber(used),
                limit: formatNumber(limit),
              })}
        </span>
      </div>
      {limit !== null && <UsageBar ratio={usageRatio(limit, used)} />}
    </div>
  );
}

/** Every feature of an Entitlements document (also used by the platform panel). */
export function EntitlementsList({
  entitlements,
}: {
  entitlements: Entitlements;
}) {
  return (
    <div className="divide-border/50 divide-y">
      {entitlements.features.map((f) => (
        <FeatureRow key={f.key} f={f} />
      ))}
    </div>
  );
}

export function PlanUsageCard() {
  const t = useTranslations('Custom.billing');
  const { entitlements, loading } = useEntitlements();
  if (loading || !entitlements) return null;

  return (
    <Card className="border-border bg-card" data-testid="plan-usage">
      <CardContent className="space-y-3 p-5">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-foreground text-sm font-semibold">
            {t('title')}
          </h3>
          <span className="border-primary/40 bg-primary/10 text-primary rounded-full border px-2.5 py-0.5 text-xs">
            {entitlements.plan?.name ?? t('noPlan')}
          </span>
        </div>
        {!entitlements.plan && (
          <p className="text-muted-foreground text-xs">
            {t('noPlanDescription')}
          </p>
        )}
        <EntitlementsList entitlements={entitlements} />
        <p className="text-muted-foreground text-xs">
          {brand.supportEmail
            ? t('upgradeContact', { email: brand.supportEmail })
            : t('upgradeGeneric')}
        </p>
      </CardContent>
    </Card>
  );
}

/** Banner for a section that needs a flag the plan does not include. */
export function PlanFeatureNotice({ feature }: { feature: FlagFeature }) {
  const t = useTranslations('Custom.billing');
  const { entitlements } = useEntitlements();
  if (!entitlements || flagEnabled(entitlements, feature)) return null;
  return (
    <div
      className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-200"
      data-plan-notice={feature}
    >
      <Lock className="mt-0.5 size-4 shrink-0" />
      <div>
        <p className="font-medium">
          {t(`notice.${feature}.title`, {
            plan: entitlements.plan?.name ?? '—',
          })}
        </p>
        <p className="text-amber-200/80">{t(`notice.${feature}.body`)}</p>
        <p className="mt-1 font-medium">
          {(() => {
            const up = featureState(entitlements, feature)?.upgrade;
            return up
              ? t('upgrade.flag', { upgrade: up.name })
              : t('upgrade.none');
          })()}
        </p>
      </div>
    </div>
  );
}

/** Banner when a limit is reached (e.g. above the members list). */
export function PlanLimitNotice({ feature }: { feature: LimitFeature }) {
  const t = useTranslations('Custom.billing');
  const { entitlements } = useEntitlements();
  if (!entitlements) return null;
  const { limit, used, reached } = limitOf(entitlements, feature);
  if (!reached || limit === null) return null;
  const upgrade = featureState(entitlements, feature)?.upgrade ?? null;
  return (
    <div
      className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-200"
      data-plan-notice={feature}
    >
      <Sparkles className="mt-0.5 size-4 shrink-0" />
      <p>
        {planLimitMessage(
          feature,
          {
            limit,
            used,
            plan: entitlements.plan?.name ?? null,
            upgrade: upgrade?.name ?? null,
            upgradeValue: upgrade ? upgrade.value : null,
          },
          (key, values) => t(key as never, values as never)
        )}
      </p>
    </div>
  );
}
