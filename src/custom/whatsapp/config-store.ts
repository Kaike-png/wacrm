/**
 * Server-only access to `whatsapp_config` secrets (fork, docs/WHATSAPP_SAAS.md).
 *
 * Since migration 905 the browser roles cannot read or write
 * access_token / verify_token / pin (column privileges). Route handlers
 * that need them resolve the caller's account first (cookie session +
 * RLS, as before) and then read the row here with the service role,
 * always filtered by that account_id.
 *
 * NEVER import this from a client component: it uses the service role.
 */
import { SupabaseClient } from '@supabase/supabase-js';

import { supabaseAdmin } from '@/lib/flows/admin-client';

export {
  WHATSAPP_CONFIG_PUBLIC_COLUMNS,
  WHATSAPP_SECRET_COLUMNS,
} from './columns';

if (typeof window !== 'undefined') {
  throw new Error('config-store is server-only');
}

/**
 * Full row (secrets still encrypted) of the account's WhatsApp config,
 * `{ data: null, error: null }` when there is none. Same result shape as
 * a supabase-js `.maybeSingle()`, so call sites keep their checks.
 *
 * Call sites pass the client they already had (`db`/`supabase`). A real
 * SupabaseClient is NOT used — browser-role clients cannot read secrets
 * anymore — the service role is. Anything else is a test double injected
 * by a unit test, and is queried as before so upstream tests keep their
 * fixtures.
 */
export async function getWhatsAppConfigRow(
  accountId: string | null | undefined,
  callerClient?: unknown
) {
  if (!accountId) return { data: null, error: null };
  if (callerClient && !(callerClient instanceof SupabaseClient)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const q = (callerClient as any)
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId);
    return typeof q.single === 'function' ? q.single() : q.maybeSingle();
  }
  return supabaseAdmin()
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .maybeSingle();
}

/**
 * Query builder on `whatsapp_config` with the service role, for writes
 * that touch secrets. Callers MUST filter by the caller's account_id.
 */
export function whatsappConfigAdmin() {
  return supabaseAdmin().from('whatsapp_config');
}
