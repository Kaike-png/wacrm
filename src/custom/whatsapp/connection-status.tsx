'use client';

/**
 * "Status da conexão" card — Configurações → WhatsApp, above the upstream
 * (advanced) form (FORK-PATCH(P-008), docs/WHATSAPP_SAAS.md).
 *
 * Shows Conectado / Pendente / Erro / Desconectado from
 * GET /api/whatsapp/connection, the non-secret identifiers, the token
 * hint (admins), health timestamps and the connection log; "Testar
 * conexão" calls POST /api/whatsapp/connection/test. Never sees a secret.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Activity, Loader2, Pencil, RefreshCw } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/custom/core/client';
import { formatDateTime, formatRelativeTime } from '@/custom/locale/format';

import type { ConnectionStatus, ConnectionSummary } from './status';

const STYLE: Record<ConnectionStatus, string> = {
  connected: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
  pending: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  error: 'border-red-500/40 bg-red-500/10 text-red-300',
  disconnected: 'border-zinc-500/40 bg-zinc-500/10 text-zinc-300',
};

export function WhatsAppConnectionStatus() {
  const t = useTranslations('Custom.whatsapp.status');
  const { canEditSettings } = useAuth();
  const [summary, setSummary] = useState<ConnectionSummary | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [testing, setTesting] = useState(false);
  const [editingBusiness, setEditingBusiness] = useState(false);
  const [businessId, setBusinessId] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/whatsapp/connection', {
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(String(res.status));
      setSummary((await res.json()) as ConnectionSummary);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function runTest() {
    setTesting(true);
    try {
      const res = await fetch('/api/whatsapp/connection/test', {
        method: 'POST',
      });
      const body = (await res.json().catch(() => ({}))) as {
        status?: ConnectionStatus;
        error?: string | null;
      };
      if (!res.ok) throw new Error(body.error || t('testFailed'));
      if (body.status === 'connected') toast.success(t('testOk'));
      else if (body.status === 'pending') toast.warning(t('testPending'));
      else if (body.status === 'disconnected') toast.info(t('testNoConfig'));
      else toast.error(body.error || t('testFailed'));
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('testFailed'));
    } finally {
      setTesting(false);
    }
  }

  async function saveBusinessId() {
    const res = await fetch('/api/whatsapp/connection', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ business_id: businessId.trim() }),
    });
    if (!res.ok) {
      toast.error(t('businessIdInvalid'));
      return;
    }
    setSummary((await res.json()) as ConnectionSummary);
    setEditingBusiness(false);
    toast.success(t('businessIdSaved'));
  }

  if (!summary) {
    return (
      <Card className="border-border bg-card">
        <CardContent className="text-muted-foreground p-5 text-sm">
          {loadError ? (
            t('loadFailed')
          ) : (
            <Loader2 className="size-4 animate-spin" />
          )}
        </CardContent>
      </Card>
    );
  }

  const s = summary;
  const rows: [string, React.ReactNode][] = [
    [t('phoneNumberId'), s.phoneNumberId ?? '—'],
    [t('wabaId'), s.wabaId ?? '—'],
    [
      t('businessId'),
      editingBusiness ? (
        <span className="flex gap-2">
          <Input
            value={businessId}
            onChange={(e) => setBusinessId(e.target.value.replace(/\D/g, ''))}
            className="h-8 w-48 font-mono text-xs"
            inputMode="numeric"
            aria-label={t('businessId')}
          />
          <Button size="sm" onClick={saveBusinessId}>
            {t('save')}
          </Button>
        </span>
      ) : (
        <span className="flex items-center gap-2">
          {s.businessId ?? '—'}
          {canEditSettings && s.phoneNumberId && (
            <button
              type="button"
              aria-label={t('editBusinessId')}
              onClick={() => {
                setBusinessId(s.businessId ?? '');
                setEditingBusiness(true);
              }}
              className="text-muted-foreground hover:text-foreground"
            >
              <Pencil className="size-3" />
            </button>
          )}
        </span>
      ),
    ],
    [t('token'), s.tokenHint ?? (s.phoneNumberId ? t('hidden') : '—')],
    [t('verifyToken'), s.hasVerifyToken ? t('configured') : t('notConfigured')],
    [t('pin'), s.hasPin ? t('configured') : t('notConfigured')],
    [
      t('registered'),
      s.registeredAt ? formatDateTime(s.registeredAt) : t('no'),
    ],
    [
      t('subscribed'),
      s.subscribedAt ? formatDateTime(s.subscribedAt) : t('no'),
    ],
    [
      t('lastWebhook'),
      s.lastWebhookAt ? formatRelativeTime(s.lastWebhookAt) : t('never'),
    ],
    [
      t('lastChecked'),
      s.lastCheckedAt ? formatRelativeTime(s.lastCheckedAt) : t('never'),
    ],
  ];

  return (
    <Card className="border-border bg-card">
      <CardContent className="space-y-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Activity className="text-muted-foreground size-4" />
            <span className="text-foreground text-sm font-medium">
              {t('title')}
            </span>
            <Badge
              variant="outline"
              className={STYLE[s.status]}
              data-status={s.status}
            >
              {t(`states.${s.status}.label`)}
            </Badge>
          </div>
          {canEditSettings && (
            <Button
              size="sm"
              variant="outline"
              onClick={runTest}
              disabled={testing || !s.phoneNumberId}
            >
              {testing ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RefreshCw className="size-4" />
              )}
              {t('test')}
            </Button>
          )}
        </div>
        <p className="text-muted-foreground text-sm">
          {t(`states.${s.status}.description`)}
        </p>
        {s.lastError && (
          <p className="rounded-md border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-300">
            {s.lastError}
          </p>
        )}

        {s.phoneNumberId && (
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            {rows.map(([label, value]) => (
              <div
                key={label}
                className="border-border/50 flex justify-between gap-3 border-b py-1"
              >
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="text-foreground text-right font-mono text-xs">
                  {value}
                </dd>
              </div>
            ))}
          </dl>
        )}

        {s.events.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-foreground text-xs font-medium">
              {t('history')}
            </p>
            <ul className="space-y-1 text-xs">
              {s.events.map((e) => (
                <li
                  key={e.id}
                  className="text-muted-foreground flex flex-wrap gap-x-2"
                >
                  <span className="text-foreground">
                    {formatDateTime(e.created_at)}
                  </span>
                  <span>· {t(`events.${e.event}`)}</span>
                  {e.status && <span>· {t(`states.${e.status}.label`)}</span>}
                  {e.message && (
                    <span className="basis-full truncate">{e.message}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
