import { describe, it, expect, vi } from "vitest";
import type { LeaveTypeCode, Prisma } from "@clokr/db";
import { hasApprovedLeaveOnDate } from "../leave-check";

/**
 * Pure unit test for `hasApprovedLeaveOnDate` — no `buildApp()`, no database, mirrors
 * `leave-type.test.ts`'s style. Covers BOTH branches of the function:
 *  - Phase 98b (D-01): the MATERNITY/PARENTAL Absence branch (`:47`) — `Absence.type` IS already
 *    the stable `LeaveTypeCode`, returned directly.
 *  - Phase 100B plan 02/14 (D-05, D-09/R4): the LeaveRequest branch (`:28`) — since plan 14,
 *    returns the stable `LeaveTypeCode` selected from `LeaveType.code`. This file's implementation
 *    deliberately never selects `LeaveType.name` at all (AC-4) — the fixtures below reflect that:
 *    `leaveType.code` is the only field a row carries. Also pins branch ordering:
 *    `hasApprovedLeaveOnDate` returns early on a LeaveRequest match (`:28`), so when both a
 *    LeaveRequest and a qualifying Absence would match the same day, the LeaveRequest wins.
 *
 * Issue #216: the stub used to discard the `where` clause entirely (bare
 * `vi.fn().mockResolvedValue(...)`), which meant the `deletedAt: null` soft-delete guard in both
 * queries of `leave-check.ts` was unpinned — deleting it produced no red test. The stub below
 * evaluates `where` against row fixtures instead, so a dropped guard now surfaces a soft-deleted
 * row that should have stayed invisible.
 */

const EMP = "emp-1";
const DATE = "2026-09-15";

interface LeaveRequestRow {
  employeeId: string;
  deletedAt: Date | null;
  status: "APPROVED" | "CANCELLATION_REQUESTED";
  startDate: Date;
  endDate: Date;
  leaveType: { code: LeaveTypeCode | null };
}

interface AbsenceRow {
  employeeId: string;
  deletedAt: Date | null;
  type: "MATERNITY" | "PARENTAL";
  startDate: Date;
  endDate: Date;
}

type WhereClause = Record<string, unknown>;

/**
 * Deliberately NOT a Prisma reimplementation — supports exactly the operator shapes the two
 * queries in `leave-check.ts` use (scalar/null/Date equality, `in`, `lte`, `gte`). Any other
 * operator throws instead of being silently ignored, so a future query shape can't quietly
 * recreate the same vacuity one level down (Issue #216, T-216-02).
 */
function matchesWhere<T extends object>(row: T, where: WhereClause): boolean {
  const record = row as unknown as Record<string, unknown>;
  return Object.entries(where).every(([field, condition]) => {
    const value = record[field];
    if (condition instanceof Date)
      return value instanceof Date && value.getTime() === condition.getTime();
    if (condition === null || typeof condition !== "object") return value === condition;
    return Object.entries(condition as Record<string, unknown>).every(([op, opValue]) => {
      if (op === "in") return Array.isArray(opValue) && opValue.includes(value);
      if (op === "lte")
        return (
          value instanceof Date && opValue instanceof Date && value.getTime() <= opValue.getTime()
        );
      if (op === "gte")
        return (
          value instanceof Date && opValue instanceof Date && value.getTime() >= opValue.getTime()
        );
      throw new Error(
        `unsupported operator "${op}" on field "${field}" — extend matchesWhere deliberately`,
      );
    });
  });
}

function leaveRow(overrides: Partial<LeaveRequestRow> = {}): LeaveRequestRow {
  return {
    employeeId: EMP,
    deletedAt: null,
    status: "APPROVED",
    startDate: new Date("2026-09-15T00:00:00Z"),
    endDate: new Date("2026-09-15T23:59:59Z"),
    // No `name` field at all — this fixture cannot even express a "renamed LeaveType" scenario,
    // which is itself the proof that `LeaveType.name` cannot influence this branch (AC-4): the
    // query never selects it, and the stub couldn't hand it back even if it wanted to.
    leaveType: { code: "VACATION" },
    ...overrides,
  };
}

