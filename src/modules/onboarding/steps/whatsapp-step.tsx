'use client';

/**
 * 4 de 4 — WhatsApp (optional), manual connection.
 *
 * A guided version of Configurações → WhatsApp (which stays as the
 * advanced screen): the same POST /api/whatsapp/config (it validates the
 * credentials with Meta, registers the number when a PIN is given,
 * subscribes the WABA and stores everything encrypted), then the webhook
 * values to paste in the Meta app. No Embedded Signup yet.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  Loader2,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field, inputClass } from '@/modules/br/contact-fields';

import { StepFooter } from '../step-footer';

export interface WhatsAppResult {
  connected: boolean;
  phone?: string;
  name?: string;
}

interface SaveResponse {
  success?: boolean;
  saved?: boolean;
  registered?: boolean;
  registration_skipped?: boolean;
  registration_error?: string;
  error?: string;
  meta?: { field?: string };
  phone_info?: { display_phone_number?: string; verified_name?: string };
}

const META_DEVELOPERS_URL = 'https://developers.facebook.com/apps';
const META_SYSTEM_USERS_URL =
  'https://business.facebook.com/settings/system-users';

/** 32 hex chars; the webhook handshake compares it with the stored one. */
export function generateVerifyToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function CopyField({
  id,
  label,
  value,
}: {
  id: string;
  label: string;
  value: string;
}) {
  const t = useTranslations('Custom.onboarding.whatsapp');
  const [copied, setCopied] = useState(false);
  return (
    <Field id={id} label={label}>
      <div className="flex gap-2">
        <Input
          id={id}
          readOnly
          value={value}
          className={`${inputClass} font-mono text-xs`}
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={t('copy')}
          onClick={async () => {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
        >
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
        </Button>
      </div>
    </Field>
  );
}

export function WhatsAppStep({
  onBack,
  onSkip,
  onDone,
}: {
  onBack: () => void;
  onSkip: () => void;
  onDone: (result: WhatsAppResult) => void;
}) {
  const t = useTranslations('Custom.onboarding.whatsapp');
  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [wabaId, setWabaId] = useState('');
  const [token, setToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [pin, setPin] = useState('');
  const [businessId, setBusinessId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{
    message: string;
    field?: string;
  } | null>(null);
  const [connected, setConnected] = useState<
    | (WhatsAppResult & { verifyToken?: string; registrationNote?: string })
    | null
  >(null);
  const [checking, setChecking] = useState(true);
  const webhookUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/api/whatsapp/webhook`
      : '';

  // Already connected (e.g. came back to the wizard)? Show it instead of the form.
  useEffect(() => {
    let cancelled = false;
    void fetch('/api/whatsapp/config', { cache: 'no-store' })
      .then((r) => r.json())
      .then(
        (body: {
          connected?: boolean;
          phone_info?: SaveResponse['phone_info'];
        }) => {
          if (cancelled || !body.connected) return;
          setConnected({
            connected: true,
            phone: body.phone_info?.display_phone_number,
            name: body.phone_info?.verified_name,
          });
        }
      )
      .catch(() => {})
      .finally(() => !cancelled && setChecking(false));
    return () => {
      cancelled = true;
    };
  }, []);

  async function connect() {
    setError(null);
    if (
      !/^\d+$/.test(phoneNumberId.trim()) ||
      !/^\d+$/.test(wabaId.trim()) ||
      !token.trim()
    ) {
      setError({ message: t('missingFields') });
      return;
    }
    if (pin && !/^\d{6}$/.test(pin)) {
      setError({ message: t('pinInvalid'), field: 'pin' });
      return;
    }
    const verifyToken = generateVerifyToken();
    setBusy(true);
    try {
      const res = await fetch('/api/whatsapp/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone_number_id: phoneNumberId.trim(),
          waba_id: wabaId.trim(),
          access_token: token.trim(),
          verify_token: verifyToken,
          ...(businessId ? { business_id: businessId } : {}),
          ...(pin ? { pin } : {}),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as SaveResponse;
      if (!res.ok || !body.saved) {
        setError({
          message: body.error || t('connectFailed'),
          field: body.meta?.field,
        });
        return;
      }
      setToken('');
      setConnected({
        connected: !body.registration_error,
        phone: body.phone_info?.display_phone_number,
        name: body.phone_info?.verified_name,
        verifyToken,
        registrationNote: body.registration_error
          ? body.registration_error
          : body.registration_skipped
            ? t('registrationSkipped')
            : undefined,
      });
      toast.success(t('connected'));
    } catch {
      setError({ message: t('connectFailed') });
    } finally {
      setBusy(false);
    }
  }

  if (checking) {
    return <Loader2 className="text-muted-foreground size-5 animate-spin" />;
  }

  if (connected) {
    return (
      <div className="space-y-5">
        <div className="flex items-start gap-3 rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-4">
          <CheckCircle2 className="mt-0.5 size-5 text-emerald-400" />
          <div className="text-sm">
            <p className="text-foreground font-medium">
              {t('connectedTitle', { phone: connected.phone ?? '—' })}
            </p>
            {connected.name && (
              <p className="text-muted-foreground">{connected.name}</p>
            )}
          </div>
        </div>
        {connected.registrationNote && (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-300">
            {connected.registrationNote}
          </p>
        )}
        {connected.verifyToken ? (
          <div className="space-y-3">
            <p className="text-foreground text-sm font-medium">
              {t('webhookTitle')}
            </p>
            <ol className="text-muted-foreground list-decimal space-y-1 pl-5 text-sm">
              <li>{t('webhookStep1')}</li>
              <li>{t('webhookStep2')}</li>
              <li>{t('webhookStep3')}</li>
            </ol>
            <CopyField
              id="ob-wa-webhook"
              label={t('webhookUrl')}
              value={webhookUrl}
            />
            <CopyField
              id="ob-wa-verify"
              label={t('verifyToken')}
              value={connected.verifyToken}
            />
            <p className="text-muted-foreground text-xs">
              {t('verifyTokenHint')}
            </p>
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">
            {t('alreadyConnected')}
          </p>
        )}
        <AdvancedLink />
        <StepFooter onBack={onBack} onContinue={() => onDone(connected)} />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="border-border rounded-lg border p-4 text-sm">
        <p className="text-foreground font-medium">{t('beforeTitle')}</p>
        <ul className="text-muted-foreground mt-2 list-disc space-y-1 pl-5">
          <li>{t('before1')}</li>
          <li>{t('before2')}</li>
          <li>{t('before3')}</li>
        </ul>
        <a
          href={META_DEVELOPERS_URL}
          target="_blank"
          rel="noreferrer"
          className="text-primary mt-3 inline-flex items-center gap-1 text-xs font-medium hover:underline"
        >
          {t('openMeta')} <ExternalLink className="size-3" />
        </a>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field
          id="ob-wa-phone-id"
          label={t('phoneNumberId')}
          error={error?.field === 'phone_number_id' ? error.message : undefined}
        >
          <Input
            id="ob-wa-phone-id"
            inputMode="numeric"
            value={phoneNumberId}
            onChange={(e) =>
              setPhoneNumberId(e.target.value.replace(/\D/g, ''))
            }
            placeholder="123456789012345"
            className={inputClass}
          />
          <p className="text-muted-foreground text-xs">
            {t('phoneNumberIdHint')}
          </p>
        </Field>
        <Field
          id="ob-wa-waba-id"
          label={t('wabaId')}
          error={error?.field === 'waba_id' ? error.message : undefined}
        >
          <Input
            id="ob-wa-waba-id"
            inputMode="numeric"
            value={wabaId}
            onChange={(e) => setWabaId(e.target.value.replace(/\D/g, ''))}
            placeholder="102938475610293"
            className={inputClass}
          />
          <p className="text-muted-foreground text-xs">{t('wabaIdHint')}</p>
        </Field>
      </div>

      <Field
        id="ob-wa-token"
        label={t('token')}
        error={error?.field === 'access_token' ? error.message : undefined}
      >
        <div className="flex gap-2">
          <Input
            id="ob-wa-token"
            type={showToken ? 'text' : 'password'}
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="EAAG…"
            className={`${inputClass} font-mono text-xs`}
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={showToken ? t('hideToken') : t('showToken')}
            onClick={() => setShowToken((v) => !v)}
          >
            {showToken ? (
              <EyeOff className="size-4" />
            ) : (
              <Eye className="size-4" />
            )}
          </Button>
        </div>
        <p className="text-muted-foreground text-xs">
          {t('tokenHint')}{' '}
          <a
            href={META_SYSTEM_USERS_URL}
            target="_blank"
            rel="noreferrer"
            className="text-primary hover:underline"
          >
            {t('systemUsers')}
          </a>
        </p>
      </Field>

      <Field
        id="ob-wa-business-id"
        label={t('businessId')}
        error={error?.field === 'business_id' ? error.message : undefined}
      >
        <Input
          id="ob-wa-business-id"
          inputMode="numeric"
          value={businessId}
          onChange={(e) => setBusinessId(e.target.value.replace(/\D/g, ''))}
          className={`${inputClass} max-w-xs`}
        />
        <p className="text-muted-foreground text-xs">{t('businessIdHint')}</p>
      </Field>

      <Field
        id="ob-wa-pin"
        label={t('pin')}
        error={error?.field === 'pin' ? error.message : undefined}
      >
        <Input
          id="ob-wa-pin"
          inputMode="numeric"
          maxLength={6}
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
          placeholder="000000"
          className={`${inputClass} max-w-[10rem]`}
        />
        <p className="text-muted-foreground text-xs">{t('pinHint')}</p>
      </Field>

      {error &&
        ![
          'phone_number_id',
          'waba_id',
          'access_token',
          'pin',
          'business_id',
        ].includes(error.field ?? '') && (
          <p className="rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300">
            {error.message}
          </p>
        )}

      <Button type="button" onClick={connect} disabled={busy}>
        {busy && <Loader2 className="size-4 animate-spin" />}
        {t('connect')}
      </Button>

      <AdvancedLink />
      <StepFooter
        onBack={onBack}
        onContinue={onSkip}
        continueLabel={t('later')}
      />
    </div>
  );
}

function AdvancedLink() {
  const t = useTranslations('Custom.onboarding.whatsapp');
  return (
    <p className="text-muted-foreground text-xs">
      {t('advancedHint')}{' '}
      <Link
        href="/settings?tab=whatsapp"
        className="text-primary font-medium hover:underline"
      >
        {t('advancedLink')}
      </Link>
    </p>
  );
}
