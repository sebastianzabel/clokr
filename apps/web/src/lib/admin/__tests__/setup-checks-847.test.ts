// Issue #847 — Verwalten › Übersicht: the setup checks, the admin task counts and the mail warning.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  adminTaskCounts,
  mailWithoutDelivery,
  overdueMonthCloses,
  setupChecks,
  type EmployeeRow,
} from "../setup-checks";

const TODAY = "2026-11-09";

const person = (over: Partial<EmployeeRow>): EmployeeRow => ({
  id: "e",
  exitDate: null,
  user: { isActive: true, role: "EMPLOYEE" },
  workSchedule: { type: "FIXED_SCHEDULE" },
  invitationStatus: "ACCEPTED",
  ...over,
});

describe("setupChecks", () => {
  it("builds at least six checks, each with a link and a state, when every source is readable", () => {
    const checks = setupChecks(
      {
        salons: [{ id: "s1", name: "Nord", isActive: true, openingHours: [{ day: 1 }] }],
        employees: [person({})],
        smtp: { deliveryReady: true },
        work: { arbzgEnabled: true },
        terminals: [{ revokedAt: null }],
      },
      TODAY,
    );
    expect(checks.length).toBeGreaterThanOrEqual(6);
    for (const c of checks) {
      expect(c.href).toMatch(/^\/verwalten\//);
      expect(c.state).toBe("erledigt");
    }
  });

  it("names what is open", () => {
    const checks = setupChecks(
      {
        salons: [{ id: "s1", name: "Nord", isActive: true, openingHours: [] }],
        employees: [person({ user: { isActive: true, role: null } })],
        smtp: { deliveryReady: false },
        work: { arbzgEnabled: false },
        terminals: [{ revokedAt: "2026-01-01" }],
      },
      TODAY,
    );
    const byKey = Object.fromEntries(checks.map((c) => [c.key, c]));
    expect(byKey["salons"].state).toBe("erledigt");
    for (const k of ["opening-hours", "roles", "smtp", "rules", "terminals"])
      expect(byKey[k].state, k).toBe("offen");
    expect(byKey["roles"].detail).toBe("1 Person ohne Rolle");
  });

  it("shows no check for a source the caller may not read (never a fake „offen“)", () => {
    expect(
      setupChecks(
        { salons: null, employees: null, smtp: null, work: null, terminals: null },
        TODAY,
      ),
    ).toEqual([]);
  });
});

describe("admin tasks", () => {
  it("counts open invitations and persons without a contract among today's staff", () => {
    const counts = adminTaskCounts(
      [
        person({ invitationStatus: "PENDING" }),
        person({ invitationStatus: "EXPIRED", workSchedule: null }),
        person({ invitationStatus: "PENDING", exitDate: "2026-10-31" }), // left: not counted
        person({}),
      ],
      TODAY,
    );
    expect(counts).toEqual({ pendingInvitations: 2, withoutContract: 1 });
  });

  it("counts outstanding month closes before the current month only", () => {
    const n = overdueMonthCloses(
      [
        {
          year: 2026,
          months: [
            { month: 9, status: "closed" },
            { month: 10, status: "ready" },
            { month: 11, status: "open" }, // the running month is not overdue
            { month: 12, status: "future" },
          ],
        },
      ],
      { year: 2026, month: 11 },
    );
    expect(n).toBe(1);
  });
});

describe("mailWithoutDelivery — one rule for the overview and the mail settings", () => {
  it("warns only when notifications are on and the server cannot deliver", () => {
    expect(mailWithoutDelivery({ emailNotificationsEnabled: true }, { deliveryReady: false })).toBe(
      true,
    );
    expect(mailWithoutDelivery({ emailNotificationsEnabled: true }, { deliveryReady: true })).toBe(
      false,
    );
    expect(
      mailWithoutDelivery({ emailNotificationsEnabled: false }, { deliveryReady: false }),
    ).toBe(false);
    expect(mailWithoutDelivery(null, { deliveryReady: false })).toBe(false);
    expect(mailWithoutDelivery({ emailNotificationsEnabled: true }, null)).toBe(false);
  });

  it("both pages call it (no second copy of the rule)", () => {
    const read = (rel: string) => readFileSync(resolve(__dirname, rel), "utf8");
    const overview = read("../../../routes/(app)/verwalten/+page.svelte");
    const system = read("../../../routes/(app)/admin/system/+page.svelte");
    for (const src of [overview, system]) {
      expect(src.length).toBeGreaterThan(1000);
      expect(src).toContain("mailWithoutDelivery(");
      expect(src).toContain("MAIL_WITHOUT_DELIVERY_TEXT");
    }
  });
});
