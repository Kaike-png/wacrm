/**
 * Core facade: client-side (anti-corruption layer).
 *
 * Browser-safe counterpart of `./server.ts`. Same rules: re-exports
 * only, add exports when a fork module needs them, and fork code
 * outside `src/custom` imports core client APIs from here.
 */

// RLS-bound browser client (anon key + the user's session).
export { createClient as createBrowserSupabase } from '@/lib/supabase/client';

// Session / profile / account context and role gating for UI.
export { useAuth } from '@/hooks/use-auth';
export { useCan, type CanAction } from '@/hooks/use-can';
