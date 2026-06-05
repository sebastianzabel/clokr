// Vitest globalSetup file — registers @testing-library/jest-dom matchers
// (toBeInTheDocument, toHaveClass, toHaveTextContent, etc.) and applies a
// cleanup() between tests so each test starts with a fresh DOM.
//
// Wired in apps/web/vitest.config.ts via test.setupFiles.
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/svelte";

afterEach(() => {
  cleanup();
});
