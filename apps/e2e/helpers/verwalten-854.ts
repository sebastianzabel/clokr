/**
 * Issue #854 (D-854-17) - shared by the gating spec verwalten-854.spec.ts and the capture spec
 * screenshots-854.spec.ts: the page list (fixtures/verwalten-854-pages.json), the tenant-admin
 * sign-in, the fixture entity a dynamic page needs, and the settle step before anything is measured.
 *
 * Fixture tenant only, synthetic names: nothing here reads or creates real data.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { APIRequestContext, Page } from "@playwright/test";
import { expect } from "../fixtures";
import type { TestTenant } from "../fixtures";

const API_BASE = process.env.E2E_API_BASE ?? "http://localhost:4001";
const PASSWORD = "test1234";

/** The synthetic name of the salon a salon detail page is opened for. */
export const FIXTURE_SALON_NAME = "Salon Nord";

/** The synthetic person a person detail page is opened for (the H1 reads „first last“). */
export const FIXTURE_EMPLOYEE_NAME = "Person A";

export interface PageTab {
  label: string;
}

export interface MigratedPage {
  slug: string;
  path: string;
  /** Exact H1 text, or a name token (e.g. ":salonName") resolved from the `fill` entity. */
  heading: string;
  tabs: PageTab[];
  fill?: string;
}

interface PageList {
  fills: Record<string, { placeholder: string; nameToken: string }>;
  pages: MigratedPage[];
}

const list = JSON.parse(
  readFileSync(resolve(__dirname, "../fixtures/verwalten-854-pages.json"), "utf8"),
) as PageList;

// An empty list would define zero tests and report success; refuse to run on one.
if (!Array.isArray(list.pages) || list.pages.length < 2) {
  throw new Error(`verwalten-854-pages.json lists only ${list.pages?.length ?? 0} pages`);
}
const slugs = new Set<string>();
for (const entry of list.pages) {
  if (slugs.has(entry.slug))
    throw new Error(`verwalten-854-pages.json: duplicate slug ${entry.slug}`);
  slugs.add(entry.slug);
  if (entry.fill !== undefined && list.fills[entry.fill] === undefined) {
    throw new Error(`verwalten-854-pages.json: ${entry.slug} names the unknown fill ${entry.fill}`);
  }
}

export const MIGRATED_PAGES: readonly MigratedPage[] = list.pages;

/** First day of the previous month, so the fixture person has a hire date in the past. */
function firstOfPreviousMonth(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
    .toISOString()
    .slice(0, 10);
}

/** The week a salon created through the API gets: Monday to Saturday open, Sunday closed. */
const WEEK = [0, 1, 2, 3, 4, 5, 6].map((day) => ({
  day,
  open: "09:00",
  close: "18:00",
  ...(day === 6 ? { closed: true } : {}),
}));

export async function signInAsTenantAdmin(
  page: Page,
  request: APIRequestContext,
  tenant: TestTenant,
): Promise<void> {
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

/** The URL and the exact H1 text of a page, after creating the entity its placeholder names. */
export async function resolvePage(
  request: APIRequestContext,
  tenant: TestTenant,
  entry: MigratedPage,
): Promise<{ url: string; heading: string }> {
  if (entry.fill === undefined) return { url: entry.path, heading: entry.heading };
  const fill = list.fills[entry.fill];
  const headers = {
    "content-type": "application/json",
    Authorization: `Bearer ${tenant.adminToken}`,
  };
  if (entry.fill === "salon") {
    const res = await request.post(`${API_BASE}/api/v1/salons`, {
      headers,
      data: { name: FIXTURE_SALON_NAME, federalState: "HESSEN", openingHours: WEEK },
    });
    expect(res.status(), `create salon (${await res.text()})`).toBe(201);
    const id = ((await res.json()) as { id: string }).id;
    return {
      url: entry.path.replace(fill.placeholder, id),
      heading: entry.heading.replace(fill.nameToken, FIXTURE_SALON_NAME),
    };
  }
  if (entry.fill === "employee") {
    const [firstName, lastName] = FIXTURE_EMPLOYEE_NAME.split(" ");
    const res = await request.post(`${API_BASE}/api/v1/employees`, {
      headers,
      data: {
        email: `person-a.${tenant.tenantId.toLowerCase()}@example.invalid`,
        firstName,
        lastName,
        employeeNumber: `E854-${tenant.tenantId.slice(-4)}`,
        hireDate: `${firstOfPreviousMonth()}T00:00:00.000Z`,
        scheduleType: "FIXED_SCHEDULE",
        weeklyHours: 40,
      },
    });
    expect(res.status(), `create employee (${await res.text()})`).toBe(201);
    const id = ((await res.json()) as { id: string }).id;
    return {
      url: entry.path.replace(fill.placeholder, id),
      heading: entry.heading.replace(fill.nameToken, FIXTURE_EMPLOYEE_NAME),
    };
  }
  throw new Error(`verwalten-854-pages.json: unknown fill ${entry.fill}`);
}

/**
 * Opens a page and waits until it rendered (its H1 is visible and the browser stayed on the path:
 * a guard redirect would otherwise measure the wrong page and pass vacuously).
 */
export async function openPage(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expect(page.locator("header.page-head h1")).toBeVisible({ timeout: 15_000 });
  expect(new URL(page.url()).pathname, "stayed on the requested path").toBe(
    new URL(url, "http://localhost").pathname,
  );
}

/** Webfonts change text widths; the layout is measured only after fonts and two frames settled. */
export async function settle(page: Page): Promise<void> {
  // A page that polls never goes network-idle; the wait is bounded and a timeout is not an error
  // (the H1 assertion of openPage already proved the page rendered).
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolveFrame) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame())),
    );
  });
  // Entrance animations (`.card-animate` fadeUp) fade a block in from opacity 0; axe measures colour
  // contrast on the blended pixels, so a scan during the fade reports a false contrast violation
  // (Issue #936: the period bar of Berichte was scanned at opacity 0.43). Wait until every finite
  // animation has finished - the same wait as hr-view-86 and reports-period use.
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (a) => a.effect?.getComputedTiming().iterations === Infinity || a.playState !== "running",
      ),
  );
}
