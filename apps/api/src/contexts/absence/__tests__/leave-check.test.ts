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
 *    deliberately never selects `LeaveType.name` at all (AC-4) — the fixture below reflects that:
 *    `leaveTypeCode` is the only field the stub's mocked `findFirst` resolves. Also pins branch
 *    ordering: `hasApprovedLeaveOnDate` returns early on a LeaveRequest match (`:28`), so when
 *    both a LeaveRequest and a qualifying Absence would match the same day, the LeaveRequest wins.
 */
function stubPrisma(
  opts: {
    leaveRequest?: {
      leaveTypeCode: LeaveTypeCode | null;
      status: "APPROVED" | "CANCELLATION_REQUESTED";
    } | null;
    absenceType?: "MATERNITY" | "PARENTAL" | null;
  } = {},
): Prisma.TransactionClient {
  const { leaveRequest = null, absenceType = null } = opts;
  return {
    leaveRequest: {
      findFirst: vi
        .fn()
        .mockResolvedValue(
          leaveRequest
            ? { leaveType: { code: leaveRequest.leaveTypeCode }, status: leaveRequest.status }
            : null,
        ),
    },
    absence: {
      findFirst: vi.fn().mockResolvedValue(absenceType === null ? null : { type: absenceType }),
    },
  } as unknown as Prisma.TransactionClient;
}

describe("hasApprovedLeaveOnDate — MATERNITY/PARENTAL Absence branch (Phase 98b, D-01)", () => {
  it("returns the MATERNITY code directly for a MATERNITY absence row", async () => {
    const result = await hasApprovedLeaveOnDate(
      stubPrisma({ absenceType: "MATERNITY" }),
      "emp-1",
      "2026-09-15",
    );
    expect(result).toEqual({ code: "MATERNITY", status: "APPROVED" });
  });

  it("returns the PARENTAL code directly for a PARENTAL absence row", async () => {
    const result = await hasApprovedLeaveOnDate(
      stubPrisma({ absenceType: "PARENTAL" }),
      "emp-1",
      "2026-09-15",
    );
    expect(result).toEqual({ code: "PARENTAL", status: "APPROVED" });
  });

  it("returns null when neither a LeaveRequest nor a MATERNITY/PARENTAL Absence exists", async () => {
    const result = await hasApprovedLeaveOnDate(stubPrisma({}), "emp-1", "2026-09-15");
    expect(result).toBeNull();
  });
});

describe("hasApprovedLeaveOnDate — LeaveRequest branch (Phase 100B plan 14, D-05)", () => {
  it("returns the stable code, sourced only from LeaveType.code — the property D-05 buys", async () => {
    // The whole point of D-05: this function must never read LeaveType.name (a tenant-editable
    // display string) to decide what it returns. The stub below cannot even express a "renamed"
    // scenario any more — it only carries `code` — which is itself the proof: a renamed
    // LeaveType.name cannot influence this branch's answer because the query never selects it.
    const result = await hasApprovedLeaveOnDate(
      stubPrisma({ leaveRequest: { leaveTypeCode: "VACATION", status: "APPROVED" } }),
      "emp-1",
      "2026-09-15",
    );
    expect(result).toEqual({ code: "VACATION", status: "APPROVED" });
  });

  it("returns status 'CANCELLATION_REQUESTED' for a LeaveRequest under cancellation (R4)", async () => {
    // services/clock/resolver.ts:39 consumes only `.status` to block clock-in during § 8 BUrlG
    // leave; nothing pinned this at the query level before plan 02 (clock-in-resolver.test.ts
    // does not exist — RESEARCH.md's assumption A5 was wrong; presence.test.ts only tests the
    // pure resolvePresenceState with data handed to it, never this query).
    const result = await hasApprovedLeaveOnDate(
      stubPrisma({ leaveRequest: { leaveTypeCode: "VACATION", status: "CANCELLATION_REQUESTED" } }),
      "emp-1",
      "2026-09-15",
    );
    expect(result).toEqual({ code: "VACATION", status: "CANCELLATION_REQUESTED" });
  });

  it("prefers the LeaveRequest branch over a matching MATERNITY Absence on the same day (branch ordering)", async () => {
    // leave-check.ts returns early at :28 on a LeaveRequest match — that ordering is behaviour,
    // not incidental. If both a LeaveRequest and a qualifying Absence exist for the same day, the
    // LeaveRequest answer wins and the Absence branch is never reached.
    const result = await hasApprovedLeaveOnDate(
      stubPrisma({
        leaveRequest: { leaveTypeCode: "VACATION", status: "APPROVED" },
        absenceType: "MATERNITY",
      }),
      "emp-1",
      "2026-09-15",
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
      stubPrisma({ leaveRequest: { leaveTypeCode: null, status: "APPROVED" } }),
      "emp-1",
      "2026-09-15",
    );
    expect(result).toEqual({ code: "OTHER", status: "APPROVED" });
  });
});
