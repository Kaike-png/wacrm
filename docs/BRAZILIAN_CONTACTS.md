# Contatos e empresas brasileiras

Como o CRM guarda **pessoa física**, **pessoa jurídica**, **CPF/CNPJ**,
**endereço** e **telefone brasileiro**, e por que foi feito assim.

Código: `src/modules/br/` · banco: `supabase/migrations/901_br_contact_profiles.sql`
· patch do core: **P-005** (`src/custom/core-patches.ts`).

---

## 1. O que existia (análise)

| Estrutura do upstream | O que oferece | Serve para CPF/CNPJ/endereço? |
|---|---|---|
| `contacts` (`name`, `phone`, `email`, `company`, `phone_normalized` gerado, `wa_user_id`…) | identidade do contato; `phone_normalized` (só dígitos) é **único por conta** (migration 022) e é a chave de deduplicação com o webhook da Meta | já cobre nome, telefone, e-mail e “empresa” |
| `custom_fields` + `contact_custom_values` | catálogo de campos por conta (`field_name`, `field_type` sempre `'text'`) e valores `TEXT` por contato (EAV) | **não** (abaixo) |

Por que **não** usar campos personalizados para CPF, CNPJ e endereço:

- **Sem tipo e sem validação.** Todo campo é `TEXT` livre, e o banco não tem
  como rejeitar um CPF inválido.
- **Catálogo mutável.** Admins renomeiam ou excluem campos a qualquer
  momento, e excluir apaga os valores (`ON DELETE CASCADE`). Um campo “CPF”
  pode virar “Documento” ou sumir, e integrações futuras (NF-e, boleto,
  busca de CEP) não teriam nome estável para ler.
- **Sem índice nem restrição por valor.** Não dá para buscar contatos por
  CNPJ com eficiência nem garantir formato.
- Por conta, nada garante que o campo exista.

Os campos personalizados continuam disponíveis para o que é de cada
negócio (“origem do lead”, “tamanho do pedido”).

Por que **não** colunas novas em `contacts`: a tabela é do upstream, e cada
coluna lá é risco de conflito em todo merge e muda o contrato de
`/api/v1/contacts`.

## 2. Modelo adotado

Uma tabela do fork, **1:1 com `contacts`**, só com o que não existe lá.
Nada é duplicado:

| Dado | Pessoa física | Pessoa jurídica | Onde fica |
|---|:-:|:-:|---|
| Nome | ✔ | ✔ (nome do contato) | `contacts.name` |
| Telefone | ✔ | ✔ | `contacts.phone` (E.164, §4) |
| E-mail | ✔ | ✔ | `contacts.email` |
| **Nome fantasia** | | ✔ | `contacts.company` (o campo “Empresa” vira “Nome fantasia” na tela quando o tipo é PJ) |
| Tipo de pessoa | ✔ | ✔ | `br_contact_profiles.person_type` (`PF` / `PJ` / vazio) |
| **CPF / CNPJ** | ✔ | ✔ | `br_contact_profiles.tax_id`, **sem máscara** |
| **Razão social** | | ✔ | `br_contact_profiles.legal_name` |
| CEP, logradouro, número, complemento, bairro, cidade, UF | ✔ | ✔ | `br_contact_profiles.postal_code`, `street`, `street_number`, `complement`, `district`, `city`, `state` |

O nome fantasia fica em `contacts.company` porque é o nome pelo qual a
empresa é conhecida, que é exatamente o que o upstream já mostra na lista
de contatos, no detalhe, na importação e nas variáveis de campanha
(campo `company`). Assim ele aparece em todo lugar sem mudança.

Um contato é um número de WhatsApp. Por isso o CNPJ **não é único**: várias
pessoas (números) podem atender pela mesma empresa, e uma pessoa pode ter
dois números. Há um índice `(account_id, tax_id)` para buscas. Uma entidade
“Empresa” separada, com vários contatos, é uma evolução possível (§8).

### Banco (`901_br_contact_profiles.sql`)

- `contact_id` é PK e FK para `contacts` com `ON DELETE CASCADE`: excluir o
  contato exclui os dados cadastrais.
- `account_id` é **sempre copiado do contato** por trigger: o valor enviado
  pelo cliente é ignorado, então não há como gravar o perfil em outro tenant.
- **RLS igual a `contacts`**: membros leem, a partir de *agent* escrevem.
  Testei localmente:
  - um `account_id` forjado é reescrito pelo trigger;
  - inserir perfil para um contato de outra conta é barrado pela RLS;
  - um CPF inválido é barrado pelo CHECK.
- CHECKs:
  - `person_type ∈ {PF, PJ}`;
  - **CPF/CNPJ com dígito verificador real** (`br_is_valid_cpf`, `br_is_valid_cnpj`);
  - CEP com 8 dígitos;
  - UF entre as 27;
  - limites de tamanho (razão social e logradouro 200, número 20, demais 100).
- Idempotente, como todas as migrations do repositório. Não altera nenhuma
  tabela do upstream.
- **Sem a migration o app continua funcionando**: a seção “Dados cadastrais”
  simplesmente não aparece.

