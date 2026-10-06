import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { PlansEditor } from '@/modules/platform/plans-editor';
import { getPlatformAdmin } from '@/modules/platform/server/auth';
import { getPlanCatalog } from '@/modules/platform/server/data';

export default async function PlatformPlansPage() {
  if (!(await getPlatformAdmin())) notFound();
  const t = await getTranslations('Custom.platform.plans');
  const catalog = await getPlanCatalog();
  return (
    <>
      <div>
        <h1 className="text-foreground text-xl font-semibold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
      </div>
      <PlansEditor catalog={catalog} />
    </>
  );
}
