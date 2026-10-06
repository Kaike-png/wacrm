/**
 * Minimal Asaas REST client (fork, docs/ASAAS.md). No SDK: fetch +
 * timeouts + error normalization. The API key travels only in the
 * `access_token` header; it is never part of an error, log line or URL.
 */
import { BillingProviderError } from '@/billing/payments/types';

import type { AsaasConfig } from './config';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 15_000;

interface AsaasErrorBody {
  errors?: { code?: string; description?: string }[];
}

export class AsaasApiError extends BillingProviderError {
  constructor(
    readonly status: number,
    readonly codes: string[],
    message: string,
    retryable: boolean
  ) {
    super('asaas', message, retryable);
    this.name = 'AsaasApiError';
  }
}

export class AsaasClient {
  constructor(
    private readonly config: AsaasConfig,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init)
  ) {}

  async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown
  ): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.config.baseUrl}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': this.config.userAgent,
          access_token: this.config.apiKey,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: 'no-store',
      });
    } catch (err) {
      const reason =
        err instanceof Error && err.name === 'TimeoutError'
          ? 'timeout'
          : 'network error';
      throw new AsaasApiError(0, [], `${method} ${path}: ${reason}`, true);
    }

    const text = await res.text();
    if (!res.ok) {
      let parsed: AsaasErrorBody = {};
      try {
        parsed = JSON.parse(text) as AsaasErrorBody;
      } catch {
        /* non-JSON error page */
      }
      const codes = (parsed.errors ?? [])
        .map((e) => e.code ?? '')
        .filter(Boolean);
      const description =
        (parsed.errors ?? [])
          .map((e) => e.description)
          .filter(Boolean)
          .join('; ')
          .slice(0, 300) || `HTTP ${res.status}`;
      // 429: rate/quota limit — do not retry immediately (Asaas docs); the
      // caller surfaces "try again shortly" and the gateway webhook retries.
      const retryable = res.status === 429 || res.status >= 500;
      throw new AsaasApiError(
        res.status,
        codes,
        `${method} ${path} → ${res.status}: ${description}`,
        retryable
      );
    }
    if (!text) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new AsaasApiError(
        res.status,
        [],
        `${method} ${path}: invalid JSON response`,
        true
      );
    }
  }
}
