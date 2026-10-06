/**
 * Secret redaction for logs, stored messages and API errors (fork,
 * docs/WHATSAPP_SAAS.md). Pure; safe on server and client.
 *
 * Covers what this app handles: Meta access tokens (EAA…), Bearer
 * headers, `access_token=` / `hub.verify_token=` style parameters, JSON
 * fields named like secrets, our own AES-GCM ciphertexts (iv:ct:tag),
 * JWTs, provider API keys (sk-…) and the public-API keys (wacrm_live_…).
 */

const REDACTED = '[redacted]';

const SECRET_KEY =
  /^(access_?token|verify_?token|hub\.verify_token|token|pin|password|secret|app_?secret|client_?secret|api_?key|authorization|encryption_?key|service_?role_?key|key_hash)$/i;

const PATTERNS: [RegExp, string | ((...m: string[]) => string)][] = [
  // Meta user / system-user / page tokens.
  [/\bEAA[A-Za-z0-9]{16,}/g, `EAA…${REDACTED}`],
  // Authorization: Bearer <anything>
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${REDACTED}`],
  // key=value in URLs, forms, querystrings
  [
    /\b((?:access_token|verify_token|hub\.verify_token|appsecret_proof|client_secret|app_secret|pin|token|api_key)=)[^&\s"'<>]+/gi,
    `$1${REDACTED}`,
  ],
  // "key": "value" in JSON-ish text
  [
    /("(?:access_?token|verify_?token|pin|token|password|secret|api_?key|authorization)"\s*:\s*")[^"]*(")/gi,
    `$1${REDACTED}$2`,
  ],
  // Our ciphertext format: 12-byte IV hex : ciphertext hex : 16-byte tag hex
  [/\b[0-9a-f]{24}:[0-9a-f]{8,}:[0-9a-f]{32}\b/gi, REDACTED],
  // Legacy CBC format: 16-byte IV hex : ciphertext hex
  [/\b[0-9a-f]{32}:[0-9a-f]{32,}\b/gi, REDACTED],
  // JWTs (Supabase service role / user sessions)
  [
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    `eyJ…${REDACTED}`,
  ],
  // Provider API keys and our public-API keys
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g, `sk-…${REDACTED}`],
  [/\bwacrm_live_[A-Za-z0-9_-]{8,}/g, `wacrm_live_…${REDACTED}`],
  // Asaas API keys ($aact_prod_… / $aact_hmlg_… / $aact_…) and the webhook auth header.
  [/\$aact_[A-Za-z0-9_\-:=.+/]{8,}/g, `$$aact_…${REDACTED}`],
  [/("?asaas-access-token"?\s*[:=]\s*"?)[^"\s,}]+/gi, `$1${REDACTED}`],
];

/** Redact secrets inside free text. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of PATTERNS) {
    out = out.replace(pattern, replacement as string);
  }
  return out;
}

/**
 * Redact any value about to be logged or serialized: strings, Errors
 * (message + stack + cause), plain objects/arrays (secret-named keys are
 * dropped entirely). Non-plain objects (Response, Buffer…) pass through.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactSecrets(value);
  if (value === null || typeof value !== 'object' || depth > 5) return value;
  if (value instanceof Error) {
    const copy = new Error(redactSecrets(value.message));
    copy.name = value.name;
    if (value.stack) copy.stack = redactSecrets(value.stack);
    for (const [k, v] of Object.entries(value)) {
      (copy as unknown as Record<string, unknown>)[k] = SECRET_KEY.test(k)
        ? REDACTED
        : redactValue(v, depth + 1);
    }
    return copy;
  }
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEY.test(k) ? REDACTED : redactValue(v, depth + 1);
  }
  return out;
}

/** `EAAGm0PX4ZCpsBA…` → `••••Bx9Q`. Never more than the last 4 chars. */
export function tokenHint(plain: string | null | undefined): string | null {
  if (!plain) return null;
  const trimmed = plain.trim();
  if (trimmed.length < 12) return '••••';
  return `••••${trimmed.slice(-4)}`;
}

/** Short, redacted text suitable for a log row or an API error. */
export function safeMessage(value: unknown, max = 500): string | null {
  if (value === null || value === undefined) return null;
  const text =
    value instanceof Error
      ? value.message
      : typeof value === 'string'
        ? value
        : JSON.stringify(redactValue(value));
  const redacted = redactSecrets(text ?? '');
  return redacted.length > max ? `${redacted.slice(0, max - 1)}…` : redacted;
}

let installed = false;

/**
 * Wrap console.{log,info,warn,error,debug} so every argument is redacted
 * before it reaches stdout (server logs, log drains). Idempotent. Called
 * from src/instrumentation.ts (FORK-PATCH(P-008)).
 */
export function installConsoleRedaction(target: Console = console): void {
  if (installed && target === console) return;
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const original = target[method].bind(target);
    target[method] = (...args: unknown[]) =>
      original(...args.map((a) => redactValue(a)));
  }
  if (target === console) installed = true;
}
