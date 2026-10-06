'use client';

/**
 * "Uso neste mês" (fork, docs/USAGE.md): the usage report of one
 * organization — stock against plan limits and this month's activity.
 * `UsageReportCard` is presentational (also used by the platform panel);
 * `MyUsageCard` loads the signed-in user's organization.
 */
import { useTranslations } from 'next-intl';
import { Bot, MessageSquareText, Megaphone, Send } from 'lucide-react';

import { Card, CardContent } from '@/components/ui/card';
import { formatDate, formatNumber } from '@/custom/locale/format';

import { usageRatio } from './features';
import type { UsageReportView } from './usage-types';
import { useUsage } from './use-entitlements';

function Bar({ limit, used }: { limit: number | null; used: number }) {
  if (limit === null) return null;
  const ratio = usageRatio(limit, used);
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

function Stock({
  label,
  used,
  limit,
  detail,
  testId,
}: {
  label: string;
  used: number;
  limit: number | null;
  detail: string;
  testId: string;
}) {
  const t = useTranslations('Custom.billing.usage');
  return (
    <div
      className="border-border/60 space-y-1 rounded-md border p-3"
      data-usage={testId}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-muted-foreground text-sm">{label}</span>
        <span className="text-foreground text-sm tabular-nums">
          <span className="text-base font-semibold">{formatNumber(used)}</span>{' '}
          <span className="text-muted-foreground">
            {limit === null
              ? `· ${t('unlimited')}`
              : t('limitOf', { limit: formatNumber(limit) })}
          </span>
        </span>
      </div>
      <Bar limit={limit} used={used} />
      <p className="text-muted-foreground text-xs">{detail}</p>
    </div>
  );
}

function Activity({
  icon: Icon,
  label,
  value,
  detail,
  testId,
}: {
  icon: typeof Send;
  label: string;
  value: string;
  detail?: string;
  testId: string;
}) {
  return (
    <div
      className="border-border/60 flex items-start gap-3 rounded-md border p-3"
      data-usage={testId}
    >
      <Icon className="text-muted-foreground mt-0.5 size-4" />
      <div className="min-w-0">
        <p className="text-muted-foreground text-sm">{label}</p>
        <p className="text-foreground text-base font-semibold tabular-nums">
          {value}
        </p>
        {detail && <p className="text-muted-foreground text-xs">{detail}</p>}
      </div>
    </div>
  );
}

export function UsageReportCard({
  usage,
  embedded = false,
}: {
  usage: UsageReportView;
  embedded?: boolean;
}) {
  const t = useTranslations('Custom.billing.usage');
  const u = usage;
  // The period end is exclusive (first instant of next month).
  const lastDay = new Date(new Date(u.period.end).getTime() - 1);
  const body = (
    <div className="space-y-4">
      {!embedded && (
        <div>
          <h3 className="text-foreground text-sm font-semibold">
            {t('title')}
          </h3>
          <p className="text-muted-foreground text-xs">
            {t('period', {
              start: formatDate(u.period.start),
              end: formatDate(lastDay),
              timeZone: u.period.time_zone,
            })}
          </p>
        </div>
      )}
      <div className="space-y-2">
        <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
          {t('stock')}
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          <Stock
            testId="users"
            label={t('users')}
            used={u.users.total + u.users.pending_invitations}
            limit={u.users.limit}
            detail={t('usersDetail', {
              active: u.users.active_30d,
              pending: u.users.pending_invitations,
            })}
          />
          <Stock
            testId="contacts"
            label={t('contacts')}
            used={u.contacts.total}
            limit={u.contacts.limit}
            detail={t('contactsDetail', {
              created: u.contacts.created_period,
            })}
          />
          <Stock
            testId="whatsapp"
            label={t('whatsapp')}
            used={u.whatsapp_accounts.total}
            limit={u.whatsapp_accounts.limit}
            detail={t('whatsappDetail', {
              connected: u.whatsapp_accounts.connected,
            })}
          />
          <Stock
            testId="automations"
            label={t('automations')}
            used={u.automations.total}
            limit={u.automations.limit}
            detail={t('automationsDetail', { active: u.automations.active })}
          />
        </div>
      </div>
      <div className="space-y-2">
        <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
          {t('activity')}
        </p>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <Activity
            testId="messages-sent"
            icon={Send}
            label={t('messagesSent')}
            value={formatNumber(u.messages.sent_period)}
            detail={
              u.messages.failed_period
                ? t('messagesFailed', {
                    failed: formatNumber(u.messages.failed_period),
                  })
                : undefined
            }
          />
          <Activity
            testId="messages-received"
            icon={MessageSquareText}
            label={t('messagesReceived')}
            value={formatNumber(u.messages.received_period)}
          />
          <Activity
            testId="campaigns"
            icon={Megaphone}
            label={t('campaigns')}
            value={formatNumber(u.campaigns.created_period)}
            detail={t('campaignsDetail', {
              recipients: formatNumber(u.campaigns.recipients_sent_period),
            })}
          />
          <Activity
            testId="ai"
            icon={Bot}
            label={t('ai')}
            value={
              u.ai.enabled
                ? t('aiTokens', { tokens: formatNumber(u.ai.tokens_period) })
                : t('aiOff')
            }
            detail={
              u.ai.enabled
                ? t('aiDetail', {
                    requests: formatNumber(u.ai.requests_period),
                    replies: formatNumber(u.ai.auto_replies_period),
                  })
                : undefined
            }
          />
        </div>
      </div>
    </div>
  );
  if (embedded) return body;
  return (
    <Card className="border-border bg-card" data-testid="usage-report">
      <CardContent className="p-5">{body}</CardContent>
    </Card>
  );
}

export function MyUsageCard() {
  const { usage } = useUsage();
  return usage ? <UsageReportCard usage={usage} /> : null;
}
