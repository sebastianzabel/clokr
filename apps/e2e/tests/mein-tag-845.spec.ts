/**
 * Issue #845 — Ich › Mein Tag: the four states of the clock stage and the first phone screen.
 *
 *   AC-1  At 390×844 the stage, Stundenkonto, Resturlaub and Nächste Schicht are fully visible
 *         without scrolling; at 360 px the page has no horizontal overflow.
 *   AC-2  The four stage states with their texts (D-02): ruhig „Noch nicht eingestempelt“, arbeitet
 *         „Du arbeitest“, Pause „Pause … Arbeitszeit steht“ (the working-time figure stands still),
 *         fertig „Ausgestempelt um HH:MM“ with „Wieder einstempeln“ — never „Tag abgeschlossen“.
 *   AC-3  Every clock action is acknowledged in the toast status region (role=status).
 *
 * A fresh tenant gives a deterministic idle day. Auth: API login plus addInitScript (the model of
 * startpage-feedback-843.spec.ts). No fixed sleeps: the pause interval is a jump of the browser
 * clock (page.clock), every other wait an auto-waiting assertion.
 */
import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import type { TestTenant } from "../fixtures";
import { zonedInstant } from "../helpers/tenant-zone";

const API_BASE = process.env.E2E_API_BASE ?? "http://localhost:4001";
const PASSWORD = "test1234";

async function signIn(page: Page, request: APIRequestContext, tenant: TestTenant): Promise<void> {
  const res = await request.post(`${API_BASE}/api/v1/auth/login`, {
    headers: { "content-type": "application/json" },
    data: { email: `admin@${tenant.tenantId}.test`, password: PASSWORD },
  });
  expect(res.ok(), `login as the tenant admin (${res.status()})`).toBe(true);
  const auth = (await res.json()) as {
    accessToken: string;
    refreshToken: string;
    user: Record<string, unknown>;
  };
  await page.addInitScript(({ accessToken, refreshToken, user }) => {
    try {
      localStorage.setItem("accessToken", accessToken);
      localStorage.setItem("refreshToken", refreshToken);
      localStorage.setItem("user", JSON.stringify(user));
    } catch {
      /* localStorage may be locked; the auth store then falls back to the login page */
    }
  }, auth);
}

test.use({ storageState: { cookies: [], origins: [] } });

