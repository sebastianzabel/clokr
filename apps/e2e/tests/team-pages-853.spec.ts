/**
 * Issue #853 (plan 853-15) - the Team pages, driven in a real browser on the real test stack.
 *
 * What only a browser on a real API can show:
 *
 *   1. AC-3, reach: a Salonmanagerin of salon A sees in Team › Abwesenheiten only her salon's
 *      persons by default; „Alle Salons“ (`kreis=alle`) adds the person of salon B as a masked row
 *      (a neutral bar, no type text); Team › Personen lists only salon A's persons and the rail
 *      offers Team › Personen but no Verwalten › Personen; Aufgaben lists only salon A's missing
 *      clock-outs (D-853-12, D-853-16, D-853-22). The assertions are about the SERVER's outcome:
 *      with one reachable salon the salon pill is not offered (`showSalonOptions()` is false), so
 *      the rows are narrowed by the API reach, not by a filter in the page.
 *   2. AC-4/AC-1, every Team page (Aufgaben, Zeiten, Abwesenheiten, the four Dienstplan tabs,
 *      Personen): one `h1` with the menu name, no eyebrow (D-853-19), and an axe scan in two
 *      passes (wcag2a/wcag2aa without colour contrast on the whole page, then colour contrast on
 *      the page content), because the legacy `accessibility.spec.ts` does not run in CI.
 *   3. AC-4, one visibility walkthrough per Team area (1280/390/360 px x light/dark): after each
 *      step the target lies IN THE VIEWPORT, not merely in the DOM (`helpers/visibility-walkthrough`).
 *
 * Setup goes through the API with the throwaway tenant's admin token. People are synthetic
 * (`.test` / `.invalid` addresses, invented names). Dates derive from the clock: the leave month is
 * the month after the current one, the open entries began three days ago. No sleeps - every wait
 * is a response, URL, element or settled animation.
 */
import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import type { TestTenant } from "../fixtures";
import { defineVisibilityWalkthrough } from "../helpers/visibility-walkthrough";
import {
  API_BASE,
  ROLE_TEMPLATE,
  approveRequest,
  chooseFromCombobox,
  createEmployee,
  createHomedPerson,
  createOpenEntry,
  createSalon,
  ensureEntitlement,
  fileVacation,
  listSalons,
} from "../helpers/team-seed";
import { login, loginAsTenantAdmin } from "./helpers";

