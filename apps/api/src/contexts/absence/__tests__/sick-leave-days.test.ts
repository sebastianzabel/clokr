/**
 * Issue #84 (D-14) — `sickLeaveDayCounts()`, the one sick-day counting rule.
 *
 * The rule used to live privately in `composition/reports.ts` (`computeEmployeeSummary`); it moved
 * into the absence context so the monthly report and the dashboard team trend read the same
 * function. The cases below therefore mirror the report exactly: calendar days including weekends,
 * clip to the period, half day x 0.5, the attest split and the § 9 shift between the attest
 * buckets. DB-free: the kernel is pure.
 */
import { describe, it, expect } from "vitest";
import type { LeaveRequestStatus, LeaveTypeCode } from "@clokr/db";
import { sickLeaveDayCounts, type SickLeaveDayRow } from "../sick-leave-days";

const FIRST = new Date("2026-06-01T00:00:00Z");
const LAST = new Date("2026-06-30T00:00:00Z");

function d(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

function row(
  start: string,
  end: string,
  over: Partial<Omit<SickLeaveDayRow, "leaveType">> & { code?: LeaveTypeCode | null } = {},
): SickLeaveDayRow {
  const { code = "SICK", ...rest } = over;
  return {
    startDate: d(start),
    endDate: d(end),
    halfDay: false,
    status: "APPROVED" as LeaveRequestStatus,
    attestPresent: false,
    attestValidFrom: null,
    attestValidTo: null,
    leaveType: { code },
    ...rest,
  };
}

const ZERO = {
  sickDays: 0,
  sickDaysWithAttest: 0,
  sickDaysWithoutAttest: 0,
  section9DaysThisMonth: 0,
};

describe("sickLeaveDayCounts (Issue #84, D-14)", () => {
  it("counts only sick codes: VACATION and a null code contribute nothing", () => {
    const result = sickLeaveDayCounts(
      [
        row("2026-06-03", "2026-06-05", { code: "VACATION" }),
        row("2026-06-03", "2026-06-05", { code: null }),
      ],
      FIRST,
      LAST,
    );
    expect(result).toEqual(ZERO);
  });

  it("counts SICK and SICK_CHILD", () => {
    const result = sickLeaveDayCounts(
      [row("2026-06-03", "2026-06-04"), row("2026-06-10", "2026-06-10", { code: "SICK_CHILD" })],
      FIRST,
      LAST,
    );
    expect(result).toEqual({
      sickDays: 3,
      sickDaysWithAttest: 0,
      sickDaysWithoutAttest: 3,
      section9DaysThisMonth: 0,
    });
  });

  it("counts APPROVED and CANCELLATION_REQUESTED but not PENDING, REJECTED or CANCELLED", () => {
    const counted = sickLeaveDayCounts(
      [
        row("2026-06-01", "2026-06-01", { status: "APPROVED" }),
        row("2026-06-02", "2026-06-02", { status: "CANCELLATION_REQUESTED" }),
      ],
      FIRST,
      LAST,
    );
    expect(counted.sickDays).toBe(2);

    const ignored = sickLeaveDayCounts(
      [
        row("2026-06-03", "2026-06-03", { status: "PENDING" }),
        row("2026-06-04", "2026-06-04", { status: "REJECTED" }),
        row("2026-06-05", "2026-06-05", { status: "CANCELLED" }),
      ],
      FIRST,
      LAST,
    );
    expect(ignored).toEqual(ZERO);
  });

  it("counts calendar days including Saturday and Sunday", () => {
    // Fri 12.06. - Sun 14.06.2026
    const result = sickLeaveDayCounts([row("2026-06-12", "2026-06-14")], FIRST, LAST);
    expect(result.sickDays).toBe(3);
  });

  it("clips a range to the period and counts a row entirely outside as 0", () => {
    const result = sickLeaveDayCounts(
      [
        row("2026-05-29", "2026-06-02"), // June part: 01.-02.
        row("2026-06-29", "2026-07-03"), // June part: 29.-30.
        row("2026-05-01", "2026-05-31"), // before the period
        row("2026-07-01", "2026-07-02"), // after the period
      ],
      FIRST,
      LAST,
    );
    expect(result.sickDays).toBe(4);
  });

  it("multiplies the row's clipped count by 0.5 for a half day", () => {
    const result = sickLeaveDayCounts(
      [row("2026-06-10", "2026-06-10", { halfDay: true })],
      FIRST,
      LAST,
    );
    expect(result).toEqual({
      sickDays: 0.5,
      sickDaysWithAttest: 0,
      sickDaysWithoutAttest: 0.5,
      section9DaysThisMonth: 0,
    });
  });

  it("splits by attest: window intersected with the request, rest without attest", () => {
    // 15.-18.06., attest 16.-17.06. -> 2 with, 2 without
    const partial = sickLeaveDayCounts(
      [
        row("2026-06-15", "2026-06-18", {
          attestPresent: true,
          attestValidFrom: d("2026-06-16"),
          attestValidTo: d("2026-06-17"),
        }),
      ],
      FIRST,
      LAST,
    );
    expect(partial).toEqual({
      sickDays: 4,
      sickDaysWithAttest: 2,
      sickDaysWithoutAttest: 2,
      section9DaysThisMonth: 0,
    });

    // attest window wider than the request: everything attested, nothing negative
    const wide = sickLeaveDayCounts(
      [
        row("2026-06-15", "2026-06-16", {
          attestPresent: true,
          attestValidFrom: d("2026-06-01"),
          attestValidTo: d("2026-06-30"),
        }),
      ],
      FIRST,
      LAST,
    );
    expect(wide.sickDaysWithAttest).toBe(2);
    expect(wide.sickDaysWithoutAttest).toBe(0);
  });

  it("treats attestPresent without validity dates as fully attested", () => {
    const result = sickLeaveDayCounts(
      [row("2026-06-15", "2026-06-17", { attestPresent: true })],
      FIRST,
      LAST,
    );
    expect(result).toEqual({
      sickDays: 3,
      sickDaysWithAttest: 3,
      sickDaysWithoutAttest: 0,
      section9DaysThisMonth: 0,
    });
  });

  it("moves min(without, credited) from without to with attest for a § 9 credit", () => {
    const rows = [row("2026-06-08", "2026-06-10")];
    const result = sickLeaveDayCounts(rows, FIRST, LAST, {
      section9Credits: [{ creditedStart: d("2026-06-09"), creditedEnd: d("2026-06-09") }],
    });
    expect(result).toEqual({
      sickDays: 3,
      sickDaysWithAttest: 1,
      sickDaysWithoutAttest: 2,
      section9DaysThisMonth: 1,
    });
  });

  it("clips § 9 credits to the period and never shifts more than the without-attest bucket holds", () => {
    // Fully attested request: nothing is left in the without bucket to shift, the sum stays.
    const attested = sickLeaveDayCounts(
      [row("2026-06-09", "2026-06-10", { attestPresent: true })],
      FIRST,
      LAST,
      { section9Credits: [{ creditedStart: d("2026-06-09"), creditedEnd: d("2026-06-10") }] },
    );
    expect(attested.sickDays).toBe(2);
    expect(attested.sickDaysWithAttest).toBe(2);
    expect(attested.sickDaysWithoutAttest).toBe(0);
    expect(attested.section9DaysThisMonth).toBe(2);

    // A credit reaching into May counts only its June part.
    const clipped = sickLeaveDayCounts([], FIRST, LAST, {
      section9Credits: [{ creditedStart: d("2026-05-30"), creditedEnd: d("2026-06-02") }],
    });
    expect(clipped.section9DaysThisMonth).toBe(2);
    expect(clipped.sickDays).toBe(0);
  });

  it("keeps sickDays equal to sickDaysWithAttest + sickDaysWithoutAttest in every case", () => {
    const rows = [
      row("2026-06-03", "2026-06-05"),
      row("2026-06-10", "2026-06-10", { halfDay: true }),
      row("2026-06-12", "2026-06-14"),
      row("2026-06-15", "2026-06-18", {
        attestPresent: true,
        attestValidFrom: d("2026-06-16"),
        attestValidTo: d("2026-06-17"),
      }),
    ];
    const result = sickLeaveDayCounts(rows, FIRST, LAST, {
      section9Credits: [{ creditedStart: d("2026-06-04"), creditedEnd: d("2026-06-05") }],
    });
    expect(result.sickDays).toBe(result.sickDaysWithAttest + result.sickDaysWithoutAttest);
  });

  it("counts two overlapping sick rows on the same day twice (no de-duplication, mirrors the report)", () => {
    const result = sickLeaveDayCounts(
      [row("2026-06-03", "2026-06-03"), row("2026-06-03", "2026-06-03", { code: "SICK_CHILD" })],
      FIRST,
      LAST,
    );
    expect(result.sickDays).toBe(2);
  });

  describe("countsDay predicate", () => {
    it("restricts a range to the days the predicate accepts", () => {
      const result = sickLeaveDayCounts([row("2026-06-03", "2026-06-05")], FIRST, LAST, {
        countsDay: (day) => day === "2026-06-03",
      });
      expect(result.sickDays).toBe(1);
    });

    it("applies the predicate to the attest window and the § 9 credit ranges too", () => {
      const accept = (day: string) => day >= "2026-06-04" && day <= "2026-06-05";
      const result = sickLeaveDayCounts(
        [
          row("2026-06-03", "2026-06-06", {
            attestPresent: true,
            attestValidFrom: d("2026-06-03"),
            attestValidTo: d("2026-06-04"),
          }),
        ],
        FIRST,
        LAST,
        {
          section9Credits: [{ creditedStart: d("2026-06-05"), creditedEnd: d("2026-06-06") }],
          countsDay: accept,
        },
      );
      // total = 4.-5. = 2 days; attest window 3.-4. -> only the 4. is accepted = 1 with, 1 without;
      // credit 5.-6. -> only the 5. is accepted = 1 day, which moves from without to with.
      expect(result).toEqual({
        sickDays: 2,
        sickDaysWithAttest: 2,
        sickDaysWithoutAttest: 0,
        section9DaysThisMonth: 1,
      });
    });

    it("keeps the half-day factor under a predicate", () => {
      const result = sickLeaveDayCounts(
        [row("2026-06-03", "2026-06-04", { halfDay: true })],
        FIRST,
        LAST,
        { countsDay: (day) => day === "2026-06-03" },
      );
      expect(result.sickDays).toBe(0.5);
    });

    it("yields exactly the predicate-free result when it accepts every day", () => {
      const fixtures: Array<{
        rows: SickLeaveDayRow[];
        credits: Array<{ creditedStart: Date; creditedEnd: Date }>;
      }> = [
        { rows: [], credits: [] },
        { rows: [row("2026-06-03", "2026-06-05")], credits: [] },
        { rows: [row("2026-05-29", "2026-06-02"), row("2026-06-29", "2026-07-03")], credits: [] },
        { rows: [row("2026-06-10", "2026-06-12", { halfDay: true })], credits: [] },
        {
          rows: [
            row("2026-06-15", "2026-06-18", {
              attestPresent: true,
              attestValidFrom: d("2026-06-16"),
              attestValidTo: d("2026-06-17"),
            }),
            row("2026-06-20", "2026-06-21", { attestPresent: true }),
          ],
          credits: [],
        },
        {
          rows: [row("2026-06-08", "2026-06-10"), row("2026-06-09", "2026-06-09")],
          credits: [
            { creditedStart: d("2026-06-09"), creditedEnd: d("2026-06-09") },
            { creditedStart: d("2026-05-31"), creditedEnd: d("2026-06-01") },
          ],
        },
        {
          rows: [
            row("2026-06-22", "2026-06-22", { status: "CANCELLATION_REQUESTED" }),
            row("2026-06-24", "2026-06-24", { status: "PENDING" }),
            row("2026-06-25", "2026-06-25", { code: "VACATION" }),
          ],
          credits: [],
        },
      ];
      expect(fixtures.length).toBeGreaterThanOrEqual(6);
      for (const { rows, credits } of fixtures) {
        const plain = sickLeaveDayCounts(rows, FIRST, LAST, { section9Credits: credits });
        const withPredicate = sickLeaveDayCounts(rows, FIRST, LAST, {
          section9Credits: credits,
          countsDay: () => true,
        });
        expect(withPredicate).toEqual(plain);
      }
    });
  });
});
