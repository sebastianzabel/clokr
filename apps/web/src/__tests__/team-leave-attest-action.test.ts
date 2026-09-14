// Phase 201 (GitHub issue #201) — source-read pin for the "Attest erfassen/ändern" row action
// and its dedicated dialog on the team leave page.
//
// Why source-read: `apps/web/vitest.config.ts` deliberately registers no `$app/*` aliases (see
// its own docblock), so `+page.svelte` files that `import { page } from "$app/stores"` cannot be
// mounted in a test. The mountable half of this change (the extracted Attest field markup) is
// covered by `lib/components/leave/__tests__/AttestFields.test.ts`; this file pins the parts
// that only exist in the route page — the row action, the dedicated modal, and that the new
// action calls exactly one endpoint (never `/correct`, never a Begründung).

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

const PAGE = readRouteFile(
  "../routes/(app)/team/leave/+page.svelte",
  "src/routes/(app)/team/leave/+page.svelte",
);

describe("team leave page — Attest row action + dedicated dialog (Phase 201)", () => {
  it("Test 1: an Attest button, gated on SICK_CODES + APPROVED, renders in the action cell", () => {
    expect(PAGE).toContain("data-testid={`leave-team-row-${req.id}-attest`}");
    // It sits inside the APPROVED branch, after the "Korrigieren" button, and is itself
    // gated on SICK_CODES.includes(req.typeCode) — not shown for non-sickness types.
    const correctIdx = PAGE.indexOf("Korrigieren");
    const attestBtnIdx = PAGE.indexOf("data-testid={`leave-team-row-${req.id}-attest`}");
    expect(correctIdx).toBeGreaterThan(-1);
    expect(attestBtnIdx).toBeGreaterThan(correctIdx);
    const between = PAGE.slice(correctIdx, attestBtnIdx);
    expect(between).toContain("SICK_CODES.includes(req.typeCode)");
  });

  it('Test 2: label reads "Attest ändern" when attestPresent, else "Attest erfassen"', () => {
    expect(PAGE).toContain('{req.attestPresent ? "Attest ändern" : "Attest erfassen"}');
  });

  it("Test 3: exactly TWO /attest PATCH call sites exist — runReview's and submitAttest's — and submitAttest carries no /correct and no reason/Begründung field", () => {
    expect((PAGE.match(/\/attest`/g) ?? []).length).toBe(2);
    const submitAttestMatch = PAGE.match(/async function submitAttest\(\)[\s\S]*?\n {2}}/);
    expect(submitAttestMatch).not.toBeNull();
    const submitAttestBody = submitAttestMatch![0];
    expect(submitAttestBody).not.toContain("/correct");
    expect(submitAttestBody.toLowerCase()).not.toContain("reason");
    expect(submitAttestBody.toLowerCase()).not.toContain("begründung");
  });

  it("Test 4: the dialog body states an Attest is recordable after the Monatsabschluss", () => {
    expect(PAGE).toContain("auch nach dem Monatsabschluss erfasst werden");
  });

  it("Test 5: runReview's D-02 comment survives verbatim — the new action does not move that call", () => {
    // The comment is WRAPPED across two source lines between "call" and "to"
    // (team/leave/+page.svelte:~727-728 at planning time). Assert each line's fragment
    // separately — a contiguous "…this call to the…" substring does NOT exist in the file
    // and would make this test permanently red. Do not reflow the comment to suit the
    // assertion.
    expect(PAGE).toContain("never wire this call");
    expect(PAGE).toContain("to the § 9 confirm flow");
  });
});
