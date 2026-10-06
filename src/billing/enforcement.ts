/**
 * Access enforcement (fork, docs/DELINQUENCY.md) — server only.
 *
 * The one API the rest of the app uses to respect the delinquency policy:
 *
 *   await assertTenantCan(accountId, 'campaigns.send')   // throws TenantRestrictedError
 *   if (!(await tenantCan(accountId, 'automations.run'))) return
 *   await assertPhoneCan(phoneNumberId, 'messages.send') // lowest send layer
 *
 * The policy itself lives in ./access-policy.ts (and the same matrix in
 * the database, migration 911). Nobody outside these two files compares
 * an organization status to decide what is allowed.
 *
 * Fails open when the status cannot be read (transient DB error, test
 * doubles): the database guards still refuse blocked writes.
 */
import {
  getAccountIdForPhone,
  getTenantState,
  type TenantState,
} from '@/custom/tenancy/access';

import { TenantRestrictedError } from './access-errors';
import {
  canPerform,
  policyFor,
  type AccessNotice,
  type RestrictedAction,
  type SuspensionSource,
} from './access-policy';
import { toAccountStatus, type AccountStatus } from './account-status';

if (typeof window !== 'undefined') {
  throw new Error('src/billing/enforcement.ts is server-only');
}

export interface TenantAccess {
  status: AccountStatus;
  notice: AccessNotice | null;
  blocked: RestrictedAction[];
  suspendedBy: SuspensionSource | null;
  pastDueSince: string | null;
  suspendedAt: string | null;
}

function toAccess(state: TenantState | null): TenantAccess {
  const status = toAccountStatus(state?.status);
  const policy = policyFor(status);
  return {
    status,
    notice: policy.notice,
    blocked: [...policy.blocks],
    suspendedBy: state?.suspendedBy ?? null,
    pastDueSince: state?.pastDueSince ?? null,
    suspendedAt: state?.suspendedAt ?? null,
  };
}

export async function getTenantAccess(
  accountId: string
): Promise<TenantAccess> {
  return toAccess(await getTenantState(accountId));
}

export async function tenantCan(
  accountId: string,
  action: RestrictedAction
): Promise<boolean> {
  const state = await getTenantState(accountId);
  return state ? canPerform(toAccountStatus(state.status), action) : true;
}

export async function assertTenantCan(
  accountId: string,
  action: RestrictedAction
): Promise<void> {
  const state = await getTenantState(accountId);
  if (!state) return;
  const status = toAccountStatus(state.status);
  if (!canPerform(status, action))
    throw new TenantRestrictedError(action, status);
}

/** For the lowest send layer, which only knows the WhatsApp number. */
export async function assertPhoneCan(
  phoneNumberId: string,
  action: RestrictedAction
): Promise<void> {
  const accountId = await getAccountIdForPhone(phoneNumberId);
  if (accountId) await assertTenantCan(accountId, action);
}

export async function tenantReceivesInbound(
  accountId: string
): Promise<boolean> {
  const state = await getTenantState(accountId);
  return state
    ? policyFor(toAccountStatus(state.status)).receivesInbound
    : true;
}

export {
  isTenantRestricted,
  restrictionBody,
  restrictionMessage,
  TENANT_RESTRICTED_SQLSTATE,
  TenantRestrictedError,
  tenantRestrictionOf,
} from './access-errors';
