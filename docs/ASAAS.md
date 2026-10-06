# Asaas

Asaas é o primeiro gateway real da camada de cobrança
([BILLING.md](./BILLING.md)). Tudo o que é específico do Asaas fica em
`src/integrations/payments/asaas/`; regras de negócio, telas e banco não
mudaram por causa dele.

| Arquivo | Papel |
|---|---|
| `config.ts` | lê e valida as variáveis de ambiente |
| `client.ts` | cliente REST mínimo (fetch, timeout de 15 s, erros normalizados, chave só no header) |
| `mapping.ts` | tradução pura: status, `billingType`, reais ↔ centavos, datas de Brasília, eventos |
| `index.ts` | `AsaasBillingProvider implements BillingProvider` |
| `testing/fake-asaas.ts` | API fake em memória (testes e QA local) |
| `scripts/fork/fake-asaas.mjs` | serve o fake por HTTP para testar o app inteiro sem conta Asaas |
| `supabase/migrations/910_billing_asaas.sql` | dados de boleto e trava atômica de webhooks |

## 1. Configuração (só variáveis de ambiente, no servidor)

```bash
BILLING_PROVIDER=asaas
ASAAS_API_KEY='$aact_hmlg_…'        # sandbox; produção: $aact_prod_…
ASAAS_WEBHOOK_TOKEN=…               # 32–255 caracteres, sem espaços, não pode ser API key
# opcionais
ASAAS_ENVIRONMENT=sandbox           # deduzido do prefixo da chave; divergência = erro
ASAAS_ACCOUNT_ID=…                  # recusa webhooks de outra conta Asaas
ASAAS_USER_AGENT="Meu CRM (billing)" # obrigatório no Asaas para contas novas; padrão: NEXT_PUBLIC_APP_NAME
ASAAS_WEBHOOK_VERIFY=true           # reconsulta a API a cada evento (não desligue em produção)
```

- A URL base vem do ambiente: sandbox `https://api-sandbox.asaas.com/v3`,
  produção `https://api.asaas.com/v3`.
- **A chave nunca:**
  - é logada;
  - vai ao navegador;
  - é gravada no banco;
  - aparece em mensagem de erro ou URL.

  Ela viaja só no header `access_token`. Além disso, o filtro global de
  logs (`instrumentation.ts`) mascara qualquer `$aact_…` e o header
  `asaas-access-token`.
- **Configuração inválida** (chave ausente, ambiente divergente, token
  fraco) deixa a cobrança **indisponível (503)**. O resto do app continua
  funcionando, e as mensagens de erro não contêm segredo.
- **Gere o token do webhook** com, por exemplo,
  `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

## 2. Webhook no painel do Asaas

- **URL:** `https://SEU_DOMINIO/api/billing/webhooks/asaas`
- **Token de autenticação:** o mesmo valor de `ASAAS_WEBHOOK_TOKEN`
- **Tipo de envio:** sequencial
- **Eventos:**
  - de cobrança: `PAYMENT_CREATED`, `PAYMENT_UPDATED`, `PAYMENT_CONFIRMED`,
    `PAYMENT_RECEIVED`, `PAYMENT_OVERDUE`, `PAYMENT_DELETED`,
    `PAYMENT_RESTORED`, `PAYMENT_REFUNDED`, os de chargeback e os de
    análise de risco;
  - de assinatura: `SUBSCRIPTION_UPDATED`, `SUBSCRIPTION_INACTIVATED`,
    `SUBSCRIPTION_DELETED`.

  Outros eventos são aceitos com 200 e ignorados.
- **Firewall (opcional):** é possível restringir a origem aos IPs oficiais
  do Asaas em produção (52.67.12.206, 18.230.8.159, 54.94.136.112,
  54.94.183.101) no proxy, por exemplo no Caddy. No sandbox há outros IPs.

## 3. Autenticidade, conforme a documentação atual do Asaas

1. **Token:** o header `asaas-access-token` é comparado em tempo constante
   (hash SHA-256 dos dois lados) com `ASAAS_WEBHOOK_TOKEN`. Ausente ou
   diferente: **401**. Se o token não estiver configurado, todo webhook é
   recusado.
2. **Conta:** se `ASAAS_ACCOUNT_ID` estiver definido, eventos de outra
   conta Asaas são recusados.
3. **O estado vem da API, não do corpo.** O token do Asaas autentica o
   remetente, mas não assina o corpo. Por isso cada evento de cobrança ou
   de assinatura é **reconsultado na API do Asaas** antes de ser aplicado.
   - Um evento forjado com o token vazado e corpo inventado não concede
     nada: a API devolve o estado real.
   - Cobrança inexistente na API não concede nada.
   - Isso também resolve entregas fora de ordem: um `PAYMENT_OVERDUE` que
     chega depois do `PAYMENT_RECEIVED` encontra o pagamento já pago.
