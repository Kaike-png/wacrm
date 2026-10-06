import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AlertTriangle } from 'lucide-react';

import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ACCOUNT_STATUSES } from '@/billing/account-status';
import { formatDate, formatNumber } from '@/custom/locale/format';
import { getPlatformAdmin } from '@/modules/platform/server/auth';
import {
  getPlanCatalog,
  listOrganizations,
  planNamer,
} from '@/modules/platform/server/data';
import { PAGE_SIZE } from '@/modules/platform/types';
import { formatTaxIdAuto, StatusPill } from '@/modules/platform/ui';

type SearchParams = Promise<{ q?: string; status?: string; page?: string }>;

export default async function PlatformOrganizationsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  if (!(await getPlatformAdmin())) notFound();
  const sp = await searchParams;
  const t = await getTranslations('Custom.platform');
  const q = (sp.q ?? '').slice(0, 120);
  const status = sp.status ?? '';
  const { rows, total, page } = await listOrganizations({
    search: q,
    status,
    page: Number(sp.page) || 1,
  });
  const planName = planNamer(await getPlanCatalog());
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const href = (p: number) => {
    const u = new URLSearchParams();
    if (q) u.set('q', q);
    if (status) u.set('status', status);
    if (p > 1) u.set('page', String(p));
    const s = u.toString();
    return s ? `/platform?${s}` : '/platform';
  };

  return (
    <>
      <div>
        <h1 className="text-foreground text-xl font-semibold">
          {t('list.title')}
        </h1>
        <p className="text-muted-foreground text-sm">
          {t('list.subtitle', { count: total })}
        </p>
      </div>

      <form method="get" action="/platform" className="flex flex-wrap gap-2">
        <Input
          name="q"
          defaultValue={q}
          placeholder={t('list.searchPlaceholder')}
          aria-label={t('list.search')}
          className="min-w-72 flex-1"
        />
        <select
          name="status"
          defaultValue={status}
          aria-label={t('list.columns.status')}
          className="border-border bg-background text-foreground h-9 rounded-md border px-3 text-sm"
        >
          <option value="">{t('list.allStatuses')}</option>
          {ACCOUNT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(`status.${s}`)}
            </option>
          ))}
        </select>
        <Button type="submit">{t('list.search')}</Button>
        {(q || status) && (
          <Link
            href="/platform"
            className={buttonVariants({ variant: 'ghost' })}
          >
            {t('list.clear')}
          </Link>
        )}
      </form>

      <div className="border-border bg-card overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('list.columns.organization')}</TableHead>
              <TableHead>{t('list.columns.status')}</TableHead>
              <TableHead>{t('list.columns.plan')}</TableHead>
              <TableHead className="text-right">
                {t('list.columns.users')}
              </TableHead>
              <TableHead className="text-right">
                {t('list.columns.contacts')}
              </TableHead>
              <TableHead>{t('list.columns.whatsapp')}</TableHead>
              <TableHead className="text-right">
                {t('list.columns.usage')}
              </TableHead>
              <TableHead>{t('list.columns.errors')}</TableHead>
              <TableHead>{t('list.columns.createdAt')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={9}
                  className="text-muted-foreground py-8 text-center text-sm"
                >
                  {t('list.empty')}
                </TableCell>
              </TableRow>
            )}
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell>
                  <Link
                    href={`/platform/organizations/${r.id}`}
                    className="text-foreground font-medium hover:underline"
                  >
                    {r.name}
                  </Link>
                  <div className="text-muted-foreground text-xs">
                    {[
                      r.legal_name ?? r.trade_name,
                      formatTaxIdAuto(r.tax_id),
                      r.owner_email,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                </TableCell>
                <TableCell>
                  <StatusPill
                    value={r.status}
                    label={t(`status.${r.status}`)}
                  />
                </TableCell>
                <TableCell className="text-sm">
                  {planName(r.plan_code) ?? t('list.noPlan')}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatNumber(r.users_count)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatNumber(r.contacts_count)}
                </TableCell>
                <TableCell>
                  {r.whatsapp_status ? (
                    <div className="space-y-0.5">
                      <StatusPill
                        value={r.whatsapp_status}
                        label={t(`whatsappStatus.${r.whatsapp_status}`)}
                      />
                      <div className="text-muted-foreground font-mono text-[11px]">
                        WABA {r.waba_id ?? '—'}
                      </div>
                    </div>
                  ) : (
                    <span className="text-muted-foreground text-xs">
                      {t('list.noWhatsapp')}
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatNumber(r.messages_30d)}
                </TableCell>
                <TableCell>
                  {r.integration_errors > 0 ? (
                    <span className="flex items-center gap-1 text-xs text-red-400">
                      <AlertTriangle className="size-3" />
                      {t('list.errorsCount', { count: r.integration_errors })}
                    </span>
                  ) : (
                    <span className="text-muted-foreground text-xs">—</span>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  {formatDate(r.created_at)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {pages > 1 && (
        <div className="text-muted-foreground flex items-center justify-between text-sm">
          <span>{t('list.page', { page, pages })}</span>
          <div className="flex gap-2">
            <Link
              href={href(Math.max(1, page - 1))}
              aria-disabled={page <= 1}
              className={cn(
                buttonVariants({ variant: 'outline', size: 'sm' }),
                page <= 1 && 'pointer-events-none opacity-50'
              )}
            >
              {t('list.previous')}
            </Link>
            <Link
              href={href(Math.min(pages, page + 1))}
              aria-disabled={page >= pages}
              className={cn(
                buttonVariants({ variant: 'outline', size: 'sm' }),
                page >= pages && 'pointer-events-none opacity-50'
              )}
            >
              {t('list.next')}
            </Link>
          </div>
        </div>
      )}
    </>
  );
}
