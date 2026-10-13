/**
 * Issue #89 - the operator console (/betreiber) against the operator API contract.
 *
 * The question this spec answers: does the browser side of the console - session guard, operator
 * client, tenant list and creation dialog, tenant detail page, salon table - work against the
 * shapes the operator API serves (GET/POST /api/v1/operator/tenants, GET /tenants/:id and
 * /tenants/:id/salons)?
 *
 * Why the operator API is mocked: CI has no operator account (OPERATOR_JWT_SECRET is unset on the
 * test stack, so the surface is absent there) and no way to complete the TOTP sign-in. Interception
 * with page.route happens in the browser, before the request reaches the web proxy, so nothing
 * here depends on the API. Every operator request is fulfilled, never continued, so a request
 * that escapes the mock cannot reach a real server by accident. The API half of the same contract
 * is covered by apps/api/src/__tests__/operator-salons-89.test.ts.
 *
 * Auth: the operator session is seeded into sessionStorage with addInitScript (keys
 * clokr.operator.accessToken / clokr.operator.expiresAt), which is exactly where the console reads
 * it. The sign-in tests drive the real two-step form against the mocked /auth/* endpoints; only
 * the tenant-session test uses the tenant fixture, to prove a tenant token never reaches the
 * operator surface.
 *
 * Selectors: data-testid and data-state only (UI-SPEC "Test Hooks"), no fixed sleeps - every wait
 * is an auto-waiting locator assertion.
 */
import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";

// Synthetic credentials: random per run, never real.
const OPERATOR_EMAIL = "betreiber@example.invalid";
const OPERATOR_PASSWORD = randomUUID();
const GOOD_CODE = "123456";
const GOOD_RECOVERY = "AAAA-BBBB-CCCC-DDDD";
const CHALLENGE_TOKEN = randomUUID();
const ACCESS_TOKEN = randomUUID();

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

interface MockTenant {
  id: string;
  name: string;
  slug: string;
  federalState: string;
  createdAt: string;
  deactivatedAt: string | null;
  deactivatedReason: string | null;
}

const TENANT: MockTenant = {
  id: TENANT_ID,
  name: "Beispiel Friseure GmbH",
  slug: "beispiel-friseure",
  federalState: "NIEDERSACHSEN",
  createdAt: "2026-01-05T08:00:00.000Z",
  deactivatedAt: null,
  deactivatedReason: null,
};

const OFF_TENANT_ID = randomUUID();
const OFF_TENANT: MockTenant = {
  id: OFF_TENANT_ID,
  name: "Altbetrieb",
  slug: "altbetrieb",
  federalState: "BAYERN",
  createdAt: "2026-02-10T08:00:00.000Z",
  deactivatedAt: "2026-03-01T08:00:00.000Z",
  deactivatedReason: "Vertrag beendet",
};

interface RecordedCall {
  method: string;
  path: string;
  authorization: string | undefined;
  body: Record<string, unknown> | null;
}

/** How the mocked POST /tenants answers. */
type CreateOutcome = "ok" | "SLUG_TAKEN" | "EMAIL_TAKEN";

interface OperatorMock {
  /** "METHOD /path" of every operator request, in order. */
  seen: string[];
  calls: RecordedCall[];
  state: {
    /** Flip to make the whole operator surface answer 404 (OPERATOR_JWT_SECRET unset). */
    surfaceOff: boolean;
    /** What GET /tenants serves; a successful create appends to it. */
    tenants: MockTenant[];
    /** Status of GET /tenants; anything but 200 serves an error body. */
    listStatus: number;
    /** What POST /tenants answers. */
    create: CreateOutcome;
    /** `invitationMailSent` of a successful create. */
    mailSent: boolean;
  };
}

const GENERIC_401 = { error: "Anmeldung fehlgeschlagen" };

