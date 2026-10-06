'use client';

/**
 * State + persistence of a contact's Brazilian registration data
 * (`br_contact_profiles`, migration 901) for the contact form and the
 * contact detail view (FORK-PATCH(P-005)). The core components keep
 * owning the `contacts` row; this hook only adds:
 *
 *   const br = useBrazilianProfile({ contactId, enabled: open });
 *   if (!br.validate()) return;           // before saving the contact
 *   …save contacts…
 *   await br.save(contactId);             // after it
 *
 * Tolerant: if the migration is missing the section is hidden
 * (`available: false`) and saving is a no-op, so the core flow is never
 * blocked by the fork.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import { createBrowserSupabase, useAuth } from '@/custom/core/client';

import {
  BR_PROFILE_TABLE,
  EMPTY_BR_PROFILE,
  draftFromRow,
  isEmptyBrProfile,
  rowFromDraft,
  validateBrProfile,
  type BrContactProfileRow,
  type BrProfileDraft,
  type BrProfileErrors,
} from './profile';

export interface BrazilianProfileController {
  /** False until loaded, or when the table does not exist. */
  available: boolean;
  loading: boolean;
  draft: BrProfileDraft;
  /** Last loaded/saved values (for read-only display, e.g. the header). */
  saved: BrProfileDraft;
  update: (patch: Partial<BrProfileDraft>) => void;
  /** Translated messages per field, after `validate()`. */
  errors: Partial<Record<keyof BrProfileDraft, string>>;
  /** True when the row has any value (to open the section by default). */
  hasData: boolean;
  /** "Nome fantasia" for PJ, to relabel the core company field; else null. */
  companyLabel: string | null;
  validate: () => boolean;
  /** Translated toast text for a failed `save`. */
  saveFailedMessage: string;
  /** Upsert (or delete, when emptied). Resolves false on error. */
  save: (contactId: string) => Promise<boolean>;
}

export function useBrazilianProfile({
  contactId,
  enabled,
}: {
  contactId: string | null | undefined;
  enabled: boolean;
}): BrazilianProfileController {
  const t = useTranslations('Br.contacts');
  const { accountId } = useAuth();
  const [state, setState] = useState<{
    key: string;
    available: boolean;
    exists: boolean;
    draft: BrProfileDraft;
    saved: BrProfileDraft;
  } | null>(null);
  const [errorCodes, setErrorCodes] = useState<BrProfileErrors>({});

  const key = `${enabled ? 1 : 0}:${contactId ?? 'new'}`;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void (async () => {
      const supabase = createBrowserSupabase();
      if (!contactId) {
        // New contact: only check the table exists so the section can show.
        const { error } = await supabase
          .from(BR_PROFILE_TABLE)
          .select('contact_id')
          .limit(0);
        if (!cancelled)
          setState({
            key,
            available: !error,
            exists: false,
            draft: { ...EMPTY_BR_PROFILE },
            saved: EMPTY_BR_PROFILE,
          });
        return;
      }
      const { data, error } = await supabase
        .from(BR_PROFILE_TABLE)
        .select('*')
        .eq('contact_id', contactId)
        .maybeSingle();
      if (cancelled) return;
      if (error) {
        console.warn('[useBrazilianProfile] unavailable:', error.message);
        setState({
          key,
          available: false,
          exists: false,
          draft: { ...EMPTY_BR_PROFILE },
          saved: EMPTY_BR_PROFILE,
        });
        return;
      }
      const row = (data as BrContactProfileRow | null) ?? null;
      const loaded = draftFromRow(row);
      setState({
        key,
        available: true,
        exists: !!row,
        draft: loaded,
        saved: loaded,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, contactId, key]);

  const current = state && state.key === key ? state : null;
  const draft = current?.draft ?? EMPTY_BR_PROFILE;

  const update = useCallback(
    (patch: Partial<BrProfileDraft>) => {
      setState((prev) =>
        prev && prev.key === key
          ? { ...prev, draft: { ...prev.draft, ...patch } }
          : prev
      );
      setErrorCodes((prev) => {
        const next = { ...prev };
        for (const k of Object.keys(patch))
          delete next[k as keyof BrProfileDraft];
        return next;
      });
    },
    [key]
  );

  const validate = useCallback(() => {
    if (!current?.available) return true;
    const found = validateBrProfile(current.draft);
    setErrorCodes(found);
    return Object.keys(found).length === 0;
  }, [current]);

  const save = useCallback(
    async (id: string) => {
      if (!current?.available) return true;
      const supabase = createBrowserSupabase();
      const row = rowFromDraft(current.draft);
      if (isEmptyBrProfile(row)) {
        if (!current.exists) return true;
        const { error } = await supabase
          .from(BR_PROFILE_TABLE)
          .delete()
          .eq('contact_id', id);
        if (!error)
          setState((prev) =>
            prev && prev.key === key
              ? { ...prev, exists: false, saved: EMPTY_BR_PROFILE }
              : prev
          );
        return !error;
      }
      if (!accountId) return false;
      // The DB trigger re-derives account_id from the contact anyway, so a
      // stale or forged value can never move the row to another tenant.
      const { error } = await supabase
        .from(BR_PROFILE_TABLE)
        .upsert(
          { contact_id: id, account_id: accountId, ...row },
          { onConflict: 'contact_id' }
        );
      if (error) {
        console.error('[useBrazilianProfile] save failed:', error.message);
        return false;
      }
      setState((prev) =>
        prev && prev.key === key
          ? { ...prev, exists: true, saved: prev.draft }
          : prev
      );
      return true;
    },
    [current, key, accountId]
  );

  const errors = useMemo(() => {
    const out: Partial<Record<keyof BrProfileDraft, string>> = {};
    for (const [field, code] of Object.entries(errorCodes)) {
      if (code) out[field as keyof BrProfileDraft] = t(`errors.${code}`);
    }
    return out;
  }, [errorCodes, t]);

  const hasData = !isEmptyBrProfile(rowFromDraft(draft));

  return {
    available: !!current?.available,
    loading: enabled && !current,
    draft,
    saved: current?.saved ?? EMPTY_BR_PROFILE,
    update,
    errors,
    hasData,
    companyLabel: draft.personType === 'PJ' ? t('tradeName') : null,
    validate,
    save,
    saveFailedMessage: t('saveFailed'),
  };
}
