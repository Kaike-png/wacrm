'use client';

/**
 * First-run setup wizard (/onboarding) — docs/ONBOARDING.md.
 *
 * "Criar conta" is the signup page; the organization itself is created
 * with the account (handle_new_user). Then:
 *   1 de 4 Organização · 2 de 4 Dados da empresa · 3 de 4 Equipe ·
 *   4 de 4 WhatsApp · Tudo pronto
 * Progress is saved after every step (onboarding_progress, 904), so a
 * reload or a detour to the advanced settings resumes where it stopped.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Check, Loader2 } from 'lucide-react';

import { createBrowserSupabase, useAuth } from '@/custom/core/client';
import { BrandLockup } from '@/custom/brand/brand-mark';
import { regionalDefaults } from '@/custom/locale/config';
import { useLocaleSettings } from '@/custom/locale/tenant-locale';
import {
  BR_ACCOUNT_PROFILE_TABLE,
  organizationDraftFromRow,
  type BrAccountProfileRow,
  type OrganizationDraft,
} from '@/modules/br/organization';

import { loadOnboardingProgress, saveOnboardingProgress } from './progress';
import {
  NEW_PROGRESS,
  ONBOARDING_STEPS,
  completeStep,
  finish,
  isOnboardingScreen,
  progressPercent,
  resumeScreen,
  skipStep,
  stepNumber,
  type OnboardingProgress,
  type OnboardingScreen,
  type OnboardingStep,
} from './steps';
import { CompanyStep } from './steps/company-step';
import { DoneStep } from './steps/done-step';
import {
  OrganizationStep,
  type OrganizationBasics,
} from './steps/organization-step';
import { TeamStep } from './steps/team-step';
import { WhatsAppStep } from './steps/whatsapp-step';

interface WizardData {
  accountId: string;
  basics: OrganizationBasics;
  company: OrganizationDraft;
  companyAvailable: boolean;
  hasCompanyData: boolean;
  progress: OnboardingProgress;
}

async function loadWizard(
  accountId: string,
  userEmail: string | null
): Promise<WizardData> {
  const supabase = createBrowserSupabase();
  const [{ data: account }, profile, { progress }] = await Promise.all([
    supabase
      .from('accounts')
      .select('name, locale, timezone, default_currency')
      .eq('id', accountId)
      .maybeSingle(),
    supabase
      .from(BR_ACCOUNT_PROFILE_TABLE)
      .select('*')
      .eq('account_id', accountId)
      .maybeSingle(),
    loadOnboardingProgress(accountId),
  ]);
  const acc = (account ?? {}) as Record<string, string | null>;
  const basics: OrganizationBasics = {
    name: acc.name ?? '',
    locale: acc.locale ?? regionalDefaults.locale,
    timezone: acc.timezone ?? regionalDefaults.timeZone,
    currency: acc.default_currency ?? regionalDefaults.currency,
  };
  const row = (profile.data as BrAccountProfileRow | null) ?? null;
  const company = organizationDraftFromRow(row);
  // Friendly defaults for a new organization: its name as nome fantasia,
  // the owner's e-mail as contact.
  if (!row) {
    company.tradeName = basics.name;
    company.email = userEmail ?? '';
  }
  return {
    accountId,
    basics,
    company,
    companyAvailable: !profile.error,
    hasCompanyData: !!row,
    progress: progress ?? NEW_PROGRESS,
  };
}

export function OnboardingWizard() {
  const t = useTranslations('Custom.onboarding');
  const router = useRouter();
  const searchParams = useSearchParams();
  const {
    accountId,
    accountStatus,
    user,
    canEditSettings,
    profileLoading,
    refreshProfile,
  } = useAuth();
  const { refresh: refreshLocale } = useLocaleSettings();

  const [data, setData] = useState<WizardData | null>(null);
  const [screen, setScreen] = useState<OnboardingScreen>('organization');
  const [invites, setInvites] = useState<number | null>(null);
  const [whatsappConnected, setWhatsappConnected] = useState(false);
  const [finishing, setFinishing] = useState(false);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    void loadWizard(accountId, user?.email ?? null).then((loaded) => {
      if (cancelled) return;
      setData(loaded);
      const requested = searchParams.get('step');
      setScreen(
        isOnboardingScreen(requested)
          ? requested
          : resumeScreen(loaded.progress)
      );
    });
    return () => {
      cancelled = true;
    };
  }, [accountId, user?.email, searchParams]);

  // Knowing whether WhatsApp is connected makes the summary honest.
  useEffect(() => {
    let cancelled = false;
    void fetch('/api/whatsapp/config', { cache: 'no-store' })
      .then((r) => r.json())
      .then(
        (b: { connected?: boolean }) =>
          !cancelled && setWhatsappConnected(!!b.connected)
      )
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const go = useCallback(
    async (
      next: OnboardingProgress,
      to: OnboardingScreen = next.current_step
    ) => {
      if (!data) return;
      setData((d) => (d ? { ...d, progress: next } : d));
      setScreen(to);
      window.scrollTo({ top: 0 });
      await saveOnboardingProgress(data.accountId, user?.id ?? null, next);
    },
    [data, user?.id]
  );

  const finishAndGo = useCallback(
    async (to: string) => {
      if (!data) return;
      setFinishing(true);
      const remaining = ONBOARDING_STEPS.filter(
        (s) => !data.progress.completed_steps.includes(s)
      ).reduce((p, s) => skipStep({ ...p, current_step: s }, s), data.progress);
      const done = finish({ ...remaining, current_step: 'done' });
      await saveOnboardingProgress(data.accountId, user?.id ?? null, done);
      if (!done.completed_at && done.current_step !== 'done') {
        // A required step is still missing: go there instead of leaving.
        setFinishing(false);
        setData((d) => (d ? { ...d, progress: done } : d));
        setScreen(done.current_step);
        return;
      }
      router.push(to);
    },
    [data, user?.id, router]
  );

  const percent = useMemo(
    () => (data ? progressPercent(data.progress) : 0),
    [data]
  );

  // Signed in without an organization (signup trigger failed, membership
  // removed): say so instead of spinning forever.
  if (
    !profileLoading &&
    !accountId &&
    (accountStatus === 'unlinked' || accountStatus === 'error')
  ) {
    return (
      <Shell>
        <div className="border-border bg-card space-y-4 rounded-xl border p-6">
          <p className="text-muted-foreground text-sm">{t('unlinked')}</p>
        </div>
      </Shell>
    );
  }

  if (profileLoading || !accountId || !data) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="text-muted-foreground size-6 animate-spin" />
      </div>
    );
  }

  if (!canEditSettings) {
    return (
      <Shell>
        <div className="border-border bg-card space-y-4 rounded-xl border p-6">
          <p className="text-muted-foreground text-sm">{t('adminOnly')}</p>
          <Link
            href="/dashboard"
            className="text-primary text-sm font-medium hover:underline"
          >
            {t('done.toDashboard')}
          </Link>
        </div>
      </Shell>
    );
  }

  const number = stepNumber(screen);
  const title =
    screen === 'done' ? t('done.title') : t(`steps.${screen}.title`);
  const description =
    screen === 'done'
      ? t('done.description')
      : t(`steps.${screen}.description`);
  const back = (step: OnboardingStep) => () => {
    const i = ONBOARDING_STEPS.indexOf(step);
    if (i > 0) setScreen(ONBOARDING_STEPS[i - 1]);
  };

  return (
    <Shell
      action={
        screen !== 'done' ? (
          <button
            type="button"
            onClick={() => void finishAndGo('/dashboard')}
            disabled={finishing}
            className="text-muted-foreground hover:text-foreground text-xs hover:underline"
          >
            {t('skipAll')}
          </button>
        ) : null
      }
    >
      {/* Progress */}
      <div className="space-y-3" aria-live="polite">
        <p className="text-primary text-xs font-medium tracking-wider uppercase">
          {number
            ? t('stepOf', { current: number, total: ONBOARDING_STEPS.length })
            : t('done.badge')}
        </p>
        <div
          className="bg-muted h-1.5 w-full overflow-hidden rounded-full"
          role="progressbar"
          aria-valuenow={screen === 'done' ? 100 : percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={t('progressLabel')}
        >
          <div
            className="bg-primary h-full rounded-full transition-all"
            style={{
              width: `${screen === 'done' ? 100 : Math.max(percent, ((number ?? 1) - 1) * 25, 4)}%`,
            }}
          />
        </div>
        <ol className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          <li className="flex items-center gap-1 text-emerald-400">
            <Check className="size-3.5" />
            {t('accountCreated')}
          </li>
          {ONBOARDING_STEPS.map((step, i) => {
            const finished = data.progress.completed_steps.includes(step);
            const skipped = data.progress.skipped_steps.includes(step);
            const current = step === screen;
            const reachable = finished || skipped || current || i === 0;
            return (
              <li key={step}>
                <button
                  type="button"
                  disabled={!reachable}
                  onClick={() => setScreen(step)}
                  aria-current={current ? 'step' : undefined}
                  className={`flex items-center gap-1 ${
                    current
                      ? 'text-foreground font-medium'
                      : finished
                        ? 'text-emerald-400'
                        : 'text-muted-foreground'
                  } disabled:cursor-default`}
                >
                  {finished ? (
                    <Check className="size-3.5" />
                  ) : (
                    <span className="inline-flex size-4 items-center justify-center rounded-full border border-current text-[10px]">
                      {i + 1}
                    </span>
                  )}
                  {t(`steps.${step}.short`)}
                  {skipped && !finished && (
                    <span className="text-muted-foreground">
                      · {t('skippedTag')}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ol>
      </div>

      <div className="border-border bg-card space-y-6 rounded-xl border p-6">
        <div>
          <h1 className="text-foreground text-xl font-semibold">
            {number
              ? t('stepTitle', {
                  current: number,
                  total: ONBOARDING_STEPS.length,
                  title,
                })
              : title}
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">{description}</p>
        </div>

        {screen === 'organization' && (
          <OrganizationStep
            accountId={data.accountId}
            initial={data.basics}
            onSaved={async (basics) => {
              setData((d) =>
                d
                  ? {
                      ...d,
                      basics,
                      company: d.hasCompanyData
                        ? d.company
                        : { ...d.company, tradeName: basics.name },
                    }
                  : d
              );
              void refreshProfile();
              void refreshLocale();
              await go(completeStep(data.progress, 'organization'));
            }}
          />
        )}
        {screen === 'company' && (
          <CompanyStep
            accountId={data.accountId}
            initial={data.company}
            available={data.companyAvailable}
            onBack={back('company')}
            onSkip={() => void go(skipStep(data.progress, 'company'))}
            onSaved={(company) => {
              setData((d) => (d ? { ...d, company, hasCompanyData: true } : d));
              void go(completeStep(data.progress, 'company'));
            }}
          />
        )}
        {screen === 'team' && (
          <TeamStep
            onBack={back('team')}
            onSkip={() => {
              setInvites(0);
              void go(skipStep(data.progress, 'team'));
            }}
            onDone={(count) => {
              setInvites(count);
              void go(completeStep(data.progress, 'team'));
            }}
          />
        )}
        {screen === 'whatsapp' && (
          <WhatsAppStep
            onBack={back('whatsapp')}
            onSkip={() => void go(skipStep(data.progress, 'whatsapp'))}
            onDone={(result) => {
              setWhatsappConnected(result.connected);
              void go(
                result.connected
                  ? completeStep(data.progress, 'whatsapp')
                  : skipStep(data.progress, 'whatsapp')
              );
            }}
          />
        )}
        {screen === 'done' && (
          <DoneStep
            progress={data.progress}
            summary={{
              organizationName: data.basics.name,
              hasCompanyData: data.hasCompanyData,
              invites,
              whatsappConnected,
            }}
            busy={finishing}
            onFinish={(to) => void finishAndGo(to)}
            onOpenStep={(step) => setScreen(step)}
          />
        )}
      </div>
    </Shell>
  );
}

function Shell({
  children,
  action,
}: {
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  const t = useTranslations('Custom.onboarding');
  return (
    <div className="bg-background min-h-screen">
      <header className="border-border flex items-center justify-between border-b px-4 py-3 sm:px-6">
        <div className="flex items-center gap-3">
          <BrandLockup />
          <span className="text-muted-foreground hidden text-sm sm:inline">
            · {t('title')}
          </span>
        </div>
        {action}
      </header>
      <main className="mx-auto w-full max-w-3xl space-y-6 px-4 py-8 sm:px-6">
        {children}
      </main>
    </div>
  );
}