/** Fulfil every /api/v1/operator/** request from the in-spec state; record what was asked. */
async function mockOperatorApi(page: Page): Promise<OperatorMock> {
  const mock: OperatorMock = {
    seen: [],
    calls: [],
    state: {
      surfaceOff: false,
      tenants: [TENANT, OFF_TENANT],
      listStatus: 200,
      create: "ok",
      mailSent: true,
    },
  };
  await page.route("**/api/v1/operator/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace("/api/v1/operator", "");
    const method = request.method();
    const body = request.postDataJSON() as Record<string, unknown> | null;
    mock.seen.push(`${method} ${path}`);
    mock.calls.push({
      method,
      path,
      authorization: request.headers()["authorization"],
      body,
    });

    if (mock.state.surfaceOff) {
      return route.fulfill({ status: 404, json: { error: "Nicht gefunden" } });
    }

    if (path === "/auth/me" && method === "GET") {
      if (!request.headers()["authorization"]) {
        return route.fulfill({ status: 401, json: { error: "Unauthorized" } });
      }
      return route.fulfill({
        status: 200,
        json: {
          id: randomUUID(),
          email: OPERATOR_EMAIL,
          displayName: "Beispiel Betreiber",
          lastLoginAt: null,
        },
      });
    }
    if (path === "/auth/login" && method === "POST") {
      return body?.email === OPERATOR_EMAIL && body?.password === OPERATOR_PASSWORD
        ? route.fulfill({
            status: 200,
            json: { challengeToken: CHALLENGE_TOKEN, expiresIn: 300 },
          })
        : route.fulfill({ status: 401, json: GENERIC_401 });
    }
    if (path === "/auth/verify" && method === "POST") {
      const good =
        body?.challengeToken === CHALLENGE_TOKEN &&
        (body?.code === GOOD_CODE || body?.recoveryCode === GOOD_RECOVERY);
      return good
        ? route.fulfill({ status: 200, json: { accessToken: ACCESS_TOKEN, expiresIn: 900 } })
        : route.fulfill({ status: 401, json: GENERIC_401 });
    }
    if (path === "/tenants" && method === "GET") {
      return mock.state.listStatus === 200
        ? route.fulfill({ status: 200, json: mock.state.tenants })
        : route.fulfill({
            status: mock.state.listStatus,
            json: { error: "Interner Serverfehler" },
          });
    }
    if (path === "/tenants" && method === "POST") {
      if (mock.state.create === "SLUG_TAKEN") {
        return route.fulfill({
          status: 409,
          json: { error: "Dieser Kurzname ist bereits vergeben.", code: "SLUG_TAKEN" },
        });
      }
      if (mock.state.create === "EMAIL_TAKEN") {
        return route.fulfill({
          status: 409,
          json: { error: "Diese E-Mail-Adresse ist bereits vergeben.", code: "EMAIL_TAKEN" },
        });
      }
      const tenant: MockTenant = {
        id: randomUUID(),
        name: String(body?.name),
        slug: String(body?.slug),
        federalState: String(body?.federalState),
        createdAt: "2026-10-13T08:00:00.000Z",
        deactivatedAt: null,
        deactivatedReason: null,
      };
      mock.state.tenants = [...mock.state.tenants, tenant];
      return route.fulfill({
        status: 201,
        json: {
          tenant,
          defaultSalonId: randomUUID(),
          adminEmployeeId: randomUUID(),
          invitationMailSent: mock.state.mailSent,
        },
      });
    }
    const createdTenant = mock.state.tenants.find(
      (t) => path === `/tenants/${t.id}` || path === `/tenants/${t.id}/salons`,
    );
    if (createdTenant && createdTenant.id !== TENANT_ID) {
      return path.endsWith("/salons")
        ? route.fulfill({ status: 200, json: [] })
        : route.fulfill({ status: 200, json: createdTenant });
    }
    if (path === `/tenants/${TENANT_ID}/salons`) {
      return route.fulfill({ status: 200, json: SALONS });
    }
    if (path === `/tenants/${TENANT_ID}`) {
      return route.fulfill({ status: 200, json: TENANT });
    }
    return route.fulfill({ status: 404, json: { error: "Mandant nicht gefunden" } });
  });
  return mock;
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
    const { seen } = await mockOperatorApi(page);
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
    const { seen } = await mockOperatorApi(page);

    await page.goto(`/betreiber/mandanten/${TENANT_ID}`);

    await expect(page).toHaveURL(
      new RegExp(`/betreiber/anmelden\\?next=%2Fbetreiber%2Fmandanten%2F${TENANT_ID}$`),
    );
    // No operator data was requested without a session: the only request is the tokenless
    // surface probe of the sign-in page it landed on.
    await expect(page.getByTestId("op-signin-page")).toBeVisible();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((entry) => entry === "GET /auth/me")).toBe(true);
  });
});

