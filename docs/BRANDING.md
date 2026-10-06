# Identidade visual (branding)

Toda a identidade do produto (nome, logo, favicon, título, descrição, URL
e e-mail de suporte) sai de **um único arquivo**:

```
src/custom/brand/config.ts      ← único lugar que lê as variáveis de marca
```

Nada mais no código lê essas variáveis. Um teste
(`src/custom/brand/brand.test.ts`) falha se alguém ler
`process.env.NEXT_PUBLIC_APP_NAME` (ou outra variável de marca) fora dele,
ou se o nome do produto original voltar a aparecer em texto visível.

---

## 1. Trocar a marca de um deploy (só variáveis de ambiente)

| Variável | Para quê | Padrão |
|---|---|---|
| `NEXT_PUBLIC_APP_NAME` | nome: título da aba, sidebar, login/páginas públicas, e-mails, textos da UI | `CRM` |
| `NEXT_PUBLIC_APP_URL` | URL canônica (sem `/` no fim): links de convite, `metadataBase`, Open Graph, imagens dos e-mails | vazio |
| `NEXT_PUBLIC_SUPPORT_EMAIL` | contato de suporte no rodapé das páginas públicas e nos e-mails | vazio (oculto) |
| `NEXT_PUBLIC_APP_DESCRIPTION` | descrição (meta description, Open Graph) | texto localizado `Custom.brand.description` |
| `NEXT_PUBLIC_APP_LOGO_URL` | logo (arquivo em `public/` ou URL `https`) | marca gerada |
| `NEXT_PUBLIC_APP_FAVICON_URL` | favicon (png/svg/jpg/webp em `public/` ou URL `https`) | marca gerada |
| `NEXT_PUBLIC_APP_MARK` | estilo da marca gerada: `glyph` (balão de chat) ou `initial` (inicial do nome) | `glyph` |
| `NEXT_PUBLIC_BRAND_COLOR` | cor hex do favicon gerado e dos e-mails | `#7c3aed` |

- `NEXT_PUBLIC_SITE_URL` (nome do upstream) continua valendo quando
  `NEXT_PUBLIC_APP_URL` não está definida.
- **As variáveis `NEXT_PUBLIC_*` entram no build.** Depois de trocar, é
  preciso **rebuild** (`npm run build`, ou `docker compose up --build`; o
  `Dockerfile` e o `docker-compose.yml` já repassam todas como build args).
- Exemplo em `.env.local.example` (bloco “BRAND”, no fim do arquivo).

Exemplo:

```env
NEXT_PUBLIC_APP_NAME=Atende Zap
NEXT_PUBLIC_APP_URL=https://app.atendezap.com.br
NEXT_PUBLIC_SUPPORT_EMAIL=suporte@atendezap.com.br
NEXT_PUBLIC_APP_LOGO_URL=/brand/logo.svg
NEXT_PUBLIC_APP_FAVICON_URL=/brand/favicon.png
```

com os arquivos em `public/brand/logo.svg` e `public/brand/favicon.png`.

### Logo e favicon

- **Logo**: quadrado, de preferência SVG ou PNG ≥ 128 px. É exibido em
  32 px (sidebar e páginas públicas) e 40 px (e-mails). Sem logo
  configurado, aparece a marca gerada: quadrado na cor primária do tema com
  o balão de chat ou a inicial do nome.
- **Favicon**: `src/app/icon.tsx` gera um PNG de 32×32 no build.
  - Com `NEXT_PUBLIC_APP_FAVICON_URL` apontando para um arquivo em `public/`,
    o arquivo é lido do disco e encaixado no ícone.
  - Com uma URL `https`, ela é baixada **durante o build**, então precisa estar acessível.
  - Sem nenhuma das duas, o favicon é a marca gerada com `NEXT_PUBLIC_BRAND_COLOR`.
- Nos e-mails, o logo precisa de URL absoluta: um caminho `/brand/...` é
  prefixado com `NEXT_PUBLIC_APP_URL`.

### Cores da interface

A cor da UI vem do **tema** (`src/lib/themes.ts` + `src/app/globals.css`,
seletor de acento em Configurações → Aparência), não da marca.
`NEXT_PUBLIC_BRAND_COLOR` só afeta o que não tem CSS: favicon e e-mails.
Para a UI inteira seguir a marca:

1. defina `NEXT_PUBLIC_BRAND_COLOR` com a mesma cor do acento escolhido;
2. troque o tema padrão quando a identidade final existir. Isso mexe em
   `src/lib/themes.ts` (`DEFAULT_THEME`) e/ou `globals.css`, que são arquivos
   do core: registre como patch (ver §6).

