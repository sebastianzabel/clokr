// Issue #853-19 - the context line of a leave task row: the sentence rules, the permission rule (a
// fact the caller may not read is left out, never guessed) and the read cost (cached, limited).
import { describe, expect, it, vi } from "vitest";
import {
  FACT_READS_AT_ONCE,
  colleaguesSentence,
  createLeaveContextLoader,
  leaveContextLine,
  type LeaveFactReaders,
  type LeaveFactRequest,
} from "../task-row-facts";
import type { VacationEntitlementRow } from "$lib/leave/vacation-balance";
import type { LeaveOverlapEntry } from "$lib/leave/leave-review";

function entitlement(over: Partial<VacationEntitlementRow> = {}): VacationEntitlementRow {
  return {
    typeCode: "VACATION",
    leaveType: { name: "Urlaub" },
    totalDays: 30,
    usedDays: 14,
    carriedOverDays: 0,
    effectiveCarryOverDays: 0,
    carryOverDeadline: null,
    ...over,
  };
}

function overlapRow(name: string, status = "APPROVED"): LeaveOverlapEntry {
  return {
    id: `o-${name}`,
    employeeName: name,
    typeCode: null,
    typeName: null,
    startDate: "2026-12-14",
    endDate: "2026-12-18",
    status,
  } as LeaveOverlapEntry;
}

function request(over: Partial<LeaveFactRequest> = {}): LeaveFactRequest {
  return {
    id: "r1",
    employeeId: "e1",
    typeCode: "VACATION",
    status: "PENDING",
    startDate: "2026-12-14",
    endDate: "2026-12-18",
    days: 4,
    ...over,
  };
}

function readers(over: Partial<LeaveFactReaders> = {}): LeaveFactReaders {
  return {
    entitlements: vi.fn().mockResolvedValue([entitlement()]),
    overlap: vi.fn().mockResolvedValue([]),
    ...over,
  };
}

describe("colleaguesSentence", () => {
  it("says nobody else is away for an empty list", () => {
    expect(colleaguesSentence([])).toBe("niemand sonst abwesend");
  });
  it("names up to two colleagues once each, then counts the rest", () => {
    expect(colleaguesSentence(["Anna A", "Anna A"])).toBe("auch abwesend: Anna A");
    expect(colleaguesSentence(["Anna A", "Ben B"])).toBe("auch abwesend: Anna A, Ben B");
    expect(colleaguesSentence(["Anna A", "Ben B", "Cem C", "Dora D"])).toBe(
      "auch abwesend: Anna A, Ben B und 2 weitere",
    );
  });
});

describe("leaveContextLine", () => {
  it("joins the Resturlaub and the colleagues like the prototype", () => {
    expect(leaveContextLine({ remainingAfter: 11, colleagues: [] })).toBe(
      "Resturlaub danach 11 · niemand sonst abwesend",
    );
  });
  it("words a fractional rest with the German decimal comma, never a raw float", () => {
    expect(leaveContextLine({ remainingAfter: 15.420000000000002, colleagues: null })).toBe(
      "Resturlaub danach 15,42",
    );
  });
  it("leaves out what is unknown, and is null when nothing is known", () => {
    expect(leaveContextLine({ remainingAfter: null, colleagues: ["Ben B"] })).toBe(
      "auch abwesend: Ben B",
    );
    expect(leaveContextLine({ remainingAfter: null, colleagues: null })).toBeNull();
  });
});

