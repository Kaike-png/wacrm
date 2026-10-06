# Localização PT-BR e configurações regionais

O produto é pensado primeiro para **empresas brasileiras**: interface em
português do Brasil, datas `05/10/2026 14:30`, dinheiro `R$ 1.234,56`, fuso
`America/Sao_Paulo`. Tudo isso é **configurável por tenant (conta)**, e os
outros idiomas do upstream (en, es, ko) continuam funcionando.

Código: `src/custom/locale/` (formatação, configurações) e
`src/custom/i18n/` (textos). Patch do core: **P-004** (`src/custom/core-patches.ts`).

---

## 1. Os dois níveis

| O quê | Nível | Onde se configura | Padrão |
|---|---|---|---|
| **Idioma da interface** (catálogo de textos) | instalação (build) | `NEXT_PUBLIC_APP_LOCALE` | `pt-BR` |
| **Formato regional** (datas, horas, números, separador decimal) | **tenant** | `accounts.locale` · Configurações → Região e moeda | `pt-BR` |
| **Fuso horário** (exibição + condições de horário das automações) | **tenant** | `accounts.timezone` · Configurações → Região e moeda | `America/Sao_Paulo` |
| **Moeda padrão** dos negócios | **tenant** | `accounts.default_currency` (upstream, migration 021) · mesma tela | `BRL` |
| Valores de reserva antes da conta carregar | instalação | `NEXT_PUBLIC_DEFAULT_TIMEZONE`, `NEXT_PUBLIC_DEFAULT_CURRENCY` | `America/Sao_Paulo`, `BRL` (em deploys `pt`; `USD` nos demais) |

- `NEXT_PUBLIC_APP_LOCALE` aceita `pt`, `pt-BR` ou `pt_BR` (todos carregam
  `messages/pt.json`), além de `en`, `es` e `ko`. Valor desconhecido → inglês,
  como no upstream. Entra no build: trocou, **rebuild** (o `Dockerfile` e o
  `docker-compose.yml` repassam as três variáveis).
- O idioma da interface é **por instalação**, não por tenant. O motivo: o
  upstream embute um único catálogo no bundle (`src/lib/i18n/translate.ts`),
  e tornar isso dinâmico mexe em todo o P-001. Ver §8.
- Formato, fuso e moeda são **por tenant**: só administradores mudam (a
  policy RLS `accounts_update` do upstream já restringe a admin+; a tela
  espelha com `canEditSettings`).

### Banco: `supabase/migrations/900_custom_account_locale.sql`

- `accounts.locale TEXT NOT NULL DEFAULT 'pt-BR'`: tag BCP 47, com CHECK de formato.
- `accounts.timezone TEXT NOT NULL DEFAULT 'America/Sao_Paulo'`: CHECK com
  `is_valid_timezone()`, que testa o nome no próprio Postgres.
- `accounts.default_currency`: o padrão de **novas** contas passa a `BRL`.
  Contas existentes não são alteradas.
- Idempotente. RLS sem mudança: as policies de `accounts` cobrem as colunas novas.
- **Sem a migration o app continua funcionando**: browser e servidor caem nos
  padrões da instalação, e a tela de configurações avisa que falta aplicá-la.

Alterar uma conta via SQL:

```sql
UPDATE public.accounts
SET locale = 'pt-BR', timezone = 'America/Manaus', default_currency = 'BRL'
WHERE id = '<account-id>';
```

---

## 2. Como a formatação funciona

Toda data, hora, número e valor passa por `src/custom/locale/format.ts`, que
usa só `Intl` (nada de `date-fns` com padrões em inglês nem `toLocaleString()`
dependente do navegador).

