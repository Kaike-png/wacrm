/**
 * Platform admin access (fork, docs/PLATFORM_ADMIN.md) — server only.
 *
 * A platform admin is a row in `platform_admins` (migration 906), which no
 * client role can read: membership is checked here with the service role
 * against the session user. Tenant roles (owner/admin) grant nothing here.
 * Non-admins get 404, so the panel's existence is not revealed.
 */
import { headers } from 'next/headers';

import { createServerSupabase, supabaseAdmin } from '@/custom/core/server';

if (typeof window !== 'undefined') {
  throw new Error('modules/platform/server is server-only');
}

export interface PlatformAdmin {
  userId: string;
  email: string;
}

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

export class PlatformAccessDenied extends Error {
  constructor() {
    super('not found');
    this.name = 'PlatformAccessDenied';
  }
}

/** The signed-in platform admin, or null (no session / not an admin / lookup failed). */
export async function getPlatformAdmin(): Promise<PlatformAdmin | null> {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data, error } = await supabaseAdmin().rpc('platform_is_admin', {
    p_user: user.id,
  });
  if (error) {
    console.error('[platform] admin lookup failed:', error.message);
    return null;
  }
  return data === true ? { userId: user.id, email: user.email ?? '' } : null;
}

export async function requirePlatformAdmin(): Promise<PlatformAdmin> {
  const admin = await getPlatformAdmin();
  if (!admin) throw new PlatformAccessDenied();
  return admin;
}

/**
 * For state-changing route handlers: admin + same-origin request.
 * (Session cookies are SameSite=Lax already; this is defence in depth.)
 */
export async function requirePlatformAdminMutation(
  request: Request
): Promise<PlatformAdmin> {
  const origin = request.headers.get('origin');
  // No Origin: still refuse what the browser itself flags as cross-site.
  const fetchSite = request.headers.get('sec-fetch-site');
  if (
    !origin &&
    fetchSite &&
    fetchSite !== 'same-origin' &&
    fetchSite !== 'none'
  )
    throw new PlatformAccessDenied();
  if (origin) {
    const host =
      request.headers.get('x-forwarded-host') ?? request.headers.get('host');
    let originHost: string | null = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = null;
    }
    if (!host || originHost !== host) throw new PlatformAccessDenied();
  }
  return requirePlatformAdmin();
}

/** IP and user agent for the audit log (truncated in SQL). */
export async function requestMeta(): Promise<RequestMeta> {
  const h = await headers();
  const forwarded = h.get('x-forwarded-for')?.split(',')[0]?.trim();
  return {
    ip: forwarded || h.get('x-real-ip') || null,
    userAgent: h.get('user-agent'),
  };
}
