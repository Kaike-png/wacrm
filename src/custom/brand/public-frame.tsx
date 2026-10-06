import type { ReactNode } from 'react';
import { getTranslations } from 'next-intl/server';
import { brand } from './config';
import { BrandLockup } from './brand-mark';

/**
 * Brand frame for public (unauthenticated) pages: brand lockup in the
 * top-left corner, support contact at the bottom. Used by the
 * `(auth)` and `join` layouts. Both corners are absolutely positioned
 * so the pages' own centred layout (`min-h-screen` + flex centring) is
 * left untouched.
 */
export async function PublicBrandFrame({ children }: { children: ReactNode }) {
  const t = await getTranslations('Custom.brand');

  return (
    <div className="relative min-h-screen">
      <header className="absolute inset-x-0 top-0 z-10 flex px-6 py-5">
        <BrandLockup />
      </header>
      {children}
      {brand.supportEmail && (
        <footer className="text-muted-foreground absolute inset-x-0 bottom-0 px-6 py-4 text-center text-xs">
          {t('supportPrompt')}{' '}
          <a
            href={`mailto:${brand.supportEmail}`}
            className="text-foreground font-medium underline-offset-4 hover:underline"
          >
            {brand.supportEmail}
          </a>
        </footer>
      )}
    </div>
  );
}
