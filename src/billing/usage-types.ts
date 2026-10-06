/** Usage report shape (billing_usage_report, migration 908). Pure — shared by server and UI. */

type Limit = number | null;

export interface UsageReport {
  period: { start: string; end: string; time_zone: string };
  plan: { code: string; name: string } | null;
  users: {
    total: number;
    active_30d: number;
    pending_invitations: number;
    limit: Limit;
  };
  contacts: { total: number; created_period: number; limit: Limit };
  whatsapp_accounts: { total: number; connected: number; limit: Limit };
  automations: { total: number; active: number; limit: Limit };
  messages: {
    sent_period: number;
    received_period: number;
    failed_period: number;
    sent_30d: number;
    received_30d: number;
  };
  campaigns: {
    total: number;
    created_period: number;
    recipients_sent_period: number;
  };
  ai: {
    enabled: boolean;
    requests_period: number;
    tokens_period: number;
    tokens_30d: number;
    auto_replies_period: number;
  };
  api: { enabled: boolean; active_keys: number };
  generated_at: string;
}

/** Same shape, as the browser receives it. */
export type UsageReportView = UsageReport;
