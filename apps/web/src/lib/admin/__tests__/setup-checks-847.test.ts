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

describe("setupChecks — each link opens the tab that holds its setting", () => {
  const read = (rel: string) => readFileSync(resolve(__dirname, rel), "utf8");
  const PAGES: Record<string, string> = {
    "/verwalten/system/allgemein": "../../../routes/(app)/admin/system/+page.svelte",
    "/verwalten/regeln/urlaub": "../../../routes/(app)/admin/vacation/+page.svelte",
  };
  // the source of one tab branch: from its `currentTab === "<tab>"` to the next branch
  const branch = (src: string, tab: string) => {
    const start = src.indexOf(`currentTab === "${tab}"}`);
    expect(start, `tab branch ${tab}`).toBeGreaterThan(0);
    const next = src.indexOf("currentTab ===", start + 20);
    return src.slice(start, next === -1 ? undefined : next);
  };

  it("rules, mail and terminals name their tab, and the tab holds the setting", () => {
    const checks = setupChecks(
      {
        salons: null,
        employees: null,
        smtp: { deliveryReady: false },
        work: { arbzgEnabled: false },
        terminals: [],
      },
      TODAY,
    );
    const byKey = Object.fromEntries(checks.map((c) => [c.key, c.href]));
    const expected: Array<[string, string, string]> = [
      ["rules", "/verwalten/regeln/urlaub#arbzg", "bind:checked={gArbzgEnabled}"],
      [
        "smtp",
        "/verwalten/system/allgemein#kommunikation",
        'data-testid="admin-system-email-emailNotificationsEnabled"',
      ],
      ["terminals", "/verwalten/system/allgemein#integration", "onclick={createTerminalKey}"],
    ];
    for (const [key, href, marker] of expected) {
      expect(byKey[key]).toBe(href);
      const [path, tab] = href.split("#");
      const src = read(PAGES[path]);
      expect(src).toContain(`{ id: "${tab}"`);
      expect(src).toContain("let activeTab = $state<string>(tabFromHash());");
      expect(branch(src, tab)).toContain(marker);
    }
  });

  it("the overview strips the hash before it asks the route table", () => {
    const overview = read("../../../routes/(app)/verwalten/+page.svelte");
    expect(overview).toContain('mayOpenPath($authStore.user, href.split("#")[0])');
    expect(overview).toContain('href="/verwalten/system/allgemein#kommunikation"');
    expect(overview).not.toMatch(/mayOpenPath\(\$authStore\.user, c\.href\)/);
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
