/**
 * Issue #553 — the month bar fits narrow phone viewports on every page that uses MonthBar or the
 * .cal-monthbar recipe (/shifts has its own week header and is not covered here).
 *
 * Before the fix, at 390 px every page with a MonthBar / .cal-monthbar was wider than the phone
 * (editorial skin: horizontal scroll, 410-514 px) or had "Heute" cut off (modern skin). This spec
 * is the permanent gate: per surface x skin x viewport it proves that
 *   - the document does not scroll horizontally,
 *   - no element of the bar lies outside the viewport or outside the bar's own box,
 *   - the month label is one line and clear of the previous/next arrows,
 *   - "Heute" (where the page offers it) is visible, exactly labelled, fully inside the viewport,
 *     at least 44 px tall (the height of the neighbouring arrow buttons) and still works.
 *
 * Why geometry and not only scrollWidth: the modern skin clips overflow with
 * `[data-skin="modern"] .card { overflow: hidden }`, so there document.scrollWidth stays equal to
 * innerWidth (390) while "Heute" is cut off at x = 414-428. A scrollWidth check alone would be
 * vacuous in that skin, which is why the bar's descendants and "Heute" are measured directly.
 *
 * Why September: "September 2026" is the longest German month name, so the gate cannot pass in
 * May and fail in September. The browser clock is fixed at 2026-09-16 (page.clock.install).
 *
 * Auth: the tenant fixture bootstraps a throwaway tenant on the test stack; the spec logs in as
 * its admin through the API and hydrates localStorage with addInitScript (same model as
 * visual.spec.ts, without the seed). The modern skin is additionally stored as the user's
 * server-side preference, because the server value wins over localStorage on hydration.
 *
 * No fixed sleeps: every wait is an auto-waiting locator assertion (the e2e lint bans sleeps).
 */
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import type { TestTenant } from "../fixtures";

const API_BASE = process.env.E2E_API_BASE ?? "http://localhost:4001";
const PASSWORD = "test1234";

/**
 * Two widths are pass/fail (360x800 is one of the most common Android sizes). 320 px is not
 * covered yet: it still overflows outside the bar on /leave and /team/leave (Issue #564).
 */
const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 360, height: 800 },
] as const;

const SKINS = ["editorial", "modern"] as const;
type Skin = (typeof SKINS)[number];

interface Surface {
  path: string;
  /** Switch /leave to its list view (the year bar) before measuring. */
  listView?: boolean;
  /** Expected label text of the bar. */
  label: string;
  prev: string;
  next: string;
  /** Whether the bar offers a "Heute" button. */
  today: boolean;
}

const MONTH = { label: "September 2026", prev: "Vorheriger Monat", next: "Nächster Monat" };

const SURFACES: Surface[] = [
  { path: "/time-entries", ...MONTH, today: true },
  { path: "/team/time-entries", ...MONTH, today: true },
  { path: "/leave", ...MONTH, today: true },
  {
    path: "/leave",
    listView: true,
    label: "2026",
    prev: "Vorheriges Jahr",
    next: "Nächstes Jahr",
    today: false,
  },
  { path: "/team/leave", ...MONTH, today: true },
  { path: "/teamcal", ...MONTH, today: true },
];

const BAR_SELECTOR = ".month-bar, .cal-monthbar";
const LABEL_SELECTOR = ".month-bar-label, .cal-monthbar-title";
/** D-04: the neighbouring .nav-btn arrows are 44 px tall. */
const MIN_TOUCH_TARGET_PX = 44;
const TOLERANCE_PX = 0.5;

async function login(request: APIRequestContext, tenant: TestTenant, skin: Skin) {
  const res = await request.post(`${API_BASE}/api/v1/auth/login`, {
    headers: { "content-type": "application/json" },
    data: { email: `admin@${tenant.tenantId}.test`, password: PASSWORD },
  });
  expect(res.ok(), `login as the tenant admin (${res.status()})`).toBe(true);
  const body = (await res.json()) as {
    accessToken: string;
    refreshToken: string;
    user: Record<string, unknown>;
  };
  if (skin === "modern") {
    const pref = await request.put(`${API_BASE}/api/v1/me/preferences`, {
      headers: { "content-type": "application/json", Authorization: `Bearer ${body.accessToken}` },
      data: { skin: "modern" },
    });
    expect(pref.ok(), `store the modern skin preference (${pref.status()})`).toBe(true);
  }
  return body;
}

interface BarGeometry {
  innerWidth: number;
  scrollWidth: number;
  outside: string[];
  labelFontSize: number;
  label: { left: number; right: number; height: number } | null;
  prevRight: number | null;
  nextLeft: number | null;
}

