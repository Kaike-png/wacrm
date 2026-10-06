'use client';

/** "Exportar dados" (fork, docs/DELINQUENCY.md): always available, whatever the organization status. */
import { useTranslations } from 'next-intl';
import { Download } from 'lucide-react';

import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

export function DataExportCard() {
  const t = useTranslations('Custom.export');
  return (
    <Card className="border-border bg-card" data-testid="data-export">
      <CardContent className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <h3 className="text-foreground text-sm font-semibold">
            {t('title')}
          </h3>
          <p className="text-muted-foreground text-sm">{t('body')}</p>
        </div>
        <a
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
          href="/api/account/export"
          download
        >
          <Download className="size-4" />
          {t('contacts')}
        </a>
      </CardContent>
    </Card>
  );
}
