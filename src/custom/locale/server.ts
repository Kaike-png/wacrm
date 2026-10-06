/**
 * Tenant regional settings on the server (route handlers, automation
 * engine, cron). Takes the caller's Supabase client so it works with the
 * service-role client (engine) and the RLS client (routes) alike.
 *
 * Tolerant by design: if the fork migration (900_custom_account_locale)
 * has not been applied, or the lookup fails, it returns the deploy
 * defaults instead of breaking the caller.
 */
import {
  regionalDefaults,
  resolveTenantSettings,
  type LocaleSettings,
} from './config';

interface AccountLocaleRow {
  locale?: string | null;
  timezone?: string | null;
  default_currency?: string | null;
}

/** Minimal shape of the Supabase query builder used here. */
interface AccountsQuery {
  from(table: 'accounts'): {
    select(columns: string): {
      eq(
        column: 'id',
        value: string
      ): {
        maybeSingle(): PromiseLike<{ data: unknown; error: unknown }>;
      };
    };
  };
}

export async function getAccountLocaleSettings(
  db: unknown,
  accountId: string | null | undefined
): Promise<LocaleSettings> {
  if (!accountId) return regionalDefaults;
  try {
    const { data, error } = await (db as AccountsQuery)
      .from('accounts')
      .select('locale, timezone, default_currency')
      .eq('id', accountId)
      .maybeSingle();
    if (error || !data) return regionalDefaults;
    return resolveTenantSettings(data as AccountLocaleRow);
  } catch {
    return regionalDefaults;
  }
}
