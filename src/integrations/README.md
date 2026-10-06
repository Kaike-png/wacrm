# `src/integrations` — adapters para sistemas externos

Camada mais externa: um diretório por integração
(`payments/asaas`, `crm/rdstation`, `erp/bling`, `meta/embedded-signup`, …).

Regras:

- Pode importar: core **via** `@/custom/core/*`, `@/custom/*`, `@/billing/*`,
  `@/modules/*`.
- Ninguém importa daqui além de rotas do fork (`src/app/**/(fork)/`).
- Credenciais por tenant: criptografadas com o mesmo esquema do core
  (AES-256-GCM, `ENCRYPTION_KEY`). Expor `encrypt/decrypt` pela fachada
  quando for necessário pela primeira vez.
- Preferência de acoplamento, da mais para a menos desejada:
  1. **Fora do processo:** consumir os webhooks de saída
     (`message.received`, `message.status_updated`, `conversation.created`) e
     chamar `/api/v1`. Zero alteração no core.
  2. **Rota própria** em `src/app/api/(fork)/integrations/<nome>/route.ts`.
  3. **Hook in-process** no core (só via patch registrado).
- Strings: namespace `Integrations.*`.

Vazio por enquanto.
