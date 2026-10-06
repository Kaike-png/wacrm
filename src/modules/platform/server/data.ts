/**
 * Platform admin data access (fork, docs/PLATFORM_ADMIN.md) — server only.
 *
 * Thin wrappers over the platform_* SQL functions (migration 906), which
 * only the service role may execute. Every action function takes the
 * already-verified admin; the SQL re-checks it and writes the audit entry
 * in the same transaction as the change.
 */
import { supabaseAdmin } from '@/custom/core/server';
import { forgetTenantStatus } from '@/custom/tenancy/access';
import { isAccountStatus, type AccountStatus } from '@/billing/account-status';
import { forgetEntitlements } from '@/billing/entitlements';
import type { UsageReport } from '@/billing/usage-types';

import {
  PAGE_SIZE,
  type AuditEntry,
  type OrganizationDetail,
  type OrganizationRow,
  type PlanCatalog,
} from '../types';
import type { PlatformAdmin, RequestMeta } from './auth';

if (typeof window !== 'undefined') {
  throw new Error('modules/platform/server is server-only');
}

export class PlatformActionError extends Error {
  constructor(
    readonly code:
      | 'not_found'
      | 'invalid_transition'
      | 'reason_required'
      | 'invalid_input'
      | 'failed',
    message: string
  ) {
    super(message);
    this.name = 'PlatformActionError';
  }
  get httpStatus(): number {
    return {
      not_found: 404,
      invalid_transition: 409,
      reason_required: 400,
      invalid_input: 400,
      failed: 500,
    }[this.code];
  }
}

