import { describe, it, expect, vi } from "vitest";
import { getCurrentShift } from "../utils/get-current-shift";

// ── helpers ───────────────────────────────────────────────────────────────────

function makePrisma(shiftOrNull: object | null) {
  return {
    shift: {
      findFirst: vi.fn().mockResolvedValue(shiftOrNull),
    },
  } as unknown as Parameters<typeof getCurrentShift>[0];
}

const TZ = "Europe/Berlin";
const EMP_ID = "emp-001";

// ── tests ─────────────────────────────────────────────────────────────────────

describe("getCurrentShift", () => {
  it("REQ-10: returns null when no shift exists", async () => {
    const prisma = makePrisma(null);
    const at = new Date("2026-05-11T08:30:00Z"); // 10:30 Berlin
    const result = await getCurrentShift(prisma, EMP_ID, at, TZ);
    expect(result).toBeNull();
  });

  it("REQ-11: returns ShiftWindow with correct UTC timestamps", async () => {
    const shift = {
      id: "shift-001",
      startTime: "08:00",
      endTime: "16:30",
      employeeId: EMP_ID,
      date: new Date("2026-05-11T00:00:00Z"),
    };
    const prisma = makePrisma(shift);
    const at = new Date("2026-05-11T08:30:00Z"); // 10:30 Berlin = 2026-05-11
    const result = await getCurrentShift(prisma, EMP_ID, at, TZ);

    expect(result).not.toBeNull();
    expect(result!.shift.startTime).toBe("08:00");
    expect(result!.shift.endTime).toBe("16:30");
    // Europe/Berlin in May is UTC+2, so 08:00 Berlin = 06:00 UTC
    expect(result!.startUtc.toISOString()).toBe("2026-05-11T06:00:00.000Z");
    // 16:30 Berlin = 14:30 UTC
    expect(result!.endUtc.toISOString()).toBe("2026-05-11T14:30:00.000Z");
  });

  it("timezone boundary: 23:00 UTC maps to next calendar day in Berlin (UTC+2)", async () => {
    // 2026-05-11T23:00:00Z = 2026-05-12T01:00:00+02:00 (Berlin) → date is 2026-05-12
    const at = new Date("2026-05-11T23:00:00Z");
    const prisma = makePrisma(null);
    await getCurrentShift(prisma, EMP_ID, at, TZ);

    // Verify the query was called with 2026-05-12, not 2026-05-11
    const callArg = (prisma.shift.findFirst as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const dateStr = callArg.where.date.toISOString().slice(0, 10);
    expect(dateStr).toBe("2026-05-12");
  });

  it("startUtc is before endUtc for a normal shift", async () => {
    const shift = {
      id: "s",
      startTime: "09:00",
      endTime: "17:00",
      employeeId: EMP_ID,
      date: new Date("2026-05-11T00:00:00Z"),
    };
    const prisma = makePrisma(shift);
    const result = await getCurrentShift(prisma, EMP_ID, new Date("2026-05-11T08:00:00Z"), TZ);
    expect(result!.startUtc < result!.endUtc).toBe(true);
  });
});