| Função | pt-BR |
|---|---|
| `formatDate(v, 'short' \| 'medium' \| 'long' \| 'dayMonth' \| 'weekdayDayMonth')` | `05/10/2026` · `5 de out. de 2026` · `5 de outubro de 2026` · `5 de out.` · `dom., 5 de out.` |
| `formatTime` / `formatDateTime` | `14:30` · `05/10/2026 14:30` |
| `formatCalendarDate` | datas sem hora (`expected_close_date`): **nunca** desloca o dia por fuso |
| `formatRelativeTime` | `há 5 minutos`, `ontem` |
| `formatListTimestamp` | estilo WhatsApp: `14:30` hoje, `ontem`, `seg.`, `05/10/2026` |
| `formatNumber` / `formatDecimal` / `formatPercent` / `formatCompact` | `1.234.567` · `1,5` · `42%` · `1,5 mil` / `2,3 mi` |
| `formatMoney(v, 'BRL')` | `R$ 1.234,56` (compacto: `R$ 1,5 mil`) |
| `formatDuration`, `formatMegabytes` | `1,5 hora` · `12,3` (MB) |
| `dayKey`, `calendarDaysAgo`, `minutesOfDay`, `isTodayInTz` | agrupamento por dia / “hoje” **no fuso do tenant** |
| `parseLocaleNumber` / `toLocaleInputNumber` | leitura de número digitado (§4) |

**Configurações ativas.** No browser, `TenantLocaleProvider`
(`tenant-locale.tsx`, montado no `dashboard-shell`) lê `locale`/`timezone`
da conta, junta com `useAuth().defaultCurrency` e define as configurações
ativas. As funções usam essas configurações quando não recebem `settings`
explícito. Ao salvar na tela, a árvore remonta e todo horário é refeito.

**No servidor** as configurações ativas **nunca** são definidas (o setter é
no-op fora do browser), então uma requisição não herda o tenant de outra.
Código de servidor que precisa do tenant chama
`getAccountLocaleSettings(db, accountId)` (`server.ts`) e passa o resultado
explicitamente. Hoje isso acontece no motor de automações: a condição
`time_of_day` (ex.: `18:00-09:00`) é avaliada no fuso da conta, não em UTC
do container. Na falta da migration, ou se a consulta falhar, valem os
padrões da instalação.

**Moeda.** `src/lib/currency.ts` (core) usa o locale do tenant:
`formatCurrency` mostra valor inteiro (decisão do upstream: negócios sem
centavos, `R$ 12.346`; o banco guarda 2 casas). Os formatos compactos usam
`Intl` (`R$ 1,5 mil`) em locales não ingleses. Em inglês o estilo do
upstream (`$1.5k`) é mantido. Negócios criados por automação sem moeda
herdam a da conta ou, se não houver, a da instalação.

---

## 3. Textos em PT-BR

Os arquivos `messages/*.json` são do upstream e **não são editados**. A
revisão do português fica em camadas do fork, aplicadas por
`withCustomMessages` (`src/custom/i18n/merge.ts`) uma vez por processo:

1. **Revisões** `src/custom/i18n/revisions/pt.json`: hoje são **555
   strings do core** retraduzidas para soar natural (terminologia de
   CRM/vendas, “Não foi possível…” em vez de “Falha ao…”, sentence case,
   concordância). Cada revisão fica **presa ao texto do upstream que
   substitui** em `revisions/pt.base.json`.
2. Overrides de marca (`overrides/`), ver `docs/BRANDING.md`.
3. Catálogo próprio do fork (`messages/pt.json`, namespaces `Custom`, `Br`,
   `Billing`, `Integrations`).
4. Reescrita da marca (`wacrm` → nome configurado).

### Glossário (obrigatório)

| Inglês | PT-BR |
|---|---|
| Contact | **Contato** |
| Lead | **Lead** (o lead, “Novo lead”) |
| Pipeline | **Funil** / Funis (nunca “pipeline” em texto visível) |
| Stage | **Etapa** (do funil) |
| Deal | **Negócio** (entidade do funil: “Novo negócio”, “negócios abertos”) |
| Opportunity | **Oportunidade** (onde o original fala em opportunity, previsão ou valor potencial) |
| Won / Lost | Ganho / Perdido |
| Inbox | **Caixa de entrada** |
| Broadcast / Campaign | **Campanha** (a ação: “enviar”, “envio”) |
| Automation | **Automação** |
| Trigger / Step / Run | Gatilho / Passo / Execução (“etapa” é só do funil) |
| Flow / Node | Fluxo / **Bloco** (nunca “nó”) |
| Settings | **Configurações** |
| Dashboard | Painel |
| Template (WhatsApp) | Modelo (termo da Meta em PT-BR) |
| Agent (pessoa da equipe) / AI agent | **Atendente** / Agente de IA |
| Assign / Unassigned | Atribuir / Sem responsável |
| Owner / Admin / Viewer | Proprietário / Administrador / Somente leitura |
| Workspace / Account | Espaço de trabalho / Conta |
| Tag / Custom field / Notes | Tag / Campo personalizado / Anotações |
| Playground | Área de testes |
| Delete / Remove | Excluir / Remover (de uma lista) |
| Upload / Download | Enviar / Baixar |
| Email | **E-mail** |
| Sign in / Sign out / Sign up | Entrar / Sair / Criar conta |

