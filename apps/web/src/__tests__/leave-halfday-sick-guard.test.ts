// Phase 201 (GitHub issue #201, defects B + C) — source-read pin for the ½-day checkbox guard
// and the request-dialog eyebrow.
//
// Why source-read: `apps/web/vitest.config.ts` deliberately registers no `$app/*` aliases (see
// its own docblock), so `+page.svelte` files that `import { page } from "$app/stores"` cannot be
// mounted in a test. The thing under test here is a rendering CONDITION (disabled attribute +
// German hint text) and a German label derivation, not behaviour — the same technique as
// `leave-page-vocabulary.test.ts` and `admin-employee-detail-disabled-field-visibility.test.ts`.
//
// The backend guards at `apps/api/src/contexts/absence/api/leave.ts:402/1610/1784` (EFZG §3/§4 — partial
// incapacity to work does not exist as a legal concept) remain the sole authority. This test
// asserts only that the UI stops walking into them — it is the second line of defence, never
// the first.
//
// Phase 415 (GitHub issue #415): before this phase, `/leave` and `/team/leave` carried TWO
// separate copies of this guard (its own `formType`/`formHalfDay` fields on the employee page,
// `createForm.type`/`createForm.halfDay` on the team page) — this file used to pin both
// separately. The create/edit dialog is now ONE shared component,
// `lib/components/leave/LeaveRequestForm.svelte`, used by both pages, so there is only one guard
// left to pin. `/team/leave` keeps a SEPARATE, still page-owned "Korrektur"-Modal (manager
// corrects an already-APPROVED request, `correctType`/`correctHalfDay`) — out of Phase 415's
// scope (CONTEXT.md, deferred) — which is why TEAM_PAGE still appears below for that one flow.

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

const SHARED_FORM = readRouteFile(
  "../lib/components/leave/LeaveRequestForm.svelte",
  "src/lib/components/leave/LeaveRequestForm.svelte",
);

describe("leave half-day sick guard + eyebrow (Phase 201, defects B + C)", () => {
  it("Test 1 (C): the shared create/edit dialog's eyebrow names the selected type, not a fixed 'Urlaub'", () => {
    expect(SHARED_FORM).not.toContain('eyebrow="Urlaub"');
    expect(SHARED_FORM).toContain("eyebrow={typeName(formType)}");
    // Neither page renders its own eyebrow any more — both delegate to the shared component
    // (Phase 415).
    expect(EMP_PAGE).not.toContain("eyebrow={typeName(formType)}");
    expect(TEAM_PAGE).not.toContain("eyebrow={typeName(createForm.type)}");
  });

  it("Test 2 (B): the ½-day checkbox is disabled — with the reason printed — in the shared dialog AND the still-separate Korrektur-Modal", () => {
    expect(SHARED_FORM).toContain("disabled={SICK_TYPE_CODES.has(formType)}");
    expect(SHARED_FORM).toContain("Halbe Kranktage sind nicht zulässig");
    // TEAM_PAGE's own remaining occurrence is the Korrektur-Modal (out of Phase 415's scope), not
    // a second copy of the create dialog.
    expect(TEAM_PAGE).toContain("disabled={SICK_CODES.includes(correctType)}");
    expect((TEAM_PAGE.match(/Halbe Kranktage sind nicht zulässig/g) ?? []).length).toBe(1);
  });

  it("Test 3 (B): the checkbox is DISABLED, never HIDDEN — the label text survives in the shared dialog and the Korrektur-Modal", () => {
    expect((SHARED_FORM.match(/Halber Tag/g) ?? []).length).toBe(1);
    expect((TEAM_PAGE.match(/Halber Tag/g) ?? []).length).toBe(1);
    // Neither page's create path carries its own copy of the label any more.
    expect((EMP_PAGE.match(/Halber Tag/g) ?? []).length).toBe(0);
  });

  it("Test 4 (B): a ticked box cannot survive a switch to a sickness type — the shared dialog's guard, and the Korrektur-Modal's separate one", () => {
    expect(SHARED_FORM).toContain("if (SICK_TYPE_CODES.has(formType)) formHalfDay = false;");
    // The Korrektur-Modal's own guard, unrelated to the shared create/edit dialog.
    expect(TEAM_PAGE).toContain("if (SICK_CODES.includes(correctType)) correctHalfDay = false;");
    // The redundant per-page copies of the CREATE guard are gone — proof the extraction did not
    // leave a stray, now-dead duplicate behind.
    expect(TEAM_PAGE).not.toContain(
      "if (SICK_CODES.includes(createForm.type)) createForm.halfDay = false;",
    );
  });

  it("Test 5: SICK_TYPE_CODES is a Set — never misused with .includes()", () => {
    expect(SHARED_FORM).not.toContain("SICK_TYPE_CODES.includes");
    expect(EMP_PAGE).not.toContain("SICK_TYPE_CODES.includes");
  });
});
