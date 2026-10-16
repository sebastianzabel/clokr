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
  fixedSalonNoteLabel,
  initialClockSalonSelection,
  loadClockSalonChoice,
  otherSalonBlocked,
  otherSalonName,
  otherSalonOptions,
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

// Issue #70 (Phase 70b-06, D-02/D-11): a FINISHED day offers a second salon. The server names the
// salon a plain re-clock continues (`fixedSalon`) and the salons OTHER than it (`salons`); the web
// only renders that and attaches a salon to the request for the other-salon action alone.
describe("clock-salon — second salon on a finished day (Issue #70)", () => {
  const C = { id: `c-${crypto.randomUUID()}`, name: "Salon West" };
  /** The server's answer on a finished day with one entry in A: the others are offered. */
  const finishedOffer = choice({
    offerChoice: true,
    preselectedSalonId: B.id,
    salons: [B, C],
    fixedSalon: A,
  });

  it("tracer: a finished day with an offer is a fixed view that also carries the offered salons", () => {
    expect(clockSalonView(finishedOffer, "finished")).toEqual({
      kind: "fixed",
      salon: A,
      others: [B, C],
    });
  });

  it("a running day never carries the offer, even if a stale answer still holds one", () => {
    expect(clockSalonView(finishedOffer, "running")).toEqual({ kind: "fixed", salon: A });
  });

  it("a finished day without an offer is the plain fixed view, exactly as before #70", () => {
    const noOffer = choice({ offerChoice: false, salons: [], fixedSalon: A });
    expect(clockSalonView(noOffer, "finished")).toEqual({ kind: "fixed", salon: A });
    expect(Object.keys(clockSalonView(noOffer, "finished")).sort()).toEqual(["kind", "salon"]);
  });

  it("an offer without a named fixed salon renders nothing (single-salon tenants have none)", () => {
    expect(clockSalonView(choice({ fixedSalon: null }), "finished")).toEqual({ kind: "none" });
  });

  it("otherSalonOptions lists the offer for the finished view and is empty for every other view", () => {
    expect(otherSalonOptions(clockSalonView(finishedOffer, "finished"))).toEqual([B, C]);
    expect(otherSalonOptions(clockSalonView(finishedOffer, "running"))).toEqual([]);
    expect(otherSalonOptions({ kind: "none" })).toEqual([]);
    expect(otherSalonOptions({ kind: "select", salons: [A, B] })).toEqual([]);
  });

  it("clockInBody sends exactly the chosen offered id for the other-salon action", () => {
    const view = clockSalonView(finishedOffer, "finished");
    expect(clockInBody(view, C.id, "otherSalon")).toEqual({ source: "MOBILE", salonId: C.id });
  });

  it("clockInBody sends no salon for „Erneut einstempeln“, for a non-offered id and for null", () => {
    const view = clockSalonView(finishedOffer, "finished");
    expect(Object.keys(clockInBody(view, C.id, "reopen"))).toEqual(["source"]);
    expect(Object.keys(clockInBody(view, A.id, "otherSalon"))).toEqual(["source"]); // the fixed salon is not offered
    expect(Object.keys(clockInBody(view, "not-offered", "otherSalon"))).toEqual(["source"]);
    expect(Object.keys(clockInBody(view, null, "otherSalon"))).toEqual(["source"]);
    // The default action stays the idle start: a finished view never carries a salon through it.
    expect(Object.keys(clockInBody(view, C.id))).toEqual(["source"]);
  });

  it("the idle and running views are unchanged: the start action carries the select, reopen never", () => {
    const idle = clockSalonView(choice(), "idle");
    expect(clockInBody(idle, A.id, "start")).toEqual({ source: "MOBILE", salonId: A.id });
    expect(Object.keys(clockInBody(idle, A.id, "otherSalon"))).toEqual(["source"]);
    expect(
      Object.keys(clockInBody(clockSalonView(finishedOffer, "running"), B.id, "otherSalon")),
    ).toEqual(["source"]);
  });

  it("otherSalonBlocked is true until an offered salon is selected", () => {
    const view = clockSalonView(finishedOffer, "finished");
    expect(otherSalonBlocked(view, null)).toBe(true);
    expect(otherSalonBlocked(view, "not-offered")).toBe(true);
    expect(otherSalonBlocked(view, A.id)).toBe(true);
    expect(otherSalonBlocked(view, B.id)).toBe(false);
    expect(otherSalonBlocked({ kind: "none" }, B.id)).toBe(true);
  });

  it("the preselection of the finished-day offer is the server's pattern salon when it is offered", () => {
    expect(initialClockSalonSelection(finishedOffer)).toBe(B.id);
    expect(initialClockSalonSelection({ ...finishedOffer, preselectedSalonId: A.id })).toBeNull();
  });

  it("otherSalonName names an offered salon and nothing else", () => {
    const view = clockSalonView(finishedOffer, "finished");
    expect(otherSalonName(view, C.id)).toBe("Salon West");
    expect(otherSalonName(view, A.id)).toBeUndefined();
    expect(otherSalonName(view, null)).toBeUndefined();
  });

  it("fixedSalonNoteLabel: running names the salon it is in, several entries the last one recorded", () => {
    expect(fixedSalonNoteLabel("running", 1)).toBe("Eingestempelt in");
    expect(fixedSalonNoteLabel("running", 2)).toBe("Eingestempelt in");
    expect(fixedSalonNoteLabel("finished", 1)).toBe("Heute erfasst in");
    expect(fixedSalonNoteLabel("finished", 2)).toBe("Zuletzt erfasst in");
  });
});