Não se traduz: WhatsApp, Meta, webhook, token, API, URL, ID, JSON, CSV,
OpenAI, Anthropic, nomes de campos técnicos (`account_id`), rotas
(`/api/v1/...`), valores de enum em mensagens de API (`admin`, `agent`).

Estilo: tratamento por **você**; **sentence case** (“Selecionar público”);
botões no infinitivo (“Salvar”, “Criar negócio”); erros com “Não foi
possível …”; sucesso no particípio (“Contato salvo”); “ex.:” em vez de
“e.g.”; nada de “deletar”, “setar”, “customizar”, “logar”; nada de pt-PT
(“contacto”, “utilizador”, “registo”).

### Garantias automáticas (`src/custom/i18n/revisions.test.ts`)

- **Glossário**: o catálogo pt *mesclado* não pode conter `pipeline`,
  `broadcast`, `inbox`, `dashboard`, `workspace`, `deal`, `deletar`, `nó`,
  `email` sem hífen, pt-PT etc. (fora de `<code>`, `{args}` e identificadores).
  Uma string nova do upstream com termo antigo quebra o CI até ser revisada.
- **ICU intacto**: cada revisão mantém os mesmos argumentos, ramos de
  `plural`/`select` e tags do original.
- **Plurais**: onde o original tem `{count}` sem plural (“1 contatos”), a
  revisão pode virar `{count, plural, =1 {…} other {…}}`. Só vale para as
  chaves listadas em `PLURALIZED`, depois de conferir que quem chama passa
  um **número** (plural ICU quebra com string). O teste formata cada uma
  com 1 e 2.
- **Pinagem**: uma revisão cujo texto do upstream mudou falha o teste.
- `src/custom/brand/brand.test.ts`: nenhum texto visível hardcoded com o
  nome do upstream.

### Rótulos que o upstream exibia crus

`src/custom/i18n/labels.ts`: modo (`light`/`dark` → claro/escuro) e nomes de
cor de destaque. Rótulos de arestas dos fluxos (`src/lib/flows/edges.ts`)
saem do catálogo. Em inglês, o texto é o próprio original do upstream.

---

## 4. Entrada de dados do jeito brasileiro

- **Valores** (formulário de negócio, ação “Criar negócio” das automações):
  campo de texto com `inputMode="decimal"` em vez de `type="number"`, que
  recusa a vírgula num navegador em inglês e lê `1.500` como 1,5.
  `parseLocaleNumber` aceita `1.500,50`, `1500,5`, `R$ 1.500` e também
  `1500.50` / `1,500.50`. Regra: havendo os dois separadores, o último é o
  decimal. Com um só tipo, o separador decimal do locale é decimal, e o
  outro é milhar quando se repete ou vem seguido de exatamente 3 dígitos
  (pt-BR: `1.500` → 1500, `1,500` → 1,5). O símbolo à esquerda do campo é o
  da moeda escolhida (`R$`), não um `$` fixo. Componente reutilizável:
  `LocaleNumberInput` (`src/custom/locale/number-input.tsx`).
- **CSV** (importar contatos, público de campanha por CSV),
  `src/custom/locale/csv.ts`:
  - arquivo do Excel pt-BR separado por **ponto e vírgula**;
  - codificação **Windows-1252** (o “CSV” padrão do Excel) ou UTF-8, com ou sem BOM;
  - cabeçalhos em português: `telefone`/`celular`/`whatsapp`/`número` →
    `phone`, `nome` → `name`, `e-mail` → `email`, `empresa` → `company`,
    `etiquetas`/`marcadores` → `tags`, sem diferenciar acento e maiúsculas;
  - um CSV no formato do upstream passa sem mudança.
- **Modelos de WhatsApp**: o idioma de um modelo novo segue o locale do
  tenant (`pt_BR`), em vez de `en_US` (`templateLanguageFor`).

---

## 5. O que fica de propósito sem localizar

