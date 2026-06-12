// Phase 78 Plan 04 — D-03 Zero-hits gate (TEST-V19-01)
//
// CONTEXT D-03 ("Strict grep VOCATIONAL_SCHOOL zero-hits Merge-Gate"):
// ALLE uses müssen den enum-import nutzen
// (AbsenceType.VOCATIONAL_SCHOOL / WorkEventType.VOCATIONAL_SCHOOL),
// nicht den string literal. KEIN __tests__/ exemption — Task 0
// hat die fixtures bereits migriert.
//
// Allowed sites (whitelist):
//   - apps/api/src/utils/work-event*.ts (canonical adapter — comment-only literal allowed)
//   - apps/api/scripts/migrate-bs-to-work-event.ts (Phase 80 migration script — forward-compat)
//   - apps/api/src/__tests__/work-event-type-boundary.test.ts (Phase 79-05 — the
//     literal type union `"VOCATIONAL_SCHOOL" | ...` IS the canonical type
//     contract being asserted via expectTypeOf; runtime payload values use
//     literals because `WorkEventType` in `@clokr/types` is a type alias,
//     not a runtime enum)
//
// This file constructs the forbidden literal via string concatenation so the test
// source itself does not contain the literal (which would self-trip the gate).

import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

// Construct the literal via concat so the test source itself stays clean.
const FORBIDDEN_LITERAL = '"' + "VOCATIONAL" + "_SCHOOL" + '"';

function safeGrep(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, { cwd, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
  } catch {
    // execSync may throw on non-zero exit — but our "; true" prevents this.
    return "";
  }
}

describe("D-03 Zero-hits gate (CONTEXT Phase 78) — TEST-V19-01", () => {
  const repoRoot = resolve(process.cwd(), "../..");

  it("no quoted string literal of Berufsschule type anywhere in apps/api/src/ outside whitelist", () => {
    const cmd = [
      `grep -rn ${JSON.stringify(FORBIDDEN_LITERAL)} apps/api/src/`,
      `--include="*.ts"`,
      `| grep -v "src/utils/work-event"`,
      `| grep -v "src/__tests__/zero-hits-vocational-school-gate.test.ts"`,
      `| grep -v "src/__tests__/work-event-type-boundary.test.ts"`,
      `; true`,
    ].join(" ");
    const output = safeGrep(cmd, repoRoot).trim();
    expect(
      output,
      `\n\nD-03 violation (Phase 78 CONTEXT — user-ratified scope, no __tests__ exemption) — source files contain the forbidden quoted Berufsschule literal.\n` +
        `Use the enum form instead: \`AbsenceType.VOCATIONAL_SCHOOL\` or \`WorkEventType.VOCATIONAL_SCHOOL\`.\n\n` +
        `Whitelisted sites (ONLY):\n` +
        `  - apps/api/src/utils/work-event*.ts (canonical adapter)\n` +
        `  - apps/api/scripts/migrate-bs-to-work-event.ts (Phase 80, forward-compat)\n` +
        `  - apps/api/src/__tests__/work-event-type-boundary.test.ts (Phase 79-05 type contract)\n\n` +
        `Offending lines:\n${output}\n`,
    ).toBe("");
  });

  it("no forbidden literal in apps/api/src/plugins/ (Phase 78 refactor sanity check)", () => {
    const cmd = `grep -rn ${JSON.stringify(FORBIDDEN_LITERAL)} apps/api/src/plugins/ --include="*.ts" ; true`;
    const output = safeGrep(cmd, repoRoot).trim();
    expect(output, `Phase 78 refactor regression in apps/api/src/plugins/:\n${output}`).toBe("");
  });

  it("no forbidden literal in apps/api/src/routes/ (Phase 78 refactor sanity check)", () => {
    const cmd = `grep -rn ${JSON.stringify(FORBIDDEN_LITERAL)} apps/api/src/routes/ --include="*.ts" ; true`;
    const output = safeGrep(cmd, repoRoot).trim();
    expect(output, `Phase 78 refactor regression in apps/api/src/routes/:\n${output}`).toBe("");
  });
});
