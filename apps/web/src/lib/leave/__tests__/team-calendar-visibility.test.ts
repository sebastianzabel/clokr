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
  SICK_CODES,
  resolveDayDetailRows,
  type ChipEntry,
  type DayDetailEntry,
} from "../team-calendar-visibility";
import { showsBurlgSection7Notice } from "../leave-review";

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

// Phase 255 (GitHub issue #255) — SICK_CODES hoisted here from team/leave/+page.svelte's local
// constant so /inbox (which never had it) can share it too. This group ADDS to the file; nothing
// above is rewritten.
describe("SICK_CODES", () => {
  it("has exactly two members, both real vocabulary codes", () => {
    expect(SICK_CODES.length).toBe(2);
    const allCodes = LEAVE_TYPES.map((t) => t.code);
    for (const code of SICK_CODES) {
      expect(allCodes).toContain(code);
    }
  });

  it(
    "is disjoint from the BUrlG § 7 notice gate — expressed against the function, not the " +
      "string literal 'VACATION', so this stays true if the § 7 set ever changes again",
    () => {
      for (const code of SICK_CODES) {
        expect(showsBurlgSection7Notice(code)).toBe(false);
      }
    },
  );
});

// ── GitHub issue #265 — the tapped day's absences, spelled out ────────────────
//
// Below 700px the bar's type label is hidden, so the type was carried by COLOUR ALONE. The
// remedy is a tap that reveals the type as text. That text is produced here, which makes this the
// place where the #257 role rule must hold a second time: a detail sheet naming a colleague's
// "Kinderkrank" to an EMPLOYEE would be a worse leak than the bug it fixes.
describe("resolveDayDetailRows (#265)", () => {
  function entry(over: Partial<DayDetailEntry> = {}): DayDetailEntry {
    return {
      id: "row-1",
      firstName: "A.",
      lastName: "B.",
      typeCode: "SICK",
      typeName: "Krankmeldung",
      status: "APPROVED",
      isOwn: false,
      ...over,
    };
  }

  // THE pair from the ticket: #d97706 against #ea580c is the hardest colour discrimination on
  // this calendar, so it is the pair the text must separate.
  const sickPair: DayDetailEntry[] = [
    entry({ id: "r1", firstName: "Eins", typeCode: "SICK", typeName: "Krankmeldung" }),
    entry({ id: "r2", firstName: "Zwei", typeCode: "SICK_CHILD", typeName: "Kinderkrank" }),
  ];

  it("MANAGER: Krank and Kinderkrank come back as two DIFFERENT words, not two colours", () => {
    const rows = resolveDayDetailRows(sickPair, "MANAGER");
    expect(rows).toHaveLength(2); // anti-vacuity: the mapping actually produced lines
    expect(rows[0].typeLabel).toBe("Krankmeldung");
    expect(rows[1].typeLabel).toBe("Kinderkrank");
    expect(rows[0].typeLabel).not.toBe(rows[1].typeLabel);
    // And the distinction does not depend on the swatch, which is the whole point.
    expect(rows[0].background).not.toBe(rows[1].background);
  });

  it("ADMIN sees the types too", () => {
    const rows = resolveDayDetailRows(sickPair, "ADMIN");
    expect(rows.map((r) => r.typeLabel)).toEqual(["Krankmeldung", "Kinderkrank"]);
  });

  it("EMPLOYEE, colleague's rows: BOTH read the neutral word and NEITHER names a sickness", () => {
    const rows = resolveDayDetailRows(sickPair, "EMPLOYEE");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.typeLabel)).toEqual([NEUTRAL_CHIP_LABEL, NEUTRAL_CHIP_LABEL]);
    const everything = JSON.stringify(rows);
    expect(everything).not.toContain("Krank");
    expect(everything).not.toContain("SICK");
    // Identical neutral fills: an EMPLOYEE must not be able to tell the two apart by swatch
    // either, which would reintroduce the leak through the back door.
    expect(rows[0].background).toBe(rows[1].background);
  });

  it("EMPLOYEE, own row: the type IS named — the rule is about colleagues, not about secrecy", () => {
    const rows = resolveDayDetailRows([entry({ isOwn: true })], "EMPLOYEE");
    expect(rows[0].typeLabel).toBe("Krankmeldung");
  });

  it("no role at all (undefined/null) is treated as an EMPLOYEE — the safe side", () => {
    for (const role of [undefined, null, "", "SOMETHING_NEW"]) {
      const rows = resolveDayDetailRows(sickPair, role);
      expect(rows.map((r) => r.typeLabel)).toEqual([NEUTRAL_CHIP_LABEL, NEUTRAL_CHIP_LABEL]);
    }
  });

  it("carries the full name, the pending flag and the paired foreground", () => {
    const rows = resolveDayDetailRows(
      [entry({ firstName: "Vor", lastName: "Nach", status: "PENDING", isOwn: true })],
      "EMPLOYEE",
    );
    expect(rows[0].name).toBe("Vor Nach");
    expect(rows[0].isPending).toBe(true);
    expect(rows[0].textColor).toContain("-text");
  });

  it("CANCELLATION_REQUESTED counts as pending, exactly as the bar's modifier class does", () => {
    const rows = resolveDayDetailRows(
      [entry({ status: "CANCELLATION_REQUESTED", isOwn: true })],
      "EMPLOYEE",
    );
    expect(rows[0].isPending).toBe(true);
  });

  it("an empty day yields no rows (the sheet's empty state is reachable)", () => {
    expect(resolveDayDetailRows([], "ADMIN")).toEqual([]);
  });
});