---

## 2. Onde a marca aparece

| Superfície | Como usa a configuração |
|---|---|
| **Título da aba / metadata** | `src/app/layout.tsx` → `brandMetadata()` (`src/custom/brand/metadata.ts`): `title` (`<página> — <nome>`), `applicationName`, `description`, `metadataBase`, Open Graph |
| **Favicon** | `src/app/icon.tsx` → `renderBrandIcon()` (`src/custom/brand/icon.tsx`) |
| **Sidebar (dashboard)** | `<BrandMark />` (`src/custom/brand/brand-mark.tsx`) + texto `Sidebar.title`, que vira o nome da marca |
| **Login, cadastro, esqueci/redefinir senha** | `src/app/(auth)/layout.tsx` → `<PublicBrandFrame>`: logo + nome no canto superior, suporte no rodapé |
| **Página de convite `/join`** | `src/app/join/layout.tsx` → `<PublicBrandFrame>` |
| **Textos da UI** (todas as línguas) | camada i18n do fork (§3): `wacrm` → nome; “CRM Template for WhatsApp” → nome |
| **Links de convite** | `src/app/api/account/invitations/route.ts` usa `brand.url` |
| **Mensagens de erro da Meta** (só em inglês, fora do i18n) | `src/lib/whatsapp/meta-error-explain.ts` usa `brand.name` |
| **E-mails de autenticação** | templates gerados da configuração (§4) |

---

## 3. Textos: como o nome entra na interface

Sem editar `messages/*.json` (arquivos do upstream). A camada i18n do fork
(`src/custom/i18n/merge.ts`) aplica, uma vez por processo e locale:

1. **Overrides** (`src/custom/i18n/overrides/<locale>.json`): lista curta e
   explícita de chaves do core cujo texto *é* a marca original:
   `Sidebar.title`, `SignupPage.desc`, `Metadata.description`. Cada uma fica
   presa ao texto em inglês que substitui (`OVERRIDE_BASELINE_EN` em
   `merge.test.ts`).
2. **Catálogo do fork** (`src/custom/i18n/messages/<locale>.json`): strings
   próprias em `Custom.brand.*` (descrição padrão, “Precisa de ajuda?”, textos dos e-mails).
3. **Reescrita**: em todas as strings, a palavra `wacrm` vira o nome
   configurado, assim como os tokens `%APP_NAME%` / `%APP_DESCRIPTION%`. O
   valor é escapado para ICU (chaves `{}`), então nomes como “Joe’s {CRM}”
   funcionam.

Para usar o nome numa string nova do fork, prefira um argumento ICU
(`t('x', { appName: brand.name })`) em vez do token.

---

## 4. E-mails

Quem envia os e-mails de autenticação (confirmação de cadastro,
redefinição de senha, troca de e-mail) é o **Supabase Auth**, não o app.
Por isso a marca entra pelos templates, que o app gera a partir da configuração:

```
GET /api/brand/email-templates/confirmation        → HTML
GET /api/brand/email-templates/recovery            → HTML
GET /api/brand/email-templates/email_change        → HTML
GET /api/brand/email-templates/<nome>?part=subject → assunto (texto)
```

Os links usam `{{ .ConfirmationURL }}`, igual aos templates padrão do
Supabase, então o fluxo de autenticação não muda (ver `docs/auth-emails.md`).

Instalação (refazer sempre que a marca mudar):

- **Supabase hospedado:** abra cada URL acima no deploy, copie o HTML para
  *Authentication → Email Templates* e o assunto (`?part=subject`) para o
  campo *Subject*.
- **Supabase self-hosted (GoTrue):** no `.env` do Supabase:
  ```env
  GOTRUE_MAILER_TEMPLATES_CONFIRMATION=https://app.exemplo.com.br/api/brand/email-templates/confirmation
  GOTRUE_MAILER_TEMPLATES_RECOVERY=https://app.exemplo.com.br/api/brand/email-templates/recovery
  GOTRUE_MAILER_TEMPLATES_EMAIL_CHANGE=https://app.exemplo.com.br/api/brand/email-templates/email_change
  GOTRUE_MAILER_SUBJECTS_CONFIRMATION="Confirme sua conta no Atende Zap"
  GOTRUE_MAILER_SUBJECTS_RECOVERY="Redefina sua senha do Atende Zap"
  GOTRUE_MAILER_SUBJECTS_EMAIL_CHANGE="Confirme seu novo e-mail no Atende Zap"
  ```
  O GoTrue baixa o template pela URL.
