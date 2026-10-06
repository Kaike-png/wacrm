import { getT } from '@/lib/i18n/translate';
import { brand, brandAbsoluteUrl, brandInitial } from './config';

/**
 * Branded Supabase Auth email templates.
 *
 * Supabase (GoTrue) sends the auth emails itself, so the app cannot
 * inject the brand at send time. Instead these builders render the
 * templates from the brand config; the operator installs them once:
 *   - hosted Supabase: paste into Authentication → Email Templates;
 *   - self-hosted GoTrue: point GOTRUE_MAILER_TEMPLATES_* at
 *     /api/brand/email-templates/<template> (GoTrue fetches the URL);
 *   - Supabase CLI: `[auth.email.template.*] content_path`.
 * See docs/BRANDING.md.
 *
 * Links use `{{ .ConfirmationURL }}`, exactly like Supabase's default
 * templates, so the auth flow is unchanged (docs/auth-emails.md).
 */

export const EMAIL_TEMPLATES = [
  'confirmation',
  'recovery',
  'email_change',
] as const;
export type EmailTemplate = (typeof EMAIL_TEMPLATES)[number];

const COPY_KEY: Record<EmailTemplate, string> = {
  confirmation: 'confirmation',
  recovery: 'recovery',
  email_change: 'emailChange',
};

export function isEmailTemplate(value: string): value is EmailTemplate {
  return (EMAIL_TEMPLATES as readonly string[]).includes(value);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function emailSubject(template: EmailTemplate): string {
  const t = getT(`Custom.brand.emails.${COPY_KEY[template]}`);
  return t('subject', { appName: brand.name });
}

export function emailHtml(template: EmailTemplate): string {
  const t = getT('Custom.brand.emails');
  const c = getT(`Custom.brand.emails.${COPY_KEY[template]}`);
  const name = escapeHtml(brand.name);
  const { primary, onPrimary } = brand.colors;
  const link = '{{ .ConfirmationURL }}';

  const logo = brand.logoUrl
    ? `<img src="${escapeHtml(brandAbsoluteUrl(brand.logoUrl))}" alt="${name}" height="40" style="display:block;height:40px;border:0">`
    : `<span style="display:inline-block;width:40px;height:40px;line-height:40px;border-radius:10px;background:${primary};color:${onPrimary};text-align:center;font-weight:700;font-size:20px">${escapeHtml(brandInitial())}</span>`;

  const support = brand.supportEmail
    ? `<p style="margin:8px 0 0">${escapeHtml(
        t('supportLine', { email: brand.supportEmail })
      ).replace(
        escapeHtml(brand.supportEmail),
        `<a href="mailto:${escapeHtml(brand.supportEmail)}" style="color:${primary}">${escapeHtml(brand.supportEmail)}</a>`
      )}</p>`
    : '';

  return `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#18181b">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 16px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:12px;padding:32px">
        <tr><td style="padding-bottom:24px">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            <td style="vertical-align:middle">${logo}</td>
            <td style="vertical-align:middle;padding-left:12px;font-size:16px;font-weight:600">${name}</td>
          </tr></table>
        </td></tr>
        <tr><td>
          <h1 style="margin:0 0 12px;font-size:20px">${escapeHtml(c('heading'))}</h1>
          <p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:#3f3f46">${escapeHtml(c('body', { appName: brand.name }))}</p>
          <a href="${link}" style="display:inline-block;background:${primary};color:${onPrimary};text-decoration:none;font-weight:600;font-size:14px;padding:12px 20px;border-radius:8px">${escapeHtml(c('cta'))}</a>
          <p style="margin:24px 0 4px;font-size:12px;color:#71717a">${escapeHtml(t('fallbackLink'))}</p>
          <p style="margin:0;font-size:12px;word-break:break-all"><a href="${link}" style="color:${primary}">${link}</a></p>
        </td></tr>
        <tr><td style="padding-top:24px;border-top:1px solid #e4e4e7;margin-top:24px;font-size:12px;line-height:1.5;color:#71717a">
          <p style="margin:16px 0 0">${escapeHtml(t('footer', { appName: brand.name }))}</p>
          ${support}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>
`;
}
