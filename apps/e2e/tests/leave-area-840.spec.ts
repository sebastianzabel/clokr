/**
 * Issue #840 — the Abwesenheiten areas, driven in a real browser on the real test stack.
 *
 * The API tests prove the masked calendar read and the component tests prove the bars; this spec
 * proves the promises only a browser can show. Ten tests, named after the steps of plan 840-13 (and 840-16, 840-17, 840-18):
 *
 *   0. (slice 1, plan 840-02) the Übersicht draws an approved request solid and a pending one
 *      dashed, read from the computed border style, so the style is the one the browser really draws;
 *   1. manager path (AC-2, AC-9, AC-13): Übersicht, Anträge (PENDING row „Offen“ with a dashed
 *      chip), „Im Posteingang prüfen“ opens the inbox review mask, Planung, „Planung verwalten“,
 *      open the plan, enter a wish, take it over;
 *   2. employee path (AC-3, AC-13): a colleague's sick leave reads only „abwesend“ in Mein Bereich
 *      (no type text anywhere), Kalender holds only own entries, Planung takes an own wish and
 *      offers no edit on a colleague's row;
 *   3. markings at 1440 x 900 (AC-8): the Jahr zoom shows January to December without scrolling, a
 *      week click opens its quarter, Quartal marks weekend, a holiday (name in title and
 *      aria-label), a salon closed day and today;
 *   4. redirects of the old URLs on the built app (AC-1, assumption A5);
 *   5. axe (wcag2a/wcag2aa) on every tab of both areas, the open „Planung verwalten“ dialog and the
 *      inbox (AC-12);
 *   6. (gap round, plan 840-16, G-5/G-6/G-2) Planung at 1440 x 900: the forecast column sits beside
 *      the day grid and every day of the quarter can be scrolled into view, the „weiter →“ hint is
 *      below the header, the planner's controls are in the toolbar, the planner is one card and the
 *      weekend shade is visible;
 *   7. (gap round, plan 840-17, G-1/G-3/G-8) the Anträge count is neutral and explained on every tab
 *      (also on a directly opened Planung) and leads to the „Offen“ filter, the type chips of the
 *      Anträge list and the inbox use the colours of the one mapping, the inbox header reads
 *      „Aufgaben“ without an eyebrow (#843 D-843-22, #853 D-853-19);
 *   8. (gap round, plan 840-18, G-9; #853 re-pointed) „Abwesenheit eintragen“ asks „Für wen?“
 *      first, then lays out as Für wen? + Art, then Von + Bis, with no field cut off and no type
 *      eyebrow, and stacks on a phone;
 *   9. (gap round, plan 840-18, G-7) the primary buttons of the leave pages compute exactly the
 *      colours of the reference primary (`/admin/employees`) and reach 4.5:1 in every theme (pflaume,
 *      salz, petrol; #842 D-842-16), mode and state (rest and hover), read from the computed styles in the real browser.
 *
 * #840 G-1 ... G-9 (gap round): tests 6 to 9 are additions; of the pre-existing text only this header
 * (the test count and the list of tests) was extended.
 *
 * Setup goes through the API with the tenant admin's token (people, requests, plans, a manual
 * holiday, the salon's opening hours). No test depends on a fixed date: the Übersicht month is the
 * month after the current one, the planner year is next year, and the marking day is a Tuesday
 * between the 8th and the 14th of the current month (no statutory holiday falls on one). People are
 * synthetic (`.invalid` addresses); the tenant is the per-test fixture tenant.
 */
import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import type { TestTenant } from "../fixtures";
import {
  API_BASE,
  authHeaders,
  chooseFromCombobox,
  createEmployee,
  ensureEntitlement,
  fileVacation,
} from "../helpers/team-seed";

const PASSWORD = "test1234";
const DAY_MS = 24 * 60 * 60 * 1000;