/** Fill step 1 with the good credentials and wait for the code step. */
async function reachCodeStep(page: Page): Promise<void> {
  await page.getByTestId("op-signin-email").fill(OPERATOR_EMAIL);
  await page.getByTestId("op-signin-password").fill(OPERATOR_PASSWORD);
  await page.getByTestId("op-signin-next").click();
  await expect(page.getByTestId("op-signin-step-code")).toBeVisible();
}

test.describe("operator console - sign-in", () => {
  test("two steps sign in and land on the safe next target with the session in sessionStorage", async ({
    page,
  }) => {
    await mockOperatorApi(page);
    const target = `/betreiber/mandanten/${TENANT_ID}`;

    await page.goto(`/betreiber/anmelden?next=${target}`);
    await expect(page.getByTestId("op-signin-step-password")).toBeVisible();
    await reachCodeStep(page);
    await expect(page.getByTestId("op-signin-code")).toBeFocused();

    await page.getByTestId("op-signin-code").fill(GOOD_CODE);
    await page.getByTestId("op-signin-submit").click();

    await expect(page).toHaveURL(new RegExp(`${target}$`));
    await expect(page.getByTestId("op-tenant-page")).toBeVisible();
    const stored = await page.evaluate((key) => sessionStorage.getItem(key), TOKEN_KEY);
    expect(stored).toBe(ACCESS_TOKEN);
  });

  test("a wrong code shows the generic error, empties the code field and refocuses it", async ({
    page,
  }) => {
    const { calls } = await mockOperatorApi(page);
    await page.goto("/betreiber/anmelden");
    await reachCodeStep(page);

    await page.getByTestId("op-signin-code").fill("000000");
    await page.getByTestId("op-signin-submit").click();

    await expect(page.getByTestId("op-signin-error")).toBeVisible();
    await expect(page.getByTestId("op-signin-code")).toHaveValue("");
    await expect(page.getByTestId("op-signin-code")).toBeFocused();
    // Still on the code step, and the password was never refilled anywhere.
    await expect(page.getByTestId("op-signin-step-code")).toBeVisible();
    expect(calls.filter((c) => c.path === "/auth/verify")).toHaveLength(1);
  });

  test("the recovery code path sends only recoveryCode and signs in", async ({ page }) => {
    const { calls } = await mockOperatorApi(page);
    await page.goto("/betreiber/anmelden");
    await reachCodeStep(page);

    await page.getByTestId("op-signin-recovery-toggle").click();
    await expect(page.getByTestId("op-signin-submit")).toBeDisabled();
    await page.getByTestId("op-signin-recovery").fill(GOOD_RECOVERY);
    await page.getByTestId("op-signin-submit").click();

    await expect(page).toHaveURL(/\/betreiber$/);
    const verify = calls.find((c) => c.path === "/auth/verify");
    expect(verify?.body).toEqual({
      challengeToken: CHALLENGE_TOKEN,
      recoveryCode: GOOD_RECOVERY,
    });
  });

  test("six typed digits send no verify request until the button is pressed", async ({ page }) => {
    const { calls } = await mockOperatorApi(page);
    await page.goto("/betreiber/anmelden");
    await reachCodeStep(page);

    await page.getByTestId("op-signin-code").pressSequentially(GOOD_CODE);
    await expect(page.getByTestId("op-signin-submit")).toBeEnabled();
    // Two animation frames: any automatic submit would have gone out by now.
    await page.evaluate(
      () =>
        new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done())),
        ),
    );
    expect(calls.filter((c) => c.path === "/auth/verify")).toHaveLength(0);

    await page.getByTestId("op-signin-submit").click();
    await expect.poll(() => calls.filter((c) => c.path === "/auth/verify").length).toBe(1);
  });

  test("a switched-off surface shows only its sentence", async ({ page }) => {
    const mock = await mockOperatorApi(page);
    mock.state.surfaceOff = true;

    await page.goto("/betreiber/anmelden");

    await expect(page.getByTestId("op-surface-off")).toBeVisible();
    await expect(page.getByTestId("op-signin-email")).toHaveCount(0);
    await expect(page.getByTestId("op-signin-error")).toHaveCount(0);
    // The probe is a tokenless read, never a login attempt.
    expect(mock.seen).toEqual(["GET /auth/me"]);
    expect(mock.calls[0]?.authorization).toBeUndefined();
  });

  test("the expired-session notice carries its code", async ({ page }) => {
    await mockOperatorApi(page);

    await page.goto("/betreiber/anmelden?abgelaufen=1");

    await expect(page.getByTestId("op-signin-notice")).toHaveAttribute(
      "data-code",
      "SESSION_EXPIRED",
    );
  });

  test("the code field uses the shared one-time-code recipe", async ({ page }) => {
    await mockOperatorApi(page);
    await page.goto("/betreiber/anmelden");
    await reachCodeStep(page);

    const code = page.getByTestId("op-signin-code");
    await expect(code).toHaveCSS("font-size", "32px");
    await expect(code).toHaveCSS("letter-spacing", "8px");
  });
});

