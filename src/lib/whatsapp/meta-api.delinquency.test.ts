// Fork test (P-014, docs/DELINQUENCY.md): every outbound WhatsApp message
// passes the delinquency policy before reaching Meta.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const guard = vi.hoisted(() => ({ blocked: false }));

vi.mock('@/billing/enforcement', () => ({
  assertPhoneCan: vi.fn(async () => {
    if (guard.blocked)
      throw Object.assign(new Error('tenant_restricted:messages.send'), {
        code: 'tenant_restricted',
      });
  }),
}));

import {
  sendInteractiveButtons,
  sendMediaMessage,
  sendReactionMessage,
  sendTemplateMessage,
  sendTextMessage,
  sendTypingIndicator,
} from './meta-api';

const base = {
  phoneNumberId: '111',
  accessToken: 'EAAtoken',
  to: '5511999990000',
};
const fetchMock = vi.fn(
  async () =>
    new Response(
      JSON.stringify({ messages: [{ id: 'wamid.1' }], success: true }),
      { status: 200 }
    )
);

describe('meta-api send functions honour the delinquency policy', () => {
  beforeEach(() => {
    guard.blocked = false;
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const sends: [string, () => Promise<unknown>][] = [
    ['text', () => sendTextMessage({ ...base, text: 'oi' })],
    [
      'media',
      () =>
        sendMediaMessage({ ...base, kind: 'image', link: 'https://x/y.png' }),
    ],
    [
      'template',
      () =>
        sendTemplateMessage({
          ...base,
          templateName: 'hello',
          languageCode: 'pt_BR',
        } as never),
    ],
    [
      'reaction',
      () =>
        sendReactionMessage({
          ...base,
          targetMessageId: 'wamid.0',
          emoji: '👍',
        } as never),
    ],
    [
      'buttons',
      () =>
        sendInteractiveButtons({
          ...base,
          bodyText: 'x',
          buttons: [{ id: 'a', title: 'A' }],
        } as never),
    ],
  ];

  it.each(sends)(
    '%s: blocked before any request to Meta',
    async (_name, send) => {
      guard.blocked = true;
      await expect(send()).rejects.toMatchObject({ code: 'tenant_restricted' });
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it('allowed organizations send normally', async () => {
    await expect(sendTextMessage({ ...base, text: 'oi' })).resolves.toEqual({
      messageId: 'wamid.1',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('marking as read / typing is not "sending a message" and is not blocked', async () => {
    guard.blocked = true;
    await sendTypingIndicator({
      phoneNumberId: '111',
      accessToken: 'EAAtoken',
      messageId: 'wamid.0',
    } as never).catch(() => {});
    expect(fetchMock).toHaveBeenCalled();
  });
});
