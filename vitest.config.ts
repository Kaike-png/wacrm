import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // Dummy secrets — encryption.ts / webhook-signature.ts read these
    // at module load. Tests never hit a real Meta/Supabase service, so
    // any 32-byte hex / non-empty string will do; keep them lexically
    // identical to the CI build env so behaviour matches.
    env: {
      ENCRYPTION_KEY:
        "0000000000000000000000000000000000000000000000000000000000000000",
      META_APP_SECRET: "test-meta-app-secret",
      // FORK-PATCH(P-004): the fork defaults to pt-BR / America/Sao_Paulo
      // (docs/LOCALIZATION.md); tests keep upstream's English catalogue
      // and a fixed UTC clock so they pass on any developer machine.
      NEXT_PUBLIC_APP_LOCALE: "en",
      NEXT_PUBLIC_DEFAULT_TIMEZONE: "UTC",
      TZ: "UTC",
    },
    clearMocks: true,
  },
});
