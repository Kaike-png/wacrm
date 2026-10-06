import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { ArrowLeft, KeyRound } from 'lucide-react';

import { Card, CardContent } from '@/components/ui/card';
import { EntitlementsList } from '@/billing/plan-ui';
import { formatDate, formatDateTime } from '@/custom/locale/format';
import { formatPhoneDisplay } from '@/modules/br/phone';
import { AuditList } from '@/modules/platform/audit-list';
import { OrganizationActions } from '@/modules/platform/organization-actions';
import { getPlatformAdmin, requestMeta } from '@/modules/platform/server/auth';
import {
  getOrganization,
  getPlanCatalog,
  getUsageReport,
  listAudit,
  planNamer,
  recordOrganizationView,
} from '@/modules/platform/server/data';
import { formatTaxIdAuto, StatusPill } from '@/modules/platform/ui';
import { UsageReportCard } from '@/billing/usage-ui';

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="border-border bg-card">
      <CardContent className="space-y-3 p-5">
        <h2 className="text-foreground text-sm font-semibold">{title}</h2>
        {children}
      </CardContent>
    </Card>
  );
}

function Fields({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
      {rows.map(([label, value]) => (
        <div
          key={label}
          className="border-border/50 flex justify-between gap-3 border-b py-1"
        >
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="text-foreground text-right">{value || '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

export default async function PlatformOrganizationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const admin = await getPlatformAdmin();
  if (!admin) notFound();
  const { id } = await params;
  const org = await getOrganization(id);
  if (!org) notFound();
  await recordOrganizationView(admin, id, await requestMeta());
  const audit = await listAudit({ accountId: id, pageSize: 20 });
  const catalog = await getPlanCatalog();
  const report = await getUsageReport(id);
  const planName = planNamer(catalog);
  const assignablePlans = catalog.plans
    .filter((p) => p.is_active)
    .map((p) => ({ code: p.code, name: p.name }));

  const t = await getTranslations('Custom.platform');
  const d = (iso: string | null | undefined) =>
    iso ? formatDateTime(iso) : t('detail.never');
  const { account: a, profile: p, errors: e } = org;
  const hasErrors =
    e.whatsapp.length +
      e.events.length +
      e.failed_messages.length +
      e.webhooks.length +
      e.automations.length >
    0;

  return (
    <>
      <Link
        href="/platform"
        className="text-muted-foreground hover:text-foreground flex w-fit items-center gap-1 text-sm"
      >
        <ArrowLeft className="size-4" />
        {t('detail.back')}
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-3">
            <h1 className="text-foreground text-xl font-semibold">{a.name}</h1>
            <StatusPill value={a.status} label={t(`status.${a.status}`)} />
          </div>
          <p className="text-muted-foreground text-sm">
            {[
              t('detail.createdAt', { date: formatDate(a.created_at) }),
              a.status_changed_at
                ? t('detail.statusSince', {
                    date: formatDate(a.status_changed_at),
                  })
                : null,
              a.status === 'trial' && a.trial_ends_at
                ? t('detail.trialEnds', { date: formatDate(a.trial_ends_at) })
                : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        <OrganizationActions
          accountId={a.id}
          name={a.name}
          status={a.status}
          planCode={org.plan?.plan_code ?? null}
          plans={assignablePlans}
        />
      </div>

      <div className="grid gap-6">
        <Section title={t('detail.sections.overview')}>
          <Fields
            rows={[
              [
                t('detail.id'),
                <span key="id" className="font-mono text-xs">
                  {a.id}
                </span>,
              ],
              [t('detail.owner'), a.owner_email],
              [t('detail.legalName'), p?.legal_name],
              [t('detail.tradeName'), p?.trade_name],
              [t('detail.taxId'), formatTaxIdAuto(p?.tax_id)],
              [t('detail.contactEmail'), p?.email],
              [
                t('detail.contactPhone'),
                p?.phone ? formatPhoneDisplay(p.phone) : null,
              ],
              [
                t('detail.city'),
                [p?.city, p?.state].filter(Boolean).join(' / '),
              ],
              [
                t('detail.regional'),
                [a.locale, a.timezone, a.default_currency]
                  .filter(Boolean)
                  .join(' · '),
              ],
              [
                t('detail.sections.plan'),
                org.plan
                  ? `${planName(org.plan.plan_code)} · ${formatDate(org.plan.assigned_at)}`
                  : t('list.noPlan'),
              ],
            ]}
          />
        </Section>
      </div>

      <Section title={t('detail.sections.usageMonth')}>
        {report && <UsageReportCard usage={report} embedded />}
      </Section>

      <Section
        title={`${t('detail.sections.entitlements')} · ${planName(org.plan?.plan_code) ?? t('list.noPlan')}`}
      >
        <EntitlementsList entitlements={org.entitlements} />
      </Section>

      <Section title={t('detail.sections.wabas')}>
        {org.wabas.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {t('detail.wabas.none')}
          </p>
        ) : (
          org.wabas.map((w) => (
            <Fields
              key={w.phone_number_id}
              rows={[
                [
                  t('detail.wabas.status'),
                  <StatusPill
                    key="s"
                    value={w.status}
                    label={t(`whatsappStatus.${w.status}`)}
                  />,
                ],
                [
                  t('detail.wabas.phoneNumberId'),
                  <span key="p" className="font-mono text-xs">
                    {w.phone_number_id}
                  </span>,
                ],
                [
                  t('detail.wabas.wabaId'),
                  <span key="w" className="font-mono text-xs">
                    {w.waba_id ?? '—'}
                  </span>,
                ],
                [
                  t('detail.wabas.businessId'),
                  <span key="b" className="font-mono text-xs">
                    {w.business_id ?? '—'}
                  </span>,
                ],
                [
                  t('detail.wabas.registered'),
                  w.registered_at ? d(w.registered_at) : t('detail.no'),
                ],
                [
                  t('detail.wabas.subscribed'),
                  w.subscribed_apps_at
                    ? d(w.subscribed_apps_at)
                    : t('detail.no'),
                ],
                [t('detail.wabas.lastWebhook'), d(w.last_webhook_at)],
                [t('detail.wabas.lastChecked'), d(w.last_checked_at)],
                [
                  t('detail.wabas.credentials'),
                  t('detail.wabas.credentialsValue', {
                    token: t(
                      w.has_access_token
                        ? 'detail.wabas.set'
                        : 'detail.wabas.unset'
                    ),
                    verify: t(
                      w.has_verify_token
                        ? 'detail.wabas.set'
                        : 'detail.wabas.unset'
                    ),
                    pin: t(
                      w.has_pin ? 'detail.wabas.set' : 'detail.wabas.unset'
                    ),
                  }),
                ],
              ]}
            />
          ))
        )}
        <p className="text-muted-foreground flex items-center gap-1 text-xs">
          <KeyRound className="size-3" />
          {t('detail.wabas.secretsNote')}
        </p>
      </Section>

      <Section title={t('detail.sections.errors')}>
        {!hasErrors && (
          <p className="text-muted-foreground text-sm">
            {t('detail.errors.none')}
          </p>
        )}
        {e.whatsapp.map((w) => (
          <div
            key={w.source}
            className="rounded-md border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-300"
          >
            <p className="font-medium">
              {t(
                w.source === 'check'
                  ? 'detail.errors.whatsappCheck'
                  : 'detail.errors.whatsappRegistration'
              )}
              {w.at ? ` · ${formatDateTime(w.at)}` : ''}
            </p>
            <p>{w.message}</p>
          </div>
        ))}
        {e.events.length > 0 && (
          <div className="space-y-1">
            <p className="text-foreground text-xs font-medium">
              {t('detail.errors.events')}
            </p>
            <ul className="text-muted-foreground space-y-1 text-xs">
              {e.events.map((ev, i) => (
                <li key={i}>
                  <span className="text-foreground">
                    {formatDateTime(ev.at)}
                  </span>{' '}
                  · {ev.event}
                  {ev.meta_error_code ? ` · #${ev.meta_error_code}` : ''}
                  {ev.message ? ` — ${ev.message}` : ''}
                </li>
              ))}
            </ul>
          </div>
        )}
        {e.failed_messages.length > 0 && (
          <div className="space-y-1">
            <p className="text-foreground text-xs font-medium">
              {t('detail.errors.failedMessages')}
            </p>
            <ul className="text-muted-foreground space-y-1 text-xs">
              {e.failed_messages.map((f, i) => (
                <li key={i}>
                  <span className="text-foreground">
                    {f.code ?? t('detail.errors.noCode')}
                  </span>
                  {f.title ? ` — ${f.title}` : ''} ·{' '}
                  {t('detail.errors.failedCount', { count: f.count })} ·{' '}
                  {formatDateTime(f.last_at)}
                </li>
              ))}
            </ul>
          </div>
        )}
        {e.webhooks.length > 0 && (
          <div className="space-y-1">
            <p className="text-foreground text-xs font-medium">
              {t('detail.errors.webhooks')}
            </p>
            <ul className="text-muted-foreground space-y-1 text-xs">
              {e.webhooks.map((w, i) => (
                <li key={i}>
                  <span className="text-foreground font-mono">
                    {w.host ?? '—'}
                  </span>{' '}
                  ·{' '}
                  {t('detail.errors.webhookFailures', {
                    count: w.failure_count,
                  })}
                </li>
              ))}
            </ul>
          </div>
        )}
        {e.automations.length > 0 && (
          <div className="space-y-1">
            <p className="text-foreground text-xs font-medium">
              {t('detail.errors.automations')}
            </p>
            <ul className="text-muted-foreground space-y-1 text-xs">
              {e.automations.map((au, i) => (
                <li key={i}>
                  <span className="text-foreground">
                    {formatDateTime(au.at)}
                  </span>
                  {au.message ? ` — ${au.message}` : ''}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Section>

      <Section title={t('detail.sections.members')}>
        <table className="w-full text-sm">
          <thead className="text-muted-foreground text-left text-xs">
            <tr>
              <th className="py-1 font-normal">{t('detail.members.name')}</th>
              <th className="py-1 font-normal">{t('detail.members.email')}</th>
              <th className="py-1 font-normal">{t('detail.members.role')}</th>
              <th className="py-1 font-normal">{t('detail.members.since')}</th>
            </tr>
          </thead>
          <tbody>
            {org.members.map((m, i) => (
              <tr key={i} className="border-border/50 border-t">
                <td className="text-foreground py-1.5">{m.full_name || '—'}</td>
                <td className="text-muted-foreground py-1.5">
                  {m.email || '—'}
                </td>
                <td className="text-muted-foreground py-1.5">
                  {t(`detail.members.roles.${m.role}`)}
                </td>
                <td className="text-muted-foreground py-1.5">
                  {formatDate(m.created_at)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title={t('detail.sections.audit')}>
        <AuditList entries={audit} linkOrganizations={false} />
      </Section>
    </>
  );
}
