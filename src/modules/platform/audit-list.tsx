/**
 * Audit entries as sentences (server component), e.g.
 * "Admin ana@empresa.com suspendeu a organização Padaria em 05/10/2026 às 14:30."
 */
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

import { formatDate, formatTime } from '@/custom/locale/format';

import { describeAudit } from './audit-text';
import { getPlanCatalog, planNamer } from './server/data';
import type { AuditEntry } from './types';

const IMPORTANT = new Set([
  'organization.suspended',
  'organization.reactivated',
  'organization.plan_changed',
  'billing_plan.updated',
]);

export async function AuditList({
  entries,
  linkOrganizations = true,
}: {
  entries: AuditEntry[];
  linkOrganizations?: boolean;
}) {
  const t = await getTranslations('Custom.platform');
  if (entries.length === 0) {
    return <p className="text-muted-foreground text-sm">{t('audit.empty')}</p>;
  }
  const planName = planNamer(await getPlanCatalog());
  const fmt = {
    date: (iso: string) => formatDate(iso),
    time: (iso: string) => formatTime(iso),
    planName: (code: string | null) => planName(code),
  };
  return (
    <ul className="divide-border border-border bg-card divide-y rounded-lg border">
      {entries.map((e) => (
        <li
          key={e.id}
          className="space-y-1 px-4 py-3 text-sm"
          data-audit-action={e.action}
        >
          <p
            className={
              IMPORTANT.has(e.action)
                ? 'text-foreground'
                : 'text-muted-foreground'
            }
          >
            {describeAudit(e, (key, values) => t(key, values), fmt)}
          </p>
          <p className="text-muted-foreground flex flex-wrap gap-x-3 text-xs">
            {e.reason && <span>{t('audit.reason', { reason: e.reason })}</span>}
            {e.ip && <span>{t('audit.from', { ip: e.ip })}</span>}
            {linkOrganizations && e.target_account_id && (
              <Link
                href={`/platform/organizations/${e.target_account_id}`}
                className="hover:underline"
              >
                {e.target_account_name ?? e.target_account_id}
              </Link>
            )}
          </p>
        </li>
      ))}
    </ul>
  );
}
