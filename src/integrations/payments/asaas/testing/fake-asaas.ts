/**
 * In-memory fake of the Asaas API v3 (fork, docs/ASAAS.md) — tests and
 * local QA only (scripts/fork/fake-asaas.mjs serves it over HTTP).
 *
 * Implements just the endpoints the adapter uses, with the documented
 * shapes: customers, payments (+ pixQrCode, identificationField),
 * subscriptions (+ payments, DELETE). Enforces the `access_token` header
 * and records every request so tests can assert what was (not) sent.
 * `settle()` changes a payment like Asaas would and returns the webhook
 * body + headers Asaas would POST.
 */

import type {
  AsaasPayment,
  AsaasSubscription,
  AsaasWebhookBody,
} from '../mapping';

export interface FakeAsaasRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

let seq = 0;
const nextId = (prefix: string) =>
  `${prefix}_${(++seq).toString().padStart(12, '0')}`;

export function createFakeAsaas(opts: {
  apiKey: string;
  webhookToken: string;
  accountId?: string;
}) {
  const customers = new Map<string, Record<string, unknown> & { id: string }>();
  const payments = new Map<string, AsaasPayment>();
  const subscriptions = new Map<string, AsaasSubscription>();
  const requests: FakeAsaasRequest[] = [];

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const notFound = () =>
    json(404, {
      errors: [{ code: 'not_found', description: 'Recurso não encontrado' }],
    });
  const invalid = (description: string) =>
    json(400, { errors: [{ code: 'invalid_action', description }] });

  function newPayment(
    fields: Partial<AsaasPayment> & {
      customer: string;
      value: number;
      billingType: string;
    }
  ) {
    const id = nextId('pay');
    const p: AsaasPayment = {
      object: 'payment',
      id,
      status: 'PENDING',
      dueDate: new Date().toISOString().slice(0, 10),
      invoiceUrl: `https://sandbox.asaas.com/i/${id}`,
      bankSlipUrl:
        fields.billingType === 'BOLETO'
          ? `https://sandbox.asaas.com/b/pdf/${id}`
          : null,
      deleted: false,
      ...fields,
    };
    payments.set(id, p);
    return p;
  }

  async function handle(url: string, init: RequestInit): Promise<Response> {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/v3/, '');
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const body =
      typeof init.body === 'string' && init.body
        ? JSON.parse(init.body)
        : undefined;
    const method = (init.method ?? 'GET').toUpperCase();
    requests.push({ method, path, headers, body });

    if (headers['access_token'] !== opts.apiKey) {
      return json(401, {
        errors: [
          {
            code: 'invalid_access_token',
            description: 'A chave de API fornecida é inválida',
          },
        ],
      });
    }
    if (!headers['user-agent'])
      return json(400, {
        errors: [{ code: 'user_agent', description: 'User-Agent obrigatório' }],
      });

    let m: RegExpExecArray | null;
    if (method === 'POST' && path === '/customers') {
      const b = body as { name?: string; cpfCnpj?: string };
      if (!b?.name || !b?.cpfCnpj)
        return invalid('O CPF/CNPJ informado é inválido.');
      const c = { ...(body as object), id: nextId('cus') } as Record<
        string,
        unknown
      > & { id: string };
      customers.set(c.id, c);
      return json(200, { object: 'customer', ...c });
    }
    if (method === 'POST' && path === '/payments') {
      const b = body as {
        customer: string;
        value: number;
        billingType: string;
        dueDate: string;
      };
      if (!customers.has(b.customer)) return invalid('Cliente inexistente.');
      return json(200, newPayment(b as never));
    }
    if (method === 'GET' && (m = /^\/payments\/([^/]+)$/.exec(path))) {
      const p = payments.get(decodeURIComponent(m[1]));
      return p ? json(200, p) : notFound();
    }
    if (
      method === 'GET' &&
      (m = /^\/payments\/([^/]+)\/pixQrCode$/.exec(path))
    ) {
      const p = payments.get(decodeURIComponent(m[1]));
      if (!p) return notFound();
      return json(200, {
        encodedImage:
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        payload: `00020101021226820014br.gov.bcb.pix2560pix-h.asaas.com/qr/cobv/${p.id}5204000053039865802BR5905ASAAS6009Joinville62070503***6304ABCD`,
        expirationDate: '2099-12-31 23:59:59',
      });
    }
    if (
      method === 'GET' &&
      (m = /^\/payments\/([^/]+)\/identificationField$/.exec(path))
    ) {
      const p = payments.get(decodeURIComponent(m[1]));
      if (!p) return notFound();
      return json(200, {
        identificationField: '00190000090275928800021932978170187890000005000',
        nossoNumero: '6543',
        barCode: '00191878900000050000000002759288002193297817',
      });
    }
    if (method === 'POST' && path === '/subscriptions') {
      const b = body as {
        customer: string;
        value: number;
        billingType: string;
        cycle: string;
        nextDueDate: string;
      };
      if (!customers.has(b.customer)) return invalid('Cliente inexistente.');
      const s: AsaasSubscription = {
        object: 'subscription',
        id: nextId('sub'),
        status: 'ACTIVE',
        deleted: false,
        ...(body as object),
      } as AsaasSubscription;
      subscriptions.set(s.id, s);
      newPayment({
        customer: b.customer,
        value: b.value,
        billingType: b.billingType,
        dueDate: b.nextDueDate,
        subscription: s.id,
        description: (body as { description?: string }).description ?? null,
      });
      return json(200, s);
    }
    if (method === 'GET' && (m = /^\/subscriptions\/([^/]+)$/.exec(path))) {
      const s = subscriptions.get(decodeURIComponent(m[1]));
      return s ? json(200, s) : notFound();
    }
    if (
      method === 'GET' &&
      (m = /^\/subscriptions\/([^/]+)\/payments$/.exec(path))
    ) {
      const id = decodeURIComponent(m[1]);
      if (!subscriptions.has(id)) return notFound();
      const data = [...payments.values()].filter(
        (p) => p.subscription === id && !p.deleted
      );
      return json(200, {
        object: 'list',
        hasMore: false,
        totalCount: data.length,
        limit: 10,
        offset: 0,
        data,
      });
    }
    if (method === 'DELETE' && (m = /^\/subscriptions\/([^/]+)$/.exec(path))) {
      const s = subscriptions.get(decodeURIComponent(m[1]));
      if (!s || s.deleted) return notFound();
      s.deleted = true;
      for (const p of payments.values())
        if (p.subscription === s.id && p.status === 'PENDING') p.deleted = true;
      return json(200, { deleted: true, id: s.id });
    }
    return notFound();
  }

  let evt = 0;
  function webhook(body: Omit<AsaasWebhookBody, 'id'> & { id?: string }) {
    const full: AsaasWebhookBody = {
      id:
        body.id ??
        `evt_${(++evt).toString(16).padStart(32, '0')}&${Date.now()}`,
      dateCreated: '2026-10-06 12:00:00',
      account: { id: opts.accountId ?? '47ed0d25-f9fb-4b35-b23a-d8895caf92b7' },
      ...body,
    } as AsaasWebhookBody;
    const rawBody = JSON.stringify(full);
    return {
      rawBody,
      body: full,
      headers: new Headers({
        'content-type': 'application/json',
        'asaas-access-token': opts.webhookToken,
      }),
    };
  }

  /** Change a payment as Asaas would and build the webhook it sends. */
  function settle(
    paymentId: string,
    event:
      | 'PAYMENT_RECEIVED'
      | 'PAYMENT_CONFIRMED'
      | 'PAYMENT_OVERDUE'
      | 'PAYMENT_DELETED'
      | 'PAYMENT_REFUNDED'
  ) {
    const p = payments.get(paymentId);
    if (!p) throw new Error(`fake asaas: unknown payment ${paymentId}`);
    const status: Record<typeof event, string> = {
      PAYMENT_RECEIVED: 'RECEIVED',
      PAYMENT_CONFIRMED: 'CONFIRMED',
      PAYMENT_OVERDUE: 'OVERDUE',
      PAYMENT_DELETED: p.status,
      PAYMENT_REFUNDED: 'REFUNDED',
    };
    p.status = status[event];
    if (event === 'PAYMENT_DELETED') p.deleted = true;
    if (event === 'PAYMENT_RECEIVED' || event === 'PAYMENT_CONFIRMED') {
      p.paymentDate = '2026-10-06';
      p.clientPaymentDate = '2026-10-06';
    }
    return webhook({ event, payment: { ...p } });
  }

  /** Next charge of a subscription (what Asaas creates each cycle). */
  function renew(subscriptionId: string) {
    const s = subscriptions.get(subscriptionId);
    if (!s)
      throw new Error(`fake asaas: unknown subscription ${subscriptionId}`);
    return newPayment({
      customer: s.customer,
      value: s.value,
      billingType: s.billingType ?? 'PIX',
      subscription: s.id,
    });
  }

  return {
    fetch: (input: string, init: RequestInit) => handle(input, init),
    customers,
    payments,
    subscriptions,
    requests,
    webhook,
    settle,
    renew,
  };
}

export type FakeAsaas = ReturnType<typeof createFakeAsaas>;
