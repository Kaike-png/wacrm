# Onboarding inicial

O que acontece entre “criar conta” e “usar o CRM”, como o progresso é
guardado e onde mexer.

Código: `src/modules/onboarding/` · rota: `src/app/(fork)/onboarding/` ·
banco: `supabase/migrations/904_onboarding.sql` · patch do core: **P-007**.

---

## 1. O fluxo

| # | Etapa | Onde | Obrigatória |
|---|---|---|:-:|
| — | **Criar conta** | `/signup` do upstream. A tela “Verifique seu e-mail” agora avisa que, depois da confirmação, vem a configuração em 4 passos | ✔ |
| — | **Criar organização** | automática: o `handle_new_user` do upstream cria a organização (`accounts`) junto com a conta, e o usuário vira dono | ✔ |
| 1 de 4 | **Sua organização** | nome, idioma/formato, fuso e moeda | ✔ (nome) |
| 2 de 4 | **Dados da empresa** | CPF/CNPJ, razão social, nome fantasia, telefone, e-mail, endereço | opcional |
| 3 de 4 | **Convide sua equipe** | links de convite | opcional |
| 4 de 4 | **Conecte o WhatsApp** | conexão manual guiada | opcional |
| — | **Tudo pronto** | resumo do que foi feito e do que ficou para depois → painel | ✔ |

- **Progresso visível:** em todas as telas aparecem a etapa (“Passo 2 de 4”),
  o título no formato “2 de 4 — Dados da empresa”, uma barra de progresso e
  a lista de etapas: “Conta criada” ✓ e as quatro etapas com ✓ (feita),
  número (a fazer) ou “para depois” (pulada). Dá para voltar a uma etapa já
  feita clicando nela.
- **Pular:** “Fazer depois” avança nas etapas opcionais. “Pular e ir para o
  painel”, no topo, encerra o assistente e marca o que faltou como “para
  depois”.
- **Retomar:** o progresso é salvo a cada etapa. Recarregar a página, ou ir
  à configuração avançada do WhatsApp e voltar, continua de onde parou.
  Reabrir: Configurações → Organização → “Abrir o assistente de
  configuração inicial” (`/onboarding?step=organization`).

### Quem passa pelo assistente

- **Só o dono de uma organização nova:** quem acabou de criar a conta.
- O redirecionamento acontece apenas a partir de **`/dashboard`**, onde o
  login e a confirmação de e-mail caem (`OnboardingGate` no
  `dashboard-shell`). Os outros endereços continuam abrindo direto, o que
  permite, por exemplo, usar a configuração avançada no meio do assistente.
- **Quem entra por convite** não passa pelo assistente: entra numa
  organização já configurada e não é o dono dela.
- **Organizações que já existiam** na data da migration 904 foram marcadas
  como concluídas: ninguém que já usa o sistema é jogado no assistente.
- **Admins** podem abrir o assistente pelo link. **Agentes e leitores**
  recebem uma mensagem e o link para o painel.
- **Sem a migration 904** não há redirecionamento: o sistema funciona como
  antes.

---

## 2. As etapas

### 1 — Sua organização

- **Nome:** já vem preenchido com o que o upstream usou na criação (nome
  completo ou e-mail). É salvo pelo `PATCH /api/account` do upstream, com a
  validação dele (até 80 caracteres).
- **Idioma/formato, fuso e moeda:** gravados em `accounts.locale`,
  `accounts.timezone` e `accounts.default_currency`, as mesmas colunas de
  Configurações → Região e moeda (`docs/LOCALIZATION.md`). Os padrões são
  pt-BR, America/Sao_Paulo e BRL.

### 2 — Dados da empresa (opcional)

- O formulário é o mesmo de Configurações → Organização
  (`OrganizationProfileFields`, extraído para ser compartilhado), com as
  mesmas máscaras e validações (`docs/BRAZILIAN_CONTACTS.md`, `docs/TENANCY.md`).
- Já vem com o nome fantasia igual ao nome da organização e o e-mail do dono.
- É gravado em `br_account_profiles`.

### 3 — Convide sua equipe (opcional)

- Explica os papéis (administrador, atendente, somente leitura).
- Usa o **mesmo `InviteMemberDialog` do upstream** (Configurações →
  Membros): link de uso único, validade, copiar ou enviar pelo WhatsApp.
- Lista os convites pendentes.

### 4 — Conecte o WhatsApp (opcional, manual)

Sem Embedded Signup nesta versão. A etapa é uma versão guiada da tela
avançada e usa a **mesma API** (`POST /api/whatsapp/config`). Essa API
valida as credenciais na Meta, registra o número quando há PIN, assina a
WABA no app e grava tudo criptografado.

1. **“Antes de começar”:** conta no Meta Business, app no Meta for
   Developers com o produto WhatsApp, e um número (o número de teste da Meta
   serve para experimentar). Há um link para o Meta for Developers.
2. **Campos, cada um com a indicação de onde encontrar:**
   - Identificação do número de telefone e da conta do WhatsApp Business
     (WhatsApp → Configuração da API);
   - token de acesso, com o aviso de que o temporário expira em 24 h e a
     recomendação de um token permanente de usuário do sistema, com link;
   - PIN opcional, só para número de produção.
