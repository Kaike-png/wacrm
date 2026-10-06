/**
 * Human sentence for an audit entry (pure):
 *   "Admin ana@empresa.com suspendeu a organização Padaria em 05/10/2026 às 14:30."
 */
import type { AuditEntry } from './types';

export type AuditTranslate = (
  key: string,
  values?: Record<string, string | number>
) => string;

export interface AuditFormatters {
  date: (iso: string) => string;
  time: (iso: string) => string;
  planName: (code: string | null) => string | null;
}

export function describeAudit(
  entry: AuditEntry,
  t: AuditTranslate,
  f: AuditFormatters
): string {
  const details = entry.details ?? {};
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
  const status = (v: unknown) => (str(v) ? t(`status.${str(v)}`) : '—');
  const plan = (v: unknown) => f.planName(str(v)) ?? t('audit.noPlan');

  const isPlan = entry.action === 'organization.plan_changed';
  return t(`audit.sentence.${entry.action.replace('.', '_')}`, {
    actor: entry.actor_email,
    organization: entry.target_account_name ?? entry.target_account_id ?? '—',
    date: f.date(entry.created_at),
    time: f.time(entry.created_at),
    from: isPlan ? plan(details.from) : status(details.from),
    to: isPlan ? plan(details.to) : status(details.to),
    email: str(details.email) ?? '—',
    plan: f.planName(str(details.plan)) ?? '—',
  });
}
