// Issue #597 (Phase 851): „Kalender abonnieren“ shows only for a person who holds what the feed API
// asks for - an employee profile and at least one of shift:read:EIGENE / leave-request:read:EIGENE.
// Decided through the web's permission check, never by a role (a custom role may lack both keys).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("$api/client", () => ({ ApiError: class extends Error {}, api: {} }));

import { CALENDAR_FEED_PERMISSIONS, canSubscribeCalendar } from "../calendar-feed";

const person = (permissions: string[], employeeId: string | null = "e1") => ({
  employeeId,
  permissions,
});

describe("canSubscribeCalendar", () => {
  it("names exactly the two own-read keys of the API", () => {
    expect([...CALENDAR_FEED_PERMISSIONS]).toEqual([
      "shift:read:EIGENE",
      "leave-request:read:EIGENE",
    ]);
  });

  it("allows either key alone", () => {
    expect(canSubscribeCalendar(person(["shift:read:EIGENE"]))).toBe(true);
    expect(canSubscribeCalendar(person(["leave-request:read:EIGENE"]))).toBe(true);
  });

  it("refuses a custom role without both keys, whatever else it holds", () => {
    expect(canSubscribeCalendar(person(["shift:read:ZUGEWIESEN", "time-entry:read:EIGENE"]))).toBe(
      false,
    );
    expect(canSubscribeCalendar(person([]))).toBe(false);
  });

  it("refuses an account without an employee profile, and no session", () => {
    expect(canSubscribeCalendar(person(["shift:read:EIGENE"], null))).toBe(false);
    expect(canSubscribeCalendar(null)).toBe(false);
  });

  it("the Dienstplan page shows the button and the dialog only behind this check", () => {
    const page = readFileSync(
      resolve(process.cwd(), "src/routes/(app)/availability/+page.svelte"),
      "utf8",
    );
    expect(page.length).toBeGreaterThan(0);
    expect(page).toContain("canSubscribeCalendar($authStore.user)");
    expect(page.split("{#if feed && mayShowFeed}").length - 1).toBe(2);
    expect(page).not.toMatch(/role\s*===|\.role\b/);
  });
});
