// Phase 201 (GitHub issue #201, defects B + C) — source-read pin for the ½-day checkbox guard
// and the request-dialog eyebrow on both leave create forms.
//
// Why source-read: `apps/web/vitest.config.ts` deliberately registers no `$app/*` aliases (see
// its own docblock), so `+page.svelte` files that `import { page } from "$app/stores"` cannot be
// mounted in a test. The thing under test here is a rendering CONDITION (disabled attribute +
// German hint text) and a German label derivation, not behaviour — the same technique as
// `leave-page-vocabulary.test.ts` and `admin-employee-detail-disabled-field-visibility.test.ts`.
//
// The backend guards at `apps/api/src/routes/leave.ts:402/1610/1784` (EFZG §3/§4 — teilweise
// Arbeitsunfähigkeit gibt es nicht) remain the sole authority. This test asserts only that the
// UI stops walking into them — it is the second line of defence, never the first.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

function readRouteFile(relativeFromHere: string, relativeFromCwd: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(relativeFromHere, import.meta.url)), "utf8");
  } catch {
    return readFileSync(resolve(process.cwd(), relativeFromCwd), "utf8");
  }
}

const EMP_PAGE = readRouteFile(
  "../routes/(app)/leave/+page.svelte",
  "src/routes/(app)/leave/+page.svelte",
);

const TEAM_PAGE = readRouteFile(
  "../routes/(app)/team/leave/+page.svelte",
  "src/routes/(app)/team/leave/+page.svelte",
);

describe("leave half-day sick guard + eyebrow (Phase 201, defects B + C)", () => {
  it("Test 1 (C): the request dialog eyebrow names the selected type, not a fixed 'Urlaub'", () => {
    expect(EMP_PAGE).not.toContain('eyebrow="Urlaub"');
    expect(EMP_PAGE).toContain("eyebrow={typeName(formType)}");
  });

  it("Test 2 (B): the ½-day checkbox is disabled — with the reason printed — in both create forms", () => {
    expect(EMP_PAGE).toContain("disabled={SICK_TYPE_CODES.has(formType)}");
    expect(EMP_PAGE).toContain("Halbe Kranktage sind nicht zulässig");
    expect(TEAM_PAGE).toContain("disabled={SICK_CODES.includes(createForm.type)}");
    expect((TEAM_PAGE.match(/Halbe Kranktage sind nicht zulässig/g) ?? []).length).toBe(2);
  });

  it("Test 3 (B): the checkbox is DISABLED, never HIDDEN — the label text survives in both files", () => {
    expect((EMP_PAGE.match(/Halber Tag/g) ?? []).length).toBe(1);
    expect((TEAM_PAGE.match(/Halber Tag/g) ?? []).length).toBe(2);
  });

  it("Test 4 (B): a ticked box cannot survive a switch to a sickness type in either form", () => {
    expect(EMP_PAGE).toContain("if (SICK_TYPE_CODES.has(formType)) formHalfDay = false;");
    expect(TEAM_PAGE).toContain(
      "if (SICK_CODES.includes(createForm.type)) createForm.halfDay = false;",
    );
  });

  it("Test 5: SICK_TYPE_CODES is a Set — never misused with .includes()", () => {
    expect(EMP_PAGE).not.toContain("SICK_TYPE_CODES.includes");
  });
});
