#!/usr/bin/env node
// Local fake of the Asaas API for QA (fork, docs/ASAAS.md). Never use in production.
//
//   ASAAS_API_KEY='$aact_hmlg_fake…' ASAAS_WEBHOOK_TOKEN=… node scripts/fork/fake-asaas.mjs [port]
//   then run the app with ASAAS_API_URL=http://127.0.0.1:<port>/v3 BILLING_PROVIDER=asaas
//
// Extra QA endpoints (no auth, localhost only):
//   POST /__fake/settle { paymentId, event }  → { rawBody, headers } Asaas would POST
//   POST /__fake/renew  { subscriptionId }    → new pending payment of the next cycle
//   GET  /__fake/state                         → customers / subscriptions / payments
import http from 'node:http';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url);
const { createFakeAsaas } = await jiti.import('../../src/integrations/payments/asaas/testing/fake-asaas.ts');

const port = Number(process.argv[2] ?? 4010);
const apiKey = process.env.ASAAS_API_KEY;
const webhookToken = process.env.ASAAS_WEBHOOK_TOKEN;
if (!apiKey || !webhookToken) {
  console.error('set ASAAS_API_KEY and ASAAS_WEBHOOK_TOKEN');
  process.exit(1);
}
const fake = createFakeAsaas({ apiKey, webhookToken });

const read = (req) => new Promise((ok) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => ok(b)); });
const send = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

http
  .createServer(async (req, res) => {
    const body = await read(req);
    try {
      if (req.url === '/__fake/settle' && req.method === 'POST') {
        const { paymentId, event } = JSON.parse(body);
        const hook = fake.settle(paymentId, event);
        return send(res, 200, { rawBody: hook.rawBody, headers: Object.fromEntries(hook.headers.entries()) });
      }
      if (req.url === '/__fake/renew' && req.method === 'POST') {
        return send(res, 200, fake.renew(JSON.parse(body).subscriptionId));
      }
      if (req.url === '/__fake/state') {
        return send(res, 200, {
          customers: [...fake.customers.values()],
          subscriptions: [...fake.subscriptions.values()],
          payments: [...fake.payments.values()],
          requests: fake.requests.map((r) => `${r.method} ${r.path}`),
        });
      }
      const r = await fake.fetch(`http://fake${req.url}`, { method: req.method, headers: req.headers, body: body || undefined });
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(await r.text());
    } catch (e) {
      send(res, 500, { error: String(e) });
    }
  })
  .listen(port, '127.0.0.1', () => console.log(`fake asaas on http://127.0.0.1:${port}/v3`));
