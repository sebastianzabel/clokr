import { defineConfig } from "vitest/config";

// Minimal Vitest config for unit tests in apps/web. Kept separate from vite.config.ts
// (which is SvelteKit-coupled) so plain .ts unit tests (e.g. src/lib/i18n/__tests__/)
// don't require the full SvelteKit transform pipeline.
export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
