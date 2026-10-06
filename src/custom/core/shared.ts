/**
 * Core facade: pure helpers (anti-corruption layer).
 *
 * Re-exports of core functions with no I/O, no React and no Supabase,
 * so they are safe in route handlers, the webhook, the browser and
 * tests alike. Fork modules that run on every side (e.g.
 * `src/modules/br/phone.ts`, used by the core display helpers) import
 * core from here instead of `./client.ts` / `./server.ts`, which would
 * drag browser or server-only code along. Re-exports only.
 */

// Phone parsing as typed by a person/integrator (requires `+`, issue #586).
export {
  parseInternationalPhone,
  isValidE164,
} from '@/lib/whatsapp/phone-utils';

// Currency options offered in pickers (code, label, symbol).
export { CURRENCIES, type CurrencyOption } from '@/lib/currency';