function absenceRow(overrides: Partial<AbsenceRow> = {}): AbsenceRow {
  return {
    employeeId: EMP,
    deletedAt: null,
    type: "MATERNITY",
    startDate: new Date("2026-09-15T00:00:00Z"),
    endDate: new Date("2026-09-15T23:59:59Z"),
    ...overrides,
  };
}

function stubPrisma(
  opts: { leaveRequests?: LeaveRequestRow[]; absences?: AbsenceRow[] } = {},
): Prisma.TransactionClient {
  const { leaveRequests = [], absences = [] } = opts;
  return {
    leaveRequest: {
      // `include`/`select` are ignored on purpose — the stub always hands back the whole matching
      // row; each test states only the fields the fixture builder produces.
      findFirst: vi.fn(
        async (args: { where: WhereClause }) =>
          leaveRequests.find((r) => matchesWhere(r, args.where)) ?? null,
      ),
    },
    absence: {
      findFirst: vi.fn(
        async (args: { where: WhereClause }) =>
          absences.find((r) => matchesWhere(r, args.where)) ?? null,
      ),
    },
  } as unknown as Prisma.TransactionClient;
}

describe("hasApprovedLeaveOnDate — MATERNITY/PARENTAL Absence branch (Phase 98b, D-01)", () => {
  it("returns the MATERNITY code directly for a MATERNITY absence row", async () => {
    const result = await hasApprovedLeaveOnDate(
      stubPrisma({ absences: [absenceRow({ type: "MATERNITY" })] }),
      EMP,
      DATE,
    );
    expect(result).toEqual({ code: "MATERNITY", status: "APPROVED" });
  });

  it("returns the PARENTAL code directly for a PARENTAL absence row", async () => {
    const result = await hasApprovedLeaveOnDate(
      stubPrisma({ absences: [absenceRow({ type: "PARENTAL" })] }),
      EMP,
      DATE,
    );
    expect(result).toEqual({ code: "PARENTAL", status: "APPROVED" });
  });

  it("returns null when neither a LeaveRequest nor a MATERNITY/PARENTAL Absence exists", async () => {
    const result = await hasApprovedLeaveOnDate(stubPrisma(), EMP, DATE);
    expect(result).toBeNull();
  });
});

describe("hasApprovedLeaveOnDate — LeaveRequest branch (Phase 100B plan 14, D-05)", () => {
  it("returns the stable code, sourced only from LeaveType.code — the property D-05 buys", async () => {
    // The whole point of D-05: this function must never read LeaveType.name (a tenant-editable
    // display string) to decide what it returns. The row fixture cannot even express a "renamed"
    // scenario any more — it only carries `code` — which is itself the proof: a renamed
    // LeaveType.name cannot influence this branch's answer because the query never selects it.
    const result = await hasApprovedLeaveOnDate(
      stubPrisma({
        leaveRequests: [leaveRow({ leaveType: { code: "VACATION" }, status: "APPROVED" })],
      }),
      EMP,
      DATE,
    );
    expect(result).toEqual({ code: "VACATION", status: "APPROVED" });
  });

  it("returns status 'CANCELLATION_REQUESTED' for a LeaveRequest under cancellation (R4)", async () => {
    // services/clock/resolver.ts:39 consumes only `.status` to block clock-in during § 8 BUrlG
    // leave; nothing pinned this at the query level before plan 02 (clock-in-resolver.test.ts
    // does not exist — RESEARCH.md's assumption A5 was wrong; presence.test.ts only tests the
    // pure resolvePresenceState with data handed to it, never this query).
    const result = await hasApprovedLeaveOnDate(
      stubPrisma({
        leaveRequests: [
          leaveRow({ leaveType: { code: "VACATION" }, status: "CANCELLATION_REQUESTED" }),
        ],
      }),
      EMP,
      DATE,
    );
    expect(result).toEqual({ code: "VACATION", status: "CANCELLATION_REQUESTED" });
  });

  it("prefers the LeaveRequest branch over a matching MATERNITY Absence on the same day (branch ordering)", async () => {
    // leave-check.ts returns early at :28 on a LeaveRequest match — that ordering is behaviour,
    // not incidental. If both a LeaveRequest and a qualifying Absence exist for the same day, the
    // LeaveRequest answer wins and the Absence branch is never reached.
    const result = await hasApprovedLeaveOnDate(
      stubPrisma({
        leaveRequests: [leaveRow({ leaveType: { code: "VACATION" }, status: "APPROVED" })],
        absences: [absenceRow({ type: "MATERNITY" })],
      }),
      EMP,
      DATE,
    );
    expect(result).toEqual({ code: "VACATION", status: "APPROVED" });
  });

  it("falls back to the generic OTHER code when LeaveType.code is null, rather than crashing or reading .name", async () => {
    // LeaveType.code is nullable in the schema until the Phase 97/98b post-rollout sweep's SET NOT
    // NULL lands (schema.prisma:612-613). Checked against the dev database on 2026-09-17: 5/5 rows
    // already carry a code — this path is defensive, not observed in production today. It does
    // NOT fall back to resolving the code from the row's name: `leave-type.ts`'s
    // `leaveTypeCodeForName()` is backfill-only and may not be called from a request handler, and
    // this function is called from two of them.
    const result = await hasApprovedLeaveOnDate(
      stubPrisma({ leaveRequests: [leaveRow({ leaveType: { code: null }, status: "APPROVED" })] }),
      EMP,
      DATE,
    );
    expect(result).toEqual({ code: "OTHER", status: "APPROVED" });
  });
});

