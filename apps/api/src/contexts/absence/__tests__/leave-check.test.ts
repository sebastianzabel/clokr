import { describe, it, expect, vi } from "vitest";
import type { Prisma } from "@clokr/db";
import { hasApprovedLeaveOnDate } from "../leave-check";

/**
 * Pure unit test for `hasApprovedLeaveOnDate` — no `buildApp()`, no database, mirrors
 * `leave-type.test.ts`'s style. Covers BOTH branches of the function:
 *  - Phase 98b (D-01): the MATERNITY/PARENTAL Absence branch (`:47`) — the two DISPLAY_NAME
 *    lookups that replaced the ternary Phase 98b folded away.
 *  - Phase 100B plan 02 (D-05, D-09/R4): the LeaveRequest branch (`:28`), which today returns
 *    the tenant-EDITABLE `leaveType.name` — untested until this plan, despite being the branch
 *    D-05 changes in plan 100B-14 to return the stable `LeaveTypeCode` instead. Also pins branch
 *    ordering: `hasApprovedLeaveOnDate` returns early on a LeaveRequest match (`:28`), so when
 *    both a LeaveRequest and a qualifying Absence would match the same day, the LeaveRequest wins.
 */
function stubPrisma(
  opts: {
    leaveRequest?: { leaveTypeName: string; status: "APPROVED" | "CANCELLATION_REQUESTED" } | null;
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
            ? { leaveType: { name: leaveRequest.leaveTypeName }, status: leaveRequest.status }
            : null,
        ),
    },
    absence: {
      findFirst: vi.fn().mockResolvedValue(absenceType === null ? null : { type: absenceType }),
    },
  } as unknown as Prisma.TransactionClient;
}

describe("hasApprovedLeaveOnDate — MATERNITY/PARENTAL Absence branch (Phase 98b, D-01)", () => {
  it("returns 'Mutterschutz' for a MATERNITY absence row", async () => {
    const result = await hasApprovedLeaveOnDate(
      stubPrisma({ absenceType: "MATERNITY" }),
      "emp-1",
      "2026-09-15",
    );
    expect(result).toEqual({ type: "Mutterschutz", status: "APPROVED" });
  });

  it("returns 'Elternzeit' for a PARENTAL absence row", async () => {
    const result = await hasApprovedLeaveOnDate(
      stubPrisma({ absenceType: "PARENTAL" }),
      "emp-1",
      "2026-09-15",
    );
    expect(result).toEqual({ type: "Elternzeit", status: "APPROVED" });
  });

  it("returns null when neither a LeaveRequest nor a MATERNITY/PARENTAL Absence exists", async () => {
    const result = await hasApprovedLeaveOnDate(stubPrisma({}), "emp-1", "2026-09-15");
    expect(result).toBeNull();
  });
});

describe("hasApprovedLeaveOnDate — LeaveRequest branch (Phase 100B plan 02, D-05 pre-change)", () => {
  it("returns the tenant-editable leaveType.name for an APPROVED LeaveRequest — TODAY's behaviour", async () => {
    // TODO(100b-14): D-05 changes the LeaveRequest branch (`leave-check.ts:28`) to return the
    // stable `LeaveTypeCode` instead of this tenant-editable display name. This assertion is
    // EXPECTED to change under that plan — it exists so the change is a visible diff on a named
    // test, not a silent one (CONTEXT.md D-05).
    const result = await hasApprovedLeaveOnDate(
      stubPrisma({
        leaveRequest: { leaveTypeName: "Erholungsurlaub (neu)", status: "APPROVED" },
      }),
      "emp-1",
      "2026-09-15",
    );
    expect(result).toEqual({ type: "Erholungsurlaub (neu)", status: "APPROVED" });
  });

  it("returns status 'CANCELLATION_REQUESTED' for a LeaveRequest under cancellation (R4)", async () => {
    // services/clock/resolver.ts:39 consumes only `.status` to block clock-in during § 8 BUrlG
    // leave; nothing pinned this at the query level before this plan (clock-in-resolver.test.ts
    // does not exist — RESEARCH.md's assumption A5 was wrong; presence.test.ts only tests the
    // pure resolvePresenceState with data handed to it, never this query).
    const result = await hasApprovedLeaveOnDate(
      stubPrisma({
        leaveRequest: { leaveTypeName: "Urlaub", status: "CANCELLATION_REQUESTED" },
      }),
      "emp-1",
      "2026-09-15",
    );
    expect(result).toEqual({ type: "Urlaub", status: "CANCELLATION_REQUESTED" });
  });

  it("prefers the LeaveRequest branch over a matching MATERNITY Absence on the same day (branch ordering)", async () => {
    // leave-check.ts returns early at :28 on a LeaveRequest match — that ordering is behaviour,
    // not incidental. If both a LeaveRequest and a qualifying Absence exist for the same day, the
    // LeaveRequest answer wins and the Absence branch is never reached.
    const result = await hasApprovedLeaveOnDate(
      stubPrisma({
        leaveRequest: { leaveTypeName: "Urlaub", status: "APPROVED" },
        absenceType: "MATERNITY",
      }),
      "emp-1",
      "2026-09-15",
    );
    expect(result).toEqual({ type: "Urlaub", status: "APPROVED" });
  });
});
