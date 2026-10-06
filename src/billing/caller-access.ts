/**
 * The signed-in user's organization access (fork, docs/DELINQUENCY.md).
 * Server only. What the status allows comes from the delinquency policy
 * (src/billing/enforcement.ts) — this file only finds the organization.
 */
import { getTenantAccess, type TenantAccess } from './enforcement';
import { createServerSupabase, supabaseAdmin } from '@/custom/core/server';

export interface CallerTenantAccess extends TenantAccess {
  accountId: string;
  accountName: string;
}

/** Null when there is no session or no organization. */
export async function getCallerTenantAccess(): Promise<CallerTenantAccess | null> {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabaseAdmin()
    .from('profiles')
    .select('account_id, accounts(name)')
    .eq('user_id', user.id)
    .maybeSingle();
  const accountId = (profile as { account_id?: string } | null)?.account_id;
  if (!accountId) return null;
  const rel = (
    profile as { accounts?: { name?: string } | { name?: string }[] | null }
  ).accounts;
  const accountName = (Array.isArray(rel) ? rel[0]?.name : rel?.name) ?? '';
  return { accountId, accountName, ...(await getTenantAccess(accountId)) };
}
