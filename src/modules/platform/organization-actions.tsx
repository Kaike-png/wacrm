'use client';

/**
 * Suspend / reactivate / change plan buttons for one organization
 * (platform panel, docs/PLATFORM_ADMIN.md). Each action asks for
 * confirmation; suspending requires a reason. Audited server-side.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Ban, Loader2, RotateCcw, Tag } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { AccountStatus } from '@/billing/account-status';

type Mode = 'suspend' | 'reactivate' | 'plan';

export function OrganizationActions({
  accountId,
  name,
  status,
  planCode,
  plans,
}: {
  accountId: string;
  name: string;
  status: AccountStatus;
  planCode: string | null;
  /** Assignable plans (active), from billing_plans. */
  plans: { code: string; name: string }[];
}) {
  const t = useTranslations('Custom.platform.actions');
  const router = useRouter();
  const [mode, setMode] = useState<Mode | null>(null);
  const [reason, setReason] = useState('');
  const [plan, setPlan] = useState<string>(planCode ?? '');
  const [busy, setBusy] = useState(false);

  const canSuspend =
    status === 'trial' || status === 'active' || status === 'past_due';
  const canReactivate = status === 'suspended' || status === 'cancelled';

  function open(next: Mode) {
    setReason('');
    setPlan(planCode ?? '');
    setMode(next);
  }

  async function submit() {
    if (!mode) return;
    if (mode === 'suspend' && !reason.trim()) {
      toast.error(t('errors.reason_required'));
      return;
    }
    setBusy(true);
    try {
      const url =
        mode === 'plan'
          ? `/api/platform/organizations/${accountId}/plan`
          : `/api/platform/organizations/${accountId}/status`;
      const body =
        mode === 'plan'
          ? { plan: plan || null, reason }
          : { action: mode, reason };
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        const key =
          json.error &&
          [
            'invalid_transition',
            'reason_required',
            'not_found',
            'invalid_input',
          ].includes(json.error)
            ? json.error
            : 'failed';
        toast.error(t(`errors.${key}`));
        return;
      }
      toast.success(
        t(
          mode === 'suspend'
            ? 'suspended'
            : mode === 'reactivate'
              ? 'reactivated'
              : 'planChanged'
        )
      );
      setMode(null);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="flex flex-wrap gap-2">
        {canSuspend && (
          <Button
            variant="destructive"
            size="sm"
            onClick={() => open('suspend')}
          >
            <Ban className="size-4" />
            {t('suspend')}
          </Button>
        )}
        {canReactivate && (
          <Button size="sm" onClick={() => open('reactivate')}>
            <RotateCcw className="size-4" />
            {t('reactivate')}
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={() => open('plan')}>
          <Tag className="size-4" />
          {t('changePlan')}
        </Button>
      </div>

      <Dialog
        open={mode !== null}
        onOpenChange={(o) => !o && !busy && setMode(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {mode === 'suspend'
                ? t('suspendTitle', { name })
                : mode === 'reactivate'
                  ? t('reactivateTitle', { name })
                  : t('planTitle', { name })}
            </DialogTitle>
            <DialogDescription>
              {mode === 'suspend'
                ? t('suspendBody')
                : mode === 'reactivate'
                  ? t('reactivateBody')
                  : t('planBody')}
            </DialogDescription>
          </DialogHeader>

          {mode === 'plan' && (
            <div className="space-y-1.5">
              <Label htmlFor="platform-plan">{t('changePlan')}</Label>
              <select
                id="platform-plan"
                value={plan}
                onChange={(e) => setPlan(e.target.value)}
                className="border-border bg-background text-foreground h-9 w-full rounded-md border px-3 text-sm"
              >
                <option value="">{t('noPlan')}</option>
                {plans.map((p) => (
                  <option key={p.code} value={p.code}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="platform-reason">
              {mode === 'suspend' ? t('reasonRequired') : t('reason')}
            </Label>
            <Textarea
              id="platform-reason"
              value={reason}
              maxLength={500}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t('reasonPlaceholder')}
            />
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setMode(null)}
              disabled={busy}
            >
              {t('cancel')}
            </Button>
            <Button
              variant={mode === 'suspend' ? 'destructive' : 'default'}
              onClick={submit}
              disabled={busy || (mode === 'suspend' && !reason.trim())}
            >
              {busy && <Loader2 className="size-4 animate-spin" />}
              {t('confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