describe("hasApprovedLeaveOnDate — soft-deleted rows are invisible (Issue #216)", () => {
  it("returns null for a soft-deleted LeaveRequest row with no absence row present", async () => {
    const result = await hasApprovedLeaveOnDate(
      stubPrisma({ leaveRequests: [leaveRow({ deletedAt: new Date("2026-09-01T00:00:00Z") })] }),
      EMP,
      DATE,
    );
    expect(result).toBeNull();
  });

  it("falls through to a matching MATERNITY Absence when the LeaveRequest row is soft-deleted", async () => {
    // This is the case that fails loudly (VACATION instead of MATERNITY) if the leaveRequest
    // query's `deletedAt: null` guard is dropped — the deleted row would still win over the
    // Absence branch via branch ordering.
    const result = await hasApprovedLeaveOnDate(
      stubPrisma({
        leaveRequests: [leaveRow({ deletedAt: new Date("2026-09-01T00:00:00Z") })],
        absences: [absenceRow({ type: "MATERNITY" })],
      }),
      EMP,
      DATE,
    );
    expect(result).toEqual({ code: "MATERNITY", status: "APPROVED" });
  });

  it("returns null for a soft-deleted MATERNITY Absence row with no LeaveRequest present", async () => {
    const result = await hasApprovedLeaveOnDate(
      stubPrisma({ absences: [absenceRow({ deletedAt: new Date("2026-09-01T00:00:00Z") })] }),
      EMP,
      DATE,
    );
    expect(result).toBeNull();
  });
});

describe("stub matcher", () => {
  it("throws on an unsupported operator instead of silently ignoring it", () => {
    expect(() => matchesWhere(leaveRow(), { startDate: { not: new Date() } })).toThrow(
      /unsupported operator "not" on field "startDate"/,
    );
  });

  it("is not vacuously true: a row for a different employeeId yields null", async () => {
    const result = await hasApprovedLeaveOnDate(
      stubPrisma({ leaveRequests: [leaveRow({ employeeId: "emp-2" })] }),
      EMP,
      DATE,
    );
    expect(result).toBeNull();
  });

  it("is not vacuously true: a row whose endDate lies before the queried day yields null", async () => {
    const result = await hasApprovedLeaveOnDate(
      stubPrisma({
        leaveRequests: [leaveRow({ endDate: new Date("2026-09-14T23:59:59Z") })],
      }),
      EMP,
      DATE,
    );
    expect(result).toBeNull();
  });
});
