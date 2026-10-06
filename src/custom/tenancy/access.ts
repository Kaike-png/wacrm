/**
 * Organization status lookup (fork, docs/DELINQUENCY.md) — server only.
 *
 * Raw state only: status, who suspended, since when. What a status
 * allows is decided in src/billing/access-policy.ts and enforced through
 * src/billing/enforcement.ts — never here.
 */
import { supabaseAdmin } from '@/custom/core/admin';

if (typeof window !== 'undefined') {
  throw new Error('src/custom/tenancy/access.ts is server-only');
}

export interface TenantState {
  status: string;
  suspendedBy: 'billing' | 'platform' | null;
  pastDueSince: string | null;
  suspendedAt: string | null;
}

// Short cache: a webhook burst or a broadcast does not hit the database
// per message. A status change takes effect within TTL_MS here (the
// database guards act immediately).
const TTL_MS = 10_000;
const states = new Map<string, { state: TenantState | null; at: number }>();
const phones = new Map<string, { accountId: string | null; at: number }>();

function fresh<T extends { at: number }>(hit: T | undefined): hit is T {
  return !!hit && Date.now() - hit.at < TTL_MS;
}

/**
 * Null when unknown (migration missing, DB error, test double): callers
 * fail open — the database guards still refuse blocked writes.
 */
export async function getTenantState(
  accountId: string
): Promise<TenantState | null> {
  const hit = states.get(accountId);
  if (fresh(hit)) return hit.state;
  let state: TenantState | null = null;
  try {
    // Plain select (not an RPC) so upstream tests with a mocked client keep
    // their call counts; billing_delinquency is 1:1 with accounts (911).
    const { data, error } = await supabaseAdmin()
      .from('accounts')
      .select(
        'status, billing_delinquency(past_due_since, suspended_by, suspended_at)'
      )
      .eq('id', accountId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const row = data as Record<string, unknown> | null;
    if (row && typeof row.status === 'string') {
      const rel = row.billing_delinquency as
        Record<string, unknown> | Record<string, unknown>[] | null | undefined;
      const d = (Array.isArray(rel) ? rel[0] : rel) ?? {};
      state = {
        status: row.status,
        suspendedBy:
          d.suspended_by === 'billing' || d.suspended_by === 'platform'
            ? d.suspended_by
            : null,
        pastDueSince:
          typeof d.past_due_since === 'string' ? d.past_due_since : null,
        suspendedAt: typeof d.suspended_at === 'string' ? d.suspended_at : null,
      };
    }
  } catch (err) {
    console.error(
      '[tenancy] organization status lookup failed:',
      err instanceof Error ? err.message : err
    );
    return null;
  }
  states.set(accountId, { state, at: Date.now() });
  if (states.size > 5000) states.clear();
  return state;
}

/** Organization that owns a WhatsApp number (phone_number_id is globally unique). */
export async function getAccountIdForPhone(
  phoneNumberId: string
): Promise<string | null> {
  const hit = phones.get(phoneNumberId);
  if (fresh(hit)) return hit.accountId;
  let accountId: string | null = null;
  try {
    const { data, error } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('account_id')
      .eq('phone_number_id', phoneNumberId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    accountId = (data as { account_id?: string } | null)?.account_id ?? null;
  } catch (err) {
    console.error(
      '[tenancy] phone lookup failed:',
      err instanceof Error ? err.message : err
    );
    return null;
  }
  phones.set(phoneNumberId, { accountId, at: Date.now() });
  if (phones.size > 5000) phones.clear();
  return accountId;
}

/** After a status change (platform panel, billing) and in tests. */
export function forgetTenantStatus(accountId?: string): void {
  if (accountId) states.delete(accountId);
  else {
    states.clear();
    phones.clear();
  }
}