async function measure(bar: Locator, prev: string, next: string): Promise<BarGeometry> {
  return bar.evaluate(
    (el, args) => {
      const tol = args.tol;
      const rect = (e: Element) => e.getBoundingClientRect();
      const iw = window.innerWidth;
      const barRect = rect(el);
      const outside = [...el.querySelectorAll("*")]
        .filter((e) => {
          const r = rect(e);
          if (r.width === 0 && r.height === 0) return false;
          return (
            r.left < -tol ||
            r.right > iw + tol ||
            r.left < barRect.left - tol ||
            r.right > barRect.right + tol
          );
        })
        .map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join(".")}`);
      const arrow = (name: string) =>
        [...el.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === name);
      const prevBtn = arrow(args.prev);
      const nextBtn = arrow(args.next);
      const labelEl = el.querySelector(args.labelSelector);
      const labelRect = labelEl ? rect(labelEl) : null;
      return {
        innerWidth: iw,
        scrollWidth: document.documentElement.scrollWidth,
        outside,
        labelFontSize: labelEl ? parseFloat(getComputedStyle(labelEl).fontSize) : 0,
        label: labelRect
          ? { left: labelRect.left, right: labelRect.right, height: labelRect.height }
          : null,
        prevRight: prevBtn ? rect(prevBtn).right : null,
        nextLeft: nextBtn ? rect(nextBtn).left : null,
      };
    },
    { prev, next, tol: TOLERANCE_PX, labelSelector: LABEL_SELECTOR },
  );
}

async function openSurface(page: Page, surface: Surface): Promise<Locator> {
  await page.goto(surface.path);
  if (surface.listView) {
    await page.getByTestId("leave-view-list").click();
  }
  const bar = page.locator(BAR_SELECTOR).first();
  await expect(bar).toBeVisible();
  // Webfonts change the label width; measure only after they are loaded.
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  return bar;
}

for (const viewport of VIEWPORTS) {
  test.describe(`${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport });

    for (const skin of SKINS) {
      for (const surface of SURFACES) {
        const surfaceName = `${surface.path}${surface.listView ? " list" : ""}`;
        const id = `${surfaceName} — ${skin} — month bar fits ${viewport.width} px`;

        test(id, async ({ page, request, tenant }, testInfo) => {
          const auth = await login(request, tenant, skin);
          await page.addInitScript(
            ({ accessToken, refreshToken, user, skinName }) => {
              try {
                localStorage.setItem("accessToken", accessToken);
                localStorage.setItem("refreshToken", refreshToken);
                localStorage.setItem("user", JSON.stringify(user));
                localStorage.setItem("skin", skinName);
              } catch {
                /* localStorage may be locked; the auth store then falls back to the login page */
              }
            },
            { ...auth, skinName: skin },
          );
          await page.clock.install({ time: new Date("2026-09-16T10:00:00") });

          const where = `${surfaceName} / ${skin} / ${viewport.width} px`;
          const bar = await openSurface(page, surface);

          // Anti-vacuity: the widest label is on screen and the skin under test is active.
          const label = bar.locator(LABEL_SELECTOR).first();
          await expect(label).toContainText(surface.label);
          if (skin === "modern") {
            await expect(page.locator("html")).toHaveAttribute("data-skin", "modern");
          } else {
            await expect(page.locator("html")).not.toHaveAttribute("data-skin", /.*/);
          }

          const g = await measure(bar, surface.prev, surface.next);

          expect(
            g.scrollWidth,
            `${where}: document is wider than the viewport`,
          ).toBeLessThanOrEqual(g.innerWidth);
          expect(g.outside, `${where}: bar elements outside the viewport or the bar`).toEqual([]);

          expect(g.label, `${where}: month label not found`).not.toBeNull();
          expect(g.prevRight, `${where}: previous arrow not found`).not.toBeNull();
          expect(g.nextLeft, `${where}: next arrow not found`).not.toBeNull();
          if (g.label && g.prevRight !== null && g.nextLeft !== null) {
            expect(
              g.label.left,
              `${where}: label collides with the previous arrow`,
            ).toBeGreaterThanOrEqual(g.prevRight - TOLERANCE_PX);
            expect(
              g.label.right,
              `${where}: label collides with the next arrow`,
            ).toBeLessThanOrEqual(g.nextLeft + TOLERANCE_PX);
            expect(g.label.height, `${where}: label wraps onto a second line`).toBeLessThan(
              2 * g.labelFontSize,
            );
          }

          if (surface.today) {
            const today = bar.getByRole("button", { name: "Heute", exact: true });
            await expect(today, `${where}: "Heute" is missing`).toBeVisible();
            await expect(today).toHaveText("Heute");
            // The bar sits below the KPI rows, so on /leave its vertical position changes while
            // the page data loads (measured: y 765 -> 982 at 360x800). Scroll first, so
            // "fully on screen" answers the horizontal question this gate is about instead of
            // racing the fold.
            await today.scrollIntoViewIfNeeded();
            await expect(today, `${where}: "Heute" is not fully on screen`).toBeInViewport({
              ratio: 1,
            });
            const box = await today.boundingBox();
            expect(box, `${where}: "Heute" has no box`).not.toBeNull();
            expect(
              box?.x ?? -1,
              `${where}: "Heute" starts left of the viewport`,
            ).toBeGreaterThanOrEqual(0);
            expect(
              (box?.x ?? 0) + (box?.width ?? 0),
              `${where}: "Heute" ends right of the viewport`,
            ).toBeLessThanOrEqual(viewport.width);
            // Layout reports a 44 px min-height at sub-pixel y offsets as 43.99997; round to
            // 0.1 px so floating-point noise (measured, flaky) cannot fail a correct 44 px.
            expect(
              Math.round((box?.height ?? 0) * 10) / 10,
              `${where}: "Heute" is smaller than the 44 px touch target`,
            ).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);

            // It still works: previous month changes the label, "Heute" brings September back.
            await bar.getByRole("button", { name: surface.prev, exact: true }).click();
            await expect(label).not.toContainText(surface.label);
            await today.click();
            await expect(label).toContainText(surface.label);
          }

          await testInfo.attach(
            `${surface.path.replaceAll("/", "_")}${surface.listView ? "-list" : ""}-${skin}-${viewport.width}.png`,
            { body: await bar.screenshot(), contentType: "image/png" },
          );
        });
      }
    }
  });
}
