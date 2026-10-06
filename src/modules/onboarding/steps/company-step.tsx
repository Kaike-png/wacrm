'use client';

/** 2 de 4 — Dados da empresa (optional): br_account_profiles (migration 902). */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { createBrowserSupabase } from '@/custom/core/client';
import {
  BR_ACCOUNT_PROFILE_TABLE,
  organizationRowFromDraft,
  validateOrganization,
  type OrganizationDraft,
  type OrganizationErrors,
} from '@/modules/br/organization';
import { OrganizationProfileFields } from '@/modules/br/organization-fields';

import { StepFooter } from '../step-footer';

export function CompanyStep({
  accountId,
  initial,
  available,
  onBack,
  onSkip,
  onSaved,
}: {
  accountId: string;
  initial: OrganizationDraft;
  /** False when migration 902 is missing: the step can only be skipped. */
  available: boolean;
  onBack: () => void;
  onSkip: () => void;
  onSaved: (draft: OrganizationDraft) => void;
}) {
  const t = useTranslations('Custom.onboarding.company');
  const [draft, setDraft] = useState(initial);
  const [errorCodes, setErrorCodes] = useState<OrganizationErrors>({});
  const [busy, setBusy] = useState(false);

  const update = (patch: Partial<OrganizationDraft>) => {
    setDraft((prev) => ({ ...prev, ...patch }));
    setErrorCodes((prev) => {
      const next = { ...prev };
      for (const k of Object.keys(patch))
        delete next[k as keyof OrganizationDraft];
      return next;
    });
  };

  async function save() {
    const found = validateOrganization(draft);
    setErrorCodes(found);
    if (Object.keys(found).length > 0) {
      toast.error(t('fix'));
      return;
    }
    setBusy(true);
    const { error } = await createBrowserSupabase()
      .from(BR_ACCOUNT_PROFILE_TABLE)
      .upsert(
        { account_id: accountId, ...organizationRowFromDraft(draft) },
        { onConflict: 'account_id' }
      );
    setBusy(false);
    if (error) {
      toast.error(t('saveFailed'));
      return;
    }
    onSaved(draft);
  }

  if (!available) {
    return (
      <div className="space-y-5">
        <p className="text-muted-foreground text-sm">{t('unavailable')}</p>
        <StepFooter onBack={onBack} onContinue={onSkip} />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <p className="text-muted-foreground text-sm">{t('optionalHint')}</p>
      <OrganizationProfileFields
        draft={draft}
        update={update}
        errorCodes={errorCodes}
        disabled={busy}
      />
      <StepFooter
        onBack={onBack}
        onSkip={onSkip}
        onContinue={save}
        busy={busy}
      />
    </div>
  );
}
