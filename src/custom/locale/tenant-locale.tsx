'use client';

/**
 * Browser side of the tenant regional settings (see docs/LOCALIZATION.md).
 *
 * Mounted once in the dashboard shell, inside `AuthProvider`. Loads the
 * signed-in account's `locale` / `timezone` (currency already comes from
 * `useAuth().defaultCurrency`), makes them the *active* settings for the
 * formatting helpers in `./format.ts`, and exposes them via
 * `useLocaleSettings()`.
 *
 * Children are keyed by the settings, so a change (e.g. after saving in
 * Configurações) re-renders every timestamp. The defaults match the
 * common case (pt-BR / America/Sao_Paulo / BRL), so for most tenants
 * the first paint is already right and nothing remounts.
 */
import {
  createContext,
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { createBrowserSupabase, useAuth } from '../core/client';
import {
  regionalDefaults,
  resolveTenantSettings,
  type LocaleSettings,
} from './config';
import { setActiveLocaleSettings } from './format';

interface RawTenantLocale {
  locale: string | null;
  timezone: string | null;
}

interface LocaleSettingsContextValue {
  settings: LocaleSettings;
  /** Raw tenant columns (null until loaded / when the migration is missing). */
  tenant: RawTenantLocale | null;
  /** True once the tenant row was read (columns exist and RLS allowed it). */
  available: boolean;
  refresh: () => Promise<void>;
}

const LocaleSettingsContext = createContext<LocaleSettingsContextValue>({
  settings: regionalDefaults,
  tenant: null,
  available: false,
  refresh: async () => {},
});

async function fetchTenantLocale(
  accountId: string
): Promise<RawTenantLocale | null> {
  const { data, error } = await createBrowserSupabase()
    .from('accounts')
    .select('locale, timezone')
    .eq('id', accountId)
    .maybeSingle();
  if (error) {
    // Most likely the fork migration is not applied yet: keep the
    // deploy defaults rather than breaking the dashboard.
    console.warn(
      '[TenantLocaleProvider] using deploy defaults:',
      error.message
    );
    return null;
  }
  return (data as RawTenantLocale | null) ?? null;
}

export function TenantLocaleProvider({ children }: { children: ReactNode }) {
  const { accountId, defaultCurrency } = useAuth();
  // Keyed by account so a stale row never applies to another account.
  const [loaded, setLoaded] = useState<{
    accountId: string;
    row: RawTenantLocale | null;
  } | null>(null);

  const load = useCallback(async () => {
    if (!accountId) return;
    setLoaded({ accountId, row: await fetchTenantLocale(accountId) });
  }, [accountId]);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    void fetchTenantLocale(accountId).then((row) => {
      if (!cancelled) setLoaded({ accountId, row });
    });
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  const current = loaded && loaded.accountId === accountId ? loaded : null;
  const tenant = current?.row ?? null;
  const available = !!tenant;

  const settings = useMemo(
    () =>
      resolveTenantSettings({
        locale: tenant?.locale,
        timezone: tenant?.timezone,
        default_currency: defaultCurrency,
      }),
    [tenant, defaultCurrency]
  );

  // Set synchronously (not in an effect) so the children rendered below
  // already format with these settings. Idempotent and browser-only.
  setActiveLocaleSettings(settings);

  const value = useMemo(
    () => ({ settings, tenant, available, refresh: load }),
    [settings, tenant, available, load]
  );
  const key = `${settings.locale}|${settings.timeZone}|${settings.currency}`;

  return (
    <LocaleSettingsContext.Provider value={value}>
      <Fragment key={key}>{children}</Fragment>
    </LocaleSettingsContext.Provider>
  );
}

export function useLocaleSettings(): LocaleSettingsContextValue {
  return useContext(LocaleSettingsContext);
}