test.describe("operator console - separation from the tenant app", () => {
  test("a tenant session alone lands on the sign-in page and no operator request carries its token", async ({
    page,
    tenant,
  }) => {
    await mockOperatorApi(page);
    await page.addInitScript((token) => {
      localStorage.setItem("accessToken", token);
    }, tenant.adminToken);

    const operatorRequests: import("@playwright/test").Request[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/v1/operator/")) operatorRequests.push(request);
    });

    // The console list page does not exist yet (a later plan); the tenant detail page sits behind
    // the same session guard.
    await page.goto(`/betreiber/mandanten/${TENANT_ID}`);

    await expect(page).toHaveURL(/\/betreiber\/anmelden/);
    await expect(page.getByTestId("op-signin-page")).toBeVisible();
    await expect(page.getByTestId("op-signin-step-password")).toBeVisible();

    // Non-vacuity: the page did talk to the operator API (the surface probe).
    expect(operatorRequests.length).toBeGreaterThan(0);
    for (const request of operatorRequests) {
      const headers = await request.allHeaders();
      expect(JSON.stringify(headers)).not.toContain(tenant.adminToken);
    }
  });

  test("the sign-in document refuses framing", async ({ page }) => {
    await mockOperatorApi(page);

    const response = await page.goto("/betreiber/anmelden");

    expect(response).not.toBeNull();
    const headers = response?.headers() ?? {};
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  });
});

test.describe("operator console - session clock", () => {
  test("the chip warns at two minutes and the console returns to sign-in at expiry", async ({
    page,
  }) => {
    await mockOperatorApi(page);
    await seedOperatorSession(page);
    await page.clock.install({ time: Date.now() });

    await page.goto(`/betreiber/mandanten/${TENANT_ID}`);
    const chip = page.getByTestId("op-session-chip");
    await expect(page.getByTestId("op-tenant-page")).toBeVisible();
    await expect(chip).toHaveAttribute("data-state", "normal");

    // 13:30 later: 1:30 left.
    await page.clock.fastForward((13 * 60 + 30) * 1000);
    await expect(chip).toHaveAttribute("data-state", "warning");
    await expect(page.getByTestId("op-session-announce")).not.toBeEmpty();

    // Past the expiry.
    await page.clock.fastForward(2 * 60 * 1000);
    await expect(page).toHaveURL(/\/betreiber\/anmelden\?.*abgelaufen=1/);
    await expect(page.getByTestId("op-signin-notice")).toHaveAttribute(
      "data-code",
      "SESSION_EXPIRED",
    );
    const stored = await page.evaluate((key) => sessionStorage.getItem(key), TOKEN_KEY);
    expect(stored).toBeNull();
  });

  test("Abmelden clears the session and lands on the plain sign-in page", async ({ page }) => {
    await mockOperatorApi(page);
    await seedOperatorSession(page);

    await page.goto(`/betreiber/mandanten/${TENANT_ID}`);
    await expect(page.getByTestId("op-tenant-page")).toBeVisible();
    await expect(page.getByTestId("op-badge")).toBeVisible();

    await page.getByTestId("op-logout").click();

    await expect(page).toHaveURL(/\/betreiber\/anmelden$/);
    const stored = await page.evaluate((key) => sessionStorage.getItem(key), TOKEN_KEY);
    expect(stored).toBeNull();
  });
});

/** Open the page the list lives on, with an operator session. */
async function openTenantList(page: Page, mock?: (state: OperatorMock["state"]) => void) {
  const operator = await mockOperatorApi(page);
  mock?.(operator.state);
  await seedOperatorSession(page);
  await page.goto("/betreiber");
  return operator;
}