| Item | Por quê |
|---|---|
| `/api/v1`, webhooks de saída, MCP | contrato: datas ISO 8601 em UTC, números com ponto, enums em inglês |
| Logs, `console.*`, erros internos (`Failed: 500`) | não chegam à interface |
| Mensagens de erro vindas da própria Meta | texto da Meta em inglês. `meta-error-explain.ts` (core, só inglês) explica os códigos comuns |
| Identificadores técnicos (`wacrm_live_`, chaves de `localStorage`) | ver `docs/BRANDING.md` §5 |
| Nome de arquivo de mídia baixada (`yyyyMMdd-HHmmss`) | formato técnico ordenável |

---

## 6. Testes

- `vitest.config.ts` fixa `NEXT_PUBLIC_APP_LOCALE=en` e `TZ=UTC`, para que
  os ~1100 testes do upstream rodem determinísticos em qualquer máquina e
  CI. Os testes de PT-BR passam `settings` explícitos (`pt-BR` /
  `America/Sao_Paulo`).
- `src/custom/locale/locale.test.ts`: datas/horas no fuso do tenant,
  separadores, moeda, relativo, parse de números, padrões, migration, `templateLanguageFor`.
- `src/custom/locale/csv.test.ts`: exportação real do Excel pt-BR (BOM, `;`,
  cabeçalhos em português, Windows-1252).
- `src/custom/i18n/revisions.test.ts`: glossário, ICU, pinagem, plurais.

---

## 7. Manutenção

**Revisar ou acrescentar um texto do core:** editar
`src/custom/i18n/revisions/pt.json` (mesma estrutura aninhada de
`messages/pt.json`) e rodar:

```bash
node scripts/fork/i18n-revisions.mjs      # fixa pt.base.json com o texto atual do upstream
npx vitest run src/custom                 # glossário + ICU + pinagem
```

**Texto novo do fork:** `src/custom/i18n/messages/{en,pt}.json`, nos namespaces do fork.

**Merge do upstream:**

1. `node scripts/fork/i18n-revisions.mjs --check` lista as chaves cujo
   texto do upstream mudou (antigo → novo).
2. Para cada uma: reler o inglês novo, ajustar a revisão (ou removê-la, se o
   upstream passou a acertar) e então rodar o script sem `--check`.
3. Se o teste do glossário apontar uma string nova do upstream, adicionar a
   revisão dela.
4. Novas chamadas de formatação no upstream (`toLocaleString`, `date-fns`
   `format`, `'en-US'`): trocar pelas funções de `@/custom/locale/format`,
   marcar `FORK-PATCH(P-004)` e registrar o arquivo em `core-patches.ts`.
   Para conferir:
   `grep -rnE "toLocale(Date|Time)?String\(|'en-US'|from 'date-fns'" src --include=*.tsx --include=*.ts | grep -v custom/`

**Outro país ou idioma:** o formato regional é por tenant e já aceita
qualquer tag BCP 47 (lista da tela em `FORMAT_LOCALES`). Um idioma de
interface novo exige um `messages/<código>.json` (upstream) e o mapeamento
em `catalogueLocale`/`translate.ts`.

---

## 8. Pendências conhecidas

- **Idioma por tenant ou por usuário**: hoje é por instalação. Para mudar, o
  `getRequestConfig` (`src/i18n/request.ts`) teria que ler o tenant por
  requisição, e `getT` (`src/lib/i18n/translate.ts`) deixaria de ter um
  catálogo único por processo. Melhor propor upstream junto com o P-001.
- **Telefones**: a identificação de contatos exige E.164 (`+55…`). Não há
  DDI padrão por tenant, nem tratamento do nono dígito (números brasileiros
  que o WhatsApp entrega sem o 9). Mexe em identidade de contato e no
  webhook (`wa-identity.ts`, `phone-utils.ts`), então fica para uma tarefa
  dedicada, com testes de deduplicação.
- **Negócios sem centavos** na exibição (decisão do upstream). Se o produto
  precisar, basta trocar `formatCurrency` para `formatMoney` com 2 casas.
- **Strings com nome de pessoa** (`{name} removido`) assumem o masculino.
- Algumas mensagens de erro raras de upload para a Meta
  (`src/lib/whatsapp/meta-api.ts`) continuam em inglês.