describe("createLeaveContextLoader", () => {
  it("builds the prototype line: Resturlaub after this request and nobody else away", async () => {
    // 30 - 14 = 16 before, 4 days requested: 12 after.
    const loader = createLeaveContextLoader(readers(), { canReadEntitlement: true });
    expect(await loader.load(request())).toBe("Resturlaub danach 12 · niemand sonst abwesend");
  });

  it("names colleagues whose APPROVED absence overlaps, ignoring other statuses", async () => {
    const loader = createLeaveContextLoader(
      readers({
        overlap: vi.fn().mockResolvedValue([overlapRow("Ben B"), overlapRow("Cem C", "PENDING")]),
      }),
      { canReadEntitlement: true },
    );
    expect(await loader.load(request())).toBe("Resturlaub danach 12 · auch abwesend: Ben B");
  });

  it("without the entitlement permission it never asks and leaves the Resturlaub out", async () => {
    const r = readers();
    const loader = createLeaveContextLoader(r, { canReadEntitlement: false });
    expect(await loader.load(request())).toBe("niemand sonst abwesend");
    expect(r.entitlements).not.toHaveBeenCalled();
  });

  it("only a vacation request has a Resturlaub; a cancellation request or a year turn derives none", async () => {
    const r = readers();
    const loader = createLeaveContextLoader(r, { canReadEntitlement: true });
    expect(await loader.load(request({ id: "s", typeCode: "SICK" }))).toBe(
      "niemand sonst abwesend",
    );
    expect(await loader.load(request({ id: "c", status: "CANCELLATION_REQUESTED" }))).toBe(
      "niemand sonst abwesend",
    );
    expect(await loader.load(request({ id: "y", endDate: "2027-01-03" }))).toBe(
      "niemand sonst abwesend",
    );
    // Only the vacation request of the two that are vacation asked at all (cancel and turn do read).
    expect(r.entitlements).toHaveBeenCalledWith("e1", "2026");
  });

  it("a refused or failed read leaves its part out: no entitlement row is no guess", async () => {
    const loader = createLeaveContextLoader(
      readers({
        entitlements: vi.fn().mockRejectedValue(new Error("403")),
        overlap: vi.fn().mockRejectedValue(new Error("500")),
      }),
      { canReadEntitlement: true },
    );
    // An empty overlap list is a statement; a failed read is not one - so no "niemand sonst".
    expect(await loader.load(request())).toBeNull();
  });

  it("a person without a vacation entitlement row gets no Resturlaub, not a fake 0", async () => {
    const loader = createLeaveContextLoader(
      readers({ entitlements: vi.fn().mockResolvedValue([]) }),
      {
        canReadEntitlement: true,
      },
    );
    expect(await loader.load(request())).toBe("niemand sonst abwesend");
  });

  it("reads once per person and year and once per period, however many rows ask", async () => {
    const r = readers();
    const loader = createLeaveContextLoader(r, { canReadEntitlement: true });
    await Promise.all([
      loader.load(request({ id: "a" })),
      loader.load(request({ id: "b" })),
      loader.load(request({ id: "c", employeeId: "e2" })),
      loader.load(request({ id: "d", startDate: "2026-12-21", endDate: "2026-12-23" })),
    ]);
    expect(r.entitlements).toHaveBeenCalledTimes(2); // e1 and e2, 2026
    expect(r.overlap).toHaveBeenCalledTimes(2); // two distinct periods
  });

  it("a failed read is not cached, so a later row may try again", async () => {
    const overlap = vi.fn().mockRejectedValueOnce(new Error("503")).mockResolvedValue([]);
    const loader = createLeaveContextLoader(readers({ overlap }), { canReadEntitlement: false });
    expect(await loader.load(request())).toBeNull();
    expect(await loader.load(request())).toBe("niemand sonst abwesend");
    expect(overlap).toHaveBeenCalledTimes(2);
  });

  it("never has more than FACT_READS_AT_ONCE reads in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    const slow = async <T>(value: T): Promise<T> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return value;
    };
    const loader = createLeaveContextLoader(
      {
        entitlements: () => slow([entitlement()]),
        overlap: () => slow([] as LeaveOverlapEntry[]),
      },
      { canReadEntitlement: true },
    );
    const rows = Array.from({ length: 12 }, (_, i) =>
      request({
        id: `r${i}`,
        employeeId: `e${i}`,
        startDate: `2026-12-${String(i + 1).padStart(2, "0")}`,
        endDate: `2026-12-${String(i + 1).padStart(2, "0")}`,
      }),
    );
    const lines = await Promise.all(rows.map((r) => loader.load(r)));
    expect(lines.every((l) => l?.includes("Resturlaub danach"))).toBe(true);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(FACT_READS_AT_ONCE);
  });
});
