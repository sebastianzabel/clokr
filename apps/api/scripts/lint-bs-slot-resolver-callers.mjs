#!/usr/bin/env node
/**
 * lint:bs-slot-callers — Phase 83 CD-1 invariant guard.
 *
 * The Phase 83 architecture mandates that resolveBsTagSlot() is the SINGLE
 * function in the codebase that reads the 4-layer slot config hierarchy.
 * If anything else (a route handler, a util, a script) directly references
 *   tenantConfig.bsSlotFirstLongDayMinutes
 *   tenantConfig.bsSlotSecondLongDayMinutes
 *   tenantConfig.bsSlotShortDayMinutes
 *   tenantConfig.bsSlotBlockWeekMinutes
 *   tenantConfig.vocationalSchoolMinutesPerDay
 *   tenantConfig.vocationalSchoolBlockMinutesPerWeek
 * (the same applies to .findUnique/findFirst `select: { ... }` projections)
 * the build fails — that PR must route through the resolver.
 *
 * Exit codes:
 *   0 — no offending references OR all are in the allowlist
 *   1 — references found outside the allowlist
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const FORBIDDEN_TOKENS = [
  "bsSlotFirstLongDayMinutes",
  "bsSlotSecondLongDayMinutes",
  "bsSlotShortDayMinutes",
  "bsSlotBlockWeekMinutes",
  "vocationalSchoolMinutesPerDay",
  "vocationalSchoolBlockMinutesPerWeek",
];

// Allowlist: files that are PERMITTED to reference the tokens above.
// Every entry here has an explicit justification — adding to this list
// requires a PR description explaining why the direct read is necessary.
//
// - bs-slot-resolver.ts: the ONLY allowed reader (single resolver, CD-1 core)
// - vocational-school-constants.ts: defines the legacy defaults (numeric constants only)
// - vocational-school-saldo.ts: legacy compat path (removed when workEventModelLive flips for ALL tenants)
// - work-event.ts: routes through resolver as transient adapter (combineBsAndWorkOnSameDay slotType param)
// - jarbschg.ts: reads via resolveSlotClassification helper (Plan 03 Task 2 slot-aware §9)
// - settings.ts: WRITE path with Zod validation bounds (T-83-02 mitigation)
// - employees.ts: WRITE path with Zod validation bounds (T-83-02 mitigation)
// - vocational-school-pattern.ts: WRITE path with Zod validation bounds (T-83-02 mitigation)
// - migrate-bs-to-work-event.ts: Phase 80 one-shot operator migration script
// - reresolve-work-event-minutes.ts: Plan 04 forward operator script
// - rollback-reresolve-work-event.ts: Plan 04 inverse rollback script
// - admin/system/+page.svelte: UI banner reads cfg.bsSlot* for CD-5 fallback transparency
// - arbzg.ts: reads vocationalSchoolMinutesPerDay for the ArbZG §3 BS-day 24-week rolling avg
//   check (legacy Absence-based path — see Phase 63 D-05..D-08). NOT a slot resolver bypass:
//   arbzg.ts uses the Absence model (hasBsOnDate), not the WorkEvent slot resolver. This is a
//   separate concern (ArbZG rolling average, not per-slot credit). Phase 83 SUMMARY CD-6 note.
// - shifts.ts: contains the token only in a JSDoc comment (not actual field read)
const ALLOWLIST = [
  "apps/api/src/utils/bs-slot-resolver.ts",
  "apps/api/src/utils/vocational-school-constants.ts",
  "apps/api/src/utils/vocational-school-saldo.ts",
  "apps/api/src/utils/work-event.ts",
  "apps/api/src/utils/jarbschg.ts",
  "apps/api/src/utils/arbzg.ts",
  "apps/api/src/routes/settings.ts",
  "apps/api/src/routes/employees.ts",
  "apps/api/src/routes/vocational-school-pattern.ts",
  "apps/api/src/routes/shifts.ts",
  "apps/api/scripts/migrate-bs-to-work-event.ts",
  "apps/api/scripts/reresolve-work-event-minutes.ts",
  "apps/api/scripts/rollback-reresolve-work-event.ts",
  "apps/web/src/routes/(app)/admin/system/+page.svelte",
];

// Allowlist prefixes: entire directories where direct reads are permitted.
// Test files need direct DB reads for test fixtures and assertion.
const ALLOWLIST_PREFIXES = [
  "apps/api/src/__tests__/",
  "apps/api/src/utils/__tests__/",
  "apps/api/scripts/__tests__/",
];

// Use git ls-files for deterministic walk (avoids node_modules, dist, .svelte-kit).
const repoRoot = execSync("git rev-parse --show-toplevel").toString().trim();
const files = execSync(
  "git ls-files 'apps/**/*.ts' 'apps/**/*.svelte' 'apps/**/*.mjs'",
  { cwd: repoRoot },
)
  .toString()
  .split("\n")
  .filter((f) => f.trim().length > 0);

const violations = [];
for (const relFile of files) {
  // Skip allowlisted files (exact path match)
  if (ALLOWLIST.includes(relFile)) continue;
  // Skip allowlisted directory prefixes (test dirs)
  if (ALLOWLIST_PREFIXES.some((p) => relFile.startsWith(p))) continue;
  // Skip this lint script itself
  if (relFile === "apps/api/scripts/lint-bs-slot-resolver-callers.mjs") continue;

  const content = readFileSync(join(repoRoot, relFile), "utf-8");
  for (const token of FORBIDDEN_TOKENS) {
    if (content.includes(token)) {
      violations.push({ file: relFile, token });
    }
  }
}

if (violations.length === 0) {
  console.log("lint:bs-slot-callers — OK (0 violations)");
  process.exit(0);
}

console.error(
  "lint:bs-slot-callers — CD-1 invariant violation: legacy/slot config tokens read outside the allowlist.",
);
console.error(
  "All slot-config reads MUST route through resolveBsTagSlot() in apps/api/src/utils/bs-slot-resolver.ts.",
);
console.error(
  "If this file legitimately needs direct access, add it to ALLOWLIST in apps/api/scripts/lint-bs-slot-resolver-callers.mjs with a justification comment.",
);
for (const v of violations) {
  console.error(`  ${v.file}: ${v.token}`);
}
process.exit(1);
