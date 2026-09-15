import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";
import sveltePlugin from "eslint-plugin-svelte";
import svelteParser from "svelte-eslint-parser";
import globals from "globals";

export default [
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  ...sveltePlugin.configs["flat/recommended"],
  eslintConfigPrettier,
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        __APP_VERSION__: "readonly",
      },
    },
  },
  {
    files: ["**/*.svelte"],
    languageOptions: {
      parser: svelteParser,
      parserOptions: {
        parser: tseslint.parser,
      },
    },
    rules: {
      // SvelteKit uses goto() and href without resolve() by design
      "svelte/no-navigation-without-resolve": "off",
      "svelte/require-each-key": "warn",
      "svelte/prefer-svelte-reactivity": "off",
      "svelte/no-unused-svelte-ignore": "off",
      "@typescript-eslint/no-unused-expressions": "off",
    },
  },
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/.svelte-kit/**",
      "**/generated/**",
      "**/coverage/**",
    ],
  },
  // Type-aware rules — requires parserOptions.project
  {
    files: ["**/*.ts"],
    // Standalone scripts (not part of any app's tsconfig) opt out of
    // type-aware linting; they still get the non-type-aware rules below.
    // apps/api/vitest.*.ts live at the workspace root, outside apps/api/tsconfig.json's
    // `include: ["src/**/*"]`, so no tsconfig project covers them either (Phase 101 plan 02 —
    // discovered pre-existing when eslint was pointed at vitest.setup.ts/vitest.config.ts
    // directly for the first time; not introduced by that plan).
    ignores: [
      "apps/web/scripts/**",
      "apps/api/scripts/**",
      "packages/db/src/seed-demo.ts",
      "packages/db/src/seed.ts",
      "packages/db/src/reset-demo.ts",
      "apps/api/vitest.*.ts",
      // packages/types has no tsconfig.json of its own and isn't `include`d by any other
      // package's tsconfig either — genuinely pre-existing, this file was touched only twice in
      // its history (initial setup, a prettier-only pass) and never through lint-staged's
      // type-aware eslint step until Phase 98 removed a line from it (found while executing
      // 98-01, see 98-01-SUMMARY.md). Same "standalone, no project covers it" shape as the
      // scripts/ ignores above.
      "packages/types/src/**",
    ],
    languageOptions: {
      parserOptions: {
        project: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
    },
  },
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "no-console": ["warn", { allow: ["warn", "error"] }],
      "no-empty": "warn",
    },
  },
];
