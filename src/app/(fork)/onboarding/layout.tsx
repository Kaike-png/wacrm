import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { OnboardingProviders } from './providers';

// Fork route (docs/ONBOARDING.md). Outside the dashboard layout on purpose:
// a focused, full-screen wizard without the sidebar.
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Custom.onboarding');
  return {
    title: t('title'),
    robots: { index: false, follow: false, nocache: true },
  };
}

export default function OnboardingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Delinquency never blocks access (docs/DELINQUENCY.md): the wizard
  // stays available; blocked actions are refused where they happen.
  return <OnboardingProviders>{children}</OnboardingProviders>;
}
