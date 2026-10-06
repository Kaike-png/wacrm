import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { ArrowLeft, ShieldCheck } from 'lucide-react';

import { getPlatformAdmin } from '@/modules/platform/server/auth';

// Fork route (docs/PLATFORM_ADMIN.md): platform team only. Each page checks
// again — layouts and pages render in parallel, so a layout check alone
// does not stop a page's data loading.
export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Custom.platform');
  return {
    title: t('title'),
    robots: { index: false, follow: false, nocache: true },
  };
}

export default async function PlatformLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const admin = await getPlatformAdmin();
  if (!admin) notFound();
  const t = await getTranslations('Custom.platform');

  return (
    <div className="bg-background min-h-screen">
      <header className="border-border bg-card border-b">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-3">
          <span className="text-foreground flex items-center gap-2 font-semibold">
            <ShieldCheck className="text-primary size-5" />
            {t('title')}
          </span>
          <nav className="flex gap-4 text-sm">
            <Link
              href="/platform"
              className="text-muted-foreground hover:text-foreground"
            >
              {t('nav.organizations')}
            </Link>
            <Link
              href="/platform/plans"
              className="text-muted-foreground hover:text-foreground"
            >
              {t('nav.plans')}
            </Link>
            <Link
              href="/platform/audit"
              className="text-muted-foreground hover:text-foreground"
            >
              {t('nav.audit')}
            </Link>
          </nav>
          <span className="text-muted-foreground ml-auto text-xs">
            {t('signedInAs', { email: admin.email })}
          </span>
          <Link
            href="/dashboard"
            className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs"
          >
            <ArrowLeft className="size-3" />
            {t('backToApp')}
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-7xl space-y-6 px-6 py-6">{children}</main>
    </div>
  );
}
