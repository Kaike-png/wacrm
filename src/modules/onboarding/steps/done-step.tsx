'use client';

/** Final screen: what was set up, what was left for later, next actions. */
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { CheckCircle2, Circle, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';

import {
  ONBOARDING_STEPS,
  type OnboardingProgress,
  type OnboardingStep,
} from '../steps';

export interface DoneSummary {
  organizationName: string;
  hasCompanyData: boolean;
  invites: number | null;
  whatsappConnected: boolean;
}

export function DoneStep({
  progress,
  summary,
  busy,
  onFinish,
  onOpenStep,
}: {
  progress: OnboardingProgress;
  summary: DoneSummary;
  busy: boolean;
  onFinish: (to: string) => void;
  onOpenStep: (step: OnboardingStep) => void;
}) {
  const t = useTranslations('Custom.onboarding');
  const done = (step: OnboardingStep): boolean => {
    if (step === 'organization') return true;
    if (step === 'company') return summary.hasCompanyData;
    if (step === 'team')
      return (
        (summary.invites ?? 0) > 0 || progress.completed_steps.includes('team')
      );
    return summary.whatsappConnected;
  };
  const detail = (step: OnboardingStep): string => {
    if (step === 'organization') return summary.organizationName;
    if (step === 'company')
      return summary.hasCompanyData ? t('done.companyDone') : t('done.later');
    if (step === 'team')
      return (summary.invites ?? 0) > 0
        ? t('done.invites', { count: summary.invites ?? 0 })
        : t('done.later');
    return summary.whatsappConnected
      ? t('done.whatsappDone')
      : t('done.whatsappLater');
  };

  return (
    <div className="space-y-6">
      <ul className="space-y-2">
        {ONBOARDING_STEPS.map((step) => (
          <li
            key={step}
            className="border-border flex items-center gap-3 rounded-lg border p-3"
          >
            {done(step) ? (
              <CheckCircle2 className="size-5 shrink-0 text-emerald-400" />
            ) : (
              <Circle className="text-muted-foreground size-5 shrink-0" />
            )}
            <div className="min-w-0 flex-1">
              <p className="text-foreground text-sm font-medium">
                {t(`steps.${step}.title`)}
              </p>
              <p className="text-muted-foreground truncate text-xs">
                {detail(step)}
              </p>
            </div>
            {!done(step) && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onOpenStep(step)}
              >
                {t('done.doNow')}
              </Button>
            )}
          </li>
        ))}
      </ul>

      <p className="text-muted-foreground text-sm">{t('done.whereLater')}</p>

      <div className="flex flex-col gap-2 sm:flex-row">
        <Button
          type="button"
          onClick={() => onFinish('/dashboard')}
          disabled={busy}
        >
          {busy && <Loader2 className="size-4 animate-spin" />}
          {t('done.toDashboard')}
        </Button>
        {summary.whatsappConnected && (
          <Button
            type="button"
            variant="outline"
            onClick={() => onFinish('/inbox')}
            disabled={busy}
          >
            {t('done.toInbox')}
          </Button>
        )}
        <Link
          href="/settings?tab=organization"
          className="text-muted-foreground hover:bg-muted hover:text-foreground inline-flex h-9 items-center justify-center rounded-lg px-3 text-sm font-medium"
        >
          {t('done.toSettings')}
        </Link>
      </div>
    </div>
  );
}