- **Supabase CLI local:** `[auth.email.template.confirmation] content_path = "…"`
  em `supabase/config.toml`, apontando para um arquivo salvo da URL.
- **Remetente** (“From”, SMTP próprio): configurado no Supabase
  (*Authentication → SMTP Settings* / `GOTRUE_SMTP_*`), fora do app.

A mensagem de convite que o admin copia para o WhatsApp
(`Settings.invite.whatsappMessage`) já sai com o nome configurado (§3).

---

## 5. O que NÃO muda, de propósito

Identificadores técnicos com “wacrm” continuam iguais, porque trocá-los
quebraria dados ou contratos e não aparecem para o usuário:

| Identificador | Por que fica |
|---|---|
| chaves de `localStorage` (`wacrm.theme`, `wacrm.mode`, `wacrm:inbox:…`, `wacrm:browser-notifications`, `wacrm.flowEditor.view`) | trocar zera as preferências de todos os usuários |
| prefixo de API key `wacrm_live_` | keys já emitidas e scanners de segredo dependem dele (contrato da `/api/v1`) |
| headers `X-Wacrm-Event` / `X-Wacrm-Signature` / `X-Wacrm-Webhook-Id` | contrato dos webhooks de saída com integrações |
| `wacrm-mcp` (pacote do `mcp-server/`), `name` do `package.json` | nomes de pacote; não aparecem na UI |
| comentários e `docs/*.md` do upstream | documentação técnica do core |

Se um dia for necessário, trocar qualquer um deles é uma **migração**
(compatibilidade dupla por um período), não um rebranding.

### Créditos e licença

O WACRM é distribuído sob a licença **MIT** (`LICENSE`, © Arnas Donauskas).
A MIT exige manter o aviso de copyright e a licença em cópias do
software. **O arquivo `LICENSE` fica no repositório e não pode ser
removido nem alterado**; o aviso também deve acompanhar distribuições
do código (por exemplo, imagens Docker que incluam o fonte).
A licença não exige crédito na interface, por isso a UI não mostra
o nome original. Se quisermos, o lugar natural para um crédito é uma
página “Sobre” do produto.

O `README.md` continua sendo o do upstream (documentação do template).
O README do produto é uma tarefa à parte.

---

## 6. Mudanças estruturais de marca no futuro

| Quero… | Onde |
|---|---|
| trocar nome/URL/suporte/logo/favicon | variáveis (§1) + rebuild |
| mudar os padrões do produto (sem env) | `BRAND_DEFAULTS` em `src/custom/brand/config.ts` |
| um campo novo de marca (ex.: WhatsApp de suporte, cor secundária) | adicionar em `BrandConfig` + `resolveBrand()` + `BrandEnv` em `config.ts`, ler a variável **só lá**, incluir em `brand.test.ts`, `.env.local.example`, `Dockerfile` e `docker-compose.yml` |
| a marca num lugar novo da UI | importar `brand` / `BrandMark` / `BrandLockup` de `@/custom/brand/*`. Se o lugar é arquivo do core, marcar com `FORK-PATCH(P-003)` e registrar em `src/custom/core-patches.ts` |
| substituir outro texto do core | entrada nova em `src/custom/i18n/overrides/<locale>.json` (os 4 locales) + linha em `OVERRIDE_BASELINE_EN` |
| texto novo do produto | `src/custom/i18n/messages/{en,pt}.json`, namespace `Custom.*` |
| novo template de e-mail | `EMAIL_TEMPLATES` + textos em `Custom.brand.emails.*` |
| identidade visual completa (paleta, tipografia) | tema em `src/lib/themes.ts` / `globals.css` (core, patch registrado) ou, preferível, um tema novo do fork somado aos existentes |

### Merges do upstream

- Arquivos tocados (patch **P-003**): `src/app/layout.tsx`,
  `src/app/icon.tsx`, `src/components/layout/sidebar.tsx`,
  `src/app/(auth)/layout.tsx`, `src/app/join/layout.tsx`,
  `src/app/api/account/invitations/route.ts`,
  `src/lib/whatsapp/meta-error-explain.ts`, `Dockerfile`,
  `docker-compose.yml`, `.env.local.example`. Em conflito, aceitar o
  upstream e reaplicar as linhas marcadas `FORK-PATCH(P-003)`.
- Se o upstream reescrever um texto que tem override, o teste
  `brand overrides › still match the upstream English text` falha: revise
  o texto novo e atualize o override e a baseline juntos.
- Se o upstream criar uma string nova com “wacrm”, a reescrita cobre
  automaticamente. Se usar outro nome de marca, o teste
  `leaves no upstream product name` aponta onde.
