import {
  EMAIL_TEMPLATES,
  emailHtml,
  emailSubject,
  isEmailTemplate,
} from '@/custom/brand/email-templates';

/**
 * GET /api/brand/email-templates/<confirmation|recovery|email_change>
 *   → branded HTML for the Supabase Auth email (copy into the dashboard,
 *     or point self-hosted GoTrue's GOTRUE_MAILER_TEMPLATES_* here).
 * GET …?part=subject → the subject line as plain text.
 *
 * Public on purpose: it contains only brand data, and GoTrue fetches it
 * without credentials. See docs/BRANDING.md.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ template: string }> }
) {
  const { template } = await params;
  if (!isEmailTemplate(template)) {
    return Response.json(
      { error: 'unknown template', available: EMAIL_TEMPLATES },
      { status: 404 }
    );
  }

  const part = new URL(request.url).searchParams.get('part');
  if (part === 'subject') {
    return new Response(emailSubject(template), {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  return new Response(emailHtml(template), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
}
