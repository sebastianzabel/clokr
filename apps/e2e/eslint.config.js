import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

// Phase 73 D-06: ban page.waitForTimeout at lint time.
// The message documents the deterministic replacements that should be used instead,
// so authors don't have to guess which API call belongs where.
const NO_WAIT_FOR_TIMEOUT_MESSAGE = [
  "page.waitForTimeout() is banned (Phase 73 D-06).",
  "Use a deterministic wait instead:",
  "  - await expect(locator).toBeVisible() / .toHaveCount() / .toContainText()",
  "  - await page.waitForResponse(predicate)",
  "  - await page.waitForLoadState('networkidle')",
  "  - await page.getByTestId('id').waitFor()",
  "If you genuinely need a delay (e.g. animation cooldown), use page.clock.fastForward()",
  "or restructure the assertion to wait on the post-condition.",
].join(" ");

export default [
  {
    ignores: ["**/node_modules/**", "**/playwright-report/**", "**/test-results/**"],
  },
  {
    files: ["**/*.ts"],
    // Don't warn on inline `eslint-disable-next-line foo` comments where rule `foo` is not
    // configured here — they may target the root workspace config (which layers no-console,
    // no-floating-promises, etc.) and are still useful even if this config doesn't enable them.
    linterOptions: {
      reportUnusedDisableDirectives: false,
    },
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          // Matches `page.waitForTimeout(...)`, `this.page.waitForTimeout(...)`, etc.
          selector: "CallExpression[callee.property.name='waitForTimeout']",
          message: NO_WAIT_FOR_TIMEOUT_MESSAGE,
        },
      ],
    },
  },
  {
    // Allow the rule itself + config to reference the banned identifier as a string.
    files: ["eslint.config.js"],
    rules: {
      "no-restricted-syntax": "off",
    },
  },
];
