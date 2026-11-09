import adapter from "@sveltejs/adapter-node";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter(),
    // Issue #849 (6): SvelteKit's own registration has no `.catch`, so a failing registration was
    // an unhandled rejection on every page load. The root layout registers the push worker itself
    // (`$lib/push/register-service-worker.ts`), catching and reporting a failure once per session.
    serviceWorker: { register: false },
    alias: {
      $lib: "./src/lib",
      $components: "./src/lib/components",
      $stores: "./src/lib/stores",
      $api: "./src/lib/api",
      // Phase 76 — colocated component tests import { renderWithTheme } from
      // "$tests/test-utils". Mirror the vitest.config.ts alias here so tsc
      // (driven by .svelte-kit/tsconfig.json paths) resolves the same.
      $tests: "./src/__tests__",
    },
  },
};

export default config;