/** Fill the create dialog with valid values; the Bundesland is chosen only when asked for. */
async function fillCreateDialog(page: Page, options: { federalState?: string } = {}) {
  await page.getByTestId("op-tenants-create").click();
  await expect(page.getByTestId("op-tenant-create-dialog")).toBeVisible();
  await page.getByTestId("op-tenant-create-name").fill("Neuer Betrieb GmbH");
  if (options.federalState) {
    await page.getByTestId("op-tenant-create-federal-state").selectOption(options.federalState);
  }
  await page.getByTestId("op-tenant-create-admin-email").fill("Erste.Admin@Example.INVALID");
  await page.getByTestId("op-tenant-create-admin-first-name").fill("Erste");
  await page.getByTestId("op-tenant-create-admin-last-name").fill("Administration");
}

function manyTenants(count: number): MockTenant[] {
  return Array.from({ length: count }, (_, i) => ({
    id: randomUUID(),
    name: `Betrieb ${String(i).padStart(2, "0")}`,
    slug: `betrieb-${i}`,
    federalState: "HESSEN",
    createdAt: "2026-01-05T08:00:00.000Z",
    deactivatedAt: null,
    deactivatedReason: null,
  }));
}

test.describe("operator console - tenant list", () => {
  test("shows an active and a deactivated tenant with state and reason", async ({ page }) => {
    const { seen } = await openTenantList(page);

    await expect(page.getByTestId("op-tenants-page")).toBeVisible();
    await expect(page.getByTestId("op-tenants-table")).toBeVisible();
    await expect(page.getByTestId(`op-tenant-row-${TENANT_ID}`)).toBeVisible();
    await expect(page.getByTestId(`op-tenant-row-${OFF_TENANT_ID}`)).toBeVisible();

    await expect(page.getByTestId(`op-tenant-status-${TENANT_ID}`)).toHaveAttribute(
      "data-state",
      "active",
    );
    await expect(page.getByTestId(`op-tenant-status-${OFF_TENANT_ID}`)).toHaveAttribute(
      "data-state",
      "deactivated",
    );
    // The reason of the deactivated tenant is on its row, the active one has none.
    await expect(page.getByTestId(`op-tenant-row-${OFF_TENANT_ID}`)).toContainText(
      OFF_TENANT.deactivatedReason ?? "",
    );
    await expect(page.getByTestId(`op-tenant-row-${TENANT_ID}`)).not.toContainText("Vertrag");

    await expect(page.getByTestId(`op-tenant-link-${TENANT_ID}`)).toHaveAttribute(
      "href",
      `/betreiber/mandanten/${TENANT_ID}`,
    );
    expect(seen).toContain("GET /tenants");
    // 2 tenants: no pagination.
    await expect(page.getByTestId("op-tenants-pagination")).toHaveCount(0);
  });

  test("a tenant name leads to the tenant page", async ({ page }) => {
    await openTenantList(page);

    await page.getByTestId(`op-tenant-link-${TENANT_ID}`).click();

    await expect(page).toHaveURL(new RegExp(`/betreiber/mandanten/${TENANT_ID}$`));
    await expect(page.getByTestId("op-tenant-page")).toBeVisible();
  });

  test("zero tenants show the empty state, whose action opens the create dialog", async ({
    page,
  }) => {
    await openTenantList(page, (state) => {
      state.tenants = [];
    });

    const empty = page.getByTestId("op-tenants-empty");
    await expect(empty).toBeVisible();
    await expect(page.getByTestId("op-tenants-table")).toHaveCount(0);

    await empty.getByRole("button").click();
    await expect(page.getByTestId("op-tenant-create-dialog")).toBeVisible();
  });

  test("a failed load shows the error and the retry loads the list", async ({ page }) => {
    const { state, seen } = await openTenantList(page, (s) => {
      s.listStatus = 500;
    });

    await expect(page.getByTestId("op-tenants-error")).toBeVisible();
    await expect(page.getByTestId("op-tenants-table")).toHaveCount(0);

    state.listStatus = 200;
    await page.getByTestId("op-tenants-retry").click();

    await expect(page.getByTestId("op-tenants-table")).toBeVisible();
    await expect(page.getByTestId("op-tenants-error")).toHaveCount(0);
    expect(seen.filter((entry) => entry === "GET /tenants")).toHaveLength(2);
  });

  test("more than 25 tenants page through the pagination", async ({ page }) => {
    await openTenantList(page, (state) => {
      state.tenants = manyTenants(30);
    });

    await expect(page.getByTestId("op-tenants-pagination")).toBeVisible();
    await expect(page.locator('[data-testid^="op-tenant-row-"]')).toHaveCount(25);

    await page.getByRole("button", { name: "Nächste Seite" }).click();
    await expect(page.locator('[data-testid^="op-tenant-row-"]')).toHaveCount(5);
  });

  test("without a session /betreiber sends the browser to the sign-in and asks for no tenant", async ({
    page,
  }) => {
    const { seen } = await mockOperatorApi(page);

    await page.goto("/betreiber");

    await expect(page).toHaveURL(/\/betreiber\/anmelden\?next=%2Fbetreiber$/);
    await expect(page.getByTestId("op-signin-page")).toBeVisible();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((entry) => entry === "GET /auth/me")).toBe(true);
  });
});

