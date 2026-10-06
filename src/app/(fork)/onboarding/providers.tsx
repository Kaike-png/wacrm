'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

import { AuthProvider, useAuth } from '@/hooks/use-auth';
import { TenantLocaleProvider } from '@/custom/locale/tenant-locale';

function RequireUser({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (!loading && !user) router.replace('/login');
  }, [user, loading, router]);
  return user ? <>{children}</> : null;
}

/** Same providers as the dashboard shell (session, tenant formatting). */
export function OnboardingProviders({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AuthProvider>
      <TenantLocaleProvider>
        <RequireUser>{children}</RequireUser>
      </TenantLocaleProvider>
    </AuthProvider>
  );
}
