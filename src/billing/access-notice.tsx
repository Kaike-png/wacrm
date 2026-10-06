/**
 * Delinquency banner above every dashboard page (fork, docs/DELINQUENCY.md).
 * Server component. Members keep using the app; the banner says what is
 * blocked (from the policy), that nothing was deleted, and links to
 * billing. Renders nothing for organizations in good standing.
 */
import Link from 'next/link';
import { AlertTriangle, Ban, CreditCard, LifeBuoy } from 'lucide-react';

import { addDays } from './dates';
import { getCallerTenantAccess } from './caller-access';
import { getT } from '@/custom/core/server';
import { brand } from '@/custom/brand/config';
import { graceDaysFromEnv } from './access-policy';
import { formatDate } from '@/custom/locale/format';

const BILLING_HREF = '/settings?tab=organization#assinatura';

export async function TenantAccessNotice() {
  const access = await getCallerTenantAccess().catch(() => null);
  if (!access?.notice) return null;
  const t = getT('Custom.billing.access.notice');

  const byTeam =
    access.notice === 'suspended' && access.suspendedBy === 'platform';
  const severe = access.notice !== 'payment_due';
  const title = byTeam ? t('suspended.platform') : t(`${access.notice}.title`);
  const body = byTeam
    ? t('suspended.platformBody')
    : t(`${access.notice}.body`);
  const deadline =
    access.notice === 'payment_due' && access.pastDueSince
      ? t('payment_due.deadline', {
          date: formatDate(
            addDays(access.pastDueSince, graceDaysFromEnv()),
            'long'
          ),
        })
      : null;
  const canPay = access.notice !== 'cancelled' && !byTeam;
  const Icon = severe ? Ban : AlertTriangle;

  return (
    <div
      role="alert"
      data-testid="tenant-access-notice"
      data-notice={access.notice}
      className={`mb-4 flex flex-col gap-3 rounded-lg border p-4 text-sm sm:flex-row sm:items-center ${
        severe
          ? 'border-red-500/40 bg-red-500/10'
          : 'border-amber-500/40 bg-amber-500/10'
      }`}
    >
      <Icon
        className={`size-5 shrink-0 ${severe ? 'text-red-400' : 'text-amber-400'}`}
      />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-foreground font-medium">{title}</p>
        <p className="text-muted-foreground">{body}</p>
        {deadline && <p className="text-amber-300">{deadline}</p>}
      </div>
      {canPay ? (
        <Link
          href={BILLING_HREF}
          className="bg-primary text-primary-foreground inline-flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 font-medium"
        >
          <CreditCard className="size-4" />
          {t('pay')}
        </Link>
      ) : brand.supportEmail ? (
        <a
          href={`mailto:${brand.supportEmail}`}
          className="border-border inline-flex shrink-0 items-center gap-1.5 rounded-md border px-3 py-1.5"
        >
          <LifeBuoy className="size-4" />
          {t('support')}
        </a>
      ) : null}
    </div>
  );
}