test.describe("operator console - tenant list at 360 px", () => {
  test.use({ viewport: { width: 360, height: 800 } });

  test("the stacked list never scrolls sideways, even with a 200-character name", async ({
    page,
  }) => {
    const longName = "Langer".repeat(34);
    expect(longName).toHaveLength(204);
    const longTenant: MockTenant = {
      ...TENANT,
      id: randomUUID(),
      name: longName.slice(0, 200),
      slug: "langer-name",
      deactivatedAt: "2026-03-01T08:00:00.000Z",
      deactivatedReason: "Grund ".repeat(80).trim(),
    };
    await openTenantList(page, (state) => {
      state.tenants = [longTenant, TENANT];
    });
    const row = page.getByTestId(`op-tenant-row-${longTenant.id}`);
    await expect(row).toBeVisible();

    // The stacked layout is really applied: a row is a flex box here, a table row on a desktop.
    await expect(row).toHaveCSS("display", "flex");

    const overflow = await page.evaluate(() => {
      const html = document.documentElement;
      const rows = [...document.querySelectorAll('[data-testid^="op-tenant-row-"]')];
      const beyond = rows.flatMap((tr) => {
        const limit = tr.getBoundingClientRect().right + 0.5;
        return [...tr.querySelectorAll("*")]
          .filter((child) => child.getBoundingClientRect().right > limit)
          .map((child) => child.tagName);
      });
      const wrap = document.querySelector(".table-wrap");
      return {
        pageScrolls: html.scrollWidth > html.clientWidth,
        wrapScrolls: wrap ? wrap.scrollWidth > wrap.clientWidth : null,
        beyond,
        rowCount: rows.length,
      };
    });
    expect(overflow.rowCount).toBe(2);
    expect(overflow.pageScrolls).toBe(false);
    expect(overflow.wrapScrolls).toBe(false);
    expect(overflow.beyond).toEqual([]);
  });

  test("the create dialog fits the viewport", async ({ page }) => {
    await openTenantList(page);
    await page.getByTestId("op-tenants-create").click();
    await expect(page.getByTestId("op-tenant-create-dialog")).toBeVisible();

    const fit = await page.evaluate(() => {
      const modal = document.querySelector('[role="dialog"]');
      if (!modal) return null;
      const limit = modal.getBoundingClientRect().right + 0.5;
      const beyond = [...modal.querySelectorAll("input, select, button, p, legend, label")]
        .filter((child) => child.getBoundingClientRect().right > limit)
        .map((child) => child.tagName);
      return {
        pageScrolls: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        modalRight: modal.getBoundingClientRect().right,
        beyond,
      };
    });
    expect(fit).not.toBeNull();
    expect(fit?.pageScrolls).toBe(false);
    expect(fit?.modalRight).toBeLessThanOrEqual(360);
    expect(fit?.beyond).toEqual([]);
  });
});

