/**
 * Default opening hours of a salon — the facade constant and the seeds' own copy.
 *
 * History: Phase 64b executed the REAL text of the `20260924071637_add_salon` migration against a
 * tenant's `TenantConfig.storeHours` and proved the default salon it created. Issue #638 dropped
 * that column, so the migration's data section can no longer run (it selects the column) and those
 * proofs were removed together with it; the migration itself stays in the history unchanged.
 *
 * What remains is the one living pin that survives the column: the API facade constant
 * (`DEFAULT_SALON_OPENING_HOURS`) and the seed copy in `packages/db/src/default-salon.ts` — a
 * deliberate second copy, because `packages/db` cannot import `apps/api` — must stay equal, and the
 * constant must satisfy the canonical opening-hours schema.
 */
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  DEFAULT_SALON_OPENING_HOURS,
  salonOpeningHoursSchema,
} from "../contexts/platform/facade/salons";

// __dirname is apps/api/src/__tests__ — four levels up is the repo root.
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

describe("DEFAULT_SALON_OPENING_HOURS living assertion", () => {
  it("parses under salonOpeningHoursSchema", () => {
    expect(() => salonOpeningHoursSchema.parse(DEFAULT_SALON_OPENING_HOURS)).not.toThrow();
  });

  it("the facade constant and the seeds' own copy (packages/db/src/default-salon.ts) are byte-identical", async () => {
    // A path computed at runtime, so tsc (rootDir: ./src) does not try to compile the seed file
    // into this package — vitest still loads the real module, not a restatement of it.
    const seedModulePath = join(REPO_ROOT, "packages/db/src/default-salon.ts");
    const seedModule = (await import(seedModulePath)) as {
      DEFAULT_SALON_OPENING_HOURS: unknown;
    };

    expect(seedModule.DEFAULT_SALON_OPENING_HOURS).toEqual(DEFAULT_SALON_OPENING_HOURS);
    expect(JSON.stringify(seedModule.DEFAULT_SALON_OPENING_HOURS)).toBe(
      JSON.stringify(DEFAULT_SALON_OPENING_HOURS),
    );
  });
});
