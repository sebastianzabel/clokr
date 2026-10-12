// Issue #87 (D-02/D-05/D-06/D-13) — the web side of the clock salon choice is presentation of the
// server's answer only. Pure functions: which view the clock card shows, what the preselection is
// and what the clock-in body carries.
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiGet = vi.fn();
const loggerWarn = vi.fn();

vi.mock("$api/client", () => ({
  api: { get: (...args: unknown[]) => apiGet(...args) },
  ApiError: class extends Error {
    constructor(
      public status: number,
      message = "err",
    ) {
      super(message);
    }
  },
}));
vi.mock("$lib/utils/logger", () => ({
  clientLogger: { warn: (...args: unknown[]) => loggerWarn(...args), error: vi.fn() },
}));

import { ApiError } from "$api/client";
import {
  clockInBlocked,
  clockInBody,
  clockSalonView,
  initialClockSalonSelection,
  loadClockSalonChoice,
  type ClockSalonChoice,
} from "../clock-salon";

const A = { id: `a-${crypto.randomUUID()}`, name: "Salon Nord" };
const B = { id: `b-${crypto.randomUUID()}`, name: "Salon Ost" };

function choice(over: Partial<ClockSalonChoice> = {}): ClockSalonChoice {
  return { offerChoice: true, preselectedSalonId: B.id, salons: [A, B], fixedSalon: null, ...over };
}

beforeEach(() => {
  apiGet.mockReset();
  loggerWarn.mockReset();
});

describe("clock-salon (Issue #87)", () => {
  it("tracer: an offered choice on an idle day is a select view, preselected, and the body carries the chosen salon", () => {
    const view = clockSalonView(choice(), "idle");
    expect(view).toEqual({ kind: "select", salons: [A, B] });
    expect(initialClockSalonSelection(choice())).toBe(B.id);
    expect(clockInBody(view, A.id)).toEqual({ source: "MOBILE", salonId: A.id });
  });

  it("clockSalonView is none for a null choice and for offerChoice false", () => {
    expect(clockSalonView(null, "idle")).toEqual({ kind: "none" });
    expect(clockSalonView(choice({ offerChoice: false, salons: [] }), "idle")).toEqual({
      kind: "none",
    });
  });

  it("clockSalonView never offers the select on a running or finished day", () => {
    expect(clockSalonView(choice(), "running")).toEqual({ kind: "none" });
    expect(clockSalonView(choice(), "finished")).toEqual({ kind: "none" });
  });

  it("clockSalonView names the fixed salon only on a non-idle day", () => {
    const fixed = choice({ offerChoice: false, salons: [], fixedSalon: B });
    expect(clockSalonView(fixed, "running")).toEqual({ kind: "fixed", salon: B });
    expect(clockSalonView(fixed, "finished")).toEqual({ kind: "fixed", salon: B });
    expect(clockSalonView(fixed, "idle")).toEqual({ kind: "none" });
  });

  it("initialClockSalonSelection is null without a preselection or with one that is not offered", () => {
    expect(initialClockSalonSelection(choice({ preselectedSalonId: null }))).toBeNull();
    expect(initialClockSalonSelection(choice({ preselectedSalonId: "elsewhere" }))).toBeNull();
    expect(initialClockSalonSelection(null)).toBeNull();
  });

  it("clockInBody omits salonId for none and fixed views (exactly the key source)", () => {
    expect(Object.keys(clockInBody({ kind: "none" }, A.id))).toEqual(["source"]);
    expect(Object.keys(clockInBody({ kind: "fixed", salon: B }, A.id))).toEqual(["source"]);
  });

  it("clockInBody never sends a null selection or an id outside the offered list", () => {
    const view = clockSalonView(choice(), "idle");
    expect(Object.keys(clockInBody(view, null))).toEqual(["source"]);
    expect(Object.keys(clockInBody(view, "not-offered"))).toEqual(["source"]);
  });

  it("clockInBlocked is true only for a select view without a valid selection", () => {
    const view = clockSalonView(choice(), "idle");
    expect(clockInBlocked(view, null)).toBe(true);
    expect(clockInBlocked(view, "not-offered")).toBe(true);
    expect(clockInBlocked(view, A.id)).toBe(false);
    expect(clockInBlocked({ kind: "none" }, null)).toBe(false);
    expect(clockInBlocked({ kind: "fixed", salon: B }, null)).toBe(false);
  });

  it("loadClockSalonChoice returns the server body on success", async () => {
    apiGet.mockResolvedValueOnce(choice());
    await expect(loadClockSalonChoice()).resolves.toEqual(choice());
    expect(apiGet).toHaveBeenCalledWith("/time-entries/clock-salon");
  });

  it("loadClockSalonChoice fails open to null and logs a 500 once", async () => {
    apiGet.mockRejectedValueOnce(new ApiError(500, "boom"));
    await expect(loadClockSalonChoice()).resolves.toBeNull();
    expect(loggerWarn).toHaveBeenCalledTimes(1);
  });

  it("loadClockSalonChoice fails open to null on a 403 without logging", async () => {
    apiGet.mockRejectedValueOnce(new ApiError(403, "forbidden"));
    await expect(loadClockSalonChoice()).resolves.toBeNull();
    expect(loggerWarn).not.toHaveBeenCalled();
  });
});