## 3. CPF e CNPJ

`src/modules/br/documents.ts`

- **Armazenamento sem máscara.** CPF: 11 dígitos (`52998224725`). CNPJ: 14
  caracteres em maiúsculas (`11222333000181`).
- **Exibição com máscara**: `529.982.247-25`, `11.222.333/0001-81`. Os
  campos aplicam a máscara enquanto se digita.
- **Validação real**: dígitos verificadores por módulo 11. Sequências
  repetidas (`111.111.111-11`, `00.000.000/0000-00`) passam no cálculo mas
  são rejeitadas.
- **CNPJ alfanumérico** (IN RFB 2.229/2024, emitido desde julho de 2026):
  - as 12 primeiras posições aceitam letras (`12.ABC.345/01DE-35`) e os 2
    dígitos finais são sempre numéricos;
  - no cálculo, cada caractere vale o código ASCII − 48 (`A` = 17). Para
    CNPJ só com números, a regra é idêntica à clássica;
  - um CNPJ antigo continua válido sem nenhuma conversão.
- **A mesma regra existe no TypeScript e no SQL.** Conferi as duas
  implementações com 109 mil documentos gerados (CPF, CNPJ numérico e
  alfanumérico, válidos e inválidos): zero divergências.
- O documento só é gravado com um tipo de pessoa escolhido (sem tipo não dá
  para saber se é CPF ou CNPJ). Trocar o tipo limpa o campo.

## 4. Telefone

`src/modules/br/phone.ts`

**Armazenamento**: E.164 com `+` (`+5521999999999`). O upstream já gera
`phone_normalized` só com dígitos (`5521999999999`), que é exatamente o
formato em que o webhook da Meta grava o `wa_id`. Por isso um contato
cadastrado à mão e a primeira mensagem dele no WhatsApp **caem no mesmo
contato** (índice único da migration 022).

**Entrada**:

| Digitado | Conta brasileira | Conta de outro país |
|---|---|---|
| `(21) 99999-9999`, `21999999999`, `21 99999-9999` | `+5521999999999` | rejeitado: “inclua o código do país” (regra do upstream) |
| `(11) 3456-7890` (fixo) | `+551134567890` | rejeitado |
| `021 99999-9999`, `0 41 21 99999-9999` (tronco/operadora) | `+5521999999999` | rejeitado |
| `55 21 99999-9999` (DDI sem `+`) | `+5521999999999` | rejeitado |
| `99999-9999` (**sem DDD**) | rejeitado: “Inclua o DDD” (**nunca** assume 21 nem outro DDD) | rejeitado |
| `(20) 9…` (DDD inexistente) | rejeitado: “Esse DDD não existe no Brasil” | rejeitado |
| `+1 415 555 0123`, `+44 20 7946 0958`… | aceito como está (E.164) | aceito |
| `+55 99999-9999` | rejeitado (falta DDD) | rejeitado |
| `00 1 415…` | rejeitado: “use + e o código do país” (00 + operadora é ambíguo) | rejeitado |

- **“Conta brasileira”** significa formato regional da conta com região BR
  (`pt-BR`, o padrão; ver `docs/LOCALIZATION.md`). Não foi criada coluna
  nova de país.
- Números internacionais **nunca são bloqueados**: com `+` e código do
  país, qualquer país é aceito. A única checagem extra é para `+55`, que
  precisa ter forma brasileira (DDD válido + 8 ou 9 dígitos).
- Celular brasileiro: 11 dígitos com o `9`. Fixo: 10 dígitos começando com
  2–5. Também aceitamos 10 dígitos começando com 6–9 (celular antigo, sem o
  nono dígito), porque é assim que o WhatsApp ainda identifica algumas
  contas. **Não acrescentamos nem removemos o 9 automaticamente.**
- Os DDDs válidos (lista da Anatel) estão em `BRAZIL_AREA_CODES`.
- Enquanto se digita, o formulário mostra “Será salvo como +55 (21)
  99999-9999” ou o motivo da recusa.

**Exibição**: números brasileiros aparecem como `+55 (21) 99999-9999`,
inclusive os que o webhook grava só com dígitos. Vale para a lista de
contatos, o detalhe, a caixa de entrada e a conversa (via `contactHandle`).
Números de outros países continuam como estão.

**Onde a normalização se aplica**:

- formulário de novo contato e edição no detalhe;
- importação de CSV e público de campanha por CSV, onde **só** números sem
  `+` de contas brasileiras são reescritos. Números com `+` ficam como
  estavam no arquivo, que é o comportamento do upstream.

**Onde não se aplica**:

- `/api/v1` (contrato: integradores mandam E.164 com `+`);
- o webhook da Meta (já recebe o número internacional);
- contatos existentes: um número que não é editado não é tocado.

## 5. Endereço e CEP

`src/modules/br/address.ts`

- CEP guardado com 8 dígitos (`20040002`) e mostrado como `20040-002`.
  Apenas o formato é validado: só uma consulta diz se o CEP existe.
