/**
 * Core facade, narrow: only the service-role client.
 *
 * For fork modules that core itself imports through a seam (e.g.
 * src/billing/entitlements.ts from lib/auth/api-context.ts): importing the
 * full ./server facade there would create an import cycle back into core.
 * Same rule as ./server: every query MUST filter by account_id.
 */
export { supabaseAdmin } from '@/lib/flows/admin-client';
