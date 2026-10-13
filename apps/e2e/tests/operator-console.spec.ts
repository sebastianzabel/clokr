/**
 * Issue #89 - the operator console (/betreiber) against the operator API contract.
 *
 * The question this spec answers: does the browser side of the console - session guard, operator
 * client, tenant detail page, salon table - work against the shapes the operator API serves
 * (GET /api/v1/operator/tenants/:id and /tenants/:id/salons)?
 *
 * Why the operator API is mocked: CI has no operator account (OPERATOR_JWT_SECRET is unset on the
 * test stack, so the surface is absent there) and no way to complete the TOTP sign-in. Interception
 * with page.route happens in the browser, before the request reaches the web proxy, so nothing
 * here depends on the API. Every operator request is fulfilled, never continued, so a request
 * that escapes the mock cannot reach a real server by accident. The API half of the same contract
 * is covered by apps/api/src/__tests__/operator-salons-89.test.ts.
 *
 * Auth: no tenant fixture is used. The operator session is seeded into sessionStorage with
 * addInitScript (keys clokr.operator.accessToken / clokr.operator.expiresAt), which is exactly
 * where the console reads it.
 *
 * Selectors: data-testid and data-state only (UI-SPEC "Test Hooks"), no fixed sleeps - every wait
 * is an auto-waiting locator assertion.
 */
import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";

const TOKEN_KEY = "clokr.operator.accessToken";
const EXPIRES_KEY = "clokr.operator.expiresAt";

interface MockSalon {
  id: string;
  name: string;
  street: string | null;
  postalCode: string | null;
  city: string | null;
  openingHours: Array<{ day: number; open: string; close: string; closed?: boolean }>;
  federalState: string;
  isActive: boolean;
  deactivatedAt: string | null;
  createdAt: string;
  isDefault: boolean;
  coupling: { provider: string; externalBranchId: string } | null;
}

const TENANT_ID = randomUUID();
const DEFAULT_SALON_ID = randomUUID();
const OLD_SALON_ID = randomUUID();
const BRANCH_ID = "branch-4711";

const HOURS = Array.from({ length: 7 }, (_, day) => ({
  day,
  open: "09:00",
  close: "18:00",
  ...(day >= 5 ? { closed: true } : {}),
}));

const SALONS: MockSalon[] = [
  {
    id: DEFAULT_SALON_ID,
    name: "Hauptsalon",
    street: "Beispielweg 1",
    postalCode: "12345",
    city: "Beispielstadt",
    openingHours: HOURS,
    federalState: "NIEDERSACHSEN",
    isActive: true,
    deactivatedAt: null,
    createdAt: "2026-01-05T08:00:00.000Z",
    isDefault: true,
    coupling: { provider: "PHOREST", externalBranchId: BRANCH_ID },
  },
  {
    id: OLD_SALON_ID,
    name: "Altsalon",
    street: null,
    postalCode: null,
    city: null,
    openingHours: HOURS,
    federalState: "BAYERN",
    isActive: false,
    deactivatedAt: "2026-03-01T08:00:00.000Z",
    createdAt: "2026-02-01T08:00:00.000Z",
    isDefault: false,
    coupling: null,
  },
];

const TENANT = {
  id: TENANT_ID,
  name: "Beispiel Friseure GmbH",
  slug: "beispiel-friseure",
  federalState: "NIEDERSACHSEN",
  createdAt: "2026-01-05T08:00:00.000Z",
  deactivatedAt: null,
  deactivatedReason: null,
};

/** Fulfil every /api/v1/operator/** request from the in-spec state; record what was asked. */
async function mockOperatorApi(page: Page): Promise<string[]> {
  const seen: string[] = [];
  await page.route("**/api/v1/operator/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace("/api/v1/operator", "");
    seen.push(`${route.request().method()} ${path}`);

    if (path === `/tenants/${TENANT_ID}/salons`) {
      return route.fulfill({ status: 200, json: SALONS });
    }
    if (path === `/tenants/${TENANT_ID}`) {
      return route.fulfill({ status: 200, json: TENANT });
    }
    return route.fulfill({ status: 404, json: { error: "Mandant nicht gefunden" } });
  });
  return seen;
}

/** Put a valid operator session where the console reads it (15 minutes ahead). */
async function seedOperatorSession(page: Page): Promise<void> {
  const expiresAt = Date.now() + 15 * 60 * 1000;
  await page.addInitScript(
    ([tokenKey, expiresKey, expiry]) => {
      sessionStorage.setItem(tokenKey, "operator-token-for-e2e");
      sessionStorage.setItem(expiresKey, expiry);
    },
    [TOKEN_KEY, EXPIRES_KEY, String(expiresAt)] as const,
  );
}

test.describe("operator console - tenant detail", () => {
  test("a seeded operator session shows the tenant's salons", async ({ page }) => {
    const seen = await mockOperatorApi(page);
    await seedOperatorSession(page);

    await page.goto(`/betreiber/mandanten/${TENANT_ID}`);

    await expect(page.getByTestId("op-tenant-page")).toBeVisible();
    await expect(page.getByTestId("op-tenant-name")).toHaveText(TENANT.name);
    await expect(page.getByTestId("op-tenant-slug")).toHaveText(TENANT.slug);

    const table = page.getByTestId("op-salons-table");
    await expect(table).toBeVisible();
    await expect(table.locator("tbody tr")).toHaveCount(2);

    // Default salon: Standardsalon badge, address line, Phorest coupling, active.
    const defaultRow = page.getByTestId(`op-salon-row-${DEFAULT_SALON_ID}`);
    await expect(page.getByTestId(`op-salon-name-${DEFAULT_SALON_ID}`)).toHaveText("Hauptsalon");
    await expect(page.getByTestId(`op-salon-default-badge-${DEFAULT_SALON_ID}`)).toBeVisible();
    await expect(defaultRow).toContainText("Beispielweg 1, 12345 Beispielstadt");
    await expect(page.getByTestId(`op-salon-coupling-${DEFAULT_SALON_ID}`)).toContainText(
      `Phorest · ${BRANCH_ID}`,
    );
    await expect(page.getByTestId(`op-salon-status-${DEFAULT_SALON_ID}`)).toHaveAttribute(
      "data-state",
      "active",
    );

    // Deactivated salon: no badge, no coupling, deactivated state.
    await expect(page.getByTestId(`op-salon-default-badge-${OLD_SALON_ID}`)).toHaveCount(0);
    await expect(page.getByTestId(`op-salon-coupling-${OLD_SALON_ID}`)).toContainText("Keine");
    await expect(page.getByTestId(`op-salon-status-${OLD_SALON_ID}`)).toHaveAttribute(
      "data-state",
      "deactivated",
    );

    // The console asked the operator API with the operator contract, and nothing else.
    expect(seen).toContain(`GET /tenants/${TENANT_ID}`);
    expect(seen).toContain(`GET /tenants/${TENANT_ID}/salons`);
  });

  test("without a session the console sends the browser to the sign-in with a safe next", async ({
    page,
  }) => {
    const seen = await mockOperatorApi(page);

    await page.goto(`/betreiber/mandanten/${TENANT_ID}`);

    await expect(page).toHaveURL(
      new RegExp(`/betreiber/anmelden\\?next=%2Fbetreiber%2Fmandanten%2F${TENANT_ID}$`),
    );
    // No operator data was requested without a session.
    expect(seen).toEqual([]);
  });
});
