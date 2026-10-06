import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { getPlatformAdmin } from '@/modules/platform/server/auth';
import { listAudit } from '@/modules/platform/server/data';
import { AuditList } from '@/modules/platform/audit-list';

export default async function PlatformAuditPage() {
  if (!(await getPlatformAdmin())) notFound();
  const t = await getTranslations('Custom.platform.audit');
  const entries = await listAudit({ pageSize: 200 });
  return (
    <>
      <div>
        <h1 className="text-foreground text-xl font-semibold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
      </div>
      <AuditList entries={entries} />
    </>
  );
}