3. **“Testar e conectar”:**
   - **em caso de erro**, mostra a explicação da Meta (a mesma da tela
     avançada) no campo certo;
   - **em caso de sucesso**, mostra o número e o nome verificado, e o
     **último passo**: a URL de retorno e um **token de verificação gerado
     na hora**, com botão de copiar e os 3 cliques no painel da Meta
     (Webhook → Editar → Verificar e salvar → assinar “messages”).
   - O token de verificação fica criptografado e não é exibido de novo; a
     tela avisa isso.
4. **Já conectado:** se o número já estava conectado, mostra o estado em
   vez do formulário.
5. **Configuração avançada mantida:** o link “Abrir configuração avançada”
   leva a **Configurações → WhatsApp**, que não mudou: diagnóstico, registro,
   PIN e troca de token.

### Tudo pronto

- Checklist das 4 etapas com o que foi feito: nome da organização, dados
  preenchidos, número de convites, WhatsApp conectado ou não.
- “Fazer agora” em cada pendência.
- Botões: Ir para o painel, Abrir a caixa de entrada (se o WhatsApp
  estiver conectado) e Ir para Configurações.
- Concluir grava `completed_at`.

---

## 3. Dados

`onboarding_progress` (migration 904), uma linha por organização:

| Coluna | Uso |
|---|---|
| `account_id` (PK) | a organização |
| `current_step` | `organization` · `company` · `team` · `whatsapp` · `done` |
| `completed_steps`, `skipped_steps` | etapas feitas / deixadas para depois |
| `completed_at`, `completed_by` | conclusão (`completed_by` precisa ser membro; senão é limpo) |

- **Sem linha** significa que o assistente não começou: é o estado das
  organizações criadas depois da migration.
- **RLS:** membros leem, admin+ escreve (como `accounts`).
- Coberta pelos testes genéricos de isolamento
  (`supabase/tests/database/tenant_isolation.test.sql`: 122 testes) e por
  testes próprios:
  - organização nova sem linha;
  - viewer não conclui;
  - `completed_by` de outro tenant é limpo;
  - etapas desconhecidas são recusadas.

## 4. Código

| Arquivo | O quê |
|---|---|
| `src/modules/onboarding/steps.ts` | etapas, avanço/pulo/conclusão, porcentagem, retomada, regra do redirecionamento (puro, testado em `steps.test.ts`) |
| `src/modules/onboarding/progress.ts` | leitura/gravação de `onboarding_progress` e o `OnboardingGate` |
| `src/modules/onboarding/wizard.tsx` | tela, progresso e navegação |
| `src/modules/onboarding/steps/*.tsx` | uma tela por etapa + resumo |
| `src/app/(fork)/onboarding/` | rota `/onboarding`, fora do layout do painel (tela cheia, sem menu lateral) |
| `src/modules/br/organization-fields.tsx` | formulário de dados da empresa, compartilhado com Configurações → Organização |

Patches no core (P-007, marcados `FORK-PATCH(P-007)`):
- `src/middleware.ts`: `/onboarding` exige login;
- `src/app/(dashboard)/dashboard-shell.tsx`: monta o `OnboardingGate`.

Textos em `Custom.onboarding.*` (`src/custom/i18n/messages/{pt,en}.json`).

## 5. Verificado

Fluxo ponta a ponta no navegador, com um usuário novo:

1. **Cadastro:** a tela “Verifique seu e-mail” aparece, e `/dashboard`
   redireciona para `/onboarding`.
2. **Passo 1 de 4:** o nome vazio é recusado; a organização é salva.
3. **Passo 2 de 4:** os campos vêm pré-preenchidos; CNPJ, telefone
   (`+55…`), CEP e UF são salvos.
4. **Passo 3 de 4:** um convite é criado pelo diálogo do upstream e aparece
   como pendente.
5. **Passo 4 de 4:**
   - campos vazios são avisados;
   - um token inválido mostra a explicação da Meta;
   - “Configurar depois” avança.
6. **Tudo pronto:** o resumo lista WhatsApp “para depois”. “Ir para o
   painel” leva a `/dashboard`, que não redireciona mais.
7. **Banco:** `completed_steps = {organization, company, team}`,
   `skipped_steps = {whatsapp}`, `completed_at` e `completed_by` preenchidos,
   status `trial`.

## 6. Próximos passos

- **Embedded Signup da Meta:** troca a etapa 4 por “Conectar com o
  Facebook”. A tela manual continua como alternativa.
- **Verificação do webhook:** confirmar que a Meta já chamou o webhook,
  por exemplo com um selo “primeira mensagem recebida” no resumo.
- **Mensagens da Meta em português:** as explicações de erro da Meta ainda
  são só em inglês (`src/lib/whatsapp/meta-error-explain.ts`, do upstream)
  e aparecem na etapa 4.
- **Checklist no painel** para quem pulou etapas, além do link em Configurações.
