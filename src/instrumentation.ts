// FORK-PATCH(P-008): new file (Next.js instrumentation hook). Redacts
// tokens, verify tokens, PINs and keys from every server console call
// before they reach the logs — docs/WHATSAPP_SAAS.md. If upstream adds its
// own instrumentation.ts, keep both bodies in register().
export async function register() {
  const { installConsoleRedaction } = await import('@/custom/whatsapp/redact');
  installConsoleRedaction();
}
