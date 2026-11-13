// Issue #599 (Phase 851): the web client of the month-correction request only files and reads; the
// newest request of a day is the one shown, and a refusal is read by its code, never by its text.
import { describe, expect, it, vi } from "vitest";

vi.mock("$api/client", async () => {
  class ApiError extends Error {
    constructor(
      public status: number,
      message: string,
      public data?: unknown,
    ) {
      super(message);
    }
  }
  return { ApiError, api: { get: vi.fn(), post: vi.fn() } };
});

import { api, ApiError } from "$api/client";
import {
  correctionForDay,
  listOwnMonthCorrections,
  MONTH_CORRECTION_STATUS_LABEL,
  refusalCode,
  type MonthCorrection,
} from "../month-corrections";

function req(over: Partial<MonthCorrection>): MonthCorrection {
  return {
    id: "r",
    targetDate: "2026-10-06",
    startTime: null,
    endTime: null,
    breakMinutes: null,
    reason: "Einstempeln vergessen",
    status: "PENDING",
    isOwn: true,
    reviewNote: null,
    correctionMinutes: null,
    bookingDate: null,
    canWithdraw: true,
    createdAt: "2026-11-01T10:00:00Z",
    ...over,
  };
}

describe("month corrections (web)", () => {
  it("picks the newest request of the day", () => {
    const list = [
      req({ id: "old", status: "REJECTED", createdAt: "2026-11-01T10:00:00Z" }),
      req({ id: "new", status: "PENDING", createdAt: "2026-11-03T10:00:00Z" }),
      req({ id: "other", targetDate: "2026-10-07", createdAt: "2026-11-05T10:00:00Z" }),
    ];
    expect(correctionForDay(list, "2026-10-06")?.id).toBe("new");
    expect(correctionForDay(list, "2026-10-08")).toBeNull();
  });

  it("reads a refusal by its code", () => {
    expect(refusalCode(new ApiError(409, "x", { code: "MONTH_NOT_CLOSED" }))).toBe(
      "MONTH_NOT_CLOSED",
    );
    expect(refusalCode(new ApiError(500, "x"))).toBeNull();
    expect(refusalCode(new Error("x"))).toBeNull();
  });

  it("answers an empty list while the route is absent, and rethrows anything else", async () => {
    vi.mocked(api.get).mockRejectedValueOnce(new ApiError(404, "x"));
    expect(await listOwnMonthCorrections()).toEqual([]);
    vi.mocked(api.get).mockRejectedValueOnce(new ApiError(500, "x"));
    await expect(listOwnMonthCorrections()).rejects.toBeInstanceOf(ApiError);
  });

  it("names every status", () => {
    const labels = Object.values(MONTH_CORRECTION_STATUS_LABEL);
    expect(labels.length).toBeGreaterThan(0);
    for (const l of labels) expect(l.length).toBeGreaterThan(0);
  });
});
