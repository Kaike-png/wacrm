'use client';

/**
 * Plan editor (platform panel, docs/PLANS.md): one card per plan with
 * its feature values. Limits: whole number, empty = unlimited. Flags:
 * on/off. Saved per plan through POST /api/platform/plans/:code (audited).
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2, Save } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { parseFeatureValue } from '@/billing/features';

import type { PlanCatalog } from './types';

type Plan = PlanCatalog['plans'][number];

/** "99,90" / "99.90" / "1.299,90" → cents; '' → null (not sold online); undefined = invalid. */
export function parsePriceCents(input: string): number | null | undefined {
  const raw = input.trim().replace(/^R\$\s*/i, '');
  if (raw === '') return null;
  // BR money: "." groups thousands, "," is the decimal separator ("99.90" also accepted).
  const normalized = raw.includes(',')
    ? raw.replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.')
    : raw;
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return undefined;
  return Math.round(Number(normalized) * 100);
}

type Feature = PlanCatalog['features'][number];

function PlanCard({ plan, features }: { plan: Plan; features: Feature[] }) {
  const t = useTranslations('Custom.platform.plans');
  const tf = useTranslations('Custom.billing.features');
  const router = useRouter();
  const [name, setName] = useState(plan.name);
  const [isActive, setIsActive] = useState(plan.is_active);
  const [isDefault, setIsDefault] = useState(plan.is_default);
  const [reason, setReason] = useState('');
  const [price, setPrice] = useState(
    plan.price_cents === null
      ? ''
      : (plan.price_cents / 100).toFixed(2).replace('.', ',')
  );
  const [busy, setBusy] = useState(false);
  const [values, setValues] = useState<Record<string, string | boolean>>(() =>
    Object.fromEntries(
      features.map((f) => {
        const v =
          f.key in plan.features ? plan.features[f.key] : f.default_value;
        return [
          f.key,
          f.kind === 'flag' ? v === true : v === null ? '' : String(v),
        ];
      })
    )
  );

  async function save() {
    const payload: Record<string, number | boolean | null> = {};
    for (const f of features) {
      const parsed = parseFeatureValue(f.kind, values[f.key]);
      if (!parsed.ok) {
        toast.error(
          t('invalid', { feature: tf.has(f.key) ? tf(f.key) : f.key })
        );
        return;
      }
      payload[f.key] = parsed.value;
    }
    const priceCents = parsePriceCents(price);
    if (priceCents === undefined) {
      toast.error(t('priceInvalid'));
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/platform/plans/${plan.code}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          is_active: isActive,
          is_default: isDefault,
          features: payload,
          price_cents: priceCents,
          reason,
        }),
      });
      if (!res.ok) {
        toast.error(t('invalid', { feature: plan.code }));
        return;
      }
      toast.success(t('saved'));
      setReason('');
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="border-border bg-card" data-plan={plan.code}>
      <CardContent className="space-y-4 p-5">
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-label={t('name')}
              className="h-8 max-w-40 font-semibold"
            />
            <span className="text-muted-foreground font-mono text-xs">
              {plan.code}
            </span>
          </div>
          <p className="text-muted-foreground text-xs">
            {t('organizations', { count: plan.organizations })}
          </p>
        </div>

        <label className="flex items-center justify-between gap-3 text-sm">
          <span className="text-muted-foreground">
            {t('price')}
            <span className="block text-[10px] opacity-70">
              {t('priceHint')}
            </span>
          </span>
          <Input
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            inputMode="decimal"
            aria-label={t('price')}
            data-price-input
            className="h-8 w-28 text-right"
          />
        </label>

        <div className="space-y-2.5">
          {features.map((f) => (
            <label
              key={f.key}
              className="flex items-center justify-between gap-3 text-sm"
            >
              <span className="text-muted-foreground">
                {tf.has(f.key) ? tf(f.key) : f.key}
                <span className="block font-mono text-[10px] opacity-70">
                  {f.key}
                </span>
              </span>
              {f.kind === 'flag' ? (
                <Switch
                  checked={values[f.key] === true}
                  onCheckedChange={(v) =>
                    setValues((s) => ({ ...s, [f.key]: v }))
                  }
                  aria-label={f.key}
                />
              ) : (
                <Input
                  inputMode="numeric"
                  value={String(values[f.key] ?? '')}
                  placeholder="∞"
                  title={t('unlimitedHint')}
                  onChange={(e) =>
                    setValues((s) => ({
                      ...s,
                      [f.key]: e.target.value.replace(/\D/g, ''),
                    }))
                  }
                  className="h-8 w-28 text-right tabular-nums"
                  aria-label={f.key}
                />
              )}
            </label>
          ))}
        </div>

        <div className="border-border/50 space-y-2 border-t pt-3 text-sm">
          <label className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">
              {isActive ? t('active') : t('inactive')}
            </span>
            <Switch
              checked={isActive}
              onCheckedChange={setIsActive}
              aria-label={t('active')}
            />
          </label>
          <label className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">{t('default')}</span>
            <Switch
              checked={isDefault}
              onCheckedChange={setIsDefault}
              aria-label={t('default')}
            />
          </label>
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t('reason')}
            maxLength={500}
          />
          <Button size="sm" onClick={save} disabled={busy} className="w-full">
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Save className="size-4" />
            )}
            {t('save')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function PlansEditor({ catalog }: { catalog: PlanCatalog }) {
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {catalog.plans.map((p) => (
        <PlanCard
          key={`${p.code}:${JSON.stringify(p)}`}
          plan={p}
          features={catalog.features}
        />
      ))}
    </div>
  );
}
