/**
 * Platform panel authorization (fork, docs/MVP_FOUNDATION_AUDIT.md §4/§20).
 * A tenant owner/admin is NOT a platform admin; lookups that fail deny;
 * mutations require a same-origin request.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  user: null as { id: string; email: string } | null,
  isAdmin: false as boolean | null,
  rpcError: null as { message: string } | null,
}));

vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('@/custom/core/server', () => ({
  createServerSupabase: async () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
  }),
  supabaseAdmin: () => ({
    rpc: async () => ({ data: state.isAdmin, error: state.rpcError }),
  }),
}));

import {
  getPlatformAdmin,
  PlatformAccessDenied,
  requirePlatformAdmin,
  requirePlatformAdminMutation,
} from './auth';

const post = (h: Record<string, string>) =>
  new Request('https://app.example.com/api/platform/x', {
    method: 'POST',
    headers: h,
  });

describe('platform admin authorization', () => {
  beforeEach(() => {
    state.user = { id: 'u1', email: 'owner@tenant.test' };
    state.isAdmin = false;
    state.rpcError = null;
  });

  it('no session → denied (404)', async () => {
    state.user = null;
    await expect(requirePlatformAdmin()).rejects.toBeInstanceOf(
      PlatformAccessDenied
    );
  });

  it('a regular user / tenant owner is not a platform admin', async () => {
    expect(await getPlatformAdmin()).toBeNull();
    await expect(requirePlatformAdmin()).rejects.toBeInstanceOf(
      PlatformAccessDenied
    );
  });

  it('a failed admin lookup denies (fails closed)', async () => {
    state.isAdmin = null;
    state.rpcError = { message: 'boom' };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(requirePlatformAdmin()).rejects.toBeInstanceOf(
      PlatformAccessDenied
    );
  });

  it('platform admin passes', async () => {
    state.isAdmin = true;
    await expect(requirePlatformAdmin()).resolves.toMatchObject({
      userId: 'u1',
    });
  });

  it('mutations: cross-origin refused even for an admin', async () => {
    state.isAdmin = true;
    await expect(
      requirePlatformAdminMutation(
        post({ origin: 'https://evil.test', host: 'app.example.com' })
      )
    ).rejects.toBeInstanceOf(PlatformAccessDenied);
    await expect(
      requirePlatformAdminMutation(post({ 'sec-fetch-site': 'cross-site' }))
    ).rejects.toBeInstanceOf(PlatformAccessDenied);
    await expect(
      requirePlatformAdminMutation(
        post({ origin: 'https://app.example.com', host: 'app.example.com' })
      )
    ).resolves.toMatchObject({ userId: 'u1' });
  });

  it('mutations: a regular user is refused even same-origin', async () => {
    await expect(
      requirePlatformAdminMutation(
        post({ origin: 'https://app.example.com', host: 'app.example.com' })
      )
    ).rejects.toBeInstanceOf(PlatformAccessDenied);
  });
});