const DAY_MS = 24 * 60 * 60 * 1000;

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The first day of the month after the current one (UTC date; only day numbers are compared). */
function firstOfNextMonth(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/** The n-th Monday (1-based) on or after the first of the month. */
function nthMonday(first: Date, n: number): Date {
  const offset = (8 - first.getUTCDay()) % 7;
  return new Date(first.getTime() + (offset + (n - 1) * 7) * DAY_MS);
}

/** A person's vacation on the second Monday-to-Wednesday of next month; `approved` decides it. */
async function vacationNextMonth(
  request: APIRequestContext,
  tenant: TestTenant,
  employeeId: string,
  approved: boolean,
): Promise<string> {
  const first = firstOfNextMonth();
  await ensureEntitlement(request, tenant, employeeId, first.getUTCFullYear());
  const start = nthMonday(first, 2);
  const id = await fileVacation(
    request,
    tenant,
    employeeId,
    iso(start),
    iso(new Date(start.getTime() + 2 * DAY_MS)),
  );
  if (approved) await approveRequest(request, tenant, id);
  return id;
}

/** The page's own content is there: the H1 is shown and nothing is still loading. */
async function pageReady(page: Page, heading: string): Promise<void> {
  await expect(page.getByRole("heading", { level: 1, name: heading, exact: true })).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
}

// ── 1. AC-3: the Salonmanagerin's reach ─────────────────────────────────────────────────────

test.describe("Salonmanagerin sieht ihren Salon (AC-3)", () => {
  test("Abwesenheiten, Personen und Aufgaben zeigen nur Salon A; „Alle Salons“ ergänzt eine maskierte Zeile", async ({
    page,
    request,
    tenant,
  }) => {
    test.setTimeout(120_000);
    const password = `Mp-${randomUUID()}!`;
    const [salonA] = await listSalons(request, tenant);
    const salonB = await createSalon(request, tenant, "Salon Zwei Probe");

    const manager = await createHomedPerson(request, tenant, {
      key: "mgr",
      firstName: "Marta",
      lastName: "Leitungsprobe",
      homeSalonId: salonA.id,
      password,
      template: {
        id: ROLE_TEMPLATE.SALON_MANAGER,
        scope: { type: "SALONS", salonIds: [salonA.id] },
      },
    });
    const personA = await createHomedPerson(request, tenant, {
      key: "ersta",
      firstName: "Anton",
      lastName: "Aprobe",
      homeSalonId: salonA.id,
      password,
    });
    const personB = await createHomedPerson(request, tenant, {
      key: "erstb",
      firstName: "Berta",
      lastName: "Bprobe",
      homeSalonId: salonB.id,
      password,
    });

    // Both persons are away next month (approved), so the calendar answer holds a row for each.
    await vacationNextMonth(request, tenant, personA.id, true);
    await vacationNextMonth(request, tenant, personB.id, true);
    // Both forgot to clock out three days ago (the Aufgaben type „Ausstempeln fehlt“).
    const openA = await createOpenEntry(request, tenant, personA.id, 3);
    const openB = await createOpenEntry(request, tenant, personB.id, 3);

    await login(page, manager.email, manager.password);

    // ── Abwesenheiten: default circle = salon A ─────────────────────────────────────────────
    const first = firstOfNextMonth();
    const calendar = page.waitForResponse(
      (r) => r.url().includes("/api/v1/leave/calendar?from=") && r.status() === 200,
    );
    await page.goto(`/team/abwesenheiten?tab=uebersicht&zoom=monat&datum=${iso(first)}`);
    await calendar;
    await pageReady(page, "Abwesenheiten");
    await expect(page.getByTestId("absence-timeline")).toBeVisible();
    await expect(page.getByTestId(`plan-track-${manager.id}`)).toBeVisible();
    await expect(page.getByTestId(`plan-track-${personA.id}`)).toBeVisible();
    await expect(
      page.getByTestId(`plan-track-${personB.id}`),
      "salon B's person is outside the default circle",
    ).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText(personB.lastName);

    // ── „Alle Salons“: B1 appears as a masked row, a neutral bar and no type text ────────────
    await page.getByRole("button", { name: "+ Filter" }).click();
    await page.getByRole("radio", { name: "Alle Salons" }).click();
    await expect(page).toHaveURL(/kreis=alle/);
    const trackB = page.getByTestId(`plan-track-${personB.id}`);
    await expect(trackB).toBeVisible();
    const barB = trackB.locator('[data-bar-style="abwesend"]');
    await expect(barB).toHaveCount(1);
    await expect(barB).toHaveAttribute("aria-label", /abwesend/);
    expect(await trackB.locator('[data-bar-style="gesetzt"]').count()).toBe(0);
    await expect(trackB).not.toContainText(/Urlaub/);
    // Her own salon's person keeps the type: the reach decides the detail, not the filter.
    await expect(
      page.getByTestId(`plan-track-${personA.id}`).locator('[data-bar-style="gesetzt"]'),
    ).toHaveCount(1);

    // ── Personen: only salon A, and the rail has Team › Personen but no Verwalten › Personen ─
    await page.goto("/team/personen");
    await pageReady(page, "Personen");
    await expect(page.getByTestId(`team-person-${manager.id}`)).toBeVisible();
    await expect(page.getByTestId(`team-person-${personA.id}`)).toBeVisible();
    await expect(
      page.getByTestId(`team-person-${personB.id}`),
      "salon B's person is not listed",
    ).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText(personB.lastName);
    const rail = page.getByRole("complementary", { name: "Hauptnavigation", exact: true });
    await expect(
      rail.getByRole("navigation", { name: "Team", exact: true }).getByRole("link", {
        name: "Personen",
        exact: true,
      }),
    ).toBeVisible();
    await expect(rail.getByRole("link", { name: "Personen", exact: true })).toHaveCount(1);
    // The Verwalten area (she may see parts of it) does not offer Personen: the one link is the Team one.
    await expect(
      rail
        .getByRole("navigation", { name: "Verwalten", exact: true })
        .getByRole("link", { name: "Personen", exact: true }),
    ).toHaveCount(0);

    // ── Aufgaben: only salon A's missing clock-out (#590 AC 1, D-853-22) ─────────────────────
    await page.goto("/team/aufgaben");
    await pageReady(page, "Aufgaben");
    await expect(page.getByTestId("inbox-task-list")).toBeVisible();
    const rowA = page.getByTestId(`task-row-ausstempeln-${openA}`);
    await expect(rowA).toBeVisible();
    await expect(rowA).toContainText(personA.lastName);
    await expect(rowA).toContainText("Ausstempeln fehlt");
    await expect(
      page.getByTestId(`task-row-ausstempeln-${openB}`),
      "salon B's missing clock-out is not a task of hers",
    ).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText(personB.lastName);
  });
});

// ── 2. AC-4/AC-1: head and accessibility of every Team page ────────────────────────────────

/** Axe violations as readable lines. */
function describeViolations(
  violations: Awaited<ReturnType<AxeBuilder["analyze"]>>["violations"],
): string[] {
  return violations.map(
    (v) =>
      `${v.id} (${v.impact}): ${v.nodes
        .map((n) => {
          const data = (n.any[0]?.data ?? {}) as Record<string, unknown>;
          return `${n.target.join(" ")} [${data.fgColor ?? ""} on ${data.bgColor ?? ""}, ${data.contrastRatio ?? ""}]`;
        })
        .join(" | ")}`,
  );
}

/** Waits until entrance animations settled, so axe measures final colours (bounded wait). */
async function animationsSettled(page: Page): Promise<void> {
  await page.evaluate(() =>
    Promise.race([
      Promise.all(
        document
          .getAnimations()
          .filter((a) => Number(a.effect?.getComputedTiming().endTime ?? 0) < 5000)
          .map((a) => a.finished.catch(() => undefined)),
      ),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]),
  );
}

/**
 * Two passes. Every rule except `color-contrast` runs on the whole page (wcag2a + wcag2aa, every
 * impact), like `accessibility.spec.ts`, which disables the contrast rule app-wide because shared
 * chrome tokens (sidebar section labels, the version label) sit below 4.5:1 and are not part of
 * this phase. The contrast rule then runs on the page content (`#main-content`), which the Team
 * pages own.
 */
async function axeViolations(page: Page): Promise<string[]> {
  await animationsSettled(page);
  const whole = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .disableRules(["color-contrast"])
    .analyze();
  const found = describeViolations(whole.violations);
  const contrast = await new AxeBuilder({ page })
    .withRules(["color-contrast"])
    .include("#main-content")
    .analyze();
  found.push(...describeViolations(contrast.violations).map((line) => `#main-content: ${line}`));
  return found;
}

const TEAM_PAGES: { path: string; heading: string }[] = [
  { path: "/team/aufgaben", heading: "Aufgaben" },
  { path: "/team/zeiten", heading: "Zeiten" },
  { path: "/team/abwesenheiten", heading: "Abwesenheiten" },
  { path: "/team/dienstplan", heading: "Dienstplan" },
  { path: "/team/dienstplan/planung", heading: "Dienstplan" },
  { path: "/team/dienstplan/konflikte", heading: "Dienstplan" },
  // The availability feature defaults to on for a tenant (`TenantConfig.availabilityEnabled`).
  { path: "/team/verfuegbarkeit", heading: "Dienstplan" },
  { path: "/team/personen", heading: "Personen" },
];

test.describe("Team-Seiten: Barrierefreiheit und Kopf (AC-4)", () => {
  for (const { path, heading } of TEAM_PAGES) {
    test(`${path}: H1 „${heading}“ ohne Eyebrow, axe ohne Verstöße`, async ({
      page,
      request,
      tenant,
    }) => {
      test.setTimeout(90_000);
      // Something to show on the content pages: a person with an open request and a missing clock-out.
      const person = await createEmployee(request, tenant, {
        key: "axe",
        firstName: "Achsen",
        lastName: "Prüfzeile",
        password: `Ax-${randomUUID()}!`, // an active login: a deactivated person takes no entry
      });
      await vacationNextMonth(request, tenant, person.id, false);
      await createOpenEntry(request, tenant, person.id, 3);

      await loginAsTenantAdmin(page, tenant);
      await page.goto(path);
      await pageReady(page, heading);

      // D-853-19: one H1 with the menu name, no eyebrow above it.
      await expect(page.locator("h1")).toHaveCount(1);
      await expect(page.locator("h1")).toHaveText(heading);
      await expect(page.locator(".page-head .eyebrow")).toHaveCount(0);

      expect(await axeViolations(page), `axe violations on ${path}`).toEqual([]);
    });
  }
});

// ── 3. AC-4: one visibility walkthrough per Team area ──────────────────────────────────────

const dialogOf = (page: Page) => page.getByRole("dialog");

// Aufgaben: an open leave task decides in its row (#853-19); „Ablehnen“ asks for the required reason
// in a dialog, which must open in view (it replaced „Prüfen“, which opened the decision dialog).
defineVisibilityWalkthrough({
  title: "Team Aufgaben Ablehnen",
  path: "/team/aufgaben",
  seed: async ({ request, tenant }) => {
    const person = await createEmployee(request, tenant, {
      key: "auf",
      firstName: "Aufgaben",
      lastName: "Wegprobe",
    });
    await vacationNextMonth(request, tenant, person.id, false);
  },
  ready: async (page) => {
    await expect(page.getByTestId("inbox-task-list")).toBeVisible();
  },
  steps: [
    {
      name: "Ablehnen",
      act: async (page) => {
        await page
          .getByTestId("inbox-task-list")
          .getByRole("button", { name: /^Ablehnen: Antrag von / })
          .first()
          .click();
      },
      target: (page) => dialogOf(page),
    },
  ],
});

// Zeiten: choose a person in the empty-state picker -> the calendar; Liste -> the day table; Öffnen ->
// the day sheet.
defineVisibilityWalkthrough({
  title: "Team Zeiten Person und Liste",
  path: "/team/zeiten",
  seed: async ({ request, tenant }) => {
    const person = await createEmployee(request, tenant, {
      key: "zei",
      firstName: "Zeiten",
      lastName: "Wegprobe",
      password: `Zw-${randomUUID()}!`, // an active login: a deactivated person takes no entry
    });
    // One closed entry yesterday (the list holds a table); on the 1st of a month: today.
    const now = new Date();
    const entryDay = now.getUTCDate() > 1 ? iso(new Date(now.getTime() - DAY_MS)) : iso(now);
    const res = await request.post(`${API_BASE}/api/v1/time-entries`, {
      headers: { "content-type": "application/json", Authorization: `Bearer ${tenant.adminToken}` },
      data: {
        employeeId: person.id,
        date: entryDay,
        startTime: `${entryDay}T05:00:00.000Z`,
        endTime: `${entryDay}T06:00:00.000Z`,
      },
    });
    expect(res.status(), `record an entry (${await res.text()})`).toBeLessThan(300);
  },
  ready: async (page) => {
    await expect(page.getByRole("combobox", { name: "Person" })).toBeVisible();
  },
  steps: [
    {
      name: "Person wählen",
      act: async (page) => {
        await chooseFromCombobox(
          page.getByRole("combobox", { name: "Person" }),
          page.getByRole("option", { name: /Wegprobe, Zeiten/ }),
          "Wegprobe",
        );
      },
      // The first thing a pick shows is the chosen person's month figures; on a phone the calendar
      // starts below that strip (the Liste step brings its view into view).
      target: (page) => page.locator(".te-figures"),
    },
    {
      name: "Liste",
      act: async (page) => {
        await page.getByRole("radio", { name: "Liste", exact: true }).click();
      },
      target: (page) => page.getByRole("table", { name: "Tage im Monat" }),
    },
    {
      // Owner review of #853: a day row's „Öffnen“ opens the day sheet with the entry and its actions.
      name: "Tag öffnen",
      act: async (page) => {
        await page.getByRole("button", { name: "Öffnen" }).first().click();
      },
      target: (page) => page.getByTestId("day-sheet"),
    },
  ],
});

// Abwesenheiten: Anträge tab -> the requests; „Abwesenheit eintragen“ -> the dialog.
defineVisibilityWalkthrough({
  title: "Team Abwesenheiten Anträge und Eintragen",
  path: "/team/abwesenheiten",
  seed: async ({ request, tenant }) => {
    const person = await createEmployee(request, tenant, {
      key: "abw",
      firstName: "Abwesend",
      lastName: "Wegprobe",
    });
    await vacationNextMonth(request, tenant, person.id, false);
  },
  ready: async (page) => {
    await expect(page.getByTestId("leave-overview")).toBeVisible();
  },
  steps: [
    {
      name: "Anträge",
      act: async (page) => {
        await page.getByTestId("leave-team-view-list").click();
      },
      target: (page) => page.getByTestId("leave-team-requests"),
    },
    {
      name: "Abwesenheit eintragen",
      act: async (page) => {
        await page
          .locator(".page-head")
          .getByRole("button", { name: "Abwesenheit eintragen" })
          .click();
      },
      // `leave-form-modal` is a `display: contents` wrapper (no box), so the dialog itself is the target.
      target: (page) => dialogOf(page),
    },
  ],
});

// Dienstplan: the tabs Bedarf, Hinweise, Verfügbarkeit each show their main block.
defineVisibilityWalkthrough({
  title: "Team Dienstplan Reiter",
  path: "/team/dienstplan",
  ready: async (page) => {
    await expect(
      page.getByRole("navigation", { name: "Dienstplan", exact: true }).first(),
    ).toBeVisible();
  },
  steps: [
    {
      name: "Bedarf",
      act: async (page) => {
        await page
          .getByRole("navigation", { name: "Dienstplan", exact: true })
          .getByRole("link", { name: "Bedarf", exact: true })
          .click();
      },
      // The week picker is always there; the roster table appears once someone is on a shift plan.
      target: (page) => [page.getByTestId("planning-week-label")],
    },
    {
      name: "Hinweise",
      act: async (page) => {
        await page
          .getByRole("navigation", { name: "Dienstplan", exact: true })
          .getByRole("link", { name: "Hinweise", exact: true })
          .click();
      },
      target: (page) => page.getByRole("heading", { name: "Hinweise zur Schichtplanung" }),
    },
    {
      name: "Verfügbarkeit",
      act: async (page) => {
        await page
          .getByRole("navigation", { name: "Dienstplan", exact: true })
          .getByRole("link", { name: "Verfügbarkeit", exact: true })
          .click();
      },
      target: (page) => page.getByRole("table", { name: "Personen" }),
    },
  ],
});

// Personen: the search narrows the table, the first row is in view.
defineVisibilityWalkthrough({
  title: "Team Personen Suche",
  path: "/team/personen",
  seed: async ({ request, tenant }) => {
    await createEmployee(request, tenant, {
      key: "per",
      firstName: "Personen",
      lastName: "Wegprobe",
    });
  },
  ready: async (page) => {
    await expect(page.getByRole("table", { name: "Personen" })).toBeVisible();
  },
  steps: [
    {
      name: "Suche",
      act: async (page) => {
        await page.getByRole("searchbox", { name: "Name oder Nummer" }).fill("Wegprobe");
        await expect(page.locator('[data-testid^="team-person-"]')).toHaveCount(1);
      },
      target: (page) => page.locator('[data-testid^="team-person-"]').first(),
    },
  ],
});
