/**
 * Issue #621 — the shared tab strip (`.view-tabs`, rendered by SectionStack and ListDetail) fits
 * narrow phone viewports.
 *
 * Before the fix, at 390 px `/admin/system` (five tabs) was ~565 px wide and the whole page
 * scrolled sideways. The strip now scrolls on its own. This spec is the permanent gate: per page x
 * skin x viewport it proves that
 *   - the document does not scroll horizontally,
 *   - the strip really is wider than its box on the narrowest page (non-vacuous: otherwise the
 *     check would pass on a page whose tabs simply fit),
 *   - a tab chosen with the keyboard (End) or by clicking the last tab is active and lies fully
 *     inside the strip and the viewport, with its 2 px underline not clipped.
 *
 * Auth: same model as month-bar-narrow-viewport.spec.ts (throwaway tenant, API login,
 * localStorage hydrated with addInitScript). No fixed sleeps.
 */
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import type { TestTenant } from "../fixtures";

const API_BASE = process.env.E2E_API_BASE ?? "http://localhost:4001";
const PASSWORD = "test1234";
const TOLERANCE_PX = 0.5;

const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 360, height: 800 },
] as const;

const SKINS = ["editorial", "modern"] as const;
type Skin = (typeof SKINS)[number];

/** Pages whose SectionStack renders a tab strip; `/admin/system` has the widest one (5 tabs). */
const PAGES = [
  { path: "/admin/system", widest: true },
  { path: "/admin/vacation", widest: false },
] as const;

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

interface StripGeometry {
  innerWidth: number;
  docScrollWidth: number;
  stripScrollWidth: number;
  stripClientWidth: number;
  active: {
    label: string;
    left: number;
    right: number;
    bottom: number;
    borderBottomWidth: number;
  } | null;
  strip: { left: number; right: number; bottom: number };
}

async function measure(strip: Locator): Promise<StripGeometry> {
  return strip.evaluate((el) => {
    const s = el.getBoundingClientRect();
    const active = el.querySelector<HTMLElement>(".view-tab--active");
    const a = active?.getBoundingClientRect();
    return {
      innerWidth: window.innerWidth,
      docScrollWidth: document.documentElement.scrollWidth,
      stripScrollWidth: el.scrollWidth,
      stripClientWidth: el.clientWidth,
      active:
        active && a
          ? {
              label: active.textContent?.trim() ?? "",
              left: a.left,
              right: a.right,
              bottom: a.bottom,
              borderBottomWidth: parseFloat(getComputedStyle(active).borderBottomWidth),
            }
          : null,
      strip: { left: s.left, right: s.right, bottom: s.bottom },
    };
  });
}

function expectActiveInside(g: StripGeometry, expectedLabel: string, where: string) {
  expect(g.active, `${where}: an active tab exists`).not.toBeNull();
  const a = g.active!;
  expect(a.label, `${where}: the chosen tab is active`).toBe(expectedLabel);
  expect(a.left, `${where}: active tab starts inside the strip`).toBeGreaterThanOrEqual(
    g.strip.left - TOLERANCE_PX,
  );
  expect(a.right, `${where}: active tab ends inside the strip`).toBeLessThanOrEqual(
    g.strip.right + TOLERANCE_PX,
  );
  expect(a.right, `${where}: active tab ends inside the viewport`).toBeLessThanOrEqual(
    g.innerWidth + TOLERANCE_PX,
  );
  // The underline sits in the strip's last 2 px; it must not be clipped by the strip's overflow.
  expect(a.borderBottomWidth, `${where}: active underline width`).toBe(2);
  expect(a.bottom, `${where}: active underline inside the strip`).toBeLessThanOrEqual(
    g.strip.bottom + TOLERANCE_PX,
  );
}

async function openPage(page: Page, path: string): Promise<Locator> {
  await page.goto(path);
  // The app re-navigates once after auth hydration; SectionStack then writes the active tab into
  // the hash. Measure only after that settled, never mid-navigation.
  await page.waitForURL(/#.+/);
  const strip = page.locator(".view-tabs").first();
  await expect(strip).toBeVisible();
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  return strip;
}

for (const viewport of VIEWPORTS) {
  test.describe(`${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport });

    for (const skin of SKINS) {
      for (const p of PAGES) {
        test(`${p.path} — ${skin} — tab strip fits ${viewport.width} px`, async ({
          page,
          request,
          tenant,
        }) => {
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
          const where = `${p.path} / ${skin} / ${viewport.width} px`;
          const strip = await openPage(page, p.path);
          if (skin === "modern") {
            await expect(page.locator("html")).toHaveAttribute("data-skin", "modern");
          } else {
            await expect(page.locator("html")).not.toHaveAttribute("data-skin", /.*/);
          }

          const tabs = strip.getByRole("tab");
          const count = await tabs.count();
          expect(count, `${where}: the page has a tab strip`).toBeGreaterThanOrEqual(2);

          const initial = await measure(strip);
          expect(
            initial.docScrollWidth,
            `${where}: page does not scroll sideways`,
          ).toBeLessThanOrEqual(initial.innerWidth);
          if (p.widest) {
            // Non-vacuous: the five-tab strip is wider than the phone, so it must scroll itself.
            expect(
              initial.stripScrollWidth,
              `${where}: the strip overflows its own box`,
            ).toBeGreaterThan(initial.stripClientWidth);
          }

          // Keyboard: End selects the last tab, which must scroll into the strip's view.
          const lastLabel = (await tabs.nth(count - 1).textContent())?.trim() ?? "";
          await tabs.first().click();
          await tabs.first().press("End");
          await expect(tabs.nth(count - 1)).toHaveAttribute("aria-selected", "true");
          await expect
            .poll(async () => (await measure(strip)).active?.right ?? Infinity)
            .toBeLessThanOrEqual(initial.strip.right + TOLERANCE_PX);
          const afterEnd = await measure(strip);
          expectActiveInside(afterEnd, lastLabel, `${where} (End)`);
          expect(afterEnd.docScrollWidth, `${where}: still no page scroll`).toBeLessThanOrEqual(
            afterEnd.innerWidth,
          );

          // Home brings the first tab back into view.
          const firstLabel = (await tabs.first().textContent())?.trim() ?? "";
          await tabs.nth(count - 1).press("Home");
          await expect(tabs.first()).toHaveAttribute("aria-selected", "true");
          await expect
            .poll(async () => (await measure(strip)).active?.left ?? -Infinity)
            .toBeGreaterThanOrEqual(initial.strip.left - TOLERANCE_PX);
          expectActiveInside(await measure(strip), firstLabel, `${where} (Home)`);
        });
      }
    }
  });
}
