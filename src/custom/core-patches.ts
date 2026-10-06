/**
 * Registry of fork changes to upstream ("core") files.
 *
 * Every core file the fork edits must be listed here, and every edit
 * must carry a `FORK-PATCH(<id>)` comment next to it. The architecture
 * test cross-checks the markers, the registry and the import seams, so
 * an unregistered core edit fails CI. Human-readable context, merge
 * notes and upstreaming status live in docs/UPSTREAM_STRATEGY.md.
 *
 * Bulk patches that are planned to be sent upstream as-is (P-001) are
 * tracked by commit instead of by marker — marking 100+ files would
 * itself create merge conflicts. `scripts/fork/core-diff.sh` lists them.
 */
export interface CorePatch {
  id: string;
  summary: string;
  /** Repo-relative core files carrying `FORK-PATCH(<id>)` markers. */
  files: string[];
  /**
   * Fork-layer modules these core files may import (repo-relative
   * prefixes). Anything else imported from a fork layer is a violation.
   */
  seams: string[];
  upstream: 'to-propose' | 'proposed' | 'fork-only';
}

export const CORE_PATCHES: CorePatch[] = [
  {
    id: 'P-001',
    summary:
      'i18n of remaining hardcoded UI/validator/API strings (commit fbabe3f, ~104 files, no markers)',
    files: [],
    seams: [],
    upstream: 'to-propose',
  },
  {
    id: 'P-002',
    summary: 'i18n seam: layer fork-owned catalogues over the core ones',
    files: ['src/i18n/request.ts', 'src/lib/i18n/translate.ts'],
    seams: ['src/custom/i18n/'],
    upstream: 'fork-only',
  },
  {
    id: 'P-003',
    summary:
      'branding: product identity from src/custom/brand/config.ts (metadata, favicon, sidebar mark, public pages, invite URL, Meta error text, build args)',
    files: [
      'src/app/layout.tsx',
      'src/app/icon.tsx',
      'src/components/layout/sidebar.tsx',
      'src/app/(auth)/layout.tsx',
      'src/app/join/layout.tsx',
      'src/app/api/account/invitations/route.ts',
      'src/lib/whatsapp/meta-error-explain.ts',
      'Dockerfile',
      'docker-compose.yml',
      '.env.local.example',
    ],
    seams: ['src/custom/brand/'],
    upstream: 'fork-only',
  },
  {
    id: 'P-004',
    summary:
      'regional settings: pt-BR default + `pt-BR` alias, tenant locale/time zone/currency formatting at every date/number call site, tenant time zone in automation time_of_day, localized flow edge labels, pt-BR money inputs ("1.500,50"), Excel pt-BR CSV import, template language default, deterministic test env',
    files: [
      // i18n loaders + deploy defaults
      'src/i18n/request.ts',
      'src/lib/i18n/translate.ts',
      'vitest.config.ts',
      'Dockerfile',
      'docker-compose.yml',
      '.env.local.example',
      // tenant settings provider + settings card
      'src/app/(dashboard)/dashboard-shell.tsx',
      'src/app/(dashboard)/settings/page.tsx',
      // server-side tenant time zone + regional default currency
      'src/lib/automations/engine.ts',
      'src/lib/whatsapp/template-header-handle.ts',
      // formatting call sites
      'src/lib/currency.ts',
      'src/lib/automations/trigger-meta.ts',
      'src/lib/flows/edges.ts',
      'src/app/(dashboard)/broadcasts/[id]/page.tsx',
      'src/app/(dashboard)/broadcasts/page.tsx',
      'src/app/(dashboard)/contacts/page.tsx',
      'src/app/(dashboard)/dashboard/page.tsx',
      'src/app/(dashboard)/flows/[id]/runs/page.tsx',
      'src/app/(dashboard)/notifications/page.tsx',
      'src/app/join/[token]/page.tsx',
      'src/components/agents/ai-usage.tsx',
      'src/components/broadcasts/step2-select-audience.tsx',
      'src/components/broadcasts/step4-schedule-send.tsx',
      'src/components/contacts/contact-detail-view.tsx',
      'src/components/dashboard/activity-feed.tsx',
      'src/components/dashboard/conversations-chart.tsx',
      'src/components/dashboard/response-time-chart.tsx',
      'src/components/flows/forms/node-config-form.tsx',
      'src/components/inbox/contact-sidebar.tsx',
      'src/components/inbox/conversation-list.tsx',
      'src/components/inbox/media-lightbox.tsx',
      'src/components/inbox/message-bubble.tsx',
      'src/components/inbox/message-composer.tsx',
      'src/components/inbox/message-thread.tsx',
      'src/components/pipelines/deal-card.tsx',
      // locale-aware money inputs ("1.500,50")
      'src/components/pipelines/deal-form.tsx',
      'src/components/automations/automation-builder.tsx',
      // Excel pt-BR CSVs (`;`, Windows-1252, Portuguese headers)
      'src/lib/contacts/parse-contact-csv.ts',
      'src/components/contacts/import-modal.tsx',
      'src/components/settings/api-keys-settings.tsx',
      'src/components/settings/members-tab.tsx',
      'src/components/settings/profile-form.tsx',
      'src/components/settings/template-manager.tsx',
      'src/components/settings/whatsapp-config.tsx',
      // raw enum labels (mode / accent theme)
      'src/components/settings/appearance-panel.tsx',
      'src/components/settings/settings-overview.tsx',
      'src/components/layout/mode-toggle.tsx',
    ],
    seams: ['src/custom/locale/', 'src/custom/i18n/'],
    // The call-site fixes (hardcoded en-US, date-fns English patterns,
    // browser locale) are upstream bugs; the helpers would move to src/lib.
    upstream: 'to-propose',
  },
  {
    id: 'P-005',
    summary:
      'Brazilian contacts: CPF/CNPJ, razão social and address (br_contact_profiles, migration 901) in the contact form/detail; Brazilian phone input "(21) 99999-9999" → E.164 for BR accounts; +55 display mask',
    files: [
      'src/components/contacts/contact-form.tsx',
      'src/components/contacts/contact-detail-view.tsx',
      'src/lib/whatsapp/wa-identity.ts',
      'src/lib/contacts/parse-contact-csv.ts',
      'src/app/(dashboard)/contacts/page.tsx',
      'src/components/inbox/conversation-list.tsx',
    ],
    seams: ['src/modules/br/'],
    upstream: 'fork-only',
  },
  {
    id: 'P-006',
    summary:
      'organization = accounts: "Organização" settings section (name, status, registration data in br_account_profiles, migration 902); tenant isolation hardening lives in migration 903 + supabase/tests',
    files: [
      'src/components/settings/settings-sections.ts',
      'src/app/(dashboard)/settings/page.tsx',
      // tenant isolation: authenticated media must not be publicly cached
      'src/app/api/whatsapp/media/[mediaId]/route.ts',
    ],
    seams: ['src/modules/br/'],
    upstream: 'fork-only',
  },
  {
    id: 'P-007',
    summary:
      'first-run onboarding: /onboarding protected by the middleware, dashboard redirects the owner of a new organization there (onboarding_progress, migration 904)',
    files: ['src/middleware.ts', 'src/app/(dashboard)/dashboard-shell.tsx'],
    seams: ['src/modules/onboarding/'],
    upstream: 'fork-only',
  },
  {
    id: 'P-008',
    summary:
      'WhatsApp for SaaS: secrets server-only (column privileges, migration 905) read/written through src/custom/whatsapp/config-store, explicit admin check on save, Business ID + encrypted PIN, connection log, WABA check + health stamp in the webhook, status card, console redaction (instrumentation)',
    files: [
      'src/instrumentation.ts',
      'src/app/api/whatsapp/config/route.ts',
      'src/app/api/whatsapp/config/verify-registration/route.ts',
      'src/app/api/whatsapp/broadcast/route.ts',
      'src/app/api/whatsapp/media/[mediaId]/route.ts',
      'src/app/api/whatsapp/react/route.ts',
      'src/app/api/whatsapp/templates/[id]/route.ts',
      'src/app/api/whatsapp/templates/submit/route.ts',
      'src/app/api/whatsapp/templates/sync/route.ts',
      'src/app/api/whatsapp/webhook/route.ts',
      'src/lib/whatsapp/broadcast-core.ts',
      'src/lib/whatsapp/broadcast-resume.ts',
      'src/lib/whatsapp/send-message.ts',
      'src/components/settings/whatsapp-config.tsx',
      'src/app/(dashboard)/inbox/page.tsx',
      'src/app/(dashboard)/settings/page.tsx',
      'src/types/index.ts',
    ],
    seams: ['src/custom/whatsapp/'],
    upstream: 'to-propose',
  },
  {
    id: 'P-009',
    summary:
      'Platform admin panel: /platform protected in middleware. (The original full-block suspension of this patch was replaced by the delinquency policy, P-014.)',
    files: ['src/middleware.ts'],
    seams: ['src/custom/tenancy/', 'src/modules/platform/'],
    upstream: 'fork-only',
  },
  {
    id: 'P-010',
    summary:
      'SaaS plans: limits/features read by key from the database (billing_plans, migration 907) through src/billing/entitlements; plan-limit errors → 403 in toErrorResponse; API/AI gated by api_enabled/ai_enabled; early checks before inviting, creating API keys/automations, connecting a number, creating contacts via API; friendly messages in contact form/import; notices in settings/agents',
    files: [
      'src/lib/auth/account.ts',
      'src/lib/auth/api-context.ts',
      'src/lib/ai/config.ts',
      'src/lib/api/v1/contacts.ts',
      'src/app/api/account/invitations/route.ts',
      'src/app/api/account/api-keys/route.ts',
      'src/app/api/automations/route.ts',
      'src/app/api/automations/[id]/duplicate/route.ts',
      'src/app/api/whatsapp/config/route.ts',
      'src/components/contacts/contact-form.tsx',
      'src/components/contacts/import-modal.tsx',
      'src/app/(dashboard)/settings/page.tsx',
      'src/app/(dashboard)/agents/page.tsx',
    ],
    seams: ['src/billing/'],
    upstream: 'fork-only',
  },
  {
    id: 'P-011',
    summary:
      'Usage limits in the UI: a notice with the plan limit and an upgrade suggestion on the contacts and automations pages when the limit is reached (UsageService, migration 908)',
    files: [
      'src/app/(dashboard)/contacts/page.tsx',
      'src/app/(dashboard)/automations/page.tsx',
    ],
    seams: ['src/billing/'],
    upstream: 'fork-only',
  },
  {
    id: 'P-012',
    summary:
      'Payment gateway abstraction: BILLING_* variables documented in the env example (BillingProvider, mock gateway, migration 909). No core code changed — everything lives in src/billing/payments, src/billing/providers, src/integrations/payments and (fork) routes',
    files: ['.env.local.example'],
    seams: [
      'src/billing/payments/',
      'src/billing/providers/',
      'src/integrations/payments/',
    ],
    upstream: 'fork-only',
  },
  {
    id: 'P-013',
    summary:
      'Asaas payment gateway: ASAAS_* variables documented in the env example. Adapter in src/integrations/payments/asaas, webhook idempotency claim in migration 910 — no core code changed',
    files: ['.env.local.example'],
    seams: ['src/integrations/payments/asaas/'],
    upstream: 'fork-only',
  },
  {
    id: 'P-014',
    summary:
      'Delinquency policy: one matrix (src/billing/access-policy.ts + migration 911) decides what past_due / suspended / cancelled block. Core calls only assertTenantCan / tenantCan / assertPhoneCan at the choke points (every outbound WhatsApp message in meta-api, the send core, campaigns, automations/flows/AI on inbound, integration creation) and maps the refusal to a friendly 403; the dashboard shows a banner instead of the old full-screen block (replaces P-009 there)',
    files: [
      'src/app/(dashboard)/layout.tsx',
      'src/app/api/account/api-keys/route.ts',
      'src/app/api/automations/[id]/duplicate/route.ts',
      'src/app/api/automations/route.ts',
      'src/app/api/v1/webhooks/route.ts',
      'src/app/api/whatsapp/broadcast/route.ts',
      'src/app/api/whatsapp/config/route.ts',
      'src/app/api/whatsapp/react/route.ts',
      'src/app/api/whatsapp/webhook/route.ts',
      'src/lib/api/v1/respond.ts',
      'src/lib/auth/account.ts',
      'src/lib/automations/engine.ts',
      'src/lib/automations/meta-send.ts',
      'src/lib/flows/meta-send.ts',
      'src/lib/whatsapp/broadcast-core.ts',
      'src/lib/whatsapp/meta-api.ts',
      'src/lib/whatsapp/send-message.ts',
      '.env.local.example',
    ],
    seams: [
      'src/billing/enforcement',
      'src/billing/access-errors',
      'src/billing/access-notice',
    ],
    upstream: 'fork-only',
  },
];
