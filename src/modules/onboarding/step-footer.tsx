'use client';

import { useTranslations } from 'next-intl';
import { ArrowLeft, ArrowRight, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';

/** Footer shared by every wizard step: Voltar · Fazer depois · Continuar. */
export function StepFooter({
  onBack,
  onSkip,
  onContinue,
  continueLabel,
  busy = false,
  continueDisabled = false,
}: {
  onBack?: () => void;
  onSkip?: () => void;
  onContinue: () => void;
  continueLabel?: string;
  busy?: boolean;
  continueDisabled?: boolean;
}) {
  const t = useTranslations('Custom.onboarding.nav');
  return (
    <div className="border-border flex flex-col-reverse gap-2 border-t pt-5 sm:flex-row sm:items-center sm:justify-between">
      <div>
        {onBack && (
          <Button
            type="button"
            variant="ghost"
            onClick={onBack}
            disabled={busy}
          >
            <ArrowLeft className="size-4" />
            {t('back')}
          </Button>
        )}
      </div>
      <div className="flex flex-col-reverse gap-2 sm:flex-row">
        {onSkip && (
          <Button
            type="button"
            variant="outline"
            onClick={onSkip}
            disabled={busy}
          >
            {t('skip')}
          </Button>
        )}
        <Button
          type="button"
          onClick={onContinue}
          disabled={busy || continueDisabled}
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : null}
          {continueLabel ?? t('continue')}
          {!busy && <ArrowRight className="size-4" />}
        </Button>
      </div>
    </div>
  );
}
