/**
 * Core facade: server-side (anti-corruption layer).
 *
 * Fork code outside `src/custom` (billing, modules/*, integrations, and
 * fork route files under `src/app/**\/(fork)/`) must reach core server
 * APIs through this file instead of importing `@/lib/**` directly. When
 * an upstream merge renames or moves something in core, the fix lands
 * here once instead of in every consumer. Enforced by
 * `src/custom/architecture.test.ts`.
 *
 * Rules:
 *   - Re-exports only. No behaviour lives here; adapters that change
 *     semantics belong in a named module with tests.
 *   - Add an export when a fork module first needs it, not
 *     speculatively.
 *   - Server-only: importing this from a Client Component pulls
 *     `next/headers` and the service-role client into the bundle.
 */

// Tenancy / auth for route handlers (cookie session → account + role).
export {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
  UnauthorizedError,
  ForbiddenError,
  type AccountContext,
} from '@/lib/auth/account';
export { hasMinRole, isAccountRole, type AccountRole } from '@/lib/auth/roles';

// Public-API auth (Bearer wacrm_live_… → account + scopes).
export { requireApiKey, type ApiKeyContext } from '@/lib/auth/api-context';

// Database clients. `supabaseAdmin` bypasses RLS: every query made with
// it MUST filter by account_id. Core has several identical copies of
// this helper; the fork always uses this one (no new copies).
export { createClient as createServerSupabase } from '@/lib/supabase/server';
export { supabaseAdmin } from './admin';

// Cross-cutting helpers.
export { getT, type Translate } from '@/lib/i18n/translate';
export {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
  type RateLimitOptions,
  type RateLimitResult,
} from '@/lib/rate-limit';