test("the four stage states, each action acknowledged (AC-2, AC-3)", async ({
  page,
  request,
  tenant,
}) => {
  await signIn(page, request, tenant);
  // A controllable browser clock: the pause check jumps two minutes instead of waiting for them.
  await page.clock.install();
  await page.goto("/ich/tag");
  const stage = page.locator(".clock-stage");
  const state = page.getByTestId("clock-state");
  const region = page.getByTestId("toast-region-status");

  // ruhig
  await expect(stage).toHaveAttribute("data-day-state", "idle");
  await expect(state).toHaveText("Noch nicht eingestempelt");
  await expect(page.locator(".stage")).toHaveAttribute("data-state", "ruhig");

  // arbeitet
  await page.getByRole("button", { name: "Einstempeln", exact: true }).click();
  await expect(region).toHaveText(/^\s*Eingestempelt \d{2}:\d{2}( · \S.*)?\s*$/);
  await expect(state).toHaveText("Du arbeitest");
  await expect(page.locator(".stage")).toHaveAttribute("data-state", "arbeitet");
  await expect(stage).toContainText(/seit \d{2}:\d{2}/);

  // Pause: the working-time figure stands still
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(region).toContainText(/Pause gestartet \d{2}:\d{2}/);
  await expect(state).toHaveText("Pause");
  await expect(page.locator(".stage")).toHaveAttribute("data-state", "pause");
  await expect(stage).toContainText("Arbeitszeit steht");
  const big = page.getByTestId("clock-big");
  const during = await big.textContent();
  // Ausstempeln waits while a break runs; „Weiterarbeiten“ is the one primary action.
  await expect(page.getByRole("button", { name: "Ausstempeln", exact: true })).toHaveCount(0);
  await page.clock.fastForward("02:00");
  await expect(stage).toContainText(/läuft [2-9] min/);
  await expect(big).toHaveText(during ?? "");

  await page.getByRole("button", { name: "Weiterarbeiten", exact: true }).click();
  await expect(region).toContainText(/Pause beendet \d{2}:\d{2}/);
  await expect(state).toHaveText("Du arbeitest");

  // fertig
  await page.getByRole("button", { name: "Ausstempeln", exact: true }).click();
  await expect(region).toContainText(/Ausgestempelt \d{2}:\d{2}/);
  await expect(stage).toHaveAttribute("data-day-state", "finished");
  await expect(state).toHaveText(/^\s*Ausgestempelt um \d{2}:\d{2}\s*$/);
  await expect(page.locator(".stage")).toHaveAttribute("data-state", "fertig");
  await expect(stage).toContainText("Netto");
  await expect(page.getByText("Tag abgeschlossen")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Wieder einstempeln", exact: true })).toBeVisible();
});

test.describe("phone (AC-1)", () => {
  test("at 390×844 stage, Stundenkonto, Resturlaub and Nächste Schicht are on the first screen", async ({
    page,
    request,
    tenant,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, request, tenant);
    await page.goto("/ich/tag");
    await expect(page.getByTestId("mein-tag-stage")).toBeVisible();
    // The phone tab bar covers the bottom of the viewport: the first screen ends at its top edge.
    const tabBar = page.locator("nav.bottom-tab-bar");
    const barBox = (await tabBar.isVisible()) ? await tabBar.boundingBox() : null;
    const screenBottom = barBox ? barBox.y : 844;
    for (const id of ["mein-tag-stage", "kpi-saldo", "kpi-vacation", "kpi-next-shift"]) {
      const el = page.getByTestId(id);
      await expect(el, `${id} is rendered`).toBeVisible();
      const box = await el.boundingBox();
      expect(box, `${id} has a box`).not.toBeNull();
      expect(box!.y + box!.height, `${id} ends inside the first screen`).toBeLessThanOrEqual(
        screenBottom,
      );
      expect(box!.x + box!.width, `${id} fits the width`).toBeLessThanOrEqual(390 + 1);
    }
    // The window was never scrolled to see them.
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  });

  test("at 360 px the page has no horizontal overflow", async ({ page, request, tenant }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    await signIn(page, request, tenant);
    await page.goto("/ich/tag");
    await expect(page.getByTestId("mein-tag-kpis")).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test.describe("an open entry of an earlier day (Issue #942)", () => {
  const TZ = "Europe/Berlin";
  test.use({ timezoneId: TZ });

  test("Mein Tag names it, keeps today's clock and opens its edit dialog in Zeiten", async ({
    page,
    request,
    tenant,
  }) => {
    // Three days back: older than yesterday (the resolver looks back one day only) and well inside
    // the retro window; a fixed start far from midnight keeps it away from the #922 day change.
    const [y, m, d] = new Date()
      .toLocaleDateString("sv-SE", { timeZone: TZ })
      .split("-")
      .map(Number);
    const back = new Date(Date.UTC(y, m - 1, d - 3));
    const day = back.toISOString().slice(0, 10);
    const res = await request.post(`${API_BASE}/api/v1/time-entries`, {
      headers: { "content-type": "application/json", Authorization: `Bearer ${tenant.adminToken}` },
      data: { date: day, startTime: zonedInstant(day, "09:15", TZ).toISOString(), breakMinutes: 0 },
    });
    expect(res.status(), `record an open entry on ${day} (${await res.text()})`).toBe(201);

    await signIn(page, request, tenant);
    await page.goto("/ich/tag");
    const hint = page.getByTestId("mein-tag-open-earlier");
    await expect(hint).toContainText(
      /Dein Eintrag vom \S+, \d{1,2}\.\d{1,2}\. ist noch offen – seit 09:15\./,
    );
    await expect(hint).toContainText("Einstempeln beginnt heute einen neuen Eintrag");
    // today's own clock state is unchanged
    await expect(page.getByTestId("clock-state")).toHaveText("Noch nicht eingestempelt");

    await page.getByTestId("mein-tag-open-earlier-end").click();
    await expect(page).toHaveURL(new RegExp(`/ich/zeiten\\?date=${day}&end=`));
    await expect(page.getByRole("dialog")).toContainText("Eintrag bearbeiten");
  });
});
