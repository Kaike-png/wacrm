# Painel administrativo da plataforma

Painel da **nossa equipe** para operar o SaaS: listar e pesquisar
organizações; ver plano, situação, usuários, contatos, WABAs, uso, erros de
integração e data de criação; suspender e reativar. Todas as ações ficam
registradas em auditoria. Clientes, inclusive donos e admins das próprias
organizações, não têm acesso ao painel.

- Banco: `supabase/migrations/906_platform_admin.sql`
- Código: `src/modules/platform/`, `src/custom/tenancy/`, `src/billing/plans.ts`
- Rotas: `/platform`, `/platform/organizations/[id]`, `/platform/audit`, `POST /api/platform/organizations/[id]/{status,plan}`
- Patch do core: **P-009**
- Testes: `supabase/tests/database/platform_admin.test.sql`, `src/modules/platform/platform.test.ts`, `src/billing/access-policy.test.ts`

---

## 1. Quem é `platform_admin`

Um usuário com linha em `platform_admins`. O papel não tem relação com
os papéis do tenant (`owner`, `admin`, `agent`, `viewer`): ser dono de
uma organização não dá acesso nenhum ao painel.

| Proteção | Como |
|---|---|
| Ninguém se promove pelo app | `platform_admins` não tem nenhum privilégio para `anon`/`authenticated`, e nem a service role insere nela. Não existe rota nem tela para conceder acesso |
| Conceder / revogar | só o operador do banco: `scripts/fork/platform-admin.sh grant <email>`, `revoke <email>` e `list`. Usa `$DATABASE_URL` ou o container local. A concessão vai para a auditoria |
| Checagem | no servidor, com a service role, contra o usuário da sessão (`requirePlatformAdmin`). O layout **e cada página** checam (layouts e páginas rodam em paralelo no Next), e as funções SQL checam o ator de novo |
| Não-admin | recebe **404**, tanto nas páginas quanto na API. A existência do painel não é revelada |
| Mutações | exigem também mesma origem (`Origin` × `Host`), além do cookie `SameSite=Lax` |
| Funções do painel | `platform_*`, `SECURITY DEFINER`, executáveis **só pela service role** |

```bash
# local
scripts/fork/platform-admin.sh grant ana@empresa.com "time de suporte"
# produção
DATABASE_URL='postgresql://postgres:…@host:5432/postgres' PLATFORM_OPERATOR='kaike' \
  scripts/fork/platform-admin.sh grant ana@empresa.com
```

Um admin da plataforma continua tendo a própria organização, criada no
cadastro como para qualquer usuário. Ela aparece na lista como qualquer
outra.

## 2. O que o painel mostra

**Lista** (`/platform`): 25 por página, mais recentes primeiro.

- **Busca:** nome, razão social, nome fantasia, CPF/CNPJ (com ou sem
  máscara, inclusive alfanumérico), e-mail do dono, ID da organização,
  Phone Number ID, WABA ID e Business ID.
- **Filtro** por situação.
- **Colunas:** situação, plano, usuários, contatos, status do WhatsApp com
  a WABA, mensagens nos últimos 30 dias, quantidade de erros de integração
  e data de criação. As contagens são calculadas só para a página exibida.

**Detalhe** (`/platform/organizations/[id]`):

| Bloco | Conteúdo |
|---|---|
| Dados | ID, dono, razão social, fantasia, CPF/CNPJ, e-mail, telefone, cidade/UF, idioma/fuso/moeda, plano |
| Uso | usuários, contatos, conversas, mensagens recebidas, enviadas e com falha (30 dias), campanhas (30 dias), tokens de IA (30 dias), automações ativas, chaves de API ativas, última mensagem |
| WhatsApp (WABAs) | Phone Number ID, WABA, Business ID, status, registro, assinatura, último webhook, último teste, e se token, verify token e PIN estão **configurados**, sem mostrá-los |
| Erros de integração | último erro do teste e do registro do número; eventos de erro do log de conexão (P-008); envios com falha por código da Meta (30 dias); webhooks de saída falhando (**só o host**, porque a URL pode carregar um token); automações com falha |
| Usuários | nome, e-mail, papel, desde quando |
| Auditoria | as últimas 20 ações sobre a organização |

**Tokens nunca aparecem.** Nenhuma função SQL do painel lê
`access_token`, `verify_token` ou `pin`, só as colunas `has_*`. O
servidor do painel não importa criptografia nem o `config-store`. Dois
testes garantem isso: um pgTAP inspeciona o corpo das funções e um teste
unitário varre os arquivos do painel.

**Auditoria** (`/platform/audit`): as últimas 200 ações de toda a
plataforma.

## 3. Suspender e reativar

| Ação | De | Para | Regras |
|---|---|---|---|
| Suspender | trial, active, past_due | suspended | **motivo obrigatório** |
| Reativar | suspended | a situação **anterior à suspensão** (lida da auditoria; padrão `active`) | motivo opcional |
| Reativar | cancelled | active | |

A mudança e a entrada de auditoria são gravadas na mesma transação
(`platform_set_account_status`). Ações inválidas, como suspender duas
vezes, recebem 409.

### O que a suspensão bloqueia de fato

> **Atualizado na 911 ([DELINQUENCY.md](./DELINQUENCY.md)).** A suspensão
> deixou de esconder os dados.

Uma organização suspensa, pela equipe ou pelo sistema por falta de
pagamento:

- **perde:** envio de mensagens, campanhas, automações (fluxos e IA
  automática incluídos) e criação de integrações;
- **mantém:** login, dados (leitura e edição), exportação e faturamento;
  mensagens recebidas continuam entrando na caixa de entrada, sem
  resposta automática.

