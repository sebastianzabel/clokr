// #843 (D-843-19): the German acknowledgement texts of the start-page writes are pinned here.
import { describe, expect, it } from "vitest";
import {
  breakEnded,
  breakStarted,
  clockedIn,
  clockedOut,
  clockTime,
  correctionSaved,
  leaveRequested,
} from "../action-messages";

describe("action-messages (D-843-19)", () => {
  it("clock in names the salon only when one is known", () => {
    expect(clockedIn("10:02", "Salon Nord")).toBe("Eingestempelt 10:02 · Salon Nord");
    expect(clockedIn("10:02", null)).toBe("Eingestempelt 10:02");
    expect(clockedIn("10:02")).toBe("Eingestempelt 10:02");
    expect(clockedIn("10:02", "  ")).toBe("Eingestempelt 10:02");
  });

  it("clock out and the two break texts", () => {
    expect(clockedOut("18:01")).toBe("Ausgestempelt 18:01");
    expect(breakStarted("12:03")).toBe("Pause gestartet 12:03");
    expect(breakEnded("12:33")).toBe("Pause beendet 12:33");
  });

  it("correction saved", () => {
    expect(correctionSaved()).toBe("Korrektur gespeichert");
  });

  it("leave request: range, single day, across years, half day", () => {
    expect(leaveRequested("Urlaub", "2026-11-10", "2026-11-14")).toBe(
      "Antrag gestellt · Urlaub 10.11.–14.11.2026",
    );
    expect(leaveRequested("Urlaub", "2026-11-10", "2026-11-10")).toBe(
      "Antrag gestellt · Urlaub 10.11.2026",
    );
    expect(leaveRequested("Urlaub", "2026-12-29", "2027-01-02")).toBe(
      "Antrag gestellt · Urlaub 29.12.2026–02.01.2027",
    );
    expect(leaveRequested("Urlaub", "2026-11-10", "2026-11-10", true)).toBe(
      "Antrag gestellt · Urlaub 10.11.2026 (halber Tag)",
    );
  });

  it("leave request accepts ISO instants that start with the calendar day", () => {
    expect(leaveRequested("Krank", "2026-11-10T00:00:00.000Z", "2026-11-12T00:00:00.000Z")).toBe(
      "Antrag gestellt · Krank 10.11.–12.11.2026",
    );
  });

  it("clockTime formats HH:MM in the local zone the dashboard displays", () => {
    // Built from local components, so the expectation holds in any time zone.
    expect(clockTime(new Date(2026, 10, 9, 10, 2).toISOString())).toBe("10:02");
    expect(clockTime(new Date(2026, 10, 9, 18, 1))).toBe("18:01");
  });
});

describe("leaveDecided (#846 D-03)", () => {
  it("names the type, the decision and the period", async () => {
    const { leaveDecided } = await import("../action-messages");
    expect(leaveDecided("Urlaub", "2026-12-14", "2026-12-18", "APPROVED")).toBe(
      "Urlaub genehmigt · 14.12.–18.12.2026",
    );
    expect(leaveDecided("Urlaub", "2026-12-14", "2026-12-14", "REJECTED")).toBe(
      "Urlaub abgelehnt · 14.12.2026",
    );
  });
});
