'use client';

/**
 * UI for Brazilian contact data (FORK-PATCH(P-005), docs/BRAZILIAN_CONTACTS.md):
 *
 *   - `BrazilianProfileFields`: pessoa física/jurídica, CPF/CNPJ (masked),
 *     razão social and address, bound to `useBrazilianProfile`.
 *   - `PhoneInputHint`: under the core phone input, shows what will be
 *     stored (`+55 (21) 99999-9999`) or why the number is not accepted.
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronRight, IdCard } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

import {
  BRAZIL_UFS,
  getCepLookupProvider,
  maskCepInput,
  normalizeCep,
} from './address';
import {
  formatTaxId,
  isValidTaxId,
  maskCnpjInput,
  maskCpfInput,
  type PersonType,
} from './documents';
import {
  defaultPhoneCountry,
  formatPhoneDisplay,
  normalizePhoneInput,
} from './phone';
import type { BrProfileDraft } from './profile';
import type { BrazilianProfileController } from './use-br-profile';

export const inputClass =
  'bg-muted border-border text-foreground placeholder:text-muted-foreground';
export const selectClass =
  'h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary disabled:opacity-60';

export function Field({
  id,
  label,
  error,
  className,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <Label htmlFor={id} className="text-muted-foreground text-xs">
        {label}
      </Label>
      {children}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}

export function BrazilianProfileFields({
  profile,
  idPrefix = 'br',
  collapsible = false,
  disabled = false,
}: {
  profile: BrazilianProfileController;
  idPrefix?: string;
  /** Contact form: start collapsed unless the contact already has data. */
  collapsible?: boolean;
  disabled?: boolean;
}) {
  const t = useTranslations('Br.contacts');
  const [expanded, setExpanded] = useState(false);
  const [lookingUp, setLookingUp] = useState(false);
  if (!profile.available) return null;

  const { draft, update, errors } = profile;
  const open = !collapsible || expanded || profile.hasData;
  const id = (name: string) => `${idPrefix}-${name}`;
  const text = (name: keyof BrProfileDraft) => ({
    id: id(name),
    value: draft[name],
    disabled,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
      update({ [name]: e.target.value }),
    className: inputClass,
  });
  const provider = getCepLookupProvider();

  async function lookupCep() {
    if (!provider) return;
    const cep = normalizeCep(draft.postalCode);
    if (cep.length !== 8) return;
    setLookingUp(true);
    try {
      const found = await provider.lookup(cep);
      if (found) update(found);
    } finally {
      setLookingUp(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="text-primary flex items-center gap-1 text-xs font-medium hover:underline"
      >
        <ChevronRight className="size-3.5" />
        {t('show')}
      </button>
    );
  }

  return (
    <fieldset
      className="border-border space-y-3 rounded-lg border p-3"
      disabled={disabled}
    >
      <legend className="text-foreground px-1 text-xs font-medium">
        {collapsible ? (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="flex items-center gap-1"
            disabled={profile.hasData}
          >
            <ChevronDown className="size-3.5" />
            {t('sectionTitle')}
          </button>
        ) : (
          t('sectionTitle')
        )}
      </legend>
      <p className="text-muted-foreground text-xs">{t('sectionHint')}</p>

      <div className="grid grid-cols-2 gap-3">
        <Field id={id('personType')} label={t('personType')}>
          <select
            id={id('personType')}
            value={draft.personType}
            disabled={disabled}
            onChange={(e) =>
              update({
                personType: e.target.value as PersonType | '',
                taxId: '',
              })
            }
            className={selectClass}
          >
            <option value="">{t('personTypes.none')}</option>
            <option value="PF">{t('personTypes.PF')}</option>
            <option value="PJ">{t('personTypes.PJ')}</option>
          </select>
        </Field>
        {draft.personType && (
          <Field
            id={id('taxId')}
            label={draft.personType === 'PF' ? t('cpf') : t('cnpj')}
            error={errors.taxId}
          >
            <Input
              {...text('taxId')}
              inputMode={draft.personType === 'PF' ? 'numeric' : 'text'}
              autoCapitalize="characters"
              placeholder={
                draft.personType === 'PF'
                  ? '000.000.000-00'
                  : '00.000.000/0000-00'
              }
              onChange={(e) =>
                update({
                  taxId:
                    draft.personType === 'PF'
                      ? maskCpfInput(e.target.value)
                      : maskCnpjInput(e.target.value),
                })
              }
              aria-invalid={!!errors.taxId}
            />
          </Field>
        )}
      </div>

      {draft.personType === 'PJ' && (
        <Field
          id={id('legalName')}
          label={t('legalName')}
          error={errors.legalName}
        >
          <Input {...text('legalName')} />
        </Field>
      )}

      <p className="text-foreground pt-1 text-xs font-medium">{t('address')}</p>
      <div className="grid grid-cols-[8rem_1fr] gap-3">
        <Field
          id={id('postalCode')}
          label={t('postalCode')}
          error={errors.postalCode}
        >
          <Input
            {...text('postalCode')}
            inputMode="numeric"
            placeholder="00000-000"
            onChange={(e) =>
              update({ postalCode: maskCepInput(e.target.value) })
            }
            aria-invalid={!!errors.postalCode}
          />
        </Field>
        <Field id={id('street')} label={t('street')} error={errors.street}>
          <Input {...text('street')} />
        </Field>
      </div>
      {provider && (
        <button
          type="button"
          onClick={lookupCep}
          disabled={lookingUp || normalizeCep(draft.postalCode).length !== 8}
          className="text-primary text-xs font-medium hover:underline disabled:opacity-50"
        >
          {t('cepLookup')}
        </button>
      )}
      <div className="grid grid-cols-[6rem_1fr] gap-3">
        <Field
          id={id('streetNumber')}
          label={t('streetNumber')}
          error={errors.streetNumber}
        >
          <Input {...text('streetNumber')} />
        </Field>
        <Field
          id={id('complement')}
          label={t('complement')}
          error={errors.complement}
        >
          <Input {...text('complement')} />
        </Field>
      </div>
      <Field id={id('district')} label={t('district')} error={errors.district}>
        <Input {...text('district')} />
      </Field>
      <div className="grid grid-cols-[1fr_6rem] gap-3">
        <Field id={id('city')} label={t('city')} error={errors.city}>
          <Input {...text('city')} />
        </Field>
        <Field id={id('state')} label={t('state')} error={errors.state}>
          <select
            id={id('state')}
            value={draft.state}
            disabled={disabled}
            onChange={(e) =>
              update({ state: e.target.value as BrProfileDraft['state'] })
            }
            className={selectClass}
          >
            <option value="">{t('statePlaceholder')}</option>
            {BRAZIL_UFS.map((uf) => (
              <option key={uf} value={uf}>
                {uf}
              </option>
            ))}
          </select>
        </Field>
      </div>
    </fieldset>
  );
}

/**
 * Hint under a phone input. For Brazilian accounts: the stored form
 * ("Será salvo como +55 (21) 99999-9999") or the reason it is not
 * accepted. Other accounts: the core hint, unchanged.
 */
export function PhoneInputHint({
  value,
  fallback,
}: {
  value: string;
  fallback: string;
}) {
  const t = useTranslations('Br.phone');
  if (defaultPhoneCountry() !== 'BR') {
    return <p className="text-muted-foreground text-xs">{fallback}</p>;
  }
  if (!value.trim()) {
    return <p className="text-muted-foreground text-xs">{t('hintBrazil')}</p>;
  }
  const result = normalizePhoneInput(value);
  if (result.ok) {
    return (
      <p className="text-muted-foreground text-xs">
        {t('willSaveAs', { phone: formatPhoneDisplay(result.e164) })}
      </p>
    );
  }
  return (
    <p className="text-xs text-amber-400">{t(`errors.${result.error}`)}</p>
  );
}

/**
 * Translated reason for a rejected phone input (toast on submit), for
 * Brazilian accounts. `null` when the number is fine or the account is
 * not Brazilian (the caller keeps the core message).
 */
export function usePhoneErrorMessage() {
  const t = useTranslations('Br.phone');
  return (raw: string): string | null => {
    if (defaultPhoneCountry() !== 'BR') return null;
    const result = normalizePhoneInput(raw);
    return result.ok ? null : t(`errors.${result.error}`);
  };
}

/** Masked CPF/CNPJ for the contact header, once saved and valid. */
export function BrazilianTaxIdBadge({
  profile,
}: {
  profile: BrazilianProfileController;
}) {
  const t = useTranslations('Br.contacts');
  const { personType, taxId } = profile.saved;
  if (!personType || !taxId || !isValidTaxId(taxId, personType)) return null;
  return (
    <span
      className="flex items-center gap-1"
      title={personType === 'PF' ? t('cpf') : t('cnpj')}
    >
      <IdCard className="size-3" />
      {formatTaxId(taxId, personType)}
    </span>
  );
}