No painel aparece um aviso no topo, não mais uma tela cheia. A regra
fica numa única matriz (`src/billing/access-policy.ts` + SQL
`account_status_blocks`), mantida em sincronia por
`access-policy.test.ts`.

Quem suspendeu fica registrado (`billing_delinquency.suspended_by`):

- suspensão feita **pela equipe** só a equipe retira; um pagamento não a
  libera;
- **Reativar** devolve a situação anterior. Se a organização voltar para
  `past_due`, começa uma carência nova.

Nada é apagado. O servidor guarda a situação em cache por até 10
segundos por processo.

## 4. Auditoria

A tabela `platform_audit_log` é append-only:

- nenhum privilégio para clientes;
- a service role só lê;
- um trigger impede UPDATE, DELETE e TRUNCATE inclusive para o dono do
  banco.

Os registros entram somente pelas funções do painel e não têm FK, então
sobrevivem à exclusão do usuário ou da organização. Cada registro guarda:

- **ator:** id e o e-mail daquele momento;
- **ação;**
- **organização:** id e o nome daquele momento;
- **motivo;**
- **detalhes:** `from` e `to`;
- **origem:** IP e user agent.

| Ação | Exemplo exibido |
|---|---|
| `organization.suspended` | Admin ana@empresa.com suspendeu a organização Padaria Pão Quente em 05/10/2026 às 14:30. |
| `organization.reactivated` | Admin ana@empresa.com reativou a organização Padaria Pão Quente em 05/10/2026 às 15:02 (Suspensa → Trial). |
| `organization.plan_changed` | Admin ana@empresa.com alterou o plano da organização Padaria Pão Quente de sem plano para Pro em … |
| `organization.viewed` | Admin ana@empresa.com consultou a organização Padaria Pão Quente em … (no máximo 1 a cada 10 min por admin e organização) |
| `platform_admin.granted` / `revoked` | kaike@servidor concedeu acesso de admin da plataforma a ana@empresa.com em … |

O acesso ao detalhe também é auditado, porque ali aparecem dados pessoais
(e-mails, CPF/CNPJ) dos clientes.

## 5. Plano

Os planos ficam em tabelas desde a 907 ([`PLANS.md`](./PLANS.md)). No
detalhe da organização, “Alterar plano” escolhe entre os planos ativos e
o bloco **Limites do plano** mostra cada recurso com o uso. A página
**Planos** (`/platform/plans`) edita nome, ativo, padrão e os valores de
cada recurso, tudo auditado.

## 6. Verificado

- **pgTAP** (`npm run test:db`): `platform_admin.test.sql`, 51 testes:
  - cliente não lê `platform_admins` nem a auditoria, não chama funções do
    painel, não se promove e não muda a própria situação;
  - a service role recusa ator não-admin e não cria admins nem grava
    auditoria diretamente;
  - busca por nome, CNPJ com máscara, e-mail e WABA, com curingas tratados
    como texto;
  - o detalhe não contém segredos;
  - suspensão exige motivo e é auditada com ator, motivo, from/to e IP;
  - um membro suspenso continua lendo e gravando os dados, mas não cria automação (911);
    a outra organização segue normal;
  - a reativação restaura a situação anterior, e os dados voltam a
    aparecer para os membros;
  - plano: alteração com auditoria, validação, membro lê o próprio e não
    altera, ninguém lê o plano de outra organização;
  - auditoria imutável inclusive para o dono do banco;
  - visualizações deduplicadas;
  - admin revogado não age mais.
  - O isolamento (126 testes) e os segredos do WhatsApp (24) continuam
    passando.
- **Vitest:** frases da auditoria (incluindo o exemplo pedido), uma frase
  para cada ação da migration, catálogo de planos, sincronia da regra de
  suspensão entre SQL, servidor e billing, aviso caso uma migration futura
  redefina `is_account_member` sem a checagem, e varredura contra
  segredos no painel.
- **Navegador** (admin `ops@local.dev` e cliente `qa-ptbr@local.dev`):
  - **cliente:** `/platform` e o POST de suspender devolveram 404; o
    PostgREST das tabelas do painel devolveu 403;
  - **busca:** encontrou a organização pelo nome, e o detalhe não trouxe
    nenhum token;
  - **suspensão com motivo:**
    - o cliente passou a ver a tela “Organização suspensa”;
    - o REST devolveu 0 contatos e 0 contas;
    - `/api/account` devolveu 403;
    - um webhook assinado para o número da organização foi descartado;
  - **reativação:** o cliente voltou ao painel com os 2 contatos;
  - **plano:** alterado para Pro;
  - **auditoria:** registrou as frases esperadas, com motivo e IP.

## 7. Pendências e riscos

- **MFA para admins da plataforma:** recomendado antes de produção. O
  Supabase suporta TOTP (`aal2`), mas o app ainda não tem a tela de
  cadastro do segundo fator. Quando tiver, basta exigir `aal2` em
  `requirePlatformAdmin`.
- **Upstream redefinindo `is_account_member`:** desde a 911 a função não
  olha mais o status (a suspensão é imposta pelas travas da política de
  inadimplência). `access-policy.test.ts` garante que continue assim.
- **Desempenho:** sem o join com `accounts` desde a 911; as travas da
  política rodam só nas gravações bloqueáveis. Ainda vale medir
  com volume real. As contagens da lista são feitas por página, e a 906
  cria um índice `messages(conversation_id, created_at)` para o uso em
  30 dias.
- **Personificação** (“entrar como cliente”) não foi implementada, de
  propósito.
- **Webhooks de saída** de organizações suspensas: como nenhum evento
  novo acontece, não há entregas. Uma fila antiga de reentrega, porém, não
  é interrompida.
