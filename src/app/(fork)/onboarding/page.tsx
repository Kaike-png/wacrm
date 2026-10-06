import { Suspense } from 'react';

import { OnboardingWizard } from '@/modules/onboarding/wizard';

export default function OnboardingPage() {
  return (
    <Suspense fallback={null}>
      <OnboardingWizard />
    </Suspense>
  );
}
