/**
 * Phase 73-02 barrel — single import surface for every Phase 73+ spec.
 *
 * Re-exports `test`, `expect`, and the `TestTenant` type so specs use a
 * stable import path (`from "../fixtures"`) that survives future fixture
 * additions (authenticated browser context, mock SMTP, etc.) without
 * touching every spec.
 */
export { test, expect } from "./tenant";
export type { TestTenant } from "./tenant";
