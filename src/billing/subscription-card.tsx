'use client';

/**
 * "Assinatura" card (fork, docs/BILLING.md): plans with prices, current
 * subscription, the pending charge with its Pix "copia e cola", payment
 * history and cancel. Talks only to /api/billing/* — never to a gateway.
 * In the sandbox (mock provider) it also offers "simulate payment".
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  Check,
  Copy,
  CreditCard,
  FlaskConical,
  Loader2,
  QrCode,
  RefreshCw,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useAuth } from '@/custom/core/client';
import {
  formatDate,
  formatDateTime,
  formatMoney,
} from '@/custom/locale/format';

interface Overview {
  provider: {
    id: string;
    name: string;
    sandbox: boolean;
    methods: ('pix' | 'boleto' | 'card')[];
    simulator: boolean;
  };
  subscription: {
    plan_code: string;
    status: 'manual' | 'pending' | 'active' | 'past_due' | 'canceled';
    pending_plan_code: string | null;
    current_period_end: string | null;
    cancel_at_period_end: boolean;
    external_id: string | null;
    pending_external_id: string | null;
  } | null;
  plans: {
    code: string;
    name: string;
    price_cents: number | null;
    currency: string;
    billing_interval: 'month' | 'year';
  }[];
  payments: {
    id: string;
    status: 'pending' | 'paid' | 'overdue' | 'refunded' | 'canceled' | 'failed';
    method: string;
    amount_cents: number;
    currency: string;
    description: string | null;
    due_date: string | null;
    paid_at: string | null;
    plan_code: string | null;
    pix_copy_paste: string | null;
    pix_qr_image: string | null;
    pix_expires_at: string | null;
    boleto_digitable_line: string | null;
    boleto_url: string | null;
    invoice_url: string | null;
    created_at: string;
  }[];
}

const PAYMENT_STYLE: Record<string, string> = {
  paid: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
  pending: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  overdue: 'border-red-500/40 bg-red-500/10 text-red-300',
  failed: 'border-red-500/40 bg-red-500/10 text-red-300',
  refunded: 'border-zinc-500/40 bg-zinc-500/10 text-zinc-300',
  canceled: 'border-zinc-500/40 bg-zinc-500/10 text-zinc-300',
};

export function SubscriptionCard() {
  const t = useTranslations('Custom.billing.subscription');
  const { canEditSettings, isOwner } = useAuth();
  const [data, setData] = useState<Overview | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [method, setMethod] = useState<'pix' | 'boleto' | 'card'>('pix');

  const load = useCallback(async () => {
    const res = await fetch('/api/billing/subscription', { cache: 'no-store' });
    if (res.ok) setData((await res.json()) as Overview);
  }, []);

  useEffect(() => {
    if (!canEditSettings) return;
    let cancelled = false;
    fetch('/api/billing/subscription', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (!cancelled && json) setData(json as Overview);
      });
    return () => {
      cancelled = true;
    };
  }, [canEditSettings]);

  async function call(
    key: string,
    url: string,
    init: RequestInit,
    success: string
  ) {
    setBusy(key);
    try {
      const res = await fetch(url, {
        ...init,
        headers: { 'Content-Type': 'application/json' },
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        const code = json.error ?? 'failed';
        toast.error(
          t.has(`errors.${code}`) ? t(`errors.${code}`) : t('errors.failed')
        );
        return;
      }
      toast.success(success);
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function copy(key: string, value: string | null) {
    await navigator.clipboard.writeText(value ?? '');
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  }

  if (!canEditSettings || !data) return null;

  const sub = data.subscription;
  const planName = (code: string | null | undefined) =>
    data.plans.find((p) => p.code === code)?.name ?? code ?? '—';
  const pending = data.payments.find(
    (p) => p.status === 'pending' || p.status === 'overdue'
  );
  const price = (p: Overview['plans'][number]) =>
    p.price_cents === null
      ? t('priceOnRequest')
      : t(p.billing_interval === 'year' ? 'perYear' : 'perMonth', {
          price: formatMoney(p.price_cents / 100, p.currency),
        });

  return (
    <Card
      className="border-border bg-card"
      id="assinatura"
      data-testid="subscription-card"
    >
      <CardContent className="space-y-5 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-foreground text-sm font-semibold">
            {t('title')}
          </h3>
          {data.provider.sandbox && (
            <Badge
              variant="outline"
              className="border-sky-500/40 bg-sky-500/10 text-sky-300"
            >
              <FlaskConical className="size-3" />
              {t('sandbox', { provider: data.provider.name })}
            </Badge>
          )}
        </div>

        <div className="space-y-1 text-sm">
          <p className="text-foreground" data-testid="subscription-status">
            {t(
              `status.${!sub || sub.status === 'pending' ? 'manual' : sub.status}`,
              { plan: planName(sub?.plan_code) }
            )}
          </p>
          {sub?.current_period_end &&
            (sub.status === 'active' ||
              sub.status === 'past_due' ||
              sub.status === 'canceled') && (
              <p className="text-muted-foreground">
                {t(sub.cancel_at_period_end ? 'endsOn' : 'renewsOn', {
                  date: formatDate(sub.current_period_end, 'long'),
                })}
              </p>
            )}
          {sub?.pending_plan_code && (
            <p className="text-amber-300">
              {t('pendingChange', { plan: planName(sub.pending_plan_code) })}
            </p>
          )}
        </div>

        {pending && (
          <div
            className="space-y-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4"
            data-testid="pending-payment"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-foreground text-sm font-medium">
                {t(
                  `payWith.${['pix', 'boleto', 'card'].includes(pending.method) ? pending.method : 'other'}`,
                  {
                    amount: formatMoney(
                      pending.amount_cents / 100,
                      pending.currency
                    ),
                  }
                )}
              </p>
              {pending.pix_expires_at && (
                <span className="text-muted-foreground text-xs">
                  {t('expiresAt', {
                    date: formatDateTime(pending.pix_expires_at),
                  })}
                </span>
              )}
            </div>
            {pending.pix_qr_image && (
              // eslint-disable-next-line @next/next/no-img-element -- data: URL / gateway URL
              <img
                src={pending.pix_qr_image}
                alt={t('qrAlt')}
                className="size-44 rounded bg-white p-2"
              />
            )}
            {pending.pix_copy_paste && (
              <CopyRow
                label={t('copyPaste')}
                value={pending.pix_copy_paste}
                testId="pix-code"
                copied={copied === 'pix'}
                onCopy={() => copy('pix', pending.pix_copy_paste)}
                copyLabel={t('copy')}
                copiedLabel={t('copied')}
              />
            )}
            {pending.boleto_digitable_line && (
              <CopyRow
                label={t('boletoLine')}
                value={pending.boleto_digitable_line}
                testId="boleto-line"
                copied={copied === 'boleto'}
                onCopy={() => copy('boleto', pending.boleto_digitable_line)}
                copyLabel={t('copy')}
                copiedLabel={t('copied')}
              />
            )}
            {(pending.boleto_url || pending.invoice_url) && (
              <div className="flex flex-wrap gap-3 text-sm">
                {pending.method === 'card' && pending.invoice_url && (
                  <a
                    className={buttonVariants({ size: 'sm' })}
                    data-testid="pay-card"
                    href={pending.invoice_url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <CreditCard className="size-4" />
                    {t('payWithCard')}
                  </a>
                )}
                {pending.boleto_url && (
                  <a
                    className="text-primary underline-offset-4 hover:underline"
                    href={pending.boleto_url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {t('openBoleto')}
                  </a>
                )}
                {pending.invoice_url && pending.method !== 'card' && (
                  <a
                    className="text-primary underline-offset-4 hover:underline"
                    href={pending.invoice_url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {t('openInvoice')}
                  </a>
                )}
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null}
                onClick={() =>
                  call(
                    'refresh',
                    `/api/billing/payments/${pending.id}`,
                    { method: 'POST' },
                    t('refreshed')
                  )
                }
              >
                {busy === 'refresh' ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <RefreshCw className="size-4" />
                )}
                {t('alreadyPaid')}
              </Button>
              {data.provider.simulator && (
                <>
                  <Button
                    size="sm"
                    disabled={busy !== null}
                    onClick={() =>
                      call(
                        'pay',
                        `/api/billing/mock/payments/${pending.id}`,
                        {
                          method: 'POST',
                          body: JSON.stringify({ status: 'paid' }),
                        },
                        t('simulatedPaid')
                      )
                    }
                  >
                    {busy === 'pay' ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <FlaskConical className="size-4" />
                    )}
                    {t('simulatePaid')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={() =>
                      call(
                        'overdue',
                        `/api/billing/mock/payments/${pending.id}`,
                        {
                          method: 'POST',
                          body: JSON.stringify({ status: 'overdue' }),
                        },
                        t('simulatedOverdue')
                      )
                    }
                  >
                    {t('simulateOverdue')}
                  </Button>
                </>
              )}
            </div>
          </div>
        )}

        {data.provider.methods.length > 1 && (
          <div
            className="flex flex-wrap items-center gap-2 text-sm"
            role="radiogroup"
            aria-label={t('methodLabel')}
          >
            <span className="text-muted-foreground">{t('methodLabel')}</span>
            {data.provider.methods.map((m) => (
              <Button
                key={m}
                size="sm"
                variant={method === m ? 'default' : 'outline'}
                role="radio"
                aria-checked={method === m}
                data-method={m}
                onClick={() => setMethod(m)}
              >
                {t(`methods.${m}`)}
              </Button>
            ))}
          </div>
        )}

        <div className="grid gap-2 sm:grid-cols-3">
          {data.plans.map((p) => {
            // Re-subscribing is offered again once a subscription is canceled.
            const current =
              sub?.plan_code === p.code &&
              (sub.status === 'active' || sub.status === 'past_due');
            return (
              <div
                key={p.code}
                className="border-border/60 space-y-2 rounded-md border p-3"
                data-plan-option={p.code}
              >
                <p className="text-foreground font-medium">{p.name}</p>
                <p className="text-muted-foreground text-sm">{price(p)}</p>
                {current ? (
                  <Badge variant="outline">{t('currentPlan')}</Badge>
                ) : (
                  <Button
                    size="sm"
                    className="w-full"
                    disabled={p.price_cents === null || busy !== null}
                    onClick={() =>
                      call(
                        `sub:${p.code}`,
                        '/api/billing/subscription',
                        {
                          method: 'POST',
                          body: JSON.stringify({ plan: p.code, method }),
                        },
                        t('chargeCreated')
                      )
                    }
                  >
                    {busy === `sub:${p.code}` && (
                      <Loader2 className="size-4 animate-spin" />
                    )}
                    {t('subscribe', { plan: p.name })}
                  </Button>
                )}
              </div>
            );
          })}
        </div>

        {data.payments.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-foreground text-xs font-medium">
              {t('history')}
            </p>
            <ul className="divide-border/50 divide-y text-sm">
              {data.payments.map((p) => (
                <li
                  key={p.id}
                  className="flex flex-wrap items-center justify-between gap-2 py-1.5"
                  data-payment-status={p.status}
                >
                  <span className="text-muted-foreground">
                    {formatDate(p.paid_at ?? p.created_at)} ·{' '}
                    {p.description ?? planName(p.plan_code)}
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="text-foreground tabular-nums">
                      {formatMoney(p.amount_cents / 100, p.currency)}
                    </span>
                    <Badge
                      variant="outline"
                      className={PAYMENT_STYLE[p.status] ?? ''}
                    >
                      {t(`paymentStatus.${p.status}`)}
                    </Badge>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {isOwner &&
          (sub?.external_id || sub?.pending_external_id) &&
          sub.status !== 'canceled' && (
            <Button
              size="sm"
              variant="ghost"
              className="text-muted-foreground"
              disabled={busy !== null}
              onClick={() => {
                if (window.confirm(t('cancelConfirm'))) {
                  void call(
                    'cancel',
                    '/api/billing/subscription',
                    { method: 'DELETE' },
                    t('canceled')
                  );
                }
              }}
            >
              {t('cancel')}
            </Button>
          )}
      </CardContent>
    </Card>
  );
}

function CopyRow(props: {
  label: string;
  value: string;
  testId: string;
  copied: boolean;
  onCopy: () => void;
  copyLabel: string;
  copiedLabel: string;
}) {
  return (
    <div className="space-y-1.5">
      <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
        <QrCode className="size-3" />
        {props.label}
      </p>
      <div className="flex gap-2">
        <code
          className="bg-muted min-w-0 flex-1 truncate rounded px-2 py-1.5 font-mono text-xs"
          data-testid={props.testId}
        >
          {props.value}
        </code>
        <Button size="sm" variant="outline" onClick={props.onCopy}>
          {props.copied ? (
            <Check className="size-4" />
          ) : (
            <Copy className="size-4" />
          )}
          {props.copied ? props.copiedLabel : props.copyLabel}
        </Button>
      </div>
    </div>
  );
}
