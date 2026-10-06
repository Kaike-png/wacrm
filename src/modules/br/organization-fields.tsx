'use client';

/**
 * Registration fields of the organization (CPF/CNPJ, razão social, nome
 * fantasia, telefone, e-mail, endereço). Controlled; shared by
 * Configurações → Organização and the onboarding wizard.
 */
import { useTranslations } from 'next-intl';

import { Input } from '@/components/ui/input';

import { BRAZIL_UFS, maskCepInput } from './address';
import {
  Field,
  PhoneInputHint,
  inputClass,
  selectClass,
} from './contact-fields';
import { maskCnpjInput, maskCpfInput, type PersonType } from './documents';
import type { OrganizationDraft, OrganizationErrors } from './organization';

export function OrganizationProfileFields({
  draft,
  update,
  errorCodes,
  disabled = false,
}: {
  draft: OrganizationDraft;
  update: (patch: Partial<OrganizationDraft>) => void;
  errorCodes: OrganizationErrors;
  disabled?: boolean;
}) {
  const t = useTranslations('Br.organization');
  const tc = useTranslations('Br.contacts');
  const tp = useTranslations('Br.phone');
  const errorOf = (field: keyof OrganizationDraft): string | undefined => {
    const code = errorCodes[field];
    if (!code) return undefined;
    if (field === 'phone') return tp(`errors.${code}`);
    if (code === 'invalidEmail') return t('errors.invalidEmail');
    return tc(`errors.${code}`);
  };
  const text = (
    field: keyof OrganizationDraft,
    extra: Record<string, unknown> = {}
  ) => ({
    id: `org-${field}`,
    value: draft[field],
    disabled,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
      update({ [field]: e.target.value }),
    className: inputClass,
    'aria-invalid': !!errorCodes[field],
    ...extra,
  });

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field id="org-personType" label={tc('personType')}>
          <select
            id="org-personType"
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
            <option value="">{tc('personTypes.none')}</option>
            <option value="PJ">{tc('personTypes.PJ')}</option>
            <option value="PF">{tc('personTypes.PF')}</option>
          </select>
        </Field>
        {draft.personType && (
          <Field
            id="org-taxId"
            label={draft.personType === 'PF' ? tc('cpf') : tc('cnpj')}
            error={errorOf('taxId')}
          >
            <Input
              {...text('taxId', {
                inputMode: draft.personType === 'PF' ? 'numeric' : 'text',
                placeholder:
                  draft.personType === 'PF'
                    ? '000.000.000-00'
                    : '00.000.000/0000-00',
                onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
                  update({
                    taxId:
                      draft.personType === 'PF'
                        ? maskCpfInput(e.target.value)
                        : maskCnpjInput(e.target.value),
                  }),
              })}
            />
          </Field>
        )}
        <Field
          id="org-legalName"
          label={tc('legalName')}
          error={errorOf('legalName')}
        >
          <Input {...text('legalName')} />
        </Field>
        <Field
          id="org-tradeName"
          label={tc('tradeName')}
          error={errorOf('tradeName')}
        >
          <Input {...text('tradeName')} />
        </Field>
        <Field id="org-phone" label={t('phone')} error={errorOf('phone')}>
          <Input {...text('phone', { inputMode: 'tel' })} />
          {!errorCodes.phone && (
            <PhoneInputHint value={draft.phone} fallback="" />
          )}
        </Field>
        <Field id="org-email" label={t('email')} error={errorOf('email')}>
          <Input {...text('email', { type: 'email' })} />
        </Field>
      </div>

      <p className="text-foreground pt-2 text-sm font-medium">
        {tc('address')}
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[8rem_1fr_6rem]">
        <Field
          id="org-postalCode"
          label={tc('postalCode')}
          error={errorOf('postalCode')}
        >
          <Input
            {...text('postalCode', {
              inputMode: 'numeric',
              placeholder: '00000-000',
              onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
                update({ postalCode: maskCepInput(e.target.value) }),
            })}
          />
        </Field>
        <Field id="org-street" label={tc('street')} error={errorOf('street')}>
          <Input {...text('street')} />
        </Field>
        <Field
          id="org-streetNumber"
          label={tc('streetNumber')}
          error={errorOf('streetNumber')}
        >
          <Input {...text('streetNumber')} />
        </Field>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field
          id="org-complement"
          label={tc('complement')}
          error={errorOf('complement')}
        >
          <Input {...text('complement')} />
        </Field>
        <Field
          id="org-district"
          label={tc('district')}
          error={errorOf('district')}
        >
          <Input {...text('district')} />
        </Field>
      </div>
      <div className="grid grid-cols-[1fr_6rem] gap-3">
        <Field id="org-city" label={tc('city')} error={errorOf('city')}>
          <Input {...text('city')} />
        </Field>
        <Field id="org-state" label={tc('state')} error={errorOf('state')}>
          <select
            id="org-state"
            value={draft.state}
            disabled={disabled}
            onChange={(e) =>
              update({
                state: e.target.value as OrganizationDraft['state'],
              })
            }
            className={selectClass}
          >
            <option value="">{tc('statePlaceholder')}</option>
            {BRAZIL_UFS.map((uf) => (
              <option key={uf} value={uf}>
                {uf}
              </option>
            ))}
          </select>
        </Field>
      </div>
    </div>
  );
}
