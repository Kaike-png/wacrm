'use client';

/**
 * Browser access to `onboarding_progress` (migration 904) and the
 * dashboard gate. Tolerant: if the table is missing (migration not
 * applied) or the read fails, the gate never redirects.
 */
import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';

import { createBrowserSupabase, useAuth } from '@/custom/core/client';

import {
  isOnboardingScreen,
  isOnboardingStep,
  shouldRedirectToOnboarding,
  type OnboardingProgress,
} from './steps';

export const ONBOARDING_TABLE = 'onboarding_progress';
export const ONBOARDING_PATH = '/onboarding';

export async function loadOnboardingProgress(
  accountId: string
): Promise<{ available: boolean; progress: OnboardingProgress | null }> {
  const { data, error } = await createBrowserSupabase()
    .from(ONBOARDING_TABLE)
    .select('current_step, completed_steps, skipped_steps, completed_at')
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) return { available: false, progress: null };
  if (!data) return { available: true, progress: null };
  const row = data as Record<string, unknown>;
  return {
    available: true,
    progress: {
      current_step: isOnboardingScreen(row.current_step)
        ? row.current_step
        : 'organization',
      completed_steps: ((row.completed_steps as unknown[]) ?? []).filter(
        isOnboardingStep
      ),
      skipped_steps: ((row.skipped_steps as unknown[]) ?? []).filter(
        isOnboardingStep
      ),
      completed_at: (row.completed_at as string | null) ?? null,
    },
  };
}

export async function saveOnboardingProgress(
  accountId: string,
  userId: string | null,
  progress: OnboardingProgress
): Promise<boolean> {
  const { error } = await createBrowserSupabase()
    .from(ONBOARDING_TABLE)
    .upsert(
      {
        account_id: accountId,
        current_step: progress.current_step,
        completed_steps: progress.completed_steps,
        skipped_steps: progress.skipped_steps,
        completed_at: progress.completed_at,
        completed_by: progress.completed_at ? userId : null,
      },
      { onConflict: 'account_id' }
    );
  if (error) console.error('[onboarding] save failed:', error.message);
  return !error;
}

/** Only the landing page redirects: deep links (e.g. the advanced
 *  WhatsApp settings opened from the wizard) keep working. */
export const ONBOARDING_GATED_PATHS: readonly string[] = ['/dashboard'];

/**
 * Mounted in the dashboard shell (FORK-PATCH(P-007)). Sends the owner of
 * an organization that has not finished setup from /dashboard (where
 * signup and login land) to /onboarding. Renders nothing; the page
 * renders normally meanwhile (no blank screen if the check is slow or
 * fails).
 */
export function OnboardingGate() {
  const { accountId, isOwner, profileLoading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [checked, setChecked] = useState<string | null>(null);

  useEffect(() => {
    if (profileLoading || !accountId || checked === accountId) return;
    if (!ONBOARDING_GATED_PATHS.includes(pathname)) return;
    let cancelled = false;
    void loadOnboardingProgress(accountId).then(({ available, progress }) => {
      if (cancelled) return;
      setChecked(accountId);
      if (shouldRedirectToOnboarding({ available, progress, isOwner })) {
        router.replace(ONBOARDING_PATH);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [accountId, isOwner, profileLoading, checked, router, pathname]);

  return null;
}