4. **Limites:** corpo acima de 512 KB recebe 413; JSON inválido ou evento
   sem `id` recebem 401, porque sem `id` não há como garantir
   idempotência.

## 4. Idempotência: o mesmo evento nunca é processado duas vezes

O Asaas entrega cada evento "pelo menos uma vez" e o reenvia com o mesmo
`id`. A chave é `(provider, event_id)` em `billing_webhook_events`, e a
reserva é **atômica**: `billing_claim_webhook_event`, um único
`INSERT … ON CONFLICT … WHERE` (migration 910).

| Situação | Resultado | Resposta ao Asaas |
|---|---|---|
| primeira entrega | `claimed`: processa e marca `processed` | 200 |
| outra entrega simultânea do mesmo evento | `in_progress`: não processa | 200 |
| reenvio depois de processado (ou ignorado) | `duplicate`: não processa | 200 |
| o processamento falhou | marca `failed`, e o próximo reenvio pode processar | 500, para o Asaas reenviar |
| processo morreu no meio | a reserva expira em 5 min e o reenvio processa | — |

Além disso, as regras não repetem efeitos:

- o período só é concedido na **primeira** vez que a cobrança fica paga;
  no cartão, `PAYMENT_CONFIRMED` seguido de `PAYMENT_RECEIVED` não estende
  duas vezes;
- pago nunca volta a pendente ou vencido.

## 5. Mapeamento para estados internos

**Status da cobrança no Asaas → status interno da cobrança:**

| Asaas | Interno |
|---|---|
| `RECEIVED`, `CONFIRMED` (cartão), `RECEIVED_IN_CASH`, `DUNNING_RECEIVED` | `paid` |
| `OVERDUE`, `DUNNING_REQUESTED` | `overdue` |
| `REFUNDED`, `REFUND_*`, `CHARGEBACK_*`, `AWAITING_CHARGEBACK_REVERSAL` | `refunded` |
| `PENDING`, `AWAITING_RISK_ANALYSIS`, status desconhecido | `pending` (não concede nada) |
| evento `PAYMENT_DELETED` / `PAYMENT_BANK_SLIP_CANCELLED`, ou `deleted: true` | `canceled` |
| `PAYMENT_REPROVED_BY_RISK_ANALYSIS`, `PAYMENT_CREDIT_CARD_CAPTURE_REFUSED` | `failed` |

**Efeito na assinatura e na organização** (regras em `rules.ts`, as mesmas
de qualquer gateway). Estes são os três mapeamentos pedidos:

| Evento | Assinatura | Organização |
|---|---|---|
| cobrança **paga** (`PAYMENT_RECEIVED`/`CONFIRMED`) | `active`; período estendido; troca de plano efetivada | `trial`/`past_due` → `active` |
| cobrança **vencida** (`PAYMENT_OVERDUE`) | `past_due` | `active` → `past_due` |
| assinatura **cancelada** (`SUBSCRIPTION_DELETED`/`INACTIVATED`) | `canceled`; o plano vale até o fim do período pago, depois volta ao padrão | inalterada |

Uma organização **suspensa** pela equipe nunca é alterada por pagamento.

> O status da assinatura é gravado como `canceled`, o vocabulário
> existente no banco desde a 909. `accounts.status` usa `cancelled` para
> outra coisa: a organização encerrada pela equipe.

## 6. Formas de pagamento

| | Como funciona |
|---|---|
| **Pix** | assinatura `billingType: PIX`; a tela mostra o QR Code e o copia e cola (`/payments/{id}/pixQrCode`) |
| **Boleto** | `billingType: BOLETO`; a tela mostra a linha digitável (`/payments/{id}/identificationField`), o PDF e a fatura |
| **Cartão** | `billingType: CREDIT_CARD` **sem dados de cartão**: o cliente paga na fatura do Asaas (`invoiceUrl`). O sistema não recebe, transmite nem guarda número de cartão, o que o mantém fora do escopo PCI. O Asaas cobra o mesmo cartão nos ciclos seguintes. |

**Detalhes da integração:**

- **Cliente:** criado com CPF/CNPJ (exigência do Asaas), sem máscara.
  Sem documento, a tela pede para preencher em Configurações → Organização.
- **Telefone:** enviado sem o 55.
- **`externalReference`:** o ID da organização.
- **Valores:** em centavos internamente e em reais na API, com
  arredondamento correto (`199.9` vira `19990`).
- **Datas:** as do Asaas (horário de Brasília, sem fuso) são convertidas
  para UTC.
