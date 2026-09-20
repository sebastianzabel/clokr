// Phase 257 (GitHub issue #257) — the privacy direction of the team calendar's absence bars.
//
// AC-5: "a person with role EMPLOYEE gets NO type colour and NO type name for a foreign entry.
// That is the direction that hurts when it breaks — the other one fails visibly."
//
// Why this lives in $lib and not next to the page: apps/web/vitest.config.ts registers no
// `$app/*` alias, and routes/(app)/team/leave/+page.svelte imports `{ page } from "$app/stores"`,
// so that file cannot be mounted here. A predicate left inside the page is untestable. The
// route file's WIRING to this module is pinned separately by
// src/__tests__/team-leave-type-visibility.test.ts (Plan 257-02).

import { describe, it, expect } from "vitest";
import {
  canSeeLeaveType,
  resolveChipVisual,
  LEAVE_TYPES,
  LEAVE_TYPE_OPTIONS,
  NEUTRAL_CHIP_LABEL,
  type ChipEntry,
} from "../team-calendar-visibility";

// ── Table 1: canSeeLeaveType(isOwn, role) over roles x ownership ──────────────
describe("canSeeLeaveType", () => {
  const cases: { isOwn: boolean; role: string | null | undefined; expected: boolean }[] = [
    { isOwn: false, role: "EMPLOYEE", expected: false }, // THE assertion that matters (AC-5 / D-02)
    { isOwn: false, role: undefined, expected: false },
    { isOwn: false, role: null, expected: false },
    { isOwn: false, role: "", expected: false },
    { isOwn: false, role: "employee", expected: false }, // lowercase must NOT pass; exact comparison
    { isOwn: false, role: "MANAGER", expected: true },
    { isOwn: false, role: "ADMIN", expected: true },
    { isOwn: true, role: "EMPLOYEE", expected: true },
    { isOwn: true, role: undefined, expected: true },
    { isOwn: true, role: "MANAGER", expected: true },
    { isOwn: true, role: "ADMIN", expected: true },
  ];

  it("the case table itself is non-empty and covers both outcomes", () => {
    // A table that silently emptied (e.g. a bad refactor) must fail this test, not pass quietly.
    expect(cases.length).toBeGreaterThan(0);
    expect(cases.some((c) => c.expected === false)).toBe(true);
    expect(cases.some((c) => c.expected === true)).toBe(true);
  });

  for (const { isOwn, role, expected } of cases) {
    it(`isOwn=${isOwn} role=${JSON.stringify(role)} => ${expected}`, () => {
      expect(canSeeLeaveType(isOwn, role)).toBe(expected);
    });
  }
});

// ── Table 2: resolveChipVisual(entry, role) over roles x ownership x type x status ──
describe("resolveChipVisual", () => {
  const statuses = ["APPROVED", "PENDING"] as const;

  for (const type of LEAVE_TYPES) {
    for (const status of statuses) {
      const typeName = `GEHEIM-${type.code}`;

      it(`EMPLOYEE, foreign ${type.code}/${status} — no colour, no label, no leak`, () => {
        const entry: ChipEntry = { typeCode: type.code, typeName, status, isOwn: false };
        const visual = resolveChipVisual(entry, "EMPLOYEE");

        expect(visual.typeLabel).toBeNull();
        expect(visual.chipLabel).toBe(NEUTRAL_CHIP_LABEL);
        expect(visual.background).toBe(
          status === "APPROVED" ? "var(--leave-type-absent)" : "var(--leave-type-absent-muted)",
        );
        expect(visual.background).not.toContain(type.colorVar);
        expect(JSON.stringify(visual)).not.toContain(typeName);
      });

      it(`MANAGER, foreign ${type.code}/${status} — colour and label visible`, () => {
        const entry: ChipEntry = { typeCode: type.code, typeName, status, isOwn: false };
        const visual = resolveChipVisual(entry, "MANAGER");

        expect(visual.typeLabel).toBe(typeName);
        expect(visual.chipLabel).toBe(typeName);
        expect(visual.background).toBe(`var(${type.colorVar})`);
        expect(visual.textColor).toBe(`var(${type.colorVar}-text, #ffffff)`);
      });

      it(`ADMIN, foreign ${type.code}/${status} — colour and label visible`, () => {
        const entry: ChipEntry = { typeCode: type.code, typeName, status, isOwn: false };
        const visual = resolveChipVisual(entry, "ADMIN");

        expect(visual.typeLabel).toBe(typeName);
        expect(visual.chipLabel).toBe(typeName);
        expect(visual.background).toBe(`var(${type.colorVar})`);
        expect(visual.textColor).toBe(`var(${type.colorVar}-text, #ffffff)`);
      });

      it(`EMPLOYEE, own ${type.code}/${status} — always visible`, () => {
        const entry: ChipEntry = { typeCode: type.code, typeName, status, isOwn: true };
        const visual = resolveChipVisual(entry, "EMPLOYEE");

        expect(visual.typeLabel).toBe(typeName);
        expect(visual.chipLabel).toBe(typeName);
        expect(visual.background).toBe(`var(${type.colorVar})`);
        expect(visual.textColor).toBe(`var(${type.colorVar}-text, #ffffff)`);
      });
    }
  }

  // ── Edge cases ──────────────────────────────────────────────────────────────
  it("typeCode null, ADMIN, own entry — no crash, no colour (pre-backfill row)", () => {
    const entry: ChipEntry = { typeCode: null, typeName: null, status: "APPROVED", isOwn: true };
    const visual = resolveChipVisual(entry, "ADMIN");

    expect(visual.typeLabel).toBeNull();
    expect(visual.chipLabel).toBe(NEUTRAL_CHIP_LABEL);
    expect(visual.background).toBe("var(--leave-type-absent)");
  });

  it("typeName null falls back to the LEAVE_TYPES label, never the raw code or 'abwesend'", () => {
    const entry: ChipEntry = { typeCode: "SICK", typeName: null, status: "APPROVED", isOwn: false };
    const visual = resolveChipVisual(entry, "MANAGER");

    expect(visual.chipLabel).toBe("Krankmeldung");
    expect(visual.chipLabel).not.toBe("SICK");
    expect(visual.chipLabel).not.toBe(NEUTRAL_CHIP_LABEL);
  });
});

// ── Data tables themselves ─────────────────────────────────────────────────────
describe("LEAVE_TYPE_OPTIONS", () => {
  it("reproduces the page's former TYPE_OPTIONS exactly — nine requestable codes, same order", () => {
    expect(LEAVE_TYPE_OPTIONS.map((t) => t.code)).toEqual([
      "VACATION",
      "OVERTIME_COMP",
      "SPECIAL",
      "EDUCATION",
      "SICK",
      "SICK_CHILD",
      "UNPAID",
      "MATERNITY",
      "PARENTAL",
    ]);
  });

  it("does not contain HOLIDAY", () => {
    expect(LEAVE_TYPE_OPTIONS.some((t) => t.code === "HOLIDAY")).toBe(false);
  });
});

describe("LEAVE_TYPES", () => {
  it("contains HOLIDAY with requestable: false", () => {
    const holiday = LEAVE_TYPES.find((t) => t.code === "HOLIDAY");
    expect(holiday).toBeDefined();
    expect(holiday?.requestable).toBe(false);
  });

  it("every entry's colorVar starts with --leave-type-", () => {
    for (const type of LEAVE_TYPES) {
      expect(type.colorVar.startsWith("--leave-type-")).toBe(true);
    }
  });
});