function toActionError(error: {
  code?: string;
  message: string;
}): PlatformActionError {
  switch (error.code) {
    case 'P0002':
      return new PlatformActionError('not_found', error.message);
    case '23514':
      return new PlatformActionError('invalid_transition', error.message);
    case '23502':
      return new PlatformActionError('reason_required', error.message);
    case '22023':
      return new PlatformActionError('invalid_input', error.message);
    case '42501':
      return new PlatformActionError('not_found', error.message);
    default:
      return new PlatformActionError('failed', error.message);
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export interface ListOrganizationsInput {
  search?: string | null;
  status?: string | null;
  page?: number;
}

export async function listOrganizations(
  input: ListOrganizationsInput
): Promise<{ rows: OrganizationRow[]; total: number; page: number }> {
  const page = Math.max(1, Math.floor(input.page ?? 1) || 1);
  const status = isAccountStatus(input.status) ? input.status : null;
  const search = input.search?.trim().slice(0, 120) || null;
  const { data, error } = await supabaseAdmin().rpc(
    'platform_list_organizations',
    {
      p_search: search,
      p_status: status,
      p_limit: PAGE_SIZE,
      p_offset: (page - 1) * PAGE_SIZE,
    }
  );
  if (error) throw toActionError(error);
  const rows = (
    (data ?? []) as (OrganizationRow & { total_count?: number })[]
  ).map((raw) => {
    const row = { ...raw };
    delete row.total_count;
    return {
      ...row,
      users_count: Number(row.users_count),
      contacts_count: Number(row.contacts_count),
      messages_30d: Number(row.messages_30d),
      integration_errors: Number(row.integration_errors),
    };
  });
  const total = Number(
    (data?.[0] as { total_count?: number } | undefined)?.total_count ?? 0
  );
  return { rows, total, page };
}

export async function getOrganization(
  accountId: string
): Promise<OrganizationDetail | null> {
  if (!isUuid(accountId)) return null;
  const { data, error } = await supabaseAdmin().rpc(
    'platform_get_organization',
    {
      p_account: accountId,
    }
  );
  if (error) throw toActionError(error);
  return (data as OrganizationDetail | null) ?? null;
}

/** "Viewed organization X" (deduplicated in SQL: once per 10 min per admin). */
export async function recordOrganizationView(
  admin: PlatformAdmin,
  accountId: string,
  meta: RequestMeta
): Promise<void> {
  const { error } = await supabaseAdmin().rpc('platform_record_view', {
    p_actor: admin.userId,
    p_account: accountId,
    p_ip: meta.ip,
    p_user_agent: meta.userAgent,
  });
  if (error) console.error('[platform] could not audit view:', error.message);
}

export async function listAudit(input: {
  accountId?: string | null;
  page?: number;
  pageSize?: number;
}): Promise<AuditEntry[]> {
  const pageSize = input.pageSize ?? 50;
  const page = Math.max(1, Math.floor(input.page ?? 1) || 1);
  const { data, error } = await supabaseAdmin().rpc('platform_list_audit', {
    p_account: isUuid(input.accountId) ? input.accountId : null,
    p_limit: pageSize,
    p_offset: (page - 1) * pageSize,
  });
  if (error) throw toActionError(error);
  return (data ?? []) as AuditEntry[];
}

export type StatusAction = 'suspend' | 'reactivate';

export async function setOrganizationStatus(
  admin: PlatformAdmin,
  accountId: string,
  action: StatusAction,
  reason: string | null,
  meta: RequestMeta
): Promise<{ previous: AccountStatus; current: AccountStatus }> {
  if (!isUuid(accountId))
    throw new PlatformActionError('not_found', 'organization not found');
  const { data, error } = await supabaseAdmin().rpc(
    'platform_set_account_status',
    {
      p_account: accountId,
      p_action: action,
      p_actor: admin.userId,
      p_reason: reason?.trim().slice(0, 500) || null,
      p_ip: meta.ip,
      p_user_agent: meta.userAgent,
    }
  );
  if (error) throw toActionError(error);
  forgetTenantStatus(accountId);
  const row = (
    data as { previous_status: AccountStatus; new_status: AccountStatus }[]
  )[0];
  return { previous: row.previous_status, current: row.new_status };
}

export async function setOrganizationPlan(
  admin: PlatformAdmin,
  accountId: string,
  planCode: string | null,
  reason: string | null,
  meta: RequestMeta
): Promise<string | null> {
  if (!isUuid(accountId))
    throw new PlatformActionError('not_found', 'organization not found');
  const { data, error } = await supabaseAdmin().rpc('platform_set_plan', {
    p_account: accountId,
    p_plan: planCode,
    p_actor: admin.userId,
    p_reason: reason?.trim().slice(0, 500) || null,
    p_ip: meta.ip,
    p_user_agent: meta.userAgent,
  });
  if (error) throw toActionError(error);
  forgetEntitlements(accountId);
  return (data as string | null) ?? null;
}

/** Every plan with its feature values (billing_plans, migration 907). */
export async function getPlanCatalog(): Promise<PlanCatalog> {
  const { data, error } = await supabaseAdmin().rpc('platform_list_plans');
  if (error) throw toActionError(error);
  return data as PlanCatalog;
}

/** code → display name; unknown codes show as-is, no plan → null. */
export function planNamer(
  catalog: PlanCatalog
): (code: string | null | undefined) => string | null {
  const names = new Map(catalog.plans.map((p) => [p.code, p.name]));
  return (code) => (code ? (names.get(code) ?? code) : null);
}

export async function updatePlan(
  admin: PlatformAdmin,
  planCode: string,
  input: {
    name?: string | null;
    isActive?: boolean | null;
    isDefault?: boolean | null;
    features: Record<string, number | boolean | null>;
    /** undefined = unchanged; null = not sold online (909). */
    priceCents?: number | null;
  },
  reason: string | null,
  meta: RequestMeta
): Promise<void> {
  const { error } = await supabaseAdmin().rpc('platform_update_plan', {
    p_plan: planCode,
    p_name: input.name ?? null,
    p_is_active: input.isActive ?? null,
    p_is_default: input.isDefault ?? null,
    p_features: input.features,
    p_actor: admin.userId,
    p_reason: reason?.trim().slice(0, 500) || null,
    p_ip: meta.ip,
    p_user_agent: meta.userAgent,
  });
  if (error) throw toActionError(error);
  if (input.priceCents !== undefined) {
    const { error: priceErr } = await supabaseAdmin().rpc(
      'platform_update_plan_price',
      {
        p_plan: planCode,
        p_price_cents: input.priceCents,
        p_actor: admin.userId,
        p_reason: reason?.trim().slice(0, 500) || null,
        p_ip: meta.ip,
        p_user_agent: meta.userAgent,
      }
    );
    if (priceErr) throw toActionError(priceErr);
  }
  forgetEntitlements();
}

/** Monthly usage report of one organization (billing_usage_report, 908). */
export async function getUsageReport(
  accountId: string
): Promise<UsageReport | null> {
  if (!isUuid(accountId)) return null;
  const { data, error } = await supabaseAdmin().rpc('platform_usage_report', {
    p_account: accountId,
  });
  if (error) throw toActionError(error);
  return (data as UsageReport | null) ?? null;
}
