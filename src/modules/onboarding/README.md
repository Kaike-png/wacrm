# `src/modules/onboarding` — assistente de configuração inicial

Fluxo pós-cadastro em `/onboarding` (4 etapas + resumo), progresso em
`onboarding_progress` (migration 904) e o redirecionamento do dono de uma
organização nova a partir de `/dashboard` (patch P-007).

Mesmas regras de `src/modules/br`: core via `@/custom/core/*`,
componentes/hooks de UI do core liberados. Strings em `Custom.onboarding.*`.

Decisões e fluxo em [`docs/ONBOARDING.md`](../../../docs/ONBOARDING.md).