/** The first day of the month after the current one (UTC date; only day numbers are compared). */
function firstOfNextMonth(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The n-th Monday (1-based) on or after the first of the month. */
function nthMonday(first: Date, n: number): Date {
  const offset = (8 - first.getUTCDay()) % 7;
  return new Date(first.getTime() + (offset + (n - 1) * 7) * DAY_MS);
}

async function loginViaForm(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("E-Mail").fill(email);
  await page.getByLabel("Passwort", { exact: true }).fill(password);
  await page.getByRole("button", { name: /anmelden/i }).click();
  await page.waitForURL(/\/(ich|team|verwalten)(\/|$)/, { timeout: 10_000 }); // #844: the start page
}

async function loginAsTenantAdmin(page: Page, tenant: TestTenant): Promise<void> {
  await loginViaForm(page, `admin@${tenant.tenantId}.test`, PASSWORD);
}

// ── Shared helpers of the later tests ────────────────────────────────────────────────────────

/** Local calendar day `YYYY-MM-DD` of a date (the page reads "today" from the browser clock). */
function localDay(date = new Date()): string {
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${m}-${d}`;
}

/** Next calendar year: the planner year of every test that opens a plan (no wish is ever past). */
const PLAN_YEAR = new Date().getFullYear() + 1;

/** The n-th Monday (1-based) of March of the plan year, as an ISO day. */
function marchMonday(n: number): string {
  const first = new Date(Date.UTC(PLAN_YEAR, 2, 1));
  const offset = (8 - first.getUTCDay()) % 7;
  return iso(new Date(first.getTime() + (offset + (n - 1) * 7) * DAY_MS));
}

function plusDays(day: string, n: number): string {
  return iso(new Date(new Date(`${day}T00:00:00.000Z`).getTime() + n * DAY_MS));
}

async function defaultSalonId(request: APIRequestContext, tenant: TestTenant): Promise<string> {
  const res = await request.get(`${API_BASE}/api/v1/salons`, { headers: authHeaders(tenant) });
  expect(res.ok(), `list the salons (${res.status()})`).toBe(true);
  return ((await res.json()) as { salons: Array<{ id: string }> }).salons[0].id;
}

/** Opens the leave plan of a salon and year through the API (no deadline). */
async function openPlanViaApi(
  request: APIRequestContext,
  tenant: TestTenant,
  salonId: string,
  year: number,
): Promise<string> {
  const res = await request.post(`${API_BASE}/api/v1/leave/plans`, {
    headers: authHeaders(tenant),
    data: { salonId, year, deadline: null },
  });
  expect(res.status(), `open the ${year} plan (${await res.text()})`).toBe(201);
  return ((await res.json()) as { plan: { id: string } }).plan.id;
}

async function addWishViaApi(
  request: APIRequestContext,
  tenant: TestTenant,
  planId: string,
  employeeId: string,
  startDate: string,
  endDate: string,
): Promise<string> {
  const res = await request.post(`${API_BASE}/api/v1/leave/plans/${planId}/wishes`, {
    headers: authHeaders(tenant),
    data: { employeeId, startDate, endDate, halfDay: false },
  });
  expect(res.status(), `file the wish (${await res.text()})`).toBe(201);
  return ((await res.json()) as { wish: { id: string } }).wish.id;
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
 * Selectors of the markup this phase introduced; the colour contrast of exactly these is checked
 * (the shared shell, KPI strip and badge tokens are not part of the phase, see below).
 */
// `.lv-controls` is the Team page's toolbar since #853 (`.leave-toolbar` stays on the own /leave page);
// both are listed so the contrast pass covers the toolbar on either page.
const PHASE_MARKUP = [
  ".leave-toolbar",
  ".lv-controls",
  '[data-testid="absence-timeline"]',
  ".leave-legend",
];

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

/**
 * Axe violations (wcag2a/wcag2aa, every impact) as readable lines; empty = clean.
 *
 * Two passes. Every rule except `color-contrast` runs on the whole page, like
 * `accessibility.spec.ts` (which disables the contrast rule app-wide: the shared design tokens
 * - sidebar section labels, the version label, `.eyebrow`, KPI labels, the `.badge` colours - are
 * below 4.5:1 today and are not part of this phase). The contrast rule then runs on the markup this
 * phase introduced (toolbar, timeline, legend), so it is not given up where the phase owns the look.
 */
async function axeViolations(page: Page): Promise<string[]> {
  await animationsSettled(page);
  const whole = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .disableRules(["color-contrast"])
    .analyze();
  const found = describeViolations(whole.violations);

  for (const selector of PHASE_MARKUP) {
    if ((await page.locator(selector).count()) === 0) continue;
    const contrast = await new AxeBuilder({ page })
      .withRules(["color-contrast"])
      .include(selector)
      .analyze();
    found.push(...describeViolations(contrast.violations).map((line) => `${selector}: ${line}`));
  }
  return found;
}

async function borderStyleOf(locator: Locator): Promise<string> {
  return locator.evaluate((el) => getComputedStyle(el).borderTopStyle);
}

/** Parses a computed colour (`rgb()`, `rgba()` or `color(srgb ...)`) to 0-255 channels and alpha. */
function parseColor(value: string): { r: number; g: number; b: number; a: number } {
  const srgb = value.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\)/);
  if (srgb) {
    const alpha =
      srgb[4] === undefined
        ? 1
        : srgb[4].endsWith("%")
          ? parseFloat(srgb[4]) / 100
          : parseFloat(srgb[4]);
    return { r: +srgb[1] * 255, g: +srgb[2] * 255, b: +srgb[3] * 255, a: alpha };
  }
  const rgb = value.match(
    /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)/,
  );
  if (!rgb) throw new Error(`cannot parse the colour "${value}"`);
  const alpha =
    rgb[4] === undefined ? 1 : rgb[4].endsWith("%") ? parseFloat(rgb[4]) / 100 : parseFloat(rgb[4]);
  return { r: +rgb[1], g: +rgb[2], b: +rgb[3], a: alpha };
}

function luminance({ r, g, b }: { r: number; g: number; b: number }): number {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast of `top` (with alpha) composited over the opaque `base`, against `base`. */
function compositedContrast(
  top: { r: number; g: number; b: number; a: number },
  base: { r: number; g: number; b: number },
): number {
  const mixed = {
    r: top.r * top.a + base.r * (1 - top.a),
    g: top.g * top.a + base.g * (1 - top.a),
    b: top.b * top.a + base.b * (1 - top.a),
  };
  const [hi, lo] = [luminance(mixed), luminance(base)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

test.describe("Abwesenheiten area (Issue #840)", () => {
  test("0. the Übersicht draws an approved request solid and a pending one dashed", async ({
    page,
    request,
    tenant,
  }) => {
    const first = firstOfNextMonth();
    const employee = await createEmployee(request, tenant);
    await ensureEntitlement(request, tenant, employee.id, first.getUTCFullYear());

    const approvedStart = nthMonday(first, 2);
    const pendingStart = nthMonday(first, 3);
    const approvedId = await fileVacation(
      request,
      tenant,
      employee.id,
      iso(approvedStart),
      iso(new Date(approvedStart.getTime() + 2 * DAY_MS)),
    );
    const pendingId = await fileVacation(
      request,
      tenant,
      employee.id,
      iso(pendingStart),
      iso(new Date(pendingStart.getTime() + 2 * DAY_MS)),
    );
    const review = await request.patch(`${API_BASE}/api/v1/leave/requests/${approvedId}/review`, {
      headers: authHeaders(tenant),
      data: { status: "APPROVED" },
    });
    expect(review.status(), `approve the first request (${await review.text()})`).toBeLessThan(300);

    await loginAsTenantAdmin(page, tenant);
    const calendar = page.waitForResponse(
      (r) => r.url().includes("/api/v1/leave/calendar?from=") && r.status() === 200,
    );
    await page.goto(`/team/leave?tab=uebersicht&zoom=monat&datum=${iso(first)}`);
    await calendar;

    // One row for the one absent person, one bar per absence of the month.
    const track = page.getByTestId(`plan-track-${employee.id}`);
    await expect(track).toBeVisible();
    await expect(page.getByTestId("absence-timeline")).toBeVisible();

    const solid = track.locator('[data-bar-style="gesetzt"]');
    const dashed = track.locator('[data-bar-style="beantragt"]');
    await expect(solid).toHaveCount(1);
    await expect(dashed).toHaveCount(1);
    await expect(track.getByTestId(`absence-bar-${approvedId}`)).toBeVisible();
    await expect(track.getByTestId(`absence-bar-${pendingId}`)).toBeVisible();

    // The browser really draws the pending bar dashed and the approved one solid.
    const borderOf = (bar: typeof solid) =>
      bar.evaluate((el) => getComputedStyle(el).borderTopStyle);
    expect(await borderOf(dashed)).toBe("dashed");
    expect(await borderOf(solid)).toBe("solid");
  });
  test("1. manager path: Übersicht, Anträge, inbox review mask, Planung, wish, takeover", async ({
    page,
    request,
    tenant,
  }) => {
    test.setTimeout(90_000);
    const first = firstOfNextMonth();
    const employee = await createEmployee(request, tenant, {
      key: "mgr",
      firstName: "Manager",
      lastName: "Pfad",
    });
    await ensureEntitlement(request, tenant, employee.id, first.getUTCFullYear());
    await ensureEntitlement(request, tenant, employee.id, PLAN_YEAR);

    const approvedStart = nthMonday(first, 2);
    const pendingStart = nthMonday(first, 3);
    const approvedId = await fileVacation(
      request,
      tenant,
      employee.id,
      iso(approvedStart),
      iso(new Date(approvedStart.getTime() + 2 * DAY_MS)),
    );
    const pendingId = await fileVacation(
      request,
      tenant,
      employee.id,
      iso(pendingStart),
      iso(new Date(pendingStart.getTime() + 2 * DAY_MS)),
    );
    const review = await request.patch(`${API_BASE}/api/v1/leave/requests/${approvedId}/review`, {
      headers: authHeaders(tenant),
      data: { status: "APPROVED" },
    });
    expect(review.status(), `approve the first request (${await review.text()})`).toBeLessThan(300);

    await loginAsTenantAdmin(page, tenant);

    // ── Übersicht: the pending request is a dashed bar ────────────────────────────────────
    await page.goto(`/team/leave?tab=uebersicht&zoom=monat&datum=${iso(first)}`);
    const track = page.getByTestId(`plan-track-${employee.id}`);
    await expect(track).toBeVisible();
    const pendingBar = track.getByTestId(`absence-bar-${pendingId}`);
    await expect(pendingBar).toHaveAttribute("data-bar-style", "beantragt");
    expect(await borderStyleOf(pendingBar)).toBe("dashed");

    // ── Anträge: the pending row says „Offen“ and its type chip is dashed ───────────────────
    await page.getByTestId("leave-team-view-list").click();
    await expect(page).toHaveURL(/tab=antraege/);
    const row = page.getByTestId(`leave-team-row-${pendingId}`);
    await expect(row).toBeVisible();
    await expect(row.getByTestId(`leave-team-row-${pendingId}-status-badge`)).toHaveText("Offen");
    const chip = row.getByTestId(`leave-team-row-${pendingId}-type-chip`);
    await expect(chip).toHaveAttribute("data-row-status", "PENDING");
    expect(await borderStyleOf(chip)).toBe("dashed");

    // ── „Im Posteingang prüfen“ lands on the inbox with the review mask open ────────────────
    await row.getByTestId(`leave-team-row-${pendingId}-review`).click();
    await page.waitForURL(/\/team\/aufgaben/);
    await expect(page.getByTestId("leave-approval-modal")).toBeVisible();
    await expect(page.getByTestId("leave-approval-modal-approve")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("leave-approval-modal")).toBeHidden();

    // ── Planung: „Planung verwalten“ opens the plan of next year ────────────────────────────
    await page.goto(`/team/leave?tab=planung&zoom=monat&datum=${PLAN_YEAR}-03-01`);
    const manageDialog = page.getByRole("dialog", { name: "Planung verwalten" });
    await page.getByTestId("leave-plan-manage").click();
    await expect(manageDialog).toBeVisible();
    const openResponse = page.waitForResponse(
      (r) => r.url().endsWith("/api/v1/leave/plans") && r.request().method() === "POST",
    );
    await manageDialog.getByTestId("leave-plan-open").click();
    expect((await openResponse).status()).toBe(201);
    await expect(manageDialog.getByLabel("Frist für Wünsche")).toBeVisible();
    await manageDialog.getByRole("button", { name: "Schließen" }).click();
    await expect(manageDialog).toBeHidden();

    // ── a wish for the employee through the wish dialog ────────────────────────────────────
    await page.getByTestId("leave-plan-add-wish").click();
    await page.getByTestId("wish-person").selectOption(employee.id);
    await page.getByTestId("wish-start").fill(marchMonday(2));
    await page.getByTestId("wish-end").fill(plusDays(marchMonday(2), 2));
    const created = page.waitForResponse(
      (r) => /\/leave\/plans\/[^/]+\/wishes$/.test(r.url()) && r.request().method() === "POST",
    );
    await page.getByTestId("wish-save").click();
    const wishResponse = await created;
    expect(wishResponse.status(), `create the wish (${await wishResponse.text()})`).toBe(201);
    const wishId = ((await wishResponse.json()) as { wish: { id: string } }).wish.id;
    await expect(page.getByTestId(`leave-plan-wish-${wishId}`)).toBeVisible();

    // ── take the plan over ─────────────────────────────────────────────────────────────────
    await page.getByTestId("leave-plan-manage").click();
    const takeoverButton = manageDialog.getByTestId("leave-plan-takeover");
    await expect(takeoverButton).toBeEnabled();
    await takeoverButton.click();
    await expect(page.getByTestId("takeover-count")).toContainText("1 offener Wunsch");
    const takeoverResponse = page.waitForResponse(
      (r) => /\/leave\/plans\/[^/]+\/takeover$/.test(r.url()) && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Übernehmen", exact: true }).click();
    const takeover = await takeoverResponse;
    expect(takeover.status(), `take the plan over (${await takeover.text()})`).toBe(200);
    await expect(page.getByTestId("takeover-result")).toBeVisible();
    await expect(page.getByTestId("takeover-created")).toContainText("Manager Pfad");
    await expect(page.getByTestId("takeover-plan-status")).toContainText("Übernommen");
  });

  test("2. employee path: colleague reads only „abwesend“, Kalender is own, Planung takes an own wish", async ({
    page,
    request,
    tenant,
  }) => {
    test.setTimeout(90_000);
    const password = `Mp-${randomUUID()}!`;
    const colleague = await createEmployee(request, tenant, {
      key: "kol",
      firstName: "Kollege",
      lastName: "Abwesenprobe",
    });
    const person = await createEmployee(request, tenant, {
      key: "mit",
      firstName: "Mitarbeit",
      lastName: "Eigenprobe",
      password,
    });
    await ensureEntitlement(request, tenant, person.id, PLAN_YEAR);

    // The colleague's APPROVED sick leave: the first of the current month, at most through today.
    const now = new Date();
    const monthStart = localDay(new Date(now.getFullYear(), now.getMonth(), 1));
    const sickEnd = [plusDays(monthStart, 4), localDay(now)].sort()[0];
    const sickRes = await request.post(`${API_BASE}/api/v1/leave/requests`, {
      headers: authHeaders(tenant),
      data: { employeeId: colleague.id, type: "SICK", startDate: monthStart, endDate: sickEnd },
    });
    expect(sickRes.status(), `file the sick leave (${await sickRes.text()})`).toBeLessThan(300);
    const sick = (await sickRes.json()) as { id: string; status: string };
    if (sick.status !== "APPROVED") {
      const approve = await request.patch(`${API_BASE}/api/v1/leave/requests/${sick.id}/review`, {
        headers: authHeaders(tenant),
        data: { status: "APPROVED" },
      });
      expect(approve.status(), `approve the sick leave (${await approve.text()})`).toBeLessThan(
        300,
      );
    }

    // The admin opens next year's plan and files a wish for the colleague.
    const salonId = await defaultSalonId(request, tenant);
    const planId = await openPlanViaApi(request, tenant, salonId, PLAN_YEAR);
    const colleagueWishId = await addWishViaApi(
      request,
      tenant,
      planId,
      colleague.id,
      marchMonday(2),
      plusDays(marchMonday(2), 2),
    );

    await loginViaForm(page, person.email, password);

    // ── Team: the colleague is „abwesend“, the type is nowhere ──────────────────────────────
    await page.goto("/leave?tab=team");
    const timeline = page.getByTestId("absence-timeline");
    await expect(timeline).toBeVisible();
    const colleagueTrack = page.getByTestId(`plan-track-${colleague.id}`);
    await expect(colleagueTrack).toBeVisible();
    const bar = colleagueTrack.locator('[data-bar-style="abwesend"]');
    await expect(bar).toHaveCount(1);
    await expect(bar).toHaveAttribute("aria-label", /abwesend/);
    expect(await colleagueTrack.locator('[data-bar-style="gesetzt"]').count()).toBe(0);
    // The page's KPI strip names „Krankheitstage“ (a count of the caller's own days); no other text
    // and no attribute names the type.
    await expect(page.locator("body")).not.toContainText(/Krank(?!heitstage)/);
    expect(
      await page.locator('[title*="Krank"], [aria-label*="Krank"]').count(),
      "no attribute names the type either",
    ).toBe(0);

    // ── Kalender: only own entries ─────────────────────────────────────────────────────────
    await page.getByTestId("leave-view-calendar").click();
    await expect(page).toHaveURL(/tab=kalender/);
    await expect(page.getByTestId("leave-page")).toBeVisible();
    await expect(page.locator("body")).not.toContainText(colleague.lastName);
    await expect(page.locator("body")).not.toContainText(/Krank(?!heitstage)/);

    // ── Planung: an own wish through the dialog; the colleague's row offers no edit ─────────
    await page.goto(`/leave?tab=planung&zoom=monat&datum=${PLAN_YEAR}-03-01`);
    await page.getByTestId("leave-plan-add-wish").click();
    await expect(page.getByTestId("wish-person")).toHaveCount(0);
    await page.getByTestId("wish-start").fill(marchMonday(3));
    await page.getByTestId("wish-end").fill(plusDays(marchMonday(3), 2));
    const created = page.waitForResponse(
      (r) => /\/leave\/plans\/[^/]+\/wishes$/.test(r.url()) && r.request().method() === "POST",
    );
    await page.getByTestId("wish-save").click();
    const wishResponse = await created;
    expect(wishResponse.status(), `create the own wish (${await wishResponse.text()})`).toBe(201);
    const ownWishId = ((await wishResponse.json()) as { wish: { id: string } }).wish.id;

    const ownTrack = page.getByTestId(`plan-track-${person.id}`);
    await expect(ownTrack.getByTestId(`leave-plan-wish-${ownWishId}`)).toBeVisible();
    await expect(ownTrack.getByTestId(`wish-bar-${ownWishId}`)).toBeVisible();
    await expect(ownTrack.getByTestId(`leave-plan-wish-handle-end-${ownWishId}`)).toHaveCount(1);

    const otherTrack = page.getByTestId(`plan-track-${colleague.id}`);
    await expect(otherTrack).toBeVisible();
    // The colleague's wish is on the plan (the planner shows wishes), but nothing about it is
    // editable: no drag handle, and opening it shows the read-only hint without a save button.
    await expect(otherTrack.locator('[data-testid^="leave-plan-wish-handle"]')).toHaveCount(0);
    await otherTrack.getByTestId(`wish-bar-${colleagueWishId}`).click();
    await expect(page.getByTestId("wish-read-only-hint")).toBeVisible();
    await expect(page.getByTestId("wish-save")).toHaveCount(0);
    await expect(page.getByTestId("wish-remove")).toHaveCount(0);
    await page.getByRole("button", { name: "Schließen" }).click();
    await expect(page.getByTestId("wish-read-only-hint")).toBeHidden();
    await expect(page.getByTestId("leave-plan-manage")).toHaveCount(0);
  });

  test("3. markings at 1440 x 900: Jahr fits, a week opens its quarter, Quartal marks the days", async ({
    page,
    request,
    tenant,
  }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const person = await createEmployee(request, tenant, {
      key: "mark",
      firstName: "Markierung",
      lastName: "Zeile",
    });

    // A Tuesday between the 8th and the 14th of the current month: no statutory holiday lies there.
    const now = new Date();
    const firstOfMonth = new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1));
    const tuesdayOffset = (2 - firstOfMonth.getUTCDay() + 7) % 7;
    const holidayDay = iso(new Date(firstOfMonth.getTime() + (tuesdayOffset + 7) * DAY_MS));
    const HOLIDAY_NAME = "Betriebsfest Testhausen";
    const holidayRes = await request.post(`${API_BASE}/api/v1/holidays`, {
      headers: authHeaders(tenant),
      data: { date: holidayDay, name: HOLIDAY_NAME },
    });
    expect(holidayRes.status(), `add the holiday (${await holidayRes.text()})`).toBeLessThan(300);

    // Opening hours: Monday (index 0 = Monday) is a closed day of the one salon.
    const salonId = await defaultSalonId(request, tenant);
    const week = [0, 1, 2, 3, 4, 5, 6].map((day) => ({
      day,
      open: "09:00",
      close: "18:00",
      ...(day === 0 ? { closed: true } : {}),
    }));
    const salonRes = await request.patch(`${API_BASE}/api/v1/salons/${salonId}`, {
      headers: authHeaders(tenant),
      data: { openingHours: week },
    });
    expect(salonRes.status(), `close Mondays (${await salonRes.text()})`).toBeLessThan(300);

    await loginAsTenantAdmin(page, tenant);

    // ── Jahr: January to December without sideways scrolling ───────────────────────────────
    const year = now.getFullYear();
    await page.goto(`/team/leave?tab=uebersicht&zoom=jahr&datum=${localDay(now)}`);
    const timeline = page.getByTestId("absence-timeline");
    await expect(timeline).toBeVisible();
    await expect(timeline).toHaveAttribute("data-zoom", "jahr");
    const scrollEl = timeline.locator(".tl-scroll");
    const fit = await scrollEl.evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    expect(fit.scrollWidth, "the Jahr grid does not scroll sideways").toBeLessThanOrEqual(
      fit.clientWidth,
    );

    // The Monday of ISO week 1 and of the week holding 28 December.
    const mondayOnOrBefore = (day: Date) =>
      iso(new Date(day.getTime() - ((day.getUTCDay() + 6) % 7) * DAY_MS));
    const firstWeek = mondayOnOrBefore(new Date(Date.UTC(year, 0, 4)));
    const lastWeek = mondayOnOrBefore(new Date(Date.UTC(year, 11, 28)));
    for (const monday of [firstWeek, lastWeek]) {
      const box = await page.getByTestId(`week-head-${monday}`).boundingBox();
      expect(box, `the week head ${monday} has a box`).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(1440);
    }
    await expect(page.getByTestId("absence-month-0")).toBeVisible();
    await expect(page.getByTestId("absence-month-11")).toBeVisible();

    // ── a week click opens its quarter ─────────────────────────────────────────────────────
    const holidayMonday = plusDays(holidayDay, -1);
    await page.getByTestId(`week-cell-${person.id}-${holidayMonday}`).click();
    await page.waitForURL(
      (url) =>
        url.searchParams.get("zoom") === "quartal" &&
        url.searchParams.get("datum") === holidayMonday,
    );
    await expect(timeline).toHaveAttribute("data-zoom", "quartal");

    // ── Quartal: weekend, holiday, closed day and today ────────────────────────────────────
    const saturday = plusDays(holidayMonday, 5);
    await expect(page.getByTestId(`absence-day-${saturday}`)).toHaveClass(/absence-day--weekend/);

    const holidayHead = page.getByTestId(`absence-day-${holidayDay}`);
    await expect(holidayHead).toHaveClass(/absence-day--holiday/);
    await expect(holidayHead).toHaveAttribute("title", HOLIDAY_NAME);
    await expect(holidayHead).toHaveAttribute("aria-label", new RegExp(HOLIDAY_NAME));
    await holidayHead.focus();
    await expect(holidayHead).toBeFocused();
    await expect(page.getByTestId(`plan-holiday-${holidayDay}`).first()).toBeAttached();

    await expect(page.getByTestId(`absence-day-${holidayMonday}`)).toHaveClass(
      /absence-day--closed/,
    );
    await expect(timeline.locator(".tl-closed").first()).toBeAttached();
    await expect(page.getByTestId("legend-marking-closed")).toBeVisible();

    await expect(page.getByTestId(`absence-day-${localDay(now)}`)).toHaveClass(
      /absence-day--today/,
    );
    await expect(timeline.locator(".tl-today").first()).toBeAttached();
  });

  test("6. Planung at 1440 x 900: forecast beside the grid, controls in the toolbar", async ({
    page,
    request,
    tenant,
  }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const person = await createEmployee(request, tenant, {
      key: "lay",
      firstName: "Layout",
      lastName: "Prognose",
    });
    await ensureEntitlement(request, tenant, person.id, PLAN_YEAR);
    const salonId = await defaultSalonId(request, tenant);
    const planId = await openPlanViaApi(request, tenant, salonId, PLAN_YEAR);
    await addWishViaApi(
      request,
      tenant,
      planId,
      person.id,
      marchMonday(2),
      plusDays(marchMonday(2), 2),
    );

    await loginAsTenantAdmin(page, tenant);
    await page.goto(`/team/leave?tab=planung&zoom=quartal&datum=${PLAN_YEAR}-02-15`);
    const timeline = page.getByTestId("absence-timeline");
    await expect(timeline).toBeVisible();
    await expect(timeline).toHaveAttribute("data-zoom", "quartal");
    const scroller = page.getByTestId("absence-timeline-scroll");
    const forecastHead = page.getByTestId("plan-forecast-head");
    await expect(forecastHead).toBeVisible();
    await animationsSettled(page);

    // (a) the forecast head starts at or right of the right edge of the day viewport.
    const scrollBox = await scroller.boundingBox();
    const headBox = await forecastHead.boundingBox();
    expect(scrollBox, "the day viewport has a box").not.toBeNull();
    expect(headBox, "the forecast head has a box").not.toBeNull();
    const scrollRight = scrollBox!.x + scrollBox!.width;
    expect(
      headBox!.x,
      `forecast head x ${headBox!.x} vs viewport right ${scrollRight}`,
    ).toBeGreaterThanOrEqual(scrollRight - 1);

    // (c) while the grid overflows, the hint lies below the header line, never on it.
    const hint = page.getByTestId("timeline-overflow-hint");
    if (await hint.isVisible()) {
      const hintBox = await hint.boundingBox();
      const headerBox = await timeline.locator(".tl-head").boundingBox();
      expect(hintBox!.y, "the hint is below the header line").toBeGreaterThanOrEqual(
        headerBox!.y + headerBox!.height - 1,
      );
    }

    // (b) scrolled to its end, the last day of the quarter ends left of the forecast column.
    await scroller.evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
    });
    const lastDay = page.getByTestId(`absence-day-${PLAN_YEAR}-03-31`);
    await expect
      .poll(async () => {
        const box = await lastDay.boundingBox();
        const head = await forecastHead.boundingBox();
        return box && head ? head.x - (box.x + box.width) : null;
      })
      .toBeGreaterThanOrEqual(-1);
    const lastBox = await lastDay.boundingBox();
    const headAfter = await forecastHead.boundingBox();
    test.info().annotations.push({
      type: "boxes",
      description: `forecast head x=${headBox!.x} (viewport right ${scrollRight}); 31.03. right=${lastBox!.x + lastBox!.width}, forecast left=${headAfter!.x}`,
    });

    // (d) the controls are in the toolbar row under the tab strip (#853: `.lv-controls` replaced the
    // old `.leave-toolbar`); the planner is one card.
    const toolbar = page.locator(".lv-controls");
    await expect(toolbar.getByTestId("leave-plan-head")).toBeVisible();
    await expect(toolbar.getByTestId("leave-plan-add-wish")).toBeVisible();
    await expect(page.getByTestId("leave-plan-page").locator(".card")).toHaveCount(1);

    // (e) the weekend shade is visible against the timeline's own background (G-2, real browser).
    const shade = await timeline
      .locator(".tl-weekend")
      .first()
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    const base = await timeline.evaluate((el) => getComputedStyle(el).backgroundColor);
    const baseColor = parseColor(base);
    expect(baseColor.a, "the timeline background is opaque").toBe(1);
    const contrast = compositedContrast(parseColor(shade), baseColor);
    expect(contrast, `weekend shade ${shade} over ${base}`).toBeGreaterThanOrEqual(1.2);
  });

  test("4. old URLs land on their new homes in the built app", async ({
    page,
    request,
    tenant,
  }) => {
    test.setTimeout(90_000);
    const password = `Mp-${randomUUID()}!`;
    const person = await createEmployee(request, tenant, {
      key: "red",
      firstName: "Weiterleitung",
      lastName: "Probe",
      password,
    });
    const year = new Date().getFullYear();
    const section9Id = randomUUID();

    // Every URL a frame passed through, so a redirect the target page later tidies up still counts.
    const seen: string[] = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) seen.push(frame.url());
    });

    // ── as the admin ───────────────────────────────────────────────────────────────────────
    await loginAsTenantAdmin(page, tenant);

    await page.goto("/teamcal");
    await page.waitForURL(/\/team\/abwesenheiten/);
    let url = new URL(page.url());
    expect(url.searchParams.get("tab")).toBe("uebersicht");
    expect(url.searchParams.get("zoom")).toBe("monat");

    await page.goto(`/leave/planung?year=${year}`);
    await page.waitForURL(/\/team\/abwesenheiten/);
    url = new URL(page.url());
    expect(url.searchParams.get("tab")).toBe("planung");

    await page.goto("/team/leave?view=approvals");
    await page.waitForURL((u) => u.searchParams.get("tab") === "antraege");
    url = new URL(page.url());
    expect(url.pathname).toBe("/team/abwesenheiten"); // #844: the new URL of /team/leave
    expect(url.searchParams.get("status")).toBe("PENDING");

    await page.goto(`/team/leave?section9=${section9Id}`);
    await page.waitForURL(/\/team\/aufgaben/);
    expect(new URL(page.url()).pathname).toBe("/team/aufgaben"); // #844: the new URL of /inbox
    expect(
      seen.some((u) => u.endsWith(`/team/aufgaben?section9=${section9Id}`)),
      `the redirect carried the case id (${seen.slice(-4).join(" | ")})`,
    ).toBe(true);

    // ── as the employee: the planner stub forwards to Mein Bereich ─────────────────────────
    // Drop the admin's session instead of walking the logout UI; the employee signs in fresh.
    await page.context().clearCookies();
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
    await loginViaForm(page, person.email, password);
    await page.goto(`/leave/planung?year=${year}`);
    await page.waitForURL(/\/ich\/abwesenheiten\?/);
    url = new URL(page.url());
    expect(url.pathname).toBe("/ich/abwesenheiten"); // #844: the new URL of /leave
    expect(url.searchParams.get("tab")).toBe("planung");
  });

  test("5. axe: every tab of both areas and the open planner dialog", async ({
    page,
    request,
    tenant,
  }) => {
    test.setTimeout(150_000);
    const first = firstOfNextMonth();
    const employee = await createEmployee(request, tenant, {
      key: "axe",
      firstName: "Barriere",
      lastName: "Frei",
    });
    await ensureEntitlement(request, tenant, employee.id, first.getUTCFullYear());
    const monday = nthMonday(first, 2);
    const approvedId = await fileVacation(
      request,
      tenant,
      employee.id,
      iso(monday),
      iso(new Date(monday.getTime() + 2 * DAY_MS)),
    );
    const review = await request.patch(`${API_BASE}/api/v1/leave/requests/${approvedId}/review`, {
      headers: authHeaders(tenant),
      data: { status: "APPROVED" },
    });
    expect(review.status(), `approve the request (${await review.text()})`).toBeLessThan(300);
    const pendingStart = nthMonday(first, 3);
    await fileVacation(
      request,
      tenant,
      employee.id,
      iso(pendingStart),
      iso(new Date(pendingStart.getTime() + 2 * DAY_MS)),
    );
    const salonId = await defaultSalonId(request, tenant);
    const planId = await openPlanViaApi(request, tenant, salonId, PLAN_YEAR);
    await addWishViaApi(
      request,
      tenant,
      planId,
      employee.id,
      marchMonday(2),
      plusDays(marchMonday(2), 2),
    );

    await loginAsTenantAdmin(page, tenant);

    const datum = iso(first);
    const surfaces: Array<{ name: string; path: string; ready: string }> = [
      {
        name: "Team Übersicht (Monat)",
        path: `/team/leave?tab=uebersicht&zoom=monat&datum=${datum}`,
        ready: "absence-timeline",
      },
      {
        name: "Team Übersicht (Jahr)",
        path: `/team/leave?tab=uebersicht&zoom=jahr&datum=${datum}`,
        ready: "absence-timeline",
      },
      {
        name: "Team Anträge",
        path: `/team/leave?tab=antraege&datum=${datum}`,
        ready: "leave-team-requests",
      },
      {
        name: "Team Planung",
        path: `/team/leave?tab=planung&zoom=monat&datum=${PLAN_YEAR}-03-01`,
        ready: "leave-plan-head",
      },
      { name: "Mein Bereich Kalender", path: "/leave?tab=kalender", ready: "leave-page" },
      { name: "Mein Bereich Anträge", path: "/leave?tab=antraege", ready: "leave-page" },
      { name: "Mein Bereich Team", path: "/leave?tab=team", ready: "leave-team-overview" },
      {
        name: "Mein Bereich Planung",
        path: `/leave?tab=planung&zoom=monat&datum=${PLAN_YEAR}-03-01`,
        ready: "leave-plan-head",
      },
    ];

    const found: Record<string, string[]> = {};
    for (const surface of surfaces) {
      await page.goto(surface.path);
      await expect(page.getByTestId(surface.ready)).toBeVisible();
      found[surface.name] = await axeViolations(page);
    }

    // The open „Planung verwalten“ dialog.
    await page.goto(`/team/leave?tab=planung&zoom=monat&datum=${PLAN_YEAR}-03-01`);
    await expect(page.getByTestId("leave-plan-head")).toBeVisible();
    await page.getByTestId("leave-plan-manage").click();
    await expect(page.getByRole("dialog", { name: "Planung verwalten" })).toBeVisible();
    found["Planung verwalten (open)"] = await axeViolations(page);
    expect(found).toEqual(Object.fromEntries(Object.keys(found).map((name) => [name, []])));
  });

  // The inbox is the one place requests are decided (D-840-03). Since #853 its rows are `TaskRow`s
  // (test id `task-row-<kind>-<id>`) in the list `inbox-task-list`; they keep the `onPrimary` mode of
  // `ListRow`: the name is the one row button and the „Ablehnen“ / „Genehmigen“ buttons (#853-19) are
  // its siblings, so axe `nested-interactive` has nothing to report.
  test("5b. axe: the inbox with an open request", async ({ page, request, tenant }) => {
    const first = firstOfNextMonth();
    const employee = await createEmployee(request, tenant, {
      key: "inb",
      firstName: "Posteingang",
      lastName: "Zeile",
    });
    await ensureEntitlement(request, tenant, employee.id, first.getUTCFullYear());
    const monday = nthMonday(first, 2);
    await fileVacation(
      request,
      tenant,
      employee.id,
      iso(monday),
      iso(new Date(monday.getTime() + 2 * DAY_MS)),
    );
    await loginAsTenantAdmin(page, tenant);
    await page.goto("/inbox");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByTestId("inbox-task-list")).toBeVisible();
    await expect(page.locator('[data-testid^="task-row-urlaub-"]').first()).toBeVisible();
    expect(await axeViolations(page), "axe on the inbox").toEqual([]);

    // Keyboard: Enter on the row's name button opens the review dialog (the `onPrimary` mode).
    const nameButton = page
      .locator('[data-testid^="task-row-urlaub-"]')
      .first()
      .getByRole("button", { name: /Posteingang Zeile/ })
      .first();
    await nameButton.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog").first()).toBeVisible();
  });

  test("7. the Anträge count, the type chips and the inbox header", async ({
    page,
    request,
    tenant,
  }) => {
    test.setTimeout(90_000);
    const first = firstOfNextMonth();
    const person = await createEmployee(request, tenant, {
      key: "cnt",
      firstName: "Zaehler",
      lastName: "Farbe",
    });
    await ensureEntitlement(request, tenant, person.id, first.getUTCFullYear());

    // One PENDING vacation request ...
    const monday = nthMonday(first, 2);
    const pendingId = await fileVacation(
      request,
      tenant,
      person.id,
      iso(monday),
      iso(new Date(monday.getTime() + 2 * DAY_MS)),
    );
    // ... and one APPROVED sick leave (the first of the current month, at most through today).
    const now = new Date();
    const monthStart = localDay(new Date(now.getFullYear(), now.getMonth(), 1));
    const sickEnd = [plusDays(monthStart, 1), localDay(now)].sort()[0];
    const sickRes = await request.post(`${API_BASE}/api/v1/leave/requests`, {
      headers: authHeaders(tenant),
      data: { employeeId: person.id, type: "SICK", startDate: monthStart, endDate: sickEnd },
    });
    expect(sickRes.status(), `file the sick leave (${await sickRes.text()})`).toBeLessThan(300);
    const sick = (await sickRes.json()) as { id: string; status: string };
    if (sick.status !== "APPROVED") {
      const approve = await request.patch(`${API_BASE}/api/v1/leave/requests/${sick.id}/review`, {
        headers: authHeaders(tenant),
        data: { status: "APPROVED" },
      });
      expect(approve.status(), `approve the sick leave (${await approve.text()})`).toBeLessThan(
        300,
      );
    }

    /** The computed colour of a design token, resolved through a probe element. */
    const tokenColor = (token: string) =>
      page.evaluate((name) => {
        const probe = document.createElement("div");
        probe.style.backgroundColor = `var(${name})`;
        document.body.appendChild(probe);
        const value = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return value;
      }, token);

    await loginAsTenantAdmin(page, tenant);

    // ── G-1: the count is on a directly opened Planung tab, neutral and explained ──────────
    await page.goto(`/team/leave?tab=planung&zoom=monat&datum=${PLAN_YEAR}-03-01`);
    const count = page.getByTestId("leave-team-view-list-badge");
    await expect(count).toBeVisible();
    await expect(count).toHaveText("1");
    // #853: the strip is PageTabs; its count pill is `page-tab-badge` (a link pill, still neutral -
    // the not-red assertion below is what pins "information, not alarm").
    await expect(count).toHaveClass(/page-tab-badge/);
    await expect(count).toHaveAttribute("title", /1 offen: 1 Antrag/);
    expect(await count.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(
      await tokenColor("--bad"),
    );

    // The toolbar with the count passes axe, colour contrast included.
    expect(await axeViolations(page), "axe on Planung with the open count").toEqual([]);

    // ... and on the Übersicht.
    await page.getByTestId("leave-team-view-uebersicht").click();
    await expect(page).toHaveURL(/tab=uebersicht/);
    await expect(page.getByTestId("leave-team-view-list-badge")).toHaveText("1");

    // A click on the count opens Anträge at „Offen“ and shows the counted request.
    await page.getByTestId("leave-team-view-list-badge").click();
    await expect(page).toHaveURL(/tab=antraege/);
    await expect(page).toHaveURL(/status=PENDING/);
    const row = page.getByTestId(`leave-team-row-${pendingId}`);
    await expect(row).toBeVisible();
    // #853: the Status filter is a toolbar filter; its active chip names the choice.
    await expect(page.getByText("Status: Offen", { exact: true })).toBeVisible();

    // ── G-3: the chip of the PENDING row is dashed in the vacation colour ────────────────────
    const vacation = await tokenColor("--leave-type-vacation");
    const pendingChip = row.getByTestId(`leave-team-row-${pendingId}-type-chip`);
    expect(await borderStyleOf(pendingChip)).toBe("dashed");
    expect(await pendingChip.evaluate((el) => getComputedStyle(el).borderTopColor)).toBe(vacation);

    // The approved sick row (all statuses, the current year) has a solid chip filled with the sick
    // colour. The list year follows the anchor day of the URL, so open it on today's year.
    await page.goto("/team/leave?tab=antraege");
    await expect(page.getByRole("button", { name: "Filter Status entfernen" })).toHaveCount(0);
    const sickChip = page
      .getByTestId(`leave-team-row-${sick.id}`)
      .getByTestId(`leave-team-row-${sick.id}-type-chip`);
    await expect(sickChip).toBeVisible();
    expect(await sickChip.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
      await tokenColor("--leave-type-sick"),
    );

    // ── G-3 / G-8: the inbox ─────────────────────────────────────────────────────────────────
    await page.goto("/inbox");
    const head = page.locator(".page-head");
    // #843 D-843-14 -> D-843-22 (owner 10.11.): the Seitenkopf renders no eyebrow (was "Team").
    await expect(head.locator(".eyebrow")).toHaveCount(0);
    await expect(head.getByRole("heading", { level: 1 })).toHaveText("Aufgaben"); // Issue #574: one page name
    await expect(head.locator("h1 em")).toHaveCount(0);
    // #853-19 (prototype „Aufgaben“): the inbox row names its type with the plain Chip - the dashed
    // LeaveTypeChip of G-3 stays on the Anträge list, where the timeline style belongs.
    const inboxRow = page.locator('[data-testid^="task-row-urlaub-"]').first();
    await expect(inboxRow).toBeVisible();
    await expect(inboxRow.locator(".leave-type-chip")).toHaveCount(0);
    const inboxChip = inboxRow.locator(".chip", { hasText: "Urlaub" }).first();
    await expect(inboxChip).toBeVisible();
    expect(await borderStyleOf(inboxChip)).not.toBe("dashed");
  });

  test("8. Abwesenheit eintragen: Für wen? + Art, then Von + Bis; stacked on a phone", async ({
    page,
    request,
    tenant,
  }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await createEmployee(request, tenant, { key: "frm", firstName: "Formular", lastName: "Zeile" });
    await loginAsTenantAdmin(page, tenant);

    // Team: „Abwesenheit eintragen“ — „Für wen?“ comes first and nothing else is offered until a
    // person is chosen; then row 1 Für wen? + Art, row 2 Von + Bis, no eyebrow.
    await page.goto("/team/leave?tab=uebersicht");
    await page.locator(".page-head").getByRole("button", { name: "Abwesenheit eintragen" }).click();
    const dialog = page.getByTestId("leave-form-modal");
    await expect(dialog).toBeVisible();
    await animationsSettled(page);
    const who = dialog.getByRole("combobox", { name: "Für wen?" });
    await expect(who).toBeVisible();
    await expect(who).toHaveValue("");
    await expect(page.locator("#f-type")).toBeHidden();
    await expect(page.locator("#f-start")).toBeHidden();
    await chooseFromCombobox(who, page.getByRole("option", { name: /Zeile, Formular/ }), "Zeile");
    await expect(who).toHaveValue(/Zeile, Formular/);
    await expect(page.locator("#f-type")).toBeVisible();
    // The person's balance block and the colleague hint load after the pick and grow (re-centre) the
    // dialog: the four boxes are read in ONE evaluate, so they come from the same layout.
    await expect(dialog.getByText("Jahresanspruch")).toBeVisible();
    await animationsSettled(page);
    const topOf = async (selector: string) => (await page.locator(selector).boundingBox())!;
    const boxes = () =>
      page.evaluate(() => {
        const rect = (selector: string) => {
          const r = document.querySelector(selector)!.getBoundingClientRect();
          return { y: r.y, width: r.width, height: r.height };
        };
        // The Combobox's field box (input + chevron) is the counterpart of the Art select's box.
        return {
          emp: rect('[data-testid="leave-form-modal"] .cb-field'),
          type: rect("#f-type"),
          from: rect("#f-start"),
          to: rect("#f-end"),
        };
      });
    const { emp, type, from, to } = await boxes();
    expect(Math.abs(emp.y - type.y), "Für wen? and Art share their top").toBeLessThanOrEqual(2);
    expect(emp.width, "the Für wen? field is wide enough").toBeGreaterThanOrEqual(200);
    expect(type.width, "the Art select is wide enough").toBeGreaterThanOrEqual(200);
    expect(Math.abs(from.y - to.y), "Von and Bis share their top").toBeLessThanOrEqual(2);
    expect(from.y, "the dates row is below the who row").toBeGreaterThan(emp.y + emp.height - 1);
    await expect(page.locator(".modal-eyebrow")).toHaveCount(0);

    // On a phone every field stacks.
    await page.setViewportSize({ width: 420, height: 800 });
    const phoneFrom = await topOf("#f-start");
    const phoneTo = await topOf("#f-end");
    expect(phoneTo.y, "Bis lies below Von on a phone").toBeGreaterThanOrEqual(
      phoneFrom.y + phoneFrom.height - 1,
    );
    const { emp: phoneEmp, type: phoneType } = await boxes();
    expect(phoneType.y, "Art lies below Für wen? on a phone").toBeGreaterThanOrEqual(
      phoneEmp.y + phoneEmp.height - 1,
    );

    // Own area: Von and Bis share a row on a desktop.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/leave");
    await page.getByTestId("leave-new-request").click();
    await expect(page.getByTestId("leave-form-modal")).toBeVisible();
    await animationsSettled(page);
    const ownFrom = await topOf("#f-start");
    const ownTo = await topOf("#f-end");
    expect(
      Math.abs(ownFrom.y - ownTo.y),
      "Von and Bis share their top (own form)",
    ).toBeLessThanOrEqual(2);
    await expect(page.locator(".modal-eyebrow")).toHaveCount(0);
  });

  test("9. primary buttons: the same recipe as elsewhere, WCAG AA in every theme, mode and state", async ({
    page,
    request,
    tenant,
  }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const person = await createEmployee(request, tenant, {
      key: "prm",
      firstName: "Knopf",
      lastName: "Farbe",
    });
    await ensureEntitlement(request, tenant, person.id, PLAN_YEAR);
    const salonId = await defaultSalonId(request, tenant);
    await openPlanViaApi(request, tenant, salonId, PLAN_YEAR);
    await loginAsTenantAdmin(page, tenant);

    interface Look {
      theme: "pflaume" | "salz" | "petrol";
      mode: "light" | "dark";
    }
    interface Painted {
      text: string;
      stops: string[];
    }

    /** Sets the look on <html> in the page only (nothing is persisted) and switches transitions off. */
    const applyLook = (look: Look) =>
      page.evaluate((l) => {
        if (!document.getElementById("e2e-no-motion")) {
          const style = document.createElement("style");
          style.id = "e2e-no-motion";
          style.textContent =
            "*, *::before, *::after { transition: none !important; animation: none !important; }";
          document.head.appendChild(style);
        }
        const root = document.documentElement;
        root.setAttribute("data-theme", l.theme);
        root.setAttribute("data-mode", l.mode);
      }, look);

    /** Computed text colour and every opaque background stop (a solid fill is its one stop). */
    const paintOf = (button: Locator): Promise<Painted> =>
      button.evaluate((el) => {
        const cs = getComputedStyle(el);
        const image = cs.backgroundImage;
        const stops = image === "none" ? [] : (image.match(/rgba?\([^)]*\)/g) ?? []);
        return { text: cs.color, stops: stops.length > 0 ? stops : [cs.backgroundColor] };
      });

    const ratioOf = (painted: Painted) => {
      const text = parseColor(painted.text);
      return painted.stops.map((stop) => {
        const bg = parseColor(stop);
        expect(bg.a, `background stop ${stop} is opaque`).toBe(1);
        const [hi, lo] = [luminance(text), luminance(bg)].sort((a, b) => b - a);
        return (hi + 0.05) / (lo + 0.05);
      });
    };

    const looks: Look[] = [];
    for (const theme of ["pflaume", "salz", "petrol"] as const)
      for (const mode of ["light", "dark"] as const) looks.push({ theme, mode });

    const pages: Array<{
      url: string;
      buttons: Array<{ name: string; locate: () => Locator }>;
    }> = [
      {
        url: "/team/leave?tab=uebersicht",
        buttons: [
          {
            name: "team: Abwesenheit eintragen",
            locate: () =>
              page.locator(".page-head").getByRole("button", { name: "Abwesenheit eintragen" }),
          },
        ],
      },
      {
        url: `/team/leave?tab=planung&zoom=monat&datum=${PLAN_YEAR}-03-01`,
        buttons: [
          { name: "team: Planung verwalten", locate: () => page.getByTestId("leave-plan-manage") },
          {
            name: "team: Wunsch hinzufügen",
            locate: () => page.getByTestId("leave-plan-add-wish"),
          },
        ],
      },
      {
        url: "/leave",
        buttons: [
          { name: "own: + Neue Abwesenheit", locate: () => page.getByTestId("leave-new-request") },
        ],
      },
      {
        url: "/admin/employees",
        buttons: [{ name: "reference", locate: () => page.getByTestId("admin-employees-add") }],
      },
    ];

    // reference[look][state]; filled from the last page, but the reference page is visited first.
    const reference = new Map<string, Painted>();
    const failures: string[] = [];
    const table: string[] = [];
    const order = [pages[3], pages[0], pages[1], pages[2]];
    for (const entry of order) {
      await page.goto(entry.url);
      for (const spec of entry.buttons) {
        const button = spec.locate();
        await expect(button, spec.name).toBeVisible();
        for (const look of looks) {
          await applyLook(look);
          for (const state of ["rest", "hover"] as const) {
            if (state === "hover") await button.hover();
            else await page.mouse.move(0, 0);
            const painted = await paintOf(button);
            const key = `${look.theme}/${look.mode}/${state}`;
            if (spec.name === "reference") reference.set(key, painted);
            const ratios = ratioOf(painted);
            const lowest = Math.min(...ratios);
            const ref = reference.get(key);
            table.push(
              `${spec.name} | ${key} | text ${painted.text} on ${painted.stops.join(" -> ")} | min ${lowest.toFixed(2)}:1${
                ref && spec.name !== "reference"
                  ? ` | ref ${ref.text} on ${ref.stops.join(" -> ")}`
                  : ""
              }`,
            );
            if (lowest < 4.5) failures.push(`AA ${spec.name} ${key}: ${lowest.toFixed(2)}:1`);
            if (ref && spec.name !== "reference") {
              if (JSON.stringify(ref) !== JSON.stringify(painted)) {
                failures.push(`differs from the reference ${spec.name} ${key}`);
              }
            }
          }
        }
        await page.mouse.move(0, 0);
      }
    }
    test.info().annotations.push({ type: "primary-buttons", description: table.join("\n") });
    console.log(`PRIMARY-BUTTON TABLE\n${table.join("\n")}`);
    expect(failures, failures.join("\n")).toEqual([]);
  });
});
