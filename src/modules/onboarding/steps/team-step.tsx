'use client';

/**
 * 3 de 4 — Equipe (optional). Reuses the upstream invite flow: links
 * created by POST /api/account/invitations through the same
 * InviteMemberDialog as Configurações → Membros (copy / send by WhatsApp).
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Link2, Loader2, UserPlus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { InviteMemberDialog } from '@/components/settings/invite-member-dialog';
import { formatDate } from '@/custom/locale/format';

import { StepFooter } from '../step-footer';

interface PendingInvite {
  id: string;
  role: string;
  label: string | null;
  expires_at: string;
  accepted_at: string | null;
}

export function TeamStep({
  onBack,
  onSkip,
  onDone,
}: {
  onBack: () => void;
  onSkip: () => void;
  onDone: (invites: number) => void;
}) {
  const t = useTranslations('Custom.onboarding.team');
  const tRoles = useTranslations('Settings.roles');
  const [open, setOpen] = useState(false);
  const [invites, setInvites] = useState<PendingInvite[] | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/account/invitations', { cache: 'no-store' });
    const body = (await res.json().catch(() => ({}))) as {
      invitations?: PendingInvite[];
    };
    setInvites((body.invitations ?? []).filter((i) => !i.accepted_at));
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- setState runs after the fetch resolves
    void load();
  }, [load]);

  const count = invites?.length ?? 0;
  return (
    <div className="space-y-5">
      <p className="text-muted-foreground text-sm">{t('intro')}</p>
      <ul className="text-muted-foreground grid gap-2 text-sm sm:grid-cols-3">
        <li className="border-border rounded-lg border p-3">
          <span className="text-foreground block font-medium">
            {tRoles('admin')}
          </span>
          {t('roles.admin')}
        </li>
        <li className="border-border rounded-lg border p-3">
          <span className="text-foreground block font-medium">
            {tRoles('agent')}
          </span>
          {t('roles.agent')}
        </li>
        <li className="border-border rounded-lg border p-3">
          <span className="text-foreground block font-medium">
            {tRoles('viewer')}
          </span>
          {t('roles.viewer')}
        </li>
      </ul>

      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        <UserPlus className="size-4" />
        {t('create')}
      </Button>

      {invites === null ? (
        <Loader2 className="text-muted-foreground size-4 animate-spin" />
      ) : count > 0 ? (
        <div className="space-y-2">
          <p className="text-foreground text-xs font-medium">
            {t('pending', { count })}
          </p>
          <ul className="space-y-1.5">
            {invites.map((inv) => (
              <li
                key={inv.id}
                className="border-border flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
              >
                <Link2 className="text-muted-foreground size-3.5" />
                <span className="text-foreground">
                  {inv.label || tRoles(inv.role)}
                </span>
                <span className="text-muted-foreground text-xs">
                  · {tRoles(inv.role)} ·{' '}
                  {t('validUntil', {
                    date: formatDate(inv.expires_at, 'medium'),
                  })}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-muted-foreground text-xs">{t('none')}</p>
      )}

      <InviteMemberDialog
        open={open}
        onOpenChange={setOpen}
        onCreated={() => void load()}
      />

      <StepFooter
        onBack={onBack}
        onSkip={count === 0 ? onSkip : undefined}
        onContinue={() => (count === 0 ? onSkip() : onDone(count))}
      />
    </div>
  );
}
