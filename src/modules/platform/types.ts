/**
 * Platform admin panel — shared types (fork, docs/PLATFORM_ADMIN.md).
 * Mirrors the platform_* SQL functions (migration 906). No secret field
 * exists in any of these shapes: WhatsApp credentials only appear as the
 * has_* flags.
 */
import type { AccountStatus } from '@/billing/account-status';
import type { Entitlements } from '@/billing/features';

export const PAGE_SIZE = 25;

export const AUDIT_ACTIONS = [
  'organization.viewed',
  'organization.suspended',
  'organization.reactivated',
  'organization.plan_changed',
  'platform_admin.granted',
  'platform_admin.revoked',
  'billing_plan.updated',
  // 911: automatic, actor = the system (delinquency)
  'organization.billing_suspended',
  'organization.billing_reactivated',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface OrganizationRow {
  id: string;
  name: string;
  status: AccountStatus;
  status_changed_at: string | null;
  trial_ends_at: string | null;
  created_at: string;
  legal_name: string | null;
  trade_name: string | null;
  tax_id: string | null;
  owner_email: string | null;
  plan_code: string | null;
  phone_number_id: string | null;
  waba_id: string | null;
  whatsapp_status: string | null;
  users_count: number;
  contacts_count: number;
  messages_30d: number;
  integration_errors: number;
}

export interface WabaSummary {
  phone_number_id: string;
  waba_id: string | null;
  business_id: string | null;
  status: string;
  connected_at: string | null;
  registered_at: string | null;
  subscribed_apps_at: string | null;
  last_checked_at: string | null;
  last_webhook_at: string | null;
  has_access_token: boolean;
  has_verify_token: boolean;
  has_pin: boolean;
}

export interface OrganizationDetail {
  account: {
    id: string;
    name: string;
    status: AccountStatus;
    status_changed_at: string | null;
    trial_ends_at: string | null;
    created_at: string;
    locale: string | null;
    timezone: string | null;
    default_currency: string | null;
    owner_email: string | null;
  };
  profile: {
    person_type: string | null;
    tax_id: string | null;
    legal_name: string | null;
    trade_name: string | null;
    email: string | null;
    phone: string | null;
    city: string | null;
    state: string | null;
  } | null;
  plan: { plan_code: string; assigned_at: string } | null;
  entitlements: Entitlements;
  members: {
    email: string | null;
    full_name: string | null;
    role: string;
    created_at: string;
  }[];
  wabas: WabaSummary[];
  usage: {
    users: number;
    contacts: number;
    conversations: number;
    messages_in_30d: number;
    messages_out_30d: number;
    messages_failed_30d: number;
    last_message_at: string | null;
    broadcasts_30d: number;
    ai_tokens_30d: number;
    automations_active: number;
    api_keys_active: number;
  };
  errors: {
    whatsapp: {
      source: 'check' | 'registration';
      message: string;
      at: string | null;
    }[];
    events: {
      event: string;
      status: string | null;
      message: string | null;
      meta_error_code: number | null;
      at: string;
    }[];
    failed_messages: {
      code: string | null;
      title: string | null;
      count: number;
      last_at: string;
    }[];
    webhooks: {
      host: string | null;
      failure_count: number;
      is_active: boolean;
      last_delivery_at: string | null;
    }[];
    automations: { status: string; message: string | null; at: string }[];
  };
}

export interface AuditEntry {
  id: number;
  created_at: string;
  actor_user_id: string | null;
  actor_email: string;
  action: AuditAction;
  target_account_id: string | null;
  target_account_name: string | null;
  reason: string | null;
  details: Record<string, unknown>;
  ip: string | null;
  user_agent: string | null;
}

export interface PlanCatalog {
  features: {
    key: string;
    kind: 'limit' | 'flag';
    default_value: number | boolean | null;
    description: string | null;
  }[];
  plans: {
    code: string;
    name: string;
    is_active: boolean;
    is_default: boolean;
    /** 909: null = not sold online. */
    price_cents: number | null;
    currency: string;
    billing_interval: 'month' | 'year';
    organizations: number;
    features: Record<string, number | boolean | null>;
  }[];
}
