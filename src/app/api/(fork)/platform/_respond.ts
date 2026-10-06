/**
 * Shared error mapping for the platform admin routes (fork,
 * docs/PLATFORM_ADMIN.md). Non-admins always get 404.
 */
import { NextResponse } from 'next/server';

import { PlatformAccessDenied } from '@/modules/platform/server/auth';
import { PlatformActionError } from '@/modules/platform/server/data';

export function platformError(err: unknown): NextResponse {
  if (err instanceof PlatformAccessDenied) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  if (err instanceof PlatformActionError) {
    return NextResponse.json({ error: err.code }, { status: err.httpStatus });
  }
  console.error('[platform] unexpected error:', err);
  return NextResponse.json({ error: 'failed' }, { status: 500 });
}