- UF: seleção entre as 27 unidades da federação.
- Número é texto livre (aceita “S/N”, “1000 A”).
- **Busca de CEP preparada, não integrada.** A interface
  `CepLookupProvider` (`lookup(cep) → { street, district, city, state }`) é o
  contrato. Uma integração futura (ViaCEP, BrasilAPI, Correios) mora em
  `src/integrations/` e se registra com `registerCepLookupProvider()`. Sem
  provedor registrado, que é o caso hoje, o botão “Buscar CEP” não aparece
  e nada sai do navegador.

## 6. Interface

- **Novo contato** (diálogo): link “Adicionar CPF/CNPJ e endereço” abre a
  seção “Dados cadastrais”. Ela já vem aberta se o contato tem dados. O
  diálogo agora rola, para caber o endereço.
- **Detalhe do contato** → aba Detalhes: seção “Dados cadastrais” abaixo da
  empresa, salva junto com “Salvar alterações”. O cabeçalho mostra o
  CPF/CNPJ com máscara.
- **Tipo de pessoa**:
  - Pessoa física → CPF;
  - Pessoa jurídica → CNPJ e razão social, e “Empresa” vira “Nome fantasia”.
- Erros aparecem no próprio campo (“CNPJ inválido — confira os dígitos.”),
  e nada é gravado enquanto houver erro.
- Textos em `Br.*` (`src/custom/i18n/messages/{pt,en}.json`).

Patches no core (P-005, todos marcados `FORK-PATCH(P-005)`):

| Arquivo | Mudança |
|---|---|
| `components/contacts/contact-form.tsx` | hook + seção, telefone normalizado, rótulo “Nome fantasia”, diálogo com rolagem |
| `components/contacts/contact-detail-view.tsx` | idem, mais o CPF/CNPJ no cabeçalho |
| `lib/whatsapp/wa-identity.ts` | `contactHandle` exibe o telefone com máscara BR |
| `lib/contacts/parse-contact-csv.ts` | telefone nacional brasileiro → E.164 na importação |
| `app/(dashboard)/contacts/page.tsx`, `components/inbox/conversation-list.tsx` | máscara na exibição |

Fachada nova: `src/custom/core/shared.ts` re-exporta funções puras do core
(`parseInternationalPhone`), para que código usado no servidor e no
navegador (como `phone.ts`) não precise importar `client.ts`/`server.ts`.

## 7. Testes

| Arquivo | Cobre |
|---|---|
| `src/modules/br/documents.test.ts` | CPF válido/inválido (dígito, sequência repetida, tamanho, letras); 200 CPFs gerados por um algoritmo independente; CNPJ válido/inválido, inclusive **alfanumérico**; máscaras |
| `src/modules/br/phone.test.ts` | telefone brasileiro (celular, fixo, tronco, operadora, DDI sem `+`), **sem DDD não é aceito**, DDD inexistente; **internacionais** (+1, +44, +351, +54) aceitos em conta BR e não BR; conta não BR mantém a regra do upstream; exibição |
| `src/modules/br/profile.test.ts` | CEP, UFs, provedor de CEP, conversão formulário ↔ linha (sem máscara), validação, conteúdo da migration (validadores, CNPJ alfanumérico, trigger de tenant, RLS, idempotência) |

A suíte do upstream roda com locale `en` (região US), então o comportamento
do upstream para telefones continua coberto pelos testes originais.

## 8. Limitações e próximos passos

- **`/api/v1` e MCP** não expõem os dados cadastrais. Exigiria um recurso
  novo (`GET/PUT /api/v1/contacts/{id}/br-profile`) com escopo próprio, sem
  mudar o contrato atual.
- **CSV**: colunas `cpf`, `cnpj` e endereço ainda não são importadas, só o
  telefone é normalizado.
- **Busca** por CPF/CNPJ na lista de contatos ainda não existe (o índice já existe).
- **Aviso de documento repetido** na conta (sem bloquear) ainda não existe.
- **Entidade Empresa** (uma PJ com vários contatos e negócios) seria uma
  tabela `br_companies` com `contacts` apontando para ela.
- **Mesclagem de duplicados** (`merge_duplicate_contacts`, migration 022 do
  upstream): não conhece a tabela nova. Se for executada de novo, os dados
  cadastrais do contato descartado se perdem. Hoje ela só roda na migration.
- **Inscrição estadual/municipal, regime tributário**: fora do escopo;
  entrariam como colunas da mesma tabela.
- **Campos personalizados já existentes** chamados “CPF” ou “CEP” podem ser
  migrados uma vez por SQL. Exemplo para CPF:

  ```sql
  INSERT INTO br_contact_profiles (contact_id, account_id, person_type, tax_id)
  SELECT v.contact_id, c.account_id, 'PF', regexp_replace(v.value, '\D', '', 'g')
  FROM contact_custom_values v
  JOIN custom_fields f ON f.id = v.custom_field_id
  JOIN contacts c ON c.id = v.contact_id
  WHERE lower(f.field_name) = 'cpf'
    AND br_is_valid_cpf(regexp_replace(v.value, '\D', '', 'g'))
  ON CONFLICT (contact_id) DO NOTHING;
  ```