- **Vencimento:** a primeira cobrança vence hoje, na data de Brasília.
- **Cancelamento:** `DELETE /subscriptions/{id}`. O Asaas não tem
  "cancelar no fim do período"; quem honra o período já pago é o sistema
  (`current_period_end` mais o cron diário). Se a assinatura já tiver sido
  removida no Asaas (404), isso é tratado como sucesso.
- **Consulta:** o botão "Já paguei" usa `GET /payments/{id}` e devolve o
  Pix ou o boleto atualizados.
- **Limites da API:** 429 e 5xx viram erro "tente de novo" (`retryable`),
  sem retry imediato, como recomenda o Asaas. No webhook, a resposta 500
  faz o Asaas reenviar.

## 7. Testar sem conta Asaas

```bash
K='$aact_hmlg_FAKE123456'; W=$(openssl rand -hex 24)
ASAAS_API_KEY="$K" ASAAS_WEBHOOK_TOKEN="$W" node scripts/fork/fake-asaas.mjs 4010
BILLING_PROVIDER=asaas ASAAS_API_KEY="$K" ASAAS_WEBHOOK_TOKEN="$W" \
  ASAAS_API_URL=http://127.0.0.1:4010/v3 npm run dev
# Simular o Asaas pagando e notificando:
curl -s -XPOST 127.0.0.1:4010/__fake/settle -d '{"paymentId":"pay_…","event":"PAYMENT_RECEIVED"}'
# → { rawBody, headers }: envie com POST para /api/billing/webhooks/asaas
```

Para o sandbox de verdade: crie a conta em sandbox.asaas.com, gere a chave
`$aact_hmlg_…`, configure o webhook com uma URL pública (ngrok ou
Cloudflare Tunnel) e confirme o pagamento pelo painel do sandbox.

## 8. Verificado

**Vitest** (`asaas.test.ts`, 27 testes, incluindo a suíte de contrato):

- **configuração:** ambiente deduzido da chave, divergência recusada,
  regras do token, nenhuma mensagem com a chave;
- **chamadas:**
  - cliente sem máscara e telefone sem +55;
  - a chave aparece só no header, nunca em URL ou corpo;
  - Pix recorrente com QR, boleto com linha digitável, cartão sem nenhum
    campo de cartão;
  - consulta e cancelamento, com 404 tolerado;
  - erros: 4xx definitivo, 429/5xx/rede com nova tentativa, sem a chave;
- **webhooks:**
  - token ausente, errado ou não configurado, outra conta, corpo grande ou
    malformado: todos recusados;
  - **evento forjado com token válido não concede nada**;
  - fora de ordem não reverte;
  - eventos informativos são ignorados;
- **mapeamento:** pago → active, vencido → past_due, cancelado → canceled,
  confirmado mais recebido concede o período uma vez só;
- **logs:** fluxo completo sem a chave nem o token no console.

**pgTAP** (`billing_webhooks.test.sql`, 16 testes): reserva, entrega
simultânea, duplicata, falha seguida de nova tentativa, reserva
abandonada, finalização tardia que não reabre o evento, funções acessíveis
só ao servidor.

**App inteiro contra o fake por HTTP** (navegador com o dev server real):

- assinatura Business no boleto: linha digitável na tela;
- evento forjado com token válido e estado falso: nada mudou;
- token errado ou ausente: 401;
- o mesmo `PAYMENT_RECEIVED` **três vezes em paralelo**: um processou e
  dois responderam "em andamento"; o reenvio posterior foi "duplicado";
  um só registro, com quatro tentativas, e um só pagamento;
- renovação vencida: assinatura e organização `past_due`; paga em seguida:
  `active`;
- upgrade para Pro no cartão: link "Pagar com cartão", nenhum campo de
  cartão enviado ao Asaas; `PAYMENT_CONFIRMED` ativou o Pro e a assinatura
  Business antiga foi removida no Asaas;
- cancelar: `DELETE` no Asaas; o `SUBSCRIPTION_DELETED` seguinte não mudou
  nada;
- log do servidor sem a chave nem o token.

## 9. Pendências

- **Sandbox real:** nada foi testado contra o Asaas de verdade, porque não
  há chave aqui. Primeira coisa a fazer quando houver.
- **Processamento assíncrono:** o Asaas recomenda gravar o evento,
  responder 200 e processar depois. Hoje o processamento é síncrono e
  rápido (uma consulta à API e poucas gravações). Se a latência crescer,
  trocar por fila mais worker; a reserva atômica já está pronta para isso.
- **Estorno e chargeback:** ficam registrados como `refunded`, sem efeito
  no plano. Falta decidir a política (rebaixar? marcar `past_due`?).
- **Tokenização de cartão e checkout transparente:** fora de escopo de
  propósito, por PCI.
- **Nota fiscal pelo Asaas:** fica para uma interface `InvoiceProvider`.