test.describe("operator console - create tenant", () => {
  test("creates a tenant, reports the sent invitation and opens the new tenant", async ({
    page,
  }) => {
    const { calls, seen } = await openTenantList(page);

    await fillCreateDialog(page, { federalState: "BAYERN" });
    // The Kurzname followed the name.
    await expect(page.getByTestId("op-tenant-create-slug")).toHaveValue("neuer-betrieb-gmbh");
    await page.getByTestId("op-tenant-create-submit").click();

    const mail = page.getByTestId("op-tenant-create-result-mail");
    await expect(page.getByTestId("op-tenant-create-result")).toBeVisible();
    await expect(mail).toHaveAttribute("data-state", "sent");

    // The request body is exactly the documented contract: no timezone, no employeeNumber key.
    const post = calls.find((c) => c.method === "POST" && c.path === "/tenants");
    expect(post?.body).toEqual({
      name: "Neuer Betrieb GmbH",
      slug: "neuer-betrieb-gmbh",
      federalState: "BAYERN",
      admin: {
        email: "erste.admin@example.invalid",
        firstName: "Erste",
        lastName: "Administration",
      },
    });
    expect(post?.authorization).toBe("Bearer operator-token-for-e2e");

    // The list was reloaded from the server, not patched locally.
    await expect.poll(() => seen.filter((entry) => entry === "GET /tenants").length).toBe(2);

    await page.getByTestId("op-tenant-create-result-open").click();
    await expect(page).toHaveURL(/\/betreiber\/mandanten\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId("op-tenant-page")).toBeVisible();
    await expect(page.getByTestId("op-tenant-name")).toHaveText("Neuer Betrieb GmbH");
  });

  test("sends timezone and employee number only when filled", async ({ page }) => {
    const { calls } = await openTenantList(page);

    await fillCreateDialog(page, { federalState: "HESSEN" });
    await page.getByTestId("op-tenant-create-timezone").fill("Europe/Vienna");
    await page.getByTestId("op-tenant-create-admin-employee-number").fill("P-1");
    await page.getByTestId("op-tenant-create-submit").click();

    await expect(page.getByTestId("op-tenant-create-result")).toBeVisible();
    const post = calls.find((c) => c.method === "POST" && c.path === "/tenants");
    expect(post?.body).toMatchObject({
      timezone: "Europe/Vienna",
      admin: { employeeNumber: "P-1" },
    });
  });

  test("an invitation that could not be sent is reported as not-sent", async ({ page }) => {
    await openTenantList(page, (state) => {
      state.mailSent = false;
    });

    await fillCreateDialog(page, { federalState: "BERLIN" });
    await page.getByTestId("op-tenant-create-submit").click();

    await expect(page.getByTestId("op-tenant-create-result-mail")).toHaveAttribute(
      "data-state",
      "not-sent",
    );
  });

  test("a taken Kurzname attaches to its field and the dialog stays open", async ({ page }) => {
    await openTenantList(page, (state) => {
      state.create = "SLUG_TAKEN";
    });

    await fillCreateDialog(page, { federalState: "BERLIN" });
    await page.getByTestId("op-tenant-create-submit").click();

    const message = page.getByTestId("op-tenant-create-field-error-slug");
    await expect(message).toHaveAttribute("data-code", "SLUG_TAKEN");
    await expect(page.getByTestId("op-tenant-create-slug")).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByTestId("op-tenant-create-dialog")).toBeVisible();
    await expect(page.getByTestId("op-tenant-create-result")).toHaveCount(0);
    await expect(page.getByTestId("op-tenant-create-slug")).toBeFocused();
  });

  test("a taken e-mail address attaches to the e-mail field", async ({ page }) => {
    await openTenantList(page, (state) => {
      state.create = "EMAIL_TAKEN";
    });

    await fillCreateDialog(page, { federalState: "BERLIN" });
    await page.getByTestId("op-tenant-create-submit").click();

    await expect(page.getByTestId("op-tenant-create-field-error-admin-email")).toHaveAttribute(
      "data-code",
      "EMAIL_TAKEN",
    );
    await expect(page.getByTestId("op-tenant-create-admin-email")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    await expect(page.getByTestId("op-tenant-create-dialog")).toBeVisible();
  });

  test("the submit stays disabled until a Bundesland is chosen", async ({ page }) => {
    const { calls } = await openTenantList(page);

    await fillCreateDialog(page);
    await expect(page.getByTestId("op-tenant-create-federal-state")).toHaveValue("");
    await expect(page.getByTestId("op-tenant-create-submit")).toBeDisabled();

    await page.getByTestId("op-tenant-create-federal-state").selectOption("SACHSEN");
    await expect(page.getByTestId("op-tenant-create-submit")).toBeEnabled();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  test("cancelling closes the dialog without a request", async ({ page }) => {
    const { calls } = await openTenantList(page);

    await fillCreateDialog(page, { federalState: "SACHSEN" });
    await page.getByTestId("op-tenant-create-cancel").click();

    await expect(page.getByTestId("op-tenant-create-dialog")).toHaveCount(0);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    // Reopening starts from a clean form.
    await page.getByTestId("op-tenants-create").click();
    await expect(page.getByTestId("op-tenant-create-name")).toHaveValue("");
    await expect(page.getByTestId("op-tenant-create-federal-state")).toHaveValue("");
  });
});
