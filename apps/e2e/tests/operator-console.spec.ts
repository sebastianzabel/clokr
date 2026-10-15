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
import AxeBuilder from "@axe-core/playwright";
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
  packages: MockPackages;
}

/** Booked packages as the operator API reports them (Phase 566). */
interface MockPackages {
  bookedModules: string[];
  salonQuota: number;
  activeSalonCount: number;
}

const TENANT: MockTenant = {
  id: TENANT_ID,
  name: "Beispiel Friseure GmbH",
  slug: "beispiel-friseure",
  federalState: "NIEDERSACHSEN",
  createdAt: "2026-01-05T08:00:00.000Z",
  deactivatedAt: null,
  deactivatedReason: null,
  // The base mock serves one active salon (Hauptsalon).
  packages: { bookedModules: ["CHAIN"], salonQuota: 3, activeSalonCount: 1 },
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
  packages: { bookedModules: [], salonQuota: 1, activeSalonCount: 0 },
};

interface RecordedCall {
  method: string;
  path: string;
  authorization: string | undefined;
  body: Record<string, unknown> | null;
}

/** How the mocked POST /tenants answers. */
type CreateOutcome = "ok" | "SLUG_TAKEN" | "EMAIL_TAKEN";

/** How the mocked POST /tenants/:id/resend-admin-invitation answers. */
type ResendOutcome =
  "sent" | "not-sent" | "TENANT_DEACTIVATED" | "TENANT_IN_USE" | "NO_PENDING_INVITATION";

/** Per-tenant aggregates of the mocked GET /dashboard (Issue #90). */
interface MockMetrics {
  activeSalons: number;
  totalSalons: number;
  activeEmployees: number;
  lastActivityAt: string | null;
  inactive: boolean;
}

/** What the mock serves for a tenant that has no entry of its own (created, bulk or long-name tenants). */
const DEFAULT_METRICS: MockMetrics = {
  activeSalons: 1,
  totalSalons: 1,
  activeEmployees: 1,
  lastActivityAt: "2026-10-01",
  inactive: false,
};

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
    /** Aggregates of GET /dashboard by tenant id; an id without an entry gets DEFAULT_METRICS. */
    metrics: Record<string, MockMetrics>;
    /** Status of GET /dashboard; anything but 200 serves an error body. */
    dashboardStatus: number;
    /** What POST /tenants answers. */
    create: CreateOutcome;
    /** `invitationMailSent` of a successful create. */
    mailSent: boolean;
    /** The tenant served at /tenants/:TENANT_ID; the lifecycle routes change it. */
    detail: MockTenant;
    /** What POST /tenants/:TENANT_ID/resend-admin-invitation answers. */
    resend: ResendOutcome;
    /** What GET /tenants/:TENANT_ID/salons serves; a successful salon write changes it. */
    salons: MockSalon[];
    /** When set, every salon write is refused with this status and code (the body is not stored). */
    salonRefusal: { status: number; code: string } | null;
    /** When set, every salon deactivate / activate is refused with this status and code. */
    lifecycleRefusal: { status: number; code: string } | null;
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
      metrics: {
        [TENANT_ID]: {
          activeSalons: 1,
          totalSalons: 2,
          activeEmployees: 7,
          lastActivityAt: "2026-10-01",
          inactive: false,
        },
        [OFF_TENANT_ID]: {
          activeSalons: 0,
          totalSalons: 1,
          activeEmployees: 0,
          lastActivityAt: null,
          inactive: false,
        },
      },
      dashboardStatus: 200,
      create: "ok",
      mailSent: true,
      detail: structuredClone(TENANT),
      resend: "sent",
      salons: structuredClone(SALONS),
      salonRefusal: null,
      lifecycleRefusal: null,
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
    if (path === "/dashboard" && method === "GET") {
      if (mock.state.dashboardStatus !== 200) {
        return route.fulfill({
          status: mock.state.dashboardStatus,
          json: { error: "Interner Serverfehler" },
        });
      }
      const items = [...mock.state.tenants]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((tenant) => ({
          id: tenant.id,
          name: tenant.name,
          slug: tenant.slug,
          deactivatedAt: tenant.deactivatedAt,
          ...(mock.state.metrics[tenant.id] ?? DEFAULT_METRICS),
        }));
      const live = items.filter((item) => item.deactivatedAt === null);
      return route.fulfill({
        status: 200,
        json: {
          inactivityDays: 30,
          totals: {
            tenants: items.length,
            activeTenants: live.length,
            deactivatedTenants: items.length - live.length,
            activeSalons: live.reduce((sum, item) => sum + item.activeSalons, 0),
            activeEmployees: live.reduce((sum, item) => sum + item.activeEmployees, 0),
            inactiveTenants: live.filter((item) => item.inactive).length,
          },
          tenants: items,
        },
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
        packages: { bookedModules: [], salonQuota: 1, activeSalonCount: 1 },
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
    if (path === `/tenants/${TENANT_ID}/salons` && method === "GET") {
      return route.fulfill({ status: 200, json: mock.state.salons });
    }
    // The tenant page also reads the operator's support accesses (#93); without a grant the
    // server answers an empty state. The support describe block overrides this with its own state.
    if (/^\/tenants\/[^/]+\/support-access$/.test(path) && method === "GET") {
      return route.fulfill({ status: 200, json: { active: null, history: [] } });
    }
    const lifecycle = new RegExp(
      `^/tenants/${TENANT_ID}/salons/([^/]+)/(deactivate|activate)$`,
    ).exec(path);
    if (lifecycle && method === "POST") {
      const [, salonId, action] = lifecycle;
      const refusal = mock.state.lifecycleRefusal;
      if (refusal) {
        // The server's own text is deliberately NOT the console's sentence: the console must
        // choose its wording by the code.
        return route.fulfill({
          status: refusal.status,
          json: { error: "Serverseitiger Text, der nicht angezeigt wird.", code: refusal.code },
        });
      }
      const current = mock.state.salons.find((salon) => salon.id === salonId);
      if (!current) {
        return route.fulfill({ status: 404, json: { error: "Salon nicht gefunden" } });
      }
      const updated: MockSalon = {
        ...current,
        isActive: action === "activate",
        deactivatedAt: action === "activate" ? null : "2026-10-13T08:00:00.000Z",
      };
      mock.state.salons = mock.state.salons.map((salon) =>
        salon.id === salonId ? updated : salon,
      );
      return route.fulfill({ status: 200, json: updated });
    }
    if (
      path.startsWith(`/tenants/${TENANT_ID}/salons`) &&
      (method === "POST" || method === "PATCH")
    ) {
      const refusal = mock.state.salonRefusal;
      if (refusal) {
        // The server's own text is deliberately NOT the console's sentence: the console must
        // choose its wording by the code.
        return route.fulfill({
          status: refusal.status,
          json: { error: "Serverseitiger Text, der nicht angezeigt wird.", code: refusal.code },
        });
      }
      const input = (body ?? {}) as Record<string, unknown>;
      const coupling = input.coupling as { externalBranchId: string } | null | undefined;
      const couplingOf = (value: typeof coupling): MockSalon["coupling"] =>
        value ? { provider: "PHOREST", externalBranchId: value.externalBranchId } : null;
      if (method === "POST") {
        const created: MockSalon = {
          id: randomUUID(),
          name: String(input.name),
          street: (input.street as string | undefined) ?? null,
          postalCode: (input.postalCode as string | undefined) ?? null,
          city: (input.city as string | undefined) ?? null,
          openingHours: input.openingHours as MockSalon["openingHours"],
          federalState: String(input.federalState),
          isActive: true,
          deactivatedAt: null,
          createdAt: "2026-10-13T08:00:00.000Z",
          isDefault: false,
          coupling: couplingOf(coupling),
        };
        mock.state.salons = [...mock.state.salons, created];
        return route.fulfill({ status: 201, json: created });
      }
      const salonId = path.split("/").pop();
      const current = mock.state.salons.find((salon) => salon.id === salonId);
      if (!current) {
        return route.fulfill({ status: 404, json: { error: "Salon nicht gefunden" } });
      }
      const { coupling: _coupling, ...rest } = input;
      const updated: MockSalon = {
        ...current,
        ...(rest as Partial<MockSalon>),
        ...("coupling" in input ? { coupling: couplingOf(coupling) } : {}),
      };
      mock.state.salons = mock.state.salons.map((salon) =>
        salon.id === salonId ? updated : salon,
      );
      return route.fulfill({ status: 200, json: updated });
    }
    if (path === `/tenants/${TENANT_ID}` && method === "PATCH") {
      mock.state.detail = { ...mock.state.detail, name: String(body?.name).trim() };
      return route.fulfill({ status: 200, json: mock.state.detail });
    }
    if (path === `/tenants/${TENANT_ID}/packages` && method === "PUT") {
      const input = (body ?? {}) as { bookedModules: string[]; salonQuota: number };
      mock.state.detail = {
        ...mock.state.detail,
        packages: {
          bookedModules: input.bookedModules,
          salonQuota: input.salonQuota,
          activeSalonCount: mock.state.detail.packages.activeSalonCount,
        },
      };
      return route.fulfill({ status: 200, json: mock.state.detail });
    }
    if (path === `/tenants/${TENANT_ID}/deactivate` && method === "POST") {
      mock.state.detail = {
        ...mock.state.detail,
        deactivatedAt: "2026-10-13T08:00:00.000Z",
        deactivatedReason: String(body?.reason),
      };
      return route.fulfill({ status: 200, json: mock.state.detail });
    }
    if (path === `/tenants/${TENANT_ID}/reactivate` && method === "POST") {
      mock.state.detail = { ...mock.state.detail, deactivatedAt: null, deactivatedReason: null };
      return route.fulfill({ status: 200, json: mock.state.detail });
    }
    if (path === `/tenants/${TENANT_ID}/resend-admin-invitation` && method === "POST") {
      const outcome = mock.state.resend;
      if (outcome === "sent" || outcome === "not-sent") {
        return route.fulfill({ status: 200, json: { invitationMailSent: outcome === "sent" } });
      }
      // The server's own text is deliberately NOT the console's sentence: the console must choose
      // its wording by the code.
      return route.fulfill({
        status: 409,
        json: { error: "Serverseitiger Text, der nicht angezeigt wird.", code: outcome },
      });
    }
    if (path === `/tenants/${TENANT_ID}`) {
      return route.fulfill({ status: 200, json: mock.state.detail });
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

    // A Bundesland name is one word and must never be split inside it ("Niedersachse" / "n"):
    // the table column may shrink down to the longest word, not below it. Counting the client
    // rects of the text gives one rect per rendered line, so a mid-word break reads as two.
    for (const salonId of [DEFAULT_SALON_ID, OLD_SALON_ID]) {
      const lineCount = await page
        .getByTestId(`op-salon-federal-label-${salonId}`)
        .evaluate((el) => {
          const range = document.createRange();
          range.selectNodeContents(el);
          return range.getClientRects().length;
        });
      expect(lineCount, `Bundesland of salon ${salonId} wraps inside a word`).toBe(1);
    }

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

const INACTIVE_TENANT_ID = randomUUID();
const INACTIVE_TENANT: MockTenant = {
  ...TENANT,
  id: INACTIVE_TENANT_ID,
  name: "Ruhender Betrieb",
  slug: "ruhender-betrieb",
  packages: { bookedModules: [], salonQuota: 1, activeSalonCount: 1 },
};

/** The list page with the extra tenant that has never signed in and is flagged inactive. */
async function openDashboard(page: Page, mock?: (state: OperatorMock["state"]) => void) {
  return openTenantList(page, (state) => {
    state.tenants = [TENANT, OFF_TENANT, INACTIVE_TENANT];
    state.metrics[INACTIVE_TENANT_ID] = {
      activeSalons: 1,
      totalSalons: 1,
      activeEmployees: 2,
      lastActivityAt: null,
      inactive: true,
    };
    mock?.(state);
  });
}

test.describe("operator console - dashboard (#90)", () => {
  test("the four tiles show the computed totals and the server's inactivity threshold", async ({
    page,
  }) => {
    const { seen } = await openDashboard(page);

    await expect(page.getByTestId("op-overview")).toBeVisible();
    // Totals over the non-deactivated tenants: TENANT (1 salon, 7 people) + INACTIVE (1 salon, 2 people).
    await expect(page.getByTestId("op-overview-tenants").locator(".kpi-value")).toHaveText("3");
    await expect(page.getByTestId("op-overview-tenants")).toContainText("2 aktiv · 1 deaktiviert");
    await expect(page.getByTestId("op-overview-inactive")).toContainText("Inaktive Mandanten");
    await expect(page.getByTestId("op-overview-inactive").locator(".kpi-value")).toHaveText("1");
    await expect(page.getByTestId("op-overview-inactive")).toContainText(
      "keine Anmeldung seit 30 Tagen",
    );
    await expect(page.getByTestId("op-overview-salons").locator(".kpi-value")).toHaveText("2");
    await expect(page.getByTestId("op-overview-employees").locator(".kpi-value")).toHaveText("9");

    expect(seen.filter((entry) => entry === "GET /dashboard")).toHaveLength(1);
    expect(seen.filter((entry) => entry === "GET /tenants")).toHaveLength(1);
  });

  test("the list shows the metric columns and the Inaktiv badge only for the inactive tenant", async ({
    page,
  }) => {
    await openDashboard(page);

    await expect(page.locator('[data-testid="op-tenants-table"] thead th')).toHaveText([
      "Name",
      "Kurzname",
      "Bundesland",
      "Angelegt",
      "Salons",
      "Mitarbeitende",
      "Letzte Aktivität",
      "Status",
    ]);

    await expect(page.getByTestId(`op-tenant-salons-${TENANT_ID}`)).toContainText("1 / 2");
    await expect(page.getByTestId(`op-tenant-employees-${TENANT_ID}`)).toContainText("7");
    await expect(page.getByTestId(`op-tenant-activity-${TENANT_ID}`)).toContainText("01.10.2026");
    await expect(page.getByTestId(`op-tenant-inactive-${TENANT_ID}`)).toHaveCount(0);

    await expect(page.getByTestId(`op-tenant-activity-${INACTIVE_TENANT_ID}`)).toContainText(
      "Keine Anmeldung",
    );
    await expect(page.getByTestId(`op-tenant-inactive-${INACTIVE_TENANT_ID}`)).toHaveText(
      "Inaktiv",
    );

    // A deactivated tenant is never flagged inactive.
    await expect(page.getByTestId(`op-tenant-status-${OFF_TENANT_ID}`)).toHaveAttribute(
      "data-state",
      "deactivated",
    );
    await expect(page.getByTestId(`op-tenant-inactive-${OFF_TENANT_ID}`)).toHaveCount(0);
  });

  test("a failed dashboard load shows the error and the retry shows overview and list", async ({
    page,
  }) => {
    const { state, seen } = await openDashboard(page, (s) => {
      s.dashboardStatus = 500;
    });

    await expect(page.getByTestId("op-tenants-error")).toBeVisible();
    await expect(page.getByTestId("op-tenants-table")).toHaveCount(0);
    await expect(page.getByTestId("op-overview")).toHaveCount(0);

    state.dashboardStatus = 200;
    await page.getByTestId("op-tenants-retry").click();

    await expect(page.getByTestId("op-overview")).toBeVisible();
    await expect(page.getByTestId("op-tenants-table")).toBeVisible();
    await expect(page.getByTestId("op-tenants-error")).toHaveCount(0);
    expect(seen.filter((entry) => entry === "GET /dashboard")).toHaveLength(2);
  });

  test("overview and list have no WCAG 2 A/AA violations with the Inaktiv badge", async ({
    page,
  }) => {
    await openDashboard(page);
    await expect(page.getByTestId(`op-tenant-inactive-${INACTIVE_TENANT_ID}`)).toBeVisible();
    await animationsSettled(page);

    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    const serious = results.violations.filter(
      (v) => v.impact === "serious" || v.impact === "critical",
    );
    expect(
      serious.map(
        (v) =>
          `${v.id}: ${v.nodes
            .map((n) => {
              const data = (n.any[0]?.data ?? {}) as Record<string, unknown>;
              return `${n.target.join(" ")} [${data.fgColor ?? ""} on ${data.bgColor ?? ""}, ${data.contrastRatio ?? ""}]`;
            })
            .join(" | ")}`,
      ),
    ).toEqual([]);
  });

  test.describe("at 360 px", () => {
    test.use({ viewport: { width: 360, height: 800 } });

    test("the overview and the stacked row fit the width and carry visible labels", async ({
      page,
    }) => {
      await openDashboard(page);
      await expect(page.getByTestId("op-overview")).toBeVisible();
      await animationsSettled(page);

      const fit = await page.evaluate(() => {
        const html = document.documentElement;
        const tiles = [...document.querySelectorAll('[data-testid^="op-overview-"]')].map(
          (tile) => {
            const box = tile.getBoundingClientRect();
            return { left: box.left, right: box.right };
          },
        );
        return {
          overflow: html.scrollWidth - window.innerWidth,
          width: window.innerWidth,
          tiles,
        };
      });
      expect(fit.overflow).toBeLessThanOrEqual(0);
      expect(fit.tiles.length).toBeGreaterThanOrEqual(4);
      for (const tile of fit.tiles) {
        expect(tile.left).toBeGreaterThanOrEqual(0);
        expect(tile.right).toBeLessThanOrEqual(fit.width);
      }

      const row = page.getByTestId(`op-tenant-row-${TENANT_ID}`);
      await expect(row).toHaveCSS("display", "flex");
      await expect(row.getByText("Salons", { exact: true })).toBeVisible();
      await expect(row.getByText("Mitarbeitende", { exact: true })).toBeVisible();
      await expect(row.getByText("Letzte Aktivität", { exact: true })).toBeVisible();
    });
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

test.describe("operator console - tenant lifecycle", () => {
  const NEW_NAME = "Umbenannte Friseure GmbH";

  async function openTenant(page: Page): Promise<OperatorMock> {
    const mock = await mockOperatorApi(page);
    await seedOperatorSession(page);
    await page.goto(`/betreiber/mandanten/${TENANT_ID}`);
    await expect(page.getByTestId("op-tenant-status")).toHaveAttribute("data-state", "active");
    return mock;
  }

  function callsTo(mock: OperatorMock, method: string, suffix: string): RecordedCall[] {
    return mock.calls.filter(
      (c) => c.method === method && c.path === `/tenants/${TENANT_ID}${suffix}`,
    );
  }

  test("rename sends {name}, reloads the tenant from the server and shows the new name", async ({
    page,
  }) => {
    const mock = await openTenant(page);
    const readsBefore = callsTo(mock, "GET", "").length;

    await page.getByTestId("op-tenant-rename").click();
    await expect(page.getByTestId("op-tenant-rename-dialog")).toBeVisible();
    await expect(page.getByTestId("op-tenant-rename-submit")).toBeDisabled();
    await page.getByTestId("op-tenant-rename-input").fill(`  ${NEW_NAME}  `);
    await page.getByTestId("op-tenant-rename-submit").click();

    await expect(page.getByTestId("op-tenant-name")).toHaveText(NEW_NAME);
    await expect(page.getByTestId("op-tenant-rename-dialog")).toHaveCount(0);
    expect(callsTo(mock, "PATCH", "")).toHaveLength(1);
    expect(callsTo(mock, "PATCH", "")[0].body).toEqual({ name: NEW_NAME });
    expect(callsTo(mock, "PATCH", "")[0].authorization).toMatch(/^Bearer /);
    expect(callsTo(mock, "GET", "").length).toBeGreaterThan(readsBefore);
    // The Kurzname is untouched.
    await expect(page.getByTestId("op-tenant-slug")).toHaveText(TENANT.slug);
  });

  test("deactivate: a two-character reason sends no request, a valid one deactivates", async ({
    page,
  }) => {
    const mock = await openTenant(page);

    await page.getByTestId("op-tenant-deactivate").click();
    const dialog = page.getByRole("dialog", { name: "Mandant deaktivieren?" });
    await expect(dialog).toBeVisible();

    await dialog.getByLabel("Begründung").fill("ab");
    await dialog.getByRole("button", { name: "Mandant deaktivieren" }).click();
    await expect(dialog.getByRole("alert")).toBeVisible();
    await expect(dialog).toBeVisible();
    expect(callsTo(mock, "POST", "/deactivate")).toHaveLength(0);

    await dialog.getByLabel("Begründung").fill("Vertrag beendet");
    await dialog.getByRole("button", { name: "Mandant deaktivieren" }).click();

    await expect(page.getByTestId("op-tenant-status")).toHaveAttribute("data-state", "deactivated");
    await expect(page.getByTestId("op-tenant-deactivated-notice")).toContainText("Vertrag beendet");
    await expect(dialog).toHaveCount(0);
    expect(callsTo(mock, "POST", "/deactivate")).toHaveLength(1);
    expect(callsTo(mock, "POST", "/deactivate")[0].body).toEqual({ reason: "Vertrag beendet" });
    // A deactivated tenant is offered reactivate, neither deactivate nor resend.
    await expect(page.getByTestId("op-tenant-reactivate")).toBeVisible();
    await expect(page.getByTestId("op-tenant-deactivate")).toHaveCount(0);
    await expect(page.getByTestId("op-tenant-resend")).toHaveCount(0);
  });

  test("reactivate asks first and then shows the tenant as active", async ({ page }) => {
    const mock = await mockOperatorApi(page);
    mock.state.detail = {
      ...TENANT,
      deactivatedAt: "2026-03-01T08:00:00.000Z",
      deactivatedReason: "Vertrag beendet",
    };
    await seedOperatorSession(page);
    await page.goto(`/betreiber/mandanten/${TENANT_ID}`);
    await expect(page.getByTestId("op-tenant-status")).toHaveAttribute("data-state", "deactivated");

    await page.getByTestId("op-tenant-reactivate").click();
    const dialog = page.getByRole("dialog", { name: "Mandant reaktivieren?" });
    await expect(dialog).toBeVisible();
    expect(callsTo(mock, "POST", "/reactivate")).toHaveLength(0);
    await dialog.getByRole("button", { name: "Mandant reaktivieren" }).click();

    await expect(page.getByTestId("op-tenant-status")).toHaveAttribute("data-state", "active");
    await expect(page.getByTestId("op-tenant-deactivated-notice")).toHaveCount(0);
    await expect(dialog).toHaveCount(0);
    expect(callsTo(mock, "POST", "/reactivate")).toHaveLength(1);
  });

  for (const code of ["TENANT_IN_USE", "NO_PENDING_INVITATION"] as const) {
    test(`resend answered with ${code} shows the notice by code and keeps the dialog open`, async ({
      page,
    }) => {
      const mock = await openTenant(page);
      mock.state.resend = code;

      await page.getByTestId("op-tenant-resend").click();
      const dialog = page.getByRole("dialog", { name: "Einladung erneut senden?" });
      await dialog.getByRole("button", { name: "Einladung senden" }).click();

      const notice = dialog.getByTestId("op-tenant-notice");
      await expect(notice).toBeVisible();
      await expect(notice).toHaveAttribute("data-code", code);
      // The server's text is never shown; the console words the reason itself.
      await expect(notice).not.toContainText("Serverseitiger Text");
      await expect(dialog).toBeVisible();
      expect(callsTo(mock, "POST", "/resend-admin-invitation")).toHaveLength(1);
      expect(callsTo(mock, "POST", "/resend-admin-invitation")[0].body).toBeNull();
    });
  }

  test("resend with a mail that could not be sent leaves a warning on the page", async ({
    page,
  }) => {
    const mock = await openTenant(page);
    mock.state.resend = "not-sent";

    await page.getByTestId("op-tenant-resend").click();
    const dialog = page.getByRole("dialog", { name: "Einladung erneut senden?" });
    await dialog.getByRole("button", { name: "Einladung senden" }).click();

    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId("op-tenant-mail-warning")).toBeVisible();
    await expect(page.getByTestId("op-tenant-mail-warning")).toHaveClass(/alert-warning/);
  });

  test("a sent invitation closes the dialog without a warning", async ({ page }) => {
    const mock = await openTenant(page);

    await page.getByTestId("op-tenant-resend").click();
    const dialog = page.getByRole("dialog", { name: "Einladung erneut senden?" });
    await dialog.getByRole("button", { name: "Einladung senden" }).click();

    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId("op-tenant-mail-warning")).toHaveCount(0);
    expect(callsTo(mock, "POST", "/resend-admin-invitation")).toHaveLength(1);
  });

  test("at 360 px the action row wraps and nothing leaves the viewport", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await openTenant(page);

    const row = page.getByTestId("op-tenant-actions");
    // Control: the flex-wrap recipe is really applied, not merely present in the source.
    await expect(row).toHaveCSS("display", "flex");
    await expect(row).toHaveCSS("flex-wrap", "wrap");
    const overflow = await page.evaluate(() => {
      const root = document.documentElement;
      const rowEl = document.querySelector('[data-testid="op-tenant-actions"]') as HTMLElement;
      const limit = rowEl.getBoundingClientRect().right;
      const beyond = [...rowEl.children].filter(
        (child) => child.getBoundingClientRect().right > limit + 0.5,
      ).length;
      return { page: root.scrollWidth - root.clientWidth, beyond };
    });
    expect(overflow.page).toBeLessThanOrEqual(0);
    expect(overflow.beyond).toBe(0);
  });
});

test.describe("operator console - salon form", () => {
  const SECOND_SALON_ID = randomUUID();
  const SECOND_SALON: MockSalon = {
    id: SECOND_SALON_ID,
    name: "Zweitsalon",
    street: null,
    postalCode: null,
    city: null,
    openingHours: HOURS,
    federalState: "HESSEN",
    isActive: true,
    deactivatedAt: null,
    createdAt: "2026-03-05T08:00:00.000Z",
    isDefault: false,
    coupling: null,
  };

  async function openTenantPage(page: Page, twoActiveSalons = true) {
    const mock = await mockOperatorApi(page);
    if (twoActiveSalons) mock.state.salons = [...mock.state.salons, structuredClone(SECOND_SALON)];
    await seedOperatorSession(page);
    await page.goto(`/betreiber/mandanten/${TENANT_ID}`);
    await expect(page.getByTestId("op-salons-table")).toBeVisible();
    return mock;
  }

  /** The body of the last salon write of the given method. */
  function lastSalonBody(mock: OperatorMock, method: "POST" | "PATCH"): Record<string, unknown> {
    const writes = mock.calls.filter(
      (call) => call.method === method && call.path.startsWith(`/tenants/${TENANT_ID}/salons`),
    );
    const last = writes.at(-1);
    if (!last?.body) throw new Error(`no ${method} salon request was recorded`);
    return last.body;
  }

  test("create: the Bundesland keeps the submit disabled, the POST carries seven days and no coupling key", async ({
    page,
  }) => {
    const mock = await openTenantPage(page);

    await page.getByTestId("op-salon-create").click();
    await expect(page.getByTestId("op-salon-dialog")).toBeVisible();
    await expect(page.getByTestId("op-salon-federal-state")).toHaveValue("");
    await page.getByTestId("op-salon-name").fill("Neuer Salon");
    await expect(page.getByTestId("op-salon-submit")).toBeDisabled();

    await page.getByTestId("op-salon-federal-state").selectOption("BAYERN");
    await expect(page.getByTestId("op-salon-submit")).toBeEnabled();
    // The hours start from the Standardsalon's: Montag-Freitag 09:00-18:00, Samstag/Sonntag closed.
    await expect(page.getByTestId("op-salon-hours-0-from")).toHaveValue("09:00");
    await expect(page.getByTestId("op-salon-hours-5-open")).not.toBeChecked();
    await page.getByTestId("op-salon-submit").click();

    await expect(page.getByTestId("op-salon-dialog")).toHaveCount(0);
    await expect(page.getByTestId("op-salons-table")).toContainText("Neuer Salon");

    const body = lastSalonBody(mock, "POST");
    expect(body.name).toBe("Neuer Salon");
    expect(body.federalState).toBe("BAYERN");
    expect("coupling" in body).toBe(false);
    const hours = body.openingHours as Array<Record<string, unknown>>;
    expect(hours).toHaveLength(7);
    expect(hours.map((entry) => entry.day)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(hours[0]).toEqual({ day: 0, open: "09:00", close: "18:00", closed: false });
    expect(hours[6]).toEqual({ day: 6, open: "09:00", close: "18:00", closed: true });
    // The list was re-read from the server after the save.
    expect(mock.seen.filter((entry) => entry === `GET /tenants/${TENANT_ID}/salons`).length).toBe(
      2,
    );
  });

  test("edit: a name-only change sends exactly { name } and the save waits for a change", async ({
    page,
  }) => {
    const mock = await openTenantPage(page);

    await page.getByTestId(`op-salon-edit-${SECOND_SALON_ID}`).click();
    await expect(page.getByTestId("op-salon-name")).toHaveValue("Zweitsalon");
    await expect(page.getByTestId("op-salon-submit")).toBeDisabled();
    await page.getByTestId("op-salon-name").fill("Umbenannter Salon");
    await expect(page.getByTestId("op-salon-submit")).toBeEnabled();
    await page.getByTestId("op-salon-submit").click();

    await expect(page.getByTestId("op-salon-dialog")).toHaveCount(0);
    await expect(page.getByTestId(`op-salon-name-${SECOND_SALON_ID}`)).toHaveText(
      "Umbenannter Salon",
    );
    expect(lastSalonBody(mock, "PATCH")).toEqual({ name: "Umbenannter Salon" });
  });

  test("a refused Bundesland change shows the reason on top and marks the field, the dialog stays", async ({
    page,
  }) => {
    const mock = await openTenantPage(page);
    mock.state.salonRefusal = { status: 409, code: "FEDERAL_STATE_IN_USE" };

    await page.getByTestId(`op-salon-edit-${SECOND_SALON_ID}`).click();
    await page.getByTestId("op-salon-federal-state").selectOption("BAYERN");
    await page.getByTestId("op-salon-submit").click();

    const reason = page.getByTestId("op-salon-reason");
    await expect(reason).toHaveAttribute("data-code", "FEDERAL_STATE_IN_USE");
    await expect(reason).toContainText("Ein Umzug ist ein neuer Salon.");
    await expect(page.getByTestId("op-salon-federal-state")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    await expect(page.getByTestId("op-salon-dialog")).toBeVisible();
    expect(lastSalonBody(mock, "PATCH")).toEqual({ federalState: "BAYERN" });
  });

  test("coupling: set from Keine sends { coupling: { externalBranchId } } and the row shows it", async ({
    page,
  }) => {
    const mock = await openTenantPage(page);

    await page.getByTestId(`op-salon-edit-${SECOND_SALON_ID}`).click();
    await page.getByTestId("op-salon-coupling-provider").selectOption("PHOREST");
    await expect(page.getByTestId("op-salon-submit")).toBeDisabled();
    await page.getByTestId("op-salon-coupling-branch").fill("branch-new-1");
    await page.getByTestId("op-salon-submit").click();

    await expect(page.getByTestId("op-salon-dialog")).toHaveCount(0);
    await expect(page.getByTestId(`op-salon-coupling-${SECOND_SALON_ID}`)).toContainText(
      "Phorest · branch-new-1",
    );
    expect(lastSalonBody(mock, "PATCH")).toEqual({
      coupling: { externalBranchId: "branch-new-1" },
    });
  });

  test("coupling: replacing the branch sends the new branch and nothing else", async ({ page }) => {
    const mock = await openTenantPage(page);

    await page.getByTestId(`op-salon-edit-${DEFAULT_SALON_ID}`).click();
    await expect(page.getByTestId("op-salon-coupling-branch")).toHaveValue(BRANCH_ID);
    await page.getByTestId("op-salon-coupling-branch").fill("branch-replaced");
    await page.getByTestId("op-salon-submit").click();

    await expect(page.getByTestId("op-salon-dialog")).toHaveCount(0);
    await expect(page.getByTestId(`op-salon-coupling-${DEFAULT_SALON_ID}`)).toContainText(
      "Phorest · branch-replaced",
    );
    expect(lastSalonBody(mock, "PATCH")).toEqual({
      coupling: { externalBranchId: "branch-replaced" },
    });
  });

  test("coupling: removal shows its hint before the save and sends { coupling: null }", async ({
    page,
  }) => {
    const mock = await openTenantPage(page);

    await page.getByTestId(`op-salon-edit-${DEFAULT_SALON_ID}`).click();
    await expect(page.getByTestId("op-salon-coupling-remove-hint")).toHaveCount(0);
    await page.getByTestId("op-salon-coupling-provider").selectOption("NONE");
    await expect(page.getByTestId("op-salon-coupling-remove-hint")).toBeVisible();
    expect(mock.calls.filter((call) => call.method === "PATCH")).toHaveLength(0);
    await page.getByTestId("op-salon-submit").click();

    await expect(page.getByTestId("op-salon-dialog")).toHaveCount(0);
    await expect(page.getByTestId(`op-salon-coupling-${DEFAULT_SALON_ID}`)).toContainText("Keine");
    expect(lastSalonBody(mock, "PATCH")).toEqual({ coupling: null });
  });

  test("a branch already coupled elsewhere attaches to the Filialkennung by its code", async ({
    page,
  }) => {
    const mock = await openTenantPage(page);
    mock.state.salonRefusal = { status: 409, code: "BRANCH_ALREADY_COUPLED" };

    await page.getByTestId(`op-salon-edit-${SECOND_SALON_ID}`).click();
    await page.getByTestId("op-salon-coupling-provider").selectOption("PHOREST");
    await page.getByTestId("op-salon-coupling-branch").fill(BRANCH_ID);
    await page.getByTestId("op-salon-submit").click();

    const message = page.getByTestId("op-salon-coupling-branch-error");
    await expect(message).toHaveAttribute("data-code", "BRANCH_ALREADY_COUPLED");
    await expect(page.getByTestId("op-salon-coupling-branch")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    await expect(page.getByTestId("op-salon-dialog")).toBeVisible();
    await expect(page.getByTestId("op-salon-error")).toHaveCount(0);
  });

  test("the salon form does not show a tenant-settings hint", async ({ page }) => {
    // The tenant-settings mirror of the opening hours is retired (Issue #563); a one-salon
    // tenant must not be promised an overwrite any more.
    await openTenantPage(page, false);
    await page.getByTestId("op-salon-create").click();
    await expect(page.getByTestId("op-salon-dialog")).toBeVisible();
    await expect(page.getByTestId("op-salon-single-salon-hint")).toHaveCount(0);
    await expect(page.getByTestId("op-salon-dialog")).not.toContainText("Mandanten-Einstellungen");
  });

  test("at 360 px the dialog's von/bis inputs share a line and nothing overflows", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await openTenantPage(page);
    await page.getByTestId("op-salon-create").click();
    await expect(page.getByTestId("op-salon-dialog")).toBeVisible();
    // The dialog enters with a 0.2 s transform animation; measuring mid-flight skews the y values.
    await animationsSettled(page);

    const from = await page.getByTestId("op-salon-hours-0-from").boundingBox();
    const to = await page.getByTestId("op-salon-hours-0-to").boundingBox();
    expect(from && to).toBeTruthy();
    expect(Math.abs((from?.y ?? 0) - (to?.y ?? 100))).toBeLessThan(2);
    expect((to?.x ?? 0) + (to?.width ?? 0)).toBeLessThanOrEqual(360);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflow).toBe(false);
  });
});

test.describe("operator console - salon lifecycle", () => {
  const SECOND_SALON_ID = randomUUID();
  const SECOND_SALON: MockSalon = {
    id: SECOND_SALON_ID,
    name: "Zweitsalon",
    street: null,
    postalCode: null,
    city: null,
    openingHours: HOURS,
    federalState: "HESSEN",
    isActive: true,
    deactivatedAt: null,
    createdAt: "2026-03-05T08:00:00.000Z",
    isDefault: false,
    coupling: null,
  };

  /** Hauptsalon (active) + Altsalon (inactive) from the base mock; `twoActive` adds Zweitsalon. */
  async function openTenantPage(page: Page, twoActive = true) {
    const mock = await mockOperatorApi(page);
    if (twoActive) mock.state.salons = [...mock.state.salons, structuredClone(SECOND_SALON)];
    await seedOperatorSession(page);
    await page.goto(`/betreiber/mandanten/${TENANT_ID}`);
    await expect(page.getByTestId("op-salons-table")).toBeVisible();
    return mock;
  }

  const confirmDialog = (page: Page) => page.getByRole("dialog", { name: "Salon deaktivieren?" });

  test("a refused deactivation (HOME_SALON_IN_USE) is shown by its code inside the open dialog", async ({
    page,
  }) => {
    const mock = await openTenantPage(page);
    mock.state.lifecycleRefusal = { status: 409, code: "HOME_SALON_IN_USE" };

    await page.getByTestId(`op-salon-deactivate-${SECOND_SALON_ID}`).click();
    await expect(confirmDialog(page)).toBeVisible();
    await confirmDialog(page).getByRole("button", { name: "Salon deaktivieren" }).click();

    const error = page.getByTestId("op-salon-deactivate-error");
    await expect(error).toHaveAttribute("data-code", "HOME_SALON_IN_USE");
    await expect(error).toContainText("noch Stammsalon von Mitarbeitenden");
    await expect(error).not.toContainText("Serverseitiger Text");
    await expect(confirmDialog(page)).toBeVisible();
    await expect(page.getByTestId(`op-salon-status-${SECOND_SALON_ID}`)).toHaveAttribute(
      "data-state",
      "active",
    );
  });

  test("LAST_ACTIVE_SALON from a stale page (two salons listed) shows in the dialog", async ({
    page,
  }) => {
    const mock = await openTenantPage(page);
    mock.state.lifecycleRefusal = { status: 409, code: "LAST_ACTIVE_SALON" };

    await page.getByTestId(`op-salon-deactivate-${SECOND_SALON_ID}`).click();
    await confirmDialog(page).getByRole("button", { name: "Salon deaktivieren" }).click();

    await expect(page.getByTestId("op-salon-deactivate-error")).toHaveAttribute(
      "data-code",
      "LAST_ACTIVE_SALON",
    );
    await expect(confirmDialog(page)).toBeVisible();
  });

  test("the dialog names the consequences and a successful deactivation shows the row as deactivated", async ({
    page,
  }) => {
    const mock = await openTenantPage(page);

    await page.getByTestId(`op-salon-deactivate-${SECOND_SALON_ID}`).click();
    await expect(confirmDialog(page)).toContainText("„Zweitsalon“ wird deaktiviert.");
    await expect(confirmDialog(page)).toContainText("Einsatzsalon-Zuordnungen enden");
    expect(mock.calls.some((call) => call.path.endsWith("/deactivate"))).toBe(false);

    await confirmDialog(page).getByRole("button", { name: "Salon deaktivieren" }).click();
    await expect(confirmDialog(page)).toHaveCount(0);
    await expect(page.getByTestId(`op-salon-status-${SECOND_SALON_ID}`)).toHaveAttribute(
      "data-state",
      "deactivated",
    );
    expect(mock.seen).toContain(`POST /tenants/${TENANT_ID}/salons/${SECOND_SALON_ID}/deactivate`);
    // The list was reloaded from the server, not edited locally.
    expect(mock.seen.filter((entry) => entry === `GET /tenants/${TENANT_ID}/salons`).length).toBe(
      2,
    );
  });

  test("activation needs no dialog and shows the row as active", async ({ page }) => {
    const mock = await openTenantPage(page);

    await page.getByTestId(`op-salon-activate-${OLD_SALON_ID}`).click();

    await expect(page.getByTestId(`op-salon-status-${OLD_SALON_ID}`)).toHaveAttribute(
      "data-state",
      "active",
    );
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(mock.seen).toContain(`POST /tenants/${TENANT_ID}/salons/${OLD_SALON_ID}/activate`);
  });

  test("ALREADY_ACTIVE lands in the page notice with its code, and the next success clears it", async ({
    page,
  }) => {
    const mock = await openTenantPage(page);
    mock.state.lifecycleRefusal = { status: 409, code: "ALREADY_ACTIVE" };

    await page.getByTestId(`op-salon-activate-${OLD_SALON_ID}`).click();
    const notice = page.getByTestId("op-salons-notice");
    await expect(notice).toHaveAttribute("data-code", "ALREADY_ACTIVE");
    await expect(notice).toHaveAttribute("role", "alert");
    await expect(notice).toContainText("Salon „Altsalon“: Der Salon ist bereits aktiv.");

    mock.state.lifecycleRefusal = null;
    await page.getByTestId(`op-salon-activate-${OLD_SALON_ID}`).click();
    await expect(page.getByTestId("op-salons-notice")).toHaveCount(0);
  });

  test("a tenant with one active salon: Deaktivieren is aria-disabled, the note is visible, no request leaves", async ({
    page,
  }) => {
    const mock = await openTenantPage(page, false);

    const control = page.getByTestId(`op-salon-deactivate-${DEFAULT_SALON_ID}`);
    await expect(control).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByTestId("op-salons-last-active-note")).toBeVisible();
    await expect(page.getByTestId("op-salons-last-active-note")).toContainText(
      "Der letzte aktive Salon lässt sich nicht deaktivieren.",
    );
    // Playwright treats aria-disabled as not actionable; a user can still press it, so force it.
    await control.click({ force: true });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(mock.calls.some((call) => call.path.endsWith("/deactivate"))).toBe(false);
  });

  test("a deactivated tenant shows the hint and freezes the salon controls", async ({ page }) => {
    const mock = await mockOperatorApi(page);
    mock.state.detail = {
      ...mock.state.detail,
      deactivatedAt: "2026-10-01T08:00:00.000Z",
      deactivatedReason: "Vertrag beendet",
    };
    await seedOperatorSession(page);
    await page.goto(`/betreiber/mandanten/${TENANT_ID}`);
    await expect(page.getByTestId("op-salons-table")).toBeVisible();

    await expect(page.getByTestId("op-salons-tenant-frozen-hint")).toContainText(
      "Der Mandant ist deaktiviert. Änderungen sind erst nach der Reaktivierung möglich.",
    );
    await expect(page.getByTestId("op-salon-create")).toBeDisabled();
    await expect(page.getByTestId(`op-salon-edit-${DEFAULT_SALON_ID}`)).toBeDisabled();
    await expect(page.getByTestId(`op-salon-deactivate-${DEFAULT_SALON_ID}`)).toBeDisabled();
    await expect(page.getByTestId(`op-salon-activate-${OLD_SALON_ID}`)).toBeDisabled();
    await expect(page.getByTestId("op-salon-create")).toHaveAttribute(
      "aria-describedby",
      "op-salons-tenant-frozen-hint",
    );
  });

  test("an active tenant shows no frozen hint", async ({ page }) => {
    await openTenantPage(page);
    await expect(page.getByTestId("op-salons-tenant-frozen-hint")).toHaveCount(0);
    await expect(page.getByTestId("op-salon-create")).toBeEnabled();
  });

  test("no element on the tenant page is named like a delete action", async ({ page }) => {
    await openTenantPage(page);
    await expect(page.getByRole("button", { name: /löschen|entfernen/i })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /löschen|entfernen/i })).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: /löschen|entfernen/i })).toHaveCount(0);
  });
});

// ── Geometry: 1440 down to 360 px with worst-case texts (D-14, #553 lesson) ──────────────────

const VIEWPORTS = [
  { name: "1440 px", width: 1440, height: 900, stacked: false },
  { name: "768 px", width: 768, height: 1024, stacked: false },
  { name: "390 px", width: 390, height: 844, stacked: true },
  { name: "360 px", width: 360, height: 800, stacked: true },
] as const;

const LONG_TENANT_NAME = "Langer".repeat(34).slice(0, 200);
const LONG_REASON = "Grund ".repeat(100).trim().slice(0, 500);
const LONG_STREET = "Sehr-lange-Strasse-".repeat(4).slice(0, 60);

/**
 * Descendants of `container` that reach beyond its right edge, labelled by test id (or tag and
 * class). Measured on the children with getBoundingClientRect, never on scrollWidth of the
 * container: a clipping parent reports a scrollWidth that hides exactly the overflow in question.
 * Elements of 1 x 1 px or less (the visually hidden live regions) are not content.
 */
async function offendersOf(page: Page, containerSelector: string): Promise<string[]> {
  return page.evaluate((selector) => {
    const containers = [...document.querySelectorAll(selector)];
    if (containers.length === 0) return [`no element matches ${selector}`];
    return containers.flatMap((container) => {
      const limit = container.getBoundingClientRect().right + 0.5;
      return [...container.querySelectorAll("*")]
        .filter((child) => {
          const box = child.getBoundingClientRect();
          if (box.width <= 1 && box.height <= 1) return false;
          // Content of a visually hidden element (the header of a stacked list) is not on screen.
          for (let up = child.parentElement; up && up !== container; up = up.parentElement) {
            const upBox = up.getBoundingClientRect();
            if (upBox.width <= 1 && upBox.height <= 1) return false;
          }
          return box.right > limit;
        })
        .map((child) => {
          const id = child.getAttribute("data-testid");
          return `${selector} > ${id ?? `${child.tagName.toLowerCase()}.${child.className}`}`;
        });
    });
  }, containerSelector);
}

/**
 * Document-level overflow: empty when the page does not scroll sideways, otherwise the elements
 * that reach past the viewport (labelled like offendersOf), so a red run names the culprit.
 */
async function pageOverflow(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const html = document.documentElement;
    if (html.scrollWidth <= window.innerWidth) return [];
    const culprits = [...document.body.querySelectorAll("*")]
      .filter((el) => {
        const box = el.getBoundingClientRect();
        return !(box.width <= 1 && box.height <= 1) && box.right > window.innerWidth + 0.5;
      })
      .map((el) => el.getAttribute("data-testid") ?? `${el.tagName.toLowerCase()}.${el.className}`);
    // Text that spills out of a box which does not clip it: the box fits, its content does not.
    const spilling = [...document.body.querySelectorAll("*")]
      .filter(
        (el) =>
          el.clientWidth > 0 &&
          el.scrollWidth > el.clientWidth + 1 &&
          getComputedStyle(el).overflowX === "visible",
      )
      .map(
        (el) =>
          `spills: ${el.getAttribute("data-testid") ?? `${el.tagName.toLowerCase()}.${el.className}`}`,
      );
    return [`html scrolls: ${html.scrollWidth} > ${window.innerWidth}`, ...culprits, ...spilling];
  });
}

/**
 * The open dialog's backdrop must cover the whole viewport. A dialog rendered inside a transformed
 * ancestor (before #570, a Section with a finished card-animate entrance kept `transform: matrix(...)`) is
 * positioned against that ancestor instead: the scrim then covers only the card and the dialog is
 * shifted and clipped. Returns what is wrong, empty when the scrim is the viewport.
 */
async function scrimProblems(page: Page): Promise<string[]> {
  // Let the finite entrance animations end first: mid-flight they shift the page by a few pixels.
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
  return page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    const scrim = dialog?.parentElement;
    if (!dialog || !scrim) return ["no open dialog"];
    const box = scrim.getBoundingClientRect();
    const problems: string[] = [];
    if (Math.abs(box.left) > 0.5 || Math.abs(box.top) > 0.5) {
      problems.push(`scrim starts at ${box.left}/${box.top}`);
    }
    if (Math.abs(box.right - window.innerWidth) > 1.5) {
      problems.push(`scrim ends at ${box.right}, viewport ${window.innerWidth}`);
    }
    if (Math.abs(box.bottom - window.innerHeight) > 1.5) {
      problems.push(`scrim bottom ${box.bottom}, viewport ${window.innerHeight}`);
    }
    return problems;
  });
}

/** True when the element is rendered as the visually hidden 1 x 1 px header of a stacked list. */
async function isVisuallyHidden(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const box = el.getBoundingClientRect();
    return box.width <= 1 && box.height <= 1;
  }, selector);
}

/** True when a scroll wrapper (or the given element) clips content horizontally. */
async function wrapperClips(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? el.scrollWidth > el.clientWidth : false;
  }, selector);
}

for (const viewport of VIEWPORTS) {
  test.describe(`operator console - geometry at ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    const longTenant: MockTenant = {
      ...TENANT,
      name: LONG_TENANT_NAME,
    };
    const frozenTenant: MockTenant = {
      ...TENANT,
      name: LONG_TENANT_NAME,
      deactivatedAt: "2026-03-01T08:00:00.000Z",
      deactivatedReason: LONG_REASON,
    };
    const longStreetSalons = (): MockSalon[] =>
      structuredClone(SALONS).map((salon) =>
        salon.id === DEFAULT_SALON_ID ? { ...salon, street: LONG_STREET } : salon,
      );

    async function openDetail(page: Page, tenant: MockTenant): Promise<void> {
      const mock = await mockOperatorApi(page);
      mock.state.detail = { ...tenant };
      mock.state.salons = longStreetSalons();
      await seedOperatorSession(page);
      await page.goto(`/betreiber/mandanten/${TENANT_ID}`);
      await expect(page.getByTestId("op-salons-table")).toBeVisible();
    }

    test("the sign-in page fits", async ({ page }) => {
      await mockOperatorApi(page);
      await page.goto("/betreiber/anmelden");
      await expect(page.getByTestId("op-signin-page")).toBeVisible();

      expect(await pageOverflow(page)).toEqual([]);
      expect(await offendersOf(page, '[data-testid="op-signin-page"]')).toEqual([]);
    });

    test("the tenant list fits with a 200-character name and a 500-character reason", async ({
      page,
    }) => {
      const listed = { ...frozenTenant, id: randomUUID() };
      await openTenantList(page, (state) => {
        state.tenants = [listed, TENANT];
      });
      await expect(page.getByTestId(`op-tenant-row-${listed.id}`)).toBeVisible();

      expect(await pageOverflow(page)).toEqual([]);
      expect(await offendersOf(page, '[data-testid="op-bar"]')).toEqual([]);
      expect(await offendersOf(page, '[data-testid="op-tenants-table"]')).toEqual([]);
      expect(await offendersOf(page, '[data-testid="op-tenants-page"]')).toEqual([]);
      expect(await wrapperClips(page, ".table-wrap")).toBe(false);
      // Stacked list below 640 px: the header row is not shown, the rows are not table rows.
      expect(await isVisuallyHidden(page, '[data-testid="op-tenants-table"] thead')).toBe(
        viewport.stacked,
      );
    });

    test("the create-tenant dialog fits", async ({ page }) => {
      await openTenantList(page);
      await page.getByTestId("op-tenants-create").click();
      await expect(page.getByTestId("op-tenant-create-dialog")).toBeVisible();
      await page.getByTestId("op-tenant-create-name").fill(LONG_TENANT_NAME);
      await page
        .getByTestId("op-tenant-create-admin-email")
        .fill(`${"a".repeat(60)}@example.invalid`);

      expect(await pageOverflow(page)).toEqual([]);
      expect(await offendersOf(page, '[role="dialog"]')).toEqual([]);
      expect(await scrimProblems(page)).toEqual([]);
      const box = await page.locator('[role="dialog"]').first().boundingBox();
      expect(box).not.toBeNull();
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(viewport.width + 0.5);
    });

    test("the tenant detail fits, the 200-character name is shown whole", async ({ page }) => {
      await openDetail(page, longTenant);

      expect(await pageOverflow(page)).toEqual([]);
      expect(await offendersOf(page, '[data-testid="op-bar"]')).toEqual([]);
      expect(await offendersOf(page, "main section")).toEqual([]);
      expect(await offendersOf(page, '[data-testid="op-salons-table"]')).toEqual([]);
      expect(await wrapperClips(page, ".table-wrap")).toBe(false);

      // Not ellipsised: the text is wrapped, so the element holds all of it.
      await expect(page.getByTestId("op-tenant-name")).toHaveText(LONG_TENANT_NAME);
      expect(await wrapperClips(page, '[data-testid="op-tenant-name"]')).toBe(false);

      expect(await isVisuallyHidden(page, '[data-testid="op-salons-table"] thead')).toBe(
        viewport.stacked,
      );
    });

    test("a deactivated tenant with a 500-character reason fits", async ({ page }) => {
      await openDetail(page, frozenTenant);
      await expect(page.getByTestId("op-tenant-deactivated-notice")).toContainText("Grund");

      expect(await pageOverflow(page)).toEqual([]);
      expect(await offendersOf(page, '[data-testid="op-bar"]')).toEqual([]);
      expect(await offendersOf(page, "main section")).toEqual([]);
      expect(await offendersOf(page, '[data-testid="op-tenant-deactivated-notice"]')).toEqual([]);
      expect(await offendersOf(page, '[data-testid="op-salons-table"]')).toEqual([]);
    });

    test("the salon dialog in edit mode fits with a 60-character street", async ({ page }) => {
      await openDetail(page, longTenant);
      await page.getByTestId(`op-salon-edit-${DEFAULT_SALON_ID}`).click();
      await expect(page.getByTestId("op-salon-dialog")).toBeVisible();
      await expect(page.getByTestId("op-salon-street")).toHaveValue(LONG_STREET);

      expect(await pageOverflow(page)).toEqual([]);
      expect(await offendersOf(page, '[role="dialog"]')).toEqual([]);
      expect(await scrimProblems(page)).toEqual([]);
      const box = await page.locator('[role="dialog"]').first().boundingBox();
      expect(box).not.toBeNull();
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(viewport.width + 0.5);
    });

    test("animated sections keep no transform after their entrance (#570)", async ({ page }) => {
      await openDetail(page, longTenant);
      await animationsSettled(page);
      const transforms = await page.evaluate(() =>
        [...document.querySelectorAll(".card-animate")].map((el) => getComputedStyle(el).transform),
      );
      // Non-vacuous: the Mandant and the Pakete section are animated again since #570.
      expect(transforms.length).toBeGreaterThanOrEqual(2);
      expect(transforms.every((t) => t === "none")).toBe(true);
    });

    test("the deactivate-tenant reason dialog fits with a 500-character reason", async ({
      page,
    }) => {
      await openDetail(page, longTenant);
      await page.getByTestId("op-tenant-deactivate").click();
      const dialog = page.getByRole("dialog", { name: "Mandant deaktivieren?" });
      await expect(dialog).toBeVisible();
      await dialog.getByLabel("Begründung").fill(LONG_REASON);

      expect(await pageOverflow(page)).toEqual([]);
      expect(await offendersOf(page, '[role="dialog"]')).toEqual([]);
      expect(await scrimProblems(page)).toEqual([]);
      const box = await dialog.boundingBox();
      expect(box).not.toBeNull();
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(viewport.width + 0.5);
    });

    test("the bar's rule is styled: its border differs from a control with an invented class", async ({
      page,
    }) => {
      await openTenantList(page);
      await expect(page.getByTestId("op-bar")).toBeVisible();
      await page.evaluate(() => {
        const control = document.createElement("div");
        control.className = "op-geometry-control-7f3a";
        control.setAttribute("data-testid", "op-geometry-control");
        document.body.appendChild(control);
      });

      const bar = await page.getByTestId("op-bar").evaluate((el) => {
        const style = getComputedStyle(el);
        return { width: style.borderTopWidth, style: style.borderTopStyle };
      });
      const control = await page.getByTestId("op-geometry-control").evaluate((el) => {
        const style = getComputedStyle(el);
        return { width: style.borderTopWidth, style: style.borderTopStyle };
      });
      expect(bar.width).toBe("2px");
      expect(bar.style).toBe("solid");
      expect(control.width).not.toBe(bar.width);
    });
  });
}

// ── Look: pinned theme / skin / density, axe in light and dark, restore on leaving (D-01) ────────

type LookPrefs = Partial<Record<"theme" | "mode" | "skin" | "density", string>>;

/** Store the device's look preferences before the page loads, exactly where the stores read them. */
async function storeLookPrefs(page: Page, prefs: LookPrefs): Promise<void> {
  await page.addInitScript((entries) => {
    for (const [key, value] of entries) localStorage.setItem(key, value);
  }, Object.entries(prefs));
}

/** Wait until every finite animation has ended: mid-flight opacity would skew contrast results. */
async function animationsSettled(page: Page): Promise<void> {
  await page.evaluate(() =>
    Promise.race([
      Promise.all(
        document
          .getAnimations()
          .filter((a) => (a.effect?.getComputedTiming().endTime ?? 0) < 5000)
          .map((a) => a.finished.catch(() => undefined)),
      ),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]),
  );
}

/** The look attributes of <html>. */
async function htmlLook(page: Page) {
  return page.evaluate(() => {
    const html = document.documentElement;
    return {
      theme: html.getAttribute("data-theme"),
      density: html.getAttribute("data-density"),
      skin: html.getAttribute("data-skin"),
      mode: html.getAttribute("data-mode"),
    };
  });
}

/**
 * WCAG contrast ratio between the text colour of the element and its effective background (its own
 * colour blended over every translucent ancestor). Colours are normalised to sRGB through a canvas,
 * because computed styles may be oklch()/color-mix() strings.
 */
async function contrastOf(page: Page, testId: string): Promise<number> {
  return page.getByTestId(testId).evaluate((el) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("no 2d canvas");
    const rgba = (css: string): [number, number, number, number] => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "#000";
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    };
    const over = (
      top: [number, number, number, number],
      base: [number, number, number],
    ): [number, number, number] => [
      top[0] * top[3] + base[0] * (1 - top[3]),
      top[1] * top[3] + base[1] * (1 - top[3]),
      top[2] * top[3] + base[2] * (1 - top[3]),
    ];
    // Background: walk up to the first opaque layer, then blend back down.
    const layers: Array<[number, number, number, number]> = [];
    for (let node: Element | null = el; node; node = node.parentElement) {
      const layer = rgba(getComputedStyle(node).backgroundColor);
      if (layer[3] > 0) layers.push(layer);
      if (layer[3] >= 1) break;
    }
    let background: [number, number, number] = [255, 255, 255];
    for (const layer of layers.reverse()) background = over(layer, background);
    // A gradient fill (the modern skin's primary button): every colour stop is a possible
    // background behind the text, the weakest one decides.
    const stops = [
      ...(getComputedStyle(el).backgroundImage.match(
        /rgba?\([^)]*\)|color\([^)]*\)|ok(?:lch|lab)\([^)]*\)|#[0-9a-f]{3,8}/gi,
      ) ?? []),
    ].map((css) => over(rgba(css), background));
    const backgrounds = stops.length > 0 ? stops : [background];
    const luminance = (c: [number, number, number]) => {
      const [r, g, b] = c.map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratios = backgrounds.map((bg) => {
      const text = over(rgba(getComputedStyle(el).color), bg);
      const [hi, lo] = [luminance(text), luminance(bg)].sort((a, b) => b - a);
      return (hi + 0.05) / (lo + 0.05);
    });
    return Math.min(...ratios);
  });
}

test.describe("operator console - fixed look", () => {
  const MODES = ["light", "dark"] as const;

  // The supported pair: editorial x nacht, with a device that stores a tenant look.
  for (const mode of MODES) {
    test.describe(`editorial x nacht, ${mode} mode`, () => {
      async function scan(page: Page): Promise<string[]> {
        await animationsSettled(page);
        const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
        return results.violations.map(
          (v) =>
            `${v.id}: ${v.nodes
              .map((n) => {
                const data = (n.any[0]?.data ?? {}) as Record<string, unknown>;
                return `${n.target.join(" ")} [${data.fgColor ?? ""} on ${data.bgColor ?? ""}, ${data.contrastRatio ?? ""}]`;
              })
              .join(" | ")}`,
        );
      }

      test.beforeEach(async ({ page }) => {
        await storeLookPrefs(page, { mode, theme: "pflaume", skin: "modern", density: "compact" });
      });

      test("sign-in has no WCAG 2 A/AA violations", async ({ page }) => {
        await mockOperatorApi(page);
        await page.goto("/betreiber/anmelden");
        await expect(page.getByTestId("op-signin-page")).toBeVisible();
        expect((await htmlLook(page)).mode).toBe(mode);
        expect(await scan(page)).toEqual([]);
      });

      test("tenant list has no WCAG 2 A/AA violations", async ({ page }) => {
        await openTenantList(page);
        await expect(page.getByTestId("op-tenants-table")).toBeVisible();
        expect((await htmlLook(page)).mode).toBe(mode);
        expect(await scan(page)).toEqual([]);
      });

      test("tenant detail has no WCAG 2 A/AA violations", async ({ page }) => {
        await mockOperatorApi(page);
        await seedOperatorSession(page);
        await page.goto(`/betreiber/mandanten/${TENANT_ID}`);
        await expect(page.getByTestId("op-salons-table")).toBeVisible();
        expect((await htmlLook(page)).mode).toBe(mode);
        expect(await scan(page)).toEqual([]);
      });
    });
  }

  // A device that stores a tenant look gets the operator look regardless (the pin), readable.
  const STORED_LOOKS: Array<{ name: string; prefs: LookPrefs }> = [
    {
      name: "modern skin, light",
      prefs: { skin: "modern", theme: "pflaume", density: "compact", mode: "light" },
    },
    {
      name: "modern skin, dark",
      prefs: { skin: "modern", theme: "pflaume", density: "compact", mode: "dark" },
    },
    {
      name: "editorial skin and Pflaume, light",
      prefs: { skin: "editorial", theme: "pflaume", density: "compact", mode: "light" },
    },
  ];
  for (const { name, prefs } of STORED_LOOKS) {
    test.describe(`stored tenant look: ${name}`, () => {
      test.use({ viewport: { width: 360, height: 800 } });

      test("the console is pinned, fits and keeps its primary button and badge readable", async ({
        page,
      }) => {
        await storeLookPrefs(page, prefs);
        await openTenantList(page);
        await expect(page.getByTestId("op-tenants-table")).toBeVisible();
        await animationsSettled(page);

        expect(await htmlLook(page)).toEqual({
          theme: "nacht",
          density: "comfortable",
          skin: null,
          mode: prefs.mode,
        });
        expect(await pageOverflow(page)).toEqual([]);
        expect(await contrastOf(page, "op-tenants-create")).toBeGreaterThanOrEqual(4.5);
        expect(await contrastOf(page, "op-badge")).toBeGreaterThanOrEqual(4.5);
      });
    });
  }

  // The pin bypassed (a future store change): the console must stay legible and fit. The supported
  // pair is editorial x nacht; modern x nacht (light, dark) and editorial x pflaume (light) are
  // smoke-checked by forcing the attributes the pin would have replaced.
  const BYPASSED_LOOKS: Array<{
    name: string;
    mode: "light" | "dark";
    skin: string | null;
    theme: string;
  }> = [
    { name: "modern x nacht, light", mode: "light", skin: "modern", theme: "nacht" },
    { name: "modern x nacht, dark", mode: "dark", skin: "modern", theme: "nacht" },
    { name: "editorial x pflaume, light", mode: "light", skin: null, theme: "pflaume" },
  ];
  for (const look of BYPASSED_LOOKS) {
    test.describe(`pin bypassed: ${look.name}`, () => {
      test.use({ viewport: { width: 360, height: 800 } });

      test("renders without overflow, primary button and badge stay readable", async ({ page }) => {
        await storeLookPrefs(page, { mode: look.mode });
        await openTenantList(page);
        await expect(page.getByTestId("op-tenants-table")).toBeVisible();
        await page.evaluate(({ skin, theme }) => {
          const html = document.documentElement;
          if (skin) html.setAttribute("data-skin", skin);
          else html.removeAttribute("data-skin");
          html.setAttribute("data-theme", theme);
          document.querySelector('[data-testid="op-shell"]')?.setAttribute("data-theme", theme);
        }, look);
        await animationsSettled(page);

        expect(await pageOverflow(page)).toEqual([]);
        expect(await offendersOf(page, '[data-testid="op-bar"]')).toEqual([]);
        expect(await offendersOf(page, '[data-testid="op-tenants-table"]')).toEqual([]);
        expect(await contrastOf(page, "op-tenants-create")).toBeGreaterThanOrEqual(4.5);
        expect(await contrastOf(page, "op-badge")).toBeGreaterThanOrEqual(4.5);
      });
    });
  }

  test("leaving /betreiber puts the device's look back on <html>", async ({ page }) => {
    await storeLookPrefs(page, { theme: "pflaume", skin: "modern", density: "compact" });
    await mockOperatorApi(page);
    await page.goto("/betreiber/anmelden");
    await expect(page.getByTestId("op-signin-page")).toBeVisible();

    // On the console: the operator look, whatever the device stored.
    expect(await htmlLook(page)).toMatchObject({
      theme: "nacht",
      density: "comfortable",
      skin: null,
    });

    // A real client-side navigation: the router handles a click on any same-origin anchor. The
    // marker proves the document was not reloaded (a reload would restore the look by itself).
    await page.evaluate(() => {
      (window as unknown as { __opNavMarker: number }).__opNavMarker = 1;
      const link = document.createElement("a");
      link.href = "/login";
      link.setAttribute("data-testid", "op-test-leave");
      link.textContent = "leave";
      document.body.appendChild(link);
    });
    await page.getByTestId("op-test-leave").click();
    await expect(page).toHaveURL(/\/login$/);

    expect(
      await page.evaluate(() => (window as unknown as { __opNavMarker?: number }).__opNavMarker),
    ).toBe(1);
    await expect
      .poll(() => htmlLook(page))
      .toMatchObject({
        theme: "pflaume",
        density: "compact",
        skin: "modern",
      });
  });
});

test.describe("operator console - packages", () => {
  async function openTenant(page: Page, tenantId = TENANT_ID): Promise<OperatorMock> {
    const mock = await mockOperatorApi(page);
    await seedOperatorSession(page);
    await page.goto(`/betreiber/mandanten/${tenantId}`);
    await expect(page.getByTestId("op-packages-section")).toBeVisible();
    return mock;
  }

  function packageWrites(mock: OperatorMock): RecordedCall[] {
    return mock.calls.filter(
      (c) => c.method === "PUT" && c.path === `/tenants/${TENANT_ID}/packages`,
    );
  }

  test("the section shows four modules, the Ketten-Paket booked and the quota", async ({
    page,
  }) => {
    await openTenant(page);

    await expect(page.getByTestId("package-base")).toContainText("Grundversion");
    const modules = page.getByTestId("package-modules");
    await expect(modules).toContainText("Ketten-Paket");
    await expect(modules).toContainText("Integrationen");
    await expect(modules).toContainText("Hardware-Stempeln");
    await expect(modules).toContainText("Auswertungen");
    await expect(modules.locator('input[type="checkbox"]')).toHaveCount(4);
    await expect(page.getByTestId("package-CHAIN")).toBeChecked();
    await expect(page.getByTestId("package-INTEGRATIONS")).not.toBeChecked();
    await expect(page.getByTestId("package-HARDWARE_CLOCK")).not.toBeChecked();
    await expect(page.getByTestId("package-ANALYTICS")).not.toBeChecked();
    await expect(page.getByTestId("package-quota")).toHaveValue("3");
    await expect(page.getByTestId("package-active-salons")).toHaveText("1");
    await expect(page.getByTestId("package-effective-limit")).toHaveText("3");
    await expect(page.getByTestId("packages-save")).toBeDisabled();
    await expect(page.getByTestId("package-quota-warning")).toHaveCount(0);
  });

  test("ticking Hardware-Stempeln and saving sends exactly { bookedModules, salonQuota }", async ({
    page,
  }) => {
    const mock = await openTenant(page);

    await page.getByTestId("package-HARDWARE_CLOCK").check();
    await expect(page.getByText("Nicht gespeichert")).toBeVisible();
    await page.getByTestId("packages-save").click();

    await expect(page.getByText("Nicht gespeichert")).toHaveCount(0);
    await expect(page.getByTestId("packages-save")).toBeDisabled();
    await expect(page.getByTestId("package-HARDWARE_CLOCK")).toBeChecked();

    const writes = packageWrites(mock);
    expect(writes).toHaveLength(1);
    expect(writes[0].body).toEqual({ bookedModules: ["CHAIN", "HARDWARE_CLOCK"], salonQuota: 3 });
    expect(writes[0].authorization).toMatch(/^Bearer /);
  });

  test("unticking the Ketten-Paket on a tenant with several active salons warns, and still saves", async ({
    page,
  }) => {
    const mock = await mockOperatorApi(page);
    mock.state.detail = {
      ...mock.state.detail,
      packages: { bookedModules: ["CHAIN"], salonQuota: 5, activeSalonCount: 3 },
    };
    await seedOperatorSession(page);
    await page.goto(`/betreiber/mandanten/${TENANT_ID}`);
    await expect(page.getByTestId("op-packages-section")).toBeVisible();
    await expect(page.getByTestId("package-quota-warning")).toHaveCount(0);

    await page.getByTestId("package-CHAIN").uncheck();
    await expect(page.getByTestId("package-effective-limit")).toHaveText("1");
    const warning = page.getByTestId("package-quota-warning");
    await expect(warning).toBeVisible();
    await expect(warning).toContainText("Bestehende Salons bleiben aktiv");
    await expect(page.getByTestId("packages-save")).toBeEnabled();

    await page.getByTestId("packages-save").click();
    await expect(page.getByText("Nicht gespeichert")).toHaveCount(0);
    expect(packageWrites(mock)).toHaveLength(1);
    expect(packageWrites(mock)[0].body).toEqual({ bookedModules: [], salonQuota: 5 });
    // The salons stay as they are: the mock saw no salon write at all.
    expect(mock.calls.filter((c) => c.path.includes("/salons") && c.method !== "GET")).toEqual([]);
  });

  test("a quota outside 1 to 500 shows the inline error and sends nothing", async ({ page }) => {
    const mock = await openTenant(page);

    await page.getByTestId("package-ANALYTICS").check();
    await page.getByTestId("package-quota").fill("501");
    await expect(page.getByTestId("package-quota-error")).toBeVisible();
    await expect(page.getByTestId("packages-save")).toBeDisabled();
    expect(packageWrites(mock)).toHaveLength(0);
  });

  test("a deactivated tenant shows the controls disabled with the frozen hint", async ({
    page,
  }) => {
    await openTenant(page, OFF_TENANT_ID);

    await expect(page.getByTestId("op-packages-tenant-frozen-hint")).toContainText(
      "Der Mandant ist deaktiviert.",
    );
    for (const module of ["CHAIN", "INTEGRATIONS", "HARDWARE_CLOCK", "ANALYTICS"]) {
      await expect(page.getByTestId(`package-${module}`)).toBeDisabled();
    }
    await expect(page.getByTestId("package-quota")).toBeDisabled();
    await expect(page.getByTestId("packages-save")).toBeDisabled();
  });

  test("a salon create refused with SALON_QUOTA_REACHED shows the console's own reason, not the server's sentence", async ({
    page,
  }) => {
    const mock = await openTenant(page);
    mock.state.salonRefusal = { status: 409, code: "SALON_QUOTA_REACHED" };

    await page.getByTestId("op-salon-create").click();
    await page.getByTestId("op-salon-name").fill("Neuer Salon");
    await page.getByTestId("op-salon-federal-state").selectOption("BAYERN");
    await page.getByTestId("op-salon-submit").click();

    const reason = page.getByTestId("op-salon-error");
    await expect(reason).toContainText("Salon-Kontingent erreicht.");
    await expect(reason).toContainText("Abschnitt „Pakete“");
    await expect(reason).not.toContainText("Serverseitiger Text");
    await expect(page.getByTestId("op-salon-dialog")).toBeVisible();
  });

  test("an activation refused with MODULE_NOT_BOOKED points to the Pakete section", async ({
    page,
  }) => {
    const mock = await openTenant(page);
    mock.state.lifecycleRefusal = { status: 409, code: "MODULE_NOT_BOOKED" };

    await page.getByTestId(`op-salon-activate-${OLD_SALON_ID}`).click();

    const notice = page.getByTestId("op-salons-notice");
    await expect(notice).toHaveAttribute("data-code", "MODULE_NOT_BOOKED");
    await expect(notice).toContainText("Abschnitt „Pakete“");
    await expect(notice).not.toContainText("Serverseitiger Text");
  });

  test("a refused save shows the reason by code and keeps the draft", async ({ page }) => {
    const mock = await openTenant(page);
    await page.route(`**/api/v1/operator/tenants/${TENANT_ID}/packages`, (route) =>
      route.fulfill({
        status: 409,
        json: {
          error: "Serverseitiger Text, der nicht angezeigt wird.",
          code: "TENANT_DEACTIVATED",
        },
      }),
    );

    await page.getByTestId("package-INTEGRATIONS").check();
    await page.getByTestId("packages-save").click();

    const error = page.getByTestId("packages-error");
    await expect(error).toContainText("Der Mandant ist deaktiviert.");
    await expect(error).not.toContainText("Serverseitiger Text");
    await expect(page.getByTestId("package-INTEGRATIONS")).toBeChecked();
    await expect(page.getByText("Nicht gespeichert")).toBeVisible();
    expect(packageWrites(mock)).toHaveLength(0);
  });

  test.describe("at 360 px", () => {
    test.use({ viewport: { width: 360, height: 800 } });

    test("the section does not scroll sideways and every control lies inside the viewport", async ({
      page,
    }) => {
      await openTenant(page);
      await page.getByTestId("package-ANALYTICS").check();

      const geometry = await page.evaluate(() => {
        const ids = [
          "package-CHAIN",
          "package-INTEGRATIONS",
          "package-HARDWARE_CLOCK",
          "package-ANALYTICS",
          "package-quota",
          "packages-save",
        ];
        const outside = ids.filter((id) => {
          const node = document.querySelector(`[data-testid="${id}"]`);
          if (!node) return true;
          const rect = node.getBoundingClientRect();
          return rect.left < 0 || rect.right > window.innerWidth;
        });
        const root = document.documentElement;
        return { outside, scrolls: root.scrollWidth - window.innerWidth };
      });
      expect(geometry.outside).toEqual([]);
      expect(geometry.scrolls).toBeLessThanOrEqual(0);
    });
  });

  test("the tenant page with the section has no serious or critical accessibility violation", async ({
    page,
  }) => {
    await openTenant(page);
    await animationsSettled(page);

    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    const blocking = results.violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
    expect(blocking).toEqual([]);
  });
});

// ── Support access (#93): request, read views, refusal, end ─────────────────────────────────────
//
// The support routes are mocked on top of mockOperatorApi (a route registered later answers first and
// hands everything else on with fallback()). One small state machine holds the grant, so a request
// switches the page to the running state and an end switches it back, exactly like the server. No
// person names, no real e-mails: every value is synthetic.

const SUPPORT_EMPLOYEE_ID = randomUUID();
const SUPPORT_EMPLOYEE_SHIFT_ID = randomUUID();
const SUPPORT_SALON_ID = randomUUID();
const SUPPORT_REASON = "Ticket zur Saldo-Abweichung im September prüfen";
const SUPPORT_HOUR = 3_600_000;
const SUPPORT_LONG_VALUE = "Wert".repeat(25);

interface MockGrant {
  id: string;
  tenantId: string;
  reason: string;
  durationHours: number;
  startedAt: string;
  expiresAt: string;
  endedAt: string | null;
  endedBy: "OPERATOR" | "TENANT" | null;
  status: "ACTIVE" | "EXPIRED" | "ENDED";
}

interface SupportMock {
  /** The running grant, null without one. */
  active: MockGrant | null;
  history: MockGrant[];
  /** GET support-access keeps answering "no grant" while true (a list read that lags the server). */
  listStale: boolean;
  /** The next read answers 403 SUPPORT_ACCESS_REQUIRED and the grant ends on the server. */
  refuseNextRead: boolean;
  /** `total` of the audit-log answer. */
  auditTotal: number;
  /** "METHOD path?query" of every support request, in order. */
  calls: string[];
  bodies: Array<Record<string, unknown> | null>;
}

function newGrant(reason: string, hours: number): MockGrant {
  const now = Date.now();
  return {
    id: randomUUID(),
    tenantId: TENANT_ID,
    reason,
    durationHours: hours,
    startedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + hours * SUPPORT_HOUR).toISOString(),
    endedAt: null,
    endedBy: null,
    status: "ACTIVE",
  };
}

function supportMonthBody(employeeId: string, month: string) {
  return {
    employee: {
      id: employeeId,
      employeeNumber: "1001",
      firstName: "Vorname",
      lastName: "Nachname",
      status: "ACTIVE",
    },
    month,
    timezone: "Europe/Berlin",
    entries: [
      {
        id: randomUUID(),
        date: `${month}-02`,
        startTime: `${month}-02T07:00:00.000Z`,
        endTime: `${month}-02T15:30:00.000Z`,
        breakMinutes: 30,
        breaks: [{ startTime: `${month}-02T10:00:00.000Z`, endTime: `${month}-02T10:30:00.000Z` }],
        breakStatus: "CONFIRMED",
        salon: { id: SUPPORT_SALON_ID, name: "Hauptsalon" },
        type: "WORK",
        source: "NFC",
        isInvalid: false,
        invalidReasonCode: null,
        deleted: false,
        isLocked: true,
      },
      {
        id: randomUUID(),
        date: `${month}-03`,
        startTime: `${month}-03T07:00:00.000Z`,
        endTime: null,
        breakMinutes: 0,
        breaks: [],
        breakStatus: "AUTO",
        salon: { id: SUPPORT_SALON_ID, name: SUPPORT_LONG_VALUE },
        type: "WORK",
        source: "MOBILE",
        isInvalid: true,
        invalidReasonCode: "MISSING_CLOCK_OUT",
        deleted: true,
        isLocked: false,
      },
    ],
    dayBreaks: [
      {
        id: randomUUID(),
        date: `${month}-04`,
        startTime: `${month}-04T11:00:00.000Z`,
        endTime: `${month}-04T11:30:00.000Z`,
      },
    ],
    leaveRequests: [
      {
        id: randomUUID(),
        typeCode: "VACATION",
        typeName: "Urlaub",
        status: "APPROVED",
        startDate: `${month}-10`,
        endDate: `${month}-12`,
        halfDay: false,
        days: 2.5,
        daysProvisional: true,
      },
    ],
    absences: [
      {
        id: randomUUID(),
        type: "VOCATIONAL_SCHOOL",
        source: "PATTERN",
        startDate: `${month}-17`,
        endDate: `${month}-17`,
        halfDay: false,
      },
    ],
    figures: {
      workedMinutes: 2430,
      expectedMinutes: 2400,
      balanceMinutes: 30,
      balanceAdjustmentMinutes: 0,
      basis: "snapshot",
    },
    figuresUnavailableReason: null,
    snapshot: { confirmed: true, basis: "snapshot" },
  };
}

function supportContractBody(id: string, type: string, validFrom: string) {
  return {
    id,
    type,
    validFrom,
    weeklyHours: 30,
    monthlyHours: null,
    dayHours: {
      monday: 1,
      tuesday: 1,
      wednesday: 1,
      thursday: 1,
      friday: 1,
      saturday: 0,
      sunday: 0,
    },
    workDays: [1, 2, 3, 4, 5],
    contractWorkDaysPerWeek: type === "SHIFT_BASED" ? 4 : null,
    usualWorkDays: type === "SHIFT_BASED" ? [2, 4, 6] : [],
    overtimeMode: "CARRY_FORWARD",
    overtimeThreshold: 60,
    allowOvertimePayout: false,
    maxNegativeBalanceMinutes: null,
    coreStart: null,
    coreEnd: null,
    coreDays: [],
  };
}

function supportAuditItems() {
  return [
    {
      id: randomUUID(),
      createdAt: "2026-10-02T08:15:00.000Z",
      action: "UPDATE",
      entity: "TimeEntry",
      entityId: randomUUID(),
      userId: randomUUID(),
      oldValue: { breakMinutes: 30, note: "[ausgeblendet]" },
      newValue: { breakMinutes: 45, note: "[ausgeblendet]", longValue: SUPPORT_LONG_VALUE },
    },
    {
      id: randomUUID(),
      createdAt: "2026-10-01T09:00:00.000Z",
      action: "SUPPORT_NOTE",
      entity: "LeaveRequest",
      entityId: randomUUID(),
      userId: null,
      oldValue: null,
      newValue: { actor: { type: "OPERATOR", operatorId: randomUUID() }, status: "APPROVED" },
    },
    {
      id: randomUUID(),
      createdAt: "2026-09-30T07:30:00.000Z",
      action: "DELETE",
      entity: "Absence",
      entityId: null,
      userId: null,
      oldValue: { halfDay: false },
      newValue: null,
    },
  ];
}

/** Serve the support routes of TENANT_ID from the state machine; everything else falls through. */
async function mockSupportApi(page: Page): Promise<SupportMock> {
  const support: SupportMock = {
    active: null,
    history: [],
    listStale: false,
    refuseNextRead: false,
    auditTotal: 3,
    calls: [],
    bodies: [],
  };
  const prefix = `/api/v1/operator/tenants/${TENANT_ID}`;
  await page.route(
    (url) => url.pathname.startsWith(`${prefix}/support`),
    async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname.slice(prefix.length);
      const method = request.method();
      support.calls.push(`${method} ${path}${url.search}`);
      support.bodies.push(request.postDataJSON() as Record<string, unknown> | null);

      if (path === "/support-access" && method === "GET") {
        return route.fulfill({
          status: 200,
          json: support.listStale
            ? { active: null, history: [] }
            : { active: support.active, history: support.history },
        });
      }
      if (path === "/support-access" && method === "POST") {
        const body = (request.postDataJSON() ?? {}) as { reason: string; durationHours: number };
        if (support.active) {
          return route.fulfill({
            status: 409,
            json: {
              error: "Serverseitiger Text, der nicht angezeigt wird.",
              code: "SUPPORT_ACCESS_ALREADY_ACTIVE",
            },
          });
        }
        const grant = newGrant(body.reason, body.durationHours);
        support.active = grant;
        support.history = [grant, ...support.history];
        return route.fulfill({ status: 201, json: { access: grant } });
      }
      const end = /^\/support-access\/([^/]+)\/end$/.exec(path);
      if (end && method === "POST") {
        if (!support.active || support.active.id !== end[1]) {
          return route.fulfill({
            status: 409,
            json: { error: "Nicht aktiv.", code: "SUPPORT_ACCESS_NOT_ACTIVE" },
          });
        }
        const ended: MockGrant = {
          ...support.active,
          status: "ENDED",
          endedAt: new Date().toISOString(),
          endedBy: "OPERATOR",
        };
        support.history = support.history.map((grant) => (grant.id === ended.id ? ended : grant));
        support.active = null;
        return route.fulfill({ status: 200, json: { access: ended } });
      }

      // Every remaining route is a read under /support/.
      if (method !== "GET" || !path.startsWith("/support/")) {
        return route.fulfill({ status: 404, json: { error: "Nicht gefunden" } });
      }
      if (support.refuseNextRead || !support.active) {
        support.refuseNextRead = false;
        if (support.active) {
          // The grant ran out on the server while the page was open.
          support.history = support.history.map((grant) =>
            grant.id === support.active?.id
              ? { ...grant, status: "EXPIRED" as const, endedAt: new Date().toISOString() }
              : grant,
          );
          support.active = null;
        }
        return route.fulfill({
          status: 403,
          json: { error: "Kein aktiver Support-Zugriff", code: "SUPPORT_ACCESS_REQUIRED" },
        });
      }
      if (path === "/support/employees") {
        return route.fulfill({
          status: 200,
          json: {
            items: [
              {
                id: SUPPORT_EMPLOYEE_ID,
                employeeNumber: "1001",
                firstName: "Vorname",
                lastName: "Nachname",
                hireDate: "2024-03-01",
                exitDate: null,
                status: "ACTIVE",
                homeSalon: { id: SUPPORT_SALON_ID, name: "Hauptsalon" },
                scheduleType: "FIXED_SCHEDULE",
              },
              {
                id: SUPPORT_EMPLOYEE_SHIFT_ID,
                employeeNumber: "1002",
                firstName: "Anna",
                lastName: SUPPORT_LONG_VALUE,
                hireDate: "2025-01-01",
                exitDate: "2026-06-30",
                status: "EXITED",
                homeSalon: null,
                scheduleType: "SHIFT_BASED",
              },
            ],
          },
        });
      }
      const month = /^\/support\/employees\/([^/]+)\/month$/.exec(path);
      if (month) {
        return route.fulfill({
          status: 200,
          json: supportMonthBody(month[1], url.searchParams.get("month") ?? "2026-09"),
        });
      }
      const contracts = /^\/support\/employees\/([^/]+)\/contracts$/.exec(path);
      if (contracts) {
        return route.fulfill({
          status: 200,
          json: {
            items: [
              supportContractBody(randomUUID(), "SHIFT_BASED", "2026-03-01T00:00:00.000Z"),
              supportContractBody(randomUUID(), "FIXED_SCHEDULE", "2025-01-01T00:00:00.000Z"),
            ],
          },
        });
      }
      if (path === "/support/audit-log") {
        const items = supportAuditItems();
        return route.fulfill({
          status: 200,
          json: {
            items: url.searchParams.get("employeeId") ? items.slice(0, 1) : items,
            total: url.searchParams.get("employeeId") ? 1 : support.auditTotal,
            page: Number(url.searchParams.get("page") ?? "1"),
            pageSize: 50,
            from: url.searchParams.get("from"),
            to: url.searchParams.get("to"),
          },
        });
      }
      return route.fulfill({ status: 404, json: { error: "Nicht gefunden" } });
    },
  );
  return support;
}

interface SupportOpenOptions {
  /** Start with a running grant of this reason. */
  active?: string;
  /** Path below the tenant page; the tenant page itself by default. */
  path?: string;
}

/** Mocked console with a seeded operator session, opened on the tenant page (or `path`). */
async function openSupport(
  page: Page,
  options: SupportOpenOptions = {},
): Promise<{ mock: OperatorMock; support: SupportMock }> {
  const mock = await mockOperatorApi(page);
  const support = await mockSupportApi(page);
  if (options.active !== undefined) {
    const grant = newGrant(options.active, 4);
    support.active = grant;
    support.history = [grant];
  }
  await seedOperatorSession(page);
  await page.goto(`/betreiber/mandanten/${TENANT_ID}${options.path ?? ""}`);
  return { mock, support };
}

function supportCalls(support: SupportMock, prefix: string): string[] {
  return support.calls.filter((call) => call.startsWith(prefix));
}

test.describe("operator console - support access (#93)", () => {
  test("request: nine characters keep the button disabled, a valid reason with 4 hours starts the access", async ({
    page,
  }) => {
    const { support } = await openSupport(page);
    await expect(page.getByTestId("op-support-section")).toBeVisible();

    await page.getByTestId("op-support-reason").fill("123456789");
    await expect(page.getByTestId("op-support-request")).toBeDisabled();

    await page.getByTestId("op-support-reason").fill(SUPPORT_REASON);
    await page.getByRole("radio", { name: "4 Stunden", exact: true }).click();
    await expect(page.getByTestId("op-support-request")).toBeEnabled();
    await page.getByTestId("op-support-request").click();

    await expect(page.getByTestId("op-support-active")).toBeVisible();
    await expect(page.getByTestId("op-support-active-reason")).toHaveText(SUPPORT_REASON);
    // 4 h minus the seconds since the request: "Noch 3 Std. 59 Min." - the countdown, not a static text.
    await expect(page.getByTestId("op-support-remaining")).toContainText(/Noch 3 Std\. \d+ Min\./);
    await expect(page.getByTestId("op-support-request")).toHaveCount(0);

    const posts = support.calls.filter((call) => call === "POST /support-access");
    expect(posts).toHaveLength(1);
    expect(support.bodies[support.calls.indexOf("POST /support-access")]).toEqual({
      reason: SUPPORT_REASON,
      durationHours: 4,
    });
  });

  test("a second request is refused with SUPPORT_ACCESS_ALREADY_ACTIVE and worded by its code", async ({
    page,
  }) => {
    const { support } = await openSupport(page);
    await expect(page.getByTestId("op-support-request")).toBeVisible();

    // Another session started an access meanwhile; this page's list read still shows the old state.
    support.listStale = true;
    const other = newGrant("Anderer Vorgang im zweiten Fenster", 1);
    support.active = other;
    support.history = [other];

    await page.getByTestId("op-support-reason").fill(SUPPORT_REASON);
    await page.getByTestId("op-support-request").click();

    const error = page.getByTestId("op-support-error");
    await expect(error).toBeVisible();
    await expect(error).toHaveAttribute("data-code", "SUPPORT_ACCESS_ALREADY_ACTIVE");
    await expect(error).toContainText("Es besteht bereits ein aktiver Support-Zugriff.");
    // The server's own text is never shown; the input stays.
    await expect(error).not.toContainText("Serverseitiger Text");
    await expect(page.getByTestId("op-support-reason")).toHaveValue(SUPPORT_REASON);
  });

  test("employees, month, contracts and protocol each carry the banner; reads are audited by the server's calls", async ({
    page,
  }) => {
    const { support } = await openSupport(page, { active: SUPPORT_REASON });

    await page.getByTestId("op-support-link-employees").click();
    await expect(page.getByTestId("op-support-employees")).toBeVisible();
    const banner = page.getByTestId("op-support-banner");
    await expect(banner).toBeVisible();
    await expect(page.getByTestId("op-support-banner-reason")).toContainText(SUPPORT_REASON);
    await expect(page.getByTestId("op-support-banner-remaining")).toContainText("Noch");
    await expect(page.getByTestId(`op-support-employee-row-${SUPPORT_EMPLOYEE_ID}`)).toContainText(
      "Feste Arbeitszeiten",
    );

    // Month view: the banner stays, the month navigation changes `monat` in the URL.
    await page.getByTestId(`op-support-employee-month-${SUPPORT_EMPLOYEE_ID}`).click();
    await expect(page.getByTestId("op-support-month")).toBeVisible();
    await expect(banner).toBeVisible();
    await expect(page.getByTestId("op-support-figure-balance")).toHaveText("+0:30");
    const before = await page.getByTestId("op-support-month-input").inputValue();
    await page.getByTestId("op-support-month-prev").click();
    await expect(page).toHaveURL(/monat=\d{4}-\d{2}/);
    const after = await page.getByTestId("op-support-month-input").inputValue();
    expect(after).not.toBe(before);
    expect(new URL(page.url()).searchParams.get("monat")).toBe(after);
    await expect(page.getByTestId("op-support-month")).toBeVisible();

    // Contracts: both contracts, the day-hours note only on the shift-based one.
    await page.getByTestId("op-support-contracts-link").click();
    await expect(page.getByTestId("op-support-contracts")).toBeVisible();
    await expect(banner).toBeVisible();
    await expect(page.locator('[data-testid^="op-support-contract-row-"]')).toHaveCount(2);
    await expect(page.locator('[data-testid^="op-support-contract-dayhours-note-"]')).toHaveCount(
      1,
    );
    await expect(page.getByTestId("op-support-contracts")).toContainText(
      "Tagesstunden sind nur bei festen Arbeitszeiten verbindlich.",
    );

    // Back to the month, then to the protocol through the employee list.
    await page.goBack();
    await expect(page.getByTestId("op-support-month")).toBeVisible();
    await page.getByRole("link", { name: "Support", exact: true }).click();
    await expect(page.getByTestId("op-support-employees")).toBeVisible();
    await page.getByTestId("op-support-protocol-link").click();
    await expect(page.getByTestId("op-support-audit")).toBeVisible();
    await expect(banner).toBeVisible();
    const rows = page.locator('[data-testid^="op-support-audit-row-"]');
    await expect(rows).toHaveCount(3);

    // The redacted marker is visible once the values are opened; the operator row is labelled.
    await rows.first().getByText("Werte anzeigen").click();
    const marker = rows.first().getByTestId("op-support-audit-redacted").first();
    await expect(marker).toBeVisible();
    await expect(marker).toContainText("[ausgeblendet]");
    await expect(rows.nth(1)).toContainText("Betreiber");

    // The console asked for exactly the four curated reads (plus the person list of the protocol).
    expect(supportCalls(support, "GET /support/employees").length).toBeGreaterThanOrEqual(3);
    expect(supportCalls(support, "GET /support/employees/")).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`/support/employees/${SUPPORT_EMPLOYEE_ID}/month?month=`),
        `GET /support/employees/${SUPPORT_EMPLOYEE_ID}/contracts`,
      ]),
    );
    expect(supportCalls(support, "GET /support/audit-log")).not.toHaveLength(0);
    // Nothing but GET under /support/.
    expect(
      support.calls.filter((call) => call.includes(" /support/") && !call.startsWith("GET ")),
    ).toEqual([]);
  });

  test("the protocol keeps its filters in the URL, refuses a window above 92 days and pages", async ({
    page,
  }) => {
    const { support } = await openSupport(page, {
      active: SUPPORT_REASON,
      path: "/support/protokoll",
    });
    support.auditTotal = 120;
    await expect(page.getByTestId("op-support-audit")).toBeVisible();
    await expect(page.locator('[data-testid^="op-support-audit-row-"]')).toHaveCount(3);

    // Default window: 30 days up to today.
    const from = await page.getByTestId("op-support-audit-from").inputValue();
    const to = await page.getByTestId("op-support-audit-to").inputValue();
    const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
    expect(days).toBe(30);

    // A window of 93 days is refused before any request.
    const requestsBefore = supportCalls(support, "GET /support/audit-log").length;
    await page.getByTestId("op-support-audit-from").fill("2026-01-01");
    await page.getByTestId("op-support-audit-to").fill("2026-04-04");
    await page.getByTestId("op-support-audit-apply").click();
    await expect(page.getByTestId("op-support-audit-window-error")).toHaveText(
      "Der Zeitraum darf höchstens 92 Tage umfassen.",
    );
    expect(supportCalls(support, "GET /support/audit-log")).toHaveLength(requestsBefore);

    // A valid window and one person land in the URL and in the request.
    await page.getByTestId("op-support-audit-from").fill("2026-09-01");
    await page.getByTestId("op-support-audit-to").fill("2026-09-30");
    await page.getByTestId("op-support-audit-person").selectOption(SUPPORT_EMPLOYEE_ID);
    await page.getByTestId("op-support-audit-apply").click();
    await expect(page).toHaveURL(/von=2026-09-01&bis=2026-09-30&person=/);
    await expect(page.locator('[data-testid^="op-support-audit-row-"]')).toHaveCount(1);
    expect(supportCalls(support, "GET /support/audit-log").at(-1)).toContain(
      `employeeId=${SUPPORT_EMPLOYEE_ID}`,
    );
    await expect(page.getByTestId("op-support-audit-window-error")).toHaveCount(0);

    // Without a person the pager shows from the 51st row on and the next page is asked for.
    await page.getByTestId("op-support-audit-person").selectOption("");
    await page.getByTestId("op-support-audit-apply").click();
    await expect(page.getByTestId("op-support-audit-pagination")).toBeVisible();
    await page.getByRole("button", { name: "Nächste Seite" }).click();
    await expect(page).toHaveURL(/seite=2/);
    expect(supportCalls(support, "GET /support/audit-log").at(-1)).toContain("page=2");
  });

  test("a read refused with SUPPORT_ACCESS_REQUIRED returns to the tenant page, the session stays", async ({
    page,
  }) => {
    const { support } = await openSupport(page, {
      active: SUPPORT_REASON,
      path: "/support",
    });
    // The layout read the grant as running; the grant ends on the server before the first read.
    support.refuseNextRead = true;
    await page.reload();

    const notice = page.getByTestId("op-support-notice");
    await expect(notice).toBeVisible();
    await expect(notice).toHaveAttribute("data-code", "SUPPORT_ACCESS_REQUIRED");
    await expect(page).toHaveURL(new RegExp(`/betreiber/mandanten/${TENANT_ID}\\?hinweis=`));
    await expect(page).not.toHaveURL(/anmelden/);
    // The operator is still signed in: the session keys are untouched and the form is offered.
    const session = await page.evaluate(
      ([tokenKey, expiresKey]) => ({
        token: sessionStorage.getItem(tokenKey),
        expires: sessionStorage.getItem(expiresKey),
      }),
      [TOKEN_KEY, EXPIRES_KEY] as const,
    );
    expect(session.token).toBe("operator-token-for-e2e");
    expect(session.expires).not.toBeNull();
    await expect(page.getByTestId("op-support-request")).toBeVisible();
  });

  test("ending the access asks first and brings the request form back", async ({ page }) => {
    const { support } = await openSupport(page, { active: SUPPORT_REASON });
    await expect(page.getByTestId("op-support-active")).toBeVisible();

    await page.getByTestId("op-support-end").click();
    const dialog = page.getByRole("dialog", { name: "Support-Zugriff beenden?" });
    await expect(dialog).toBeVisible();
    expect(supportCalls(support, "POST /support-access/")).toHaveLength(0);
    await dialog.getByRole("button", { name: "Zugriff beenden" }).click();

    await expect(page.getByTestId("op-support-request")).toBeVisible();
    await expect(page.getByTestId("op-support-active")).toHaveCount(0);
    await expect(dialog).toHaveCount(0);
    expect(supportCalls(support, "POST /support-access/")).toHaveLength(1);
    await expect(page.getByTestId("op-support-history")).toContainText("Beendet");
  });

  test.describe("at 360 px", () => {
    test.use({ viewport: { width: 360, height: 800 } });

    const AREAS = [
      {
        name: "the tenant page support section",
        path: "",
        ready: "op-support-active",
        container: '[data-testid="op-support-section"]',
      },
      {
        name: "the tenant page request form",
        path: "",
        ready: "op-support-request",
        container: '[data-testid="op-support-section"]',
        grant: false,
      },
      {
        name: "the employees view",
        path: "/support",
        ready: "op-support-employees",
        container: '[data-testid="op-support-employees-page"]',
      },
      {
        name: "the month view",
        path: `/support/mitarbeitende/${SUPPORT_EMPLOYEE_ID}?monat=2026-09`,
        ready: "op-support-month",
        container: '[data-testid="op-support-month-page"]',
      },
      {
        name: "the contracts view",
        path: `/support/mitarbeitende/${SUPPORT_EMPLOYEE_ID}/vertraege`,
        ready: "op-support-contracts",
        container: '[data-testid="op-support-contracts-page"]',
      },
      {
        name: "the protocol view",
        path: "/support/protokoll",
        ready: "op-support-audit-row-",
        container: '[data-testid="op-support-protocol-page"]',
      },
    ] as const;

    for (const area of AREAS) {
      test(`${area.name} never scrolls sideways`, async ({ page }) => {
        // The longest allowed reason, so the banner and the section are measured at their worst.
        await openSupport(
          page,
          "grant" in area ? { path: area.path } : { active: LONG_REASON, path: area.path },
        );
        if (area.ready.endsWith("-")) {
          await expect(page.locator(`[data-testid^="${area.ready}"]`).first()).toBeVisible();
          // Open every value block so the long values are measured too.
          for (const summary of await page.locator("details > summary").all()) {
            await summary.click();
          }
        } else {
          await expect(page.getByTestId(area.ready)).toBeVisible();
        }
        await animationsSettled(page);

        expect(await pageOverflow(page)).toEqual([]);
        expect(await offendersOf(page, area.container)).toEqual([]);
      });
    }
  });

  for (const mode of ["light", "dark"] as const) {
    test.describe(`accessibility, editorial x nacht, ${mode} mode`, () => {
      async function violations(page: Page): Promise<string[]> {
        await animationsSettled(page);
        const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
        return results.violations.map(
          (v) =>
            `${v.id}: ${v.nodes
              .map((n) => {
                const data = (n.any[0]?.data ?? {}) as Record<string, unknown>;
                return `${n.target.join(" ")} [${data.fgColor ?? ""} on ${data.bgColor ?? ""}, ${data.contrastRatio ?? ""}]`;
              })
              .join(" | ")}`,
        );
      }

      test.beforeEach(async ({ page }) => {
        await storeLookPrefs(page, { mode, theme: "pflaume", skin: "modern", density: "compact" });
      });

      test("the tenant page with a running access has no WCAG 2 A/AA violation", async ({
        page,
      }) => {
        await openSupport(page, { active: SUPPORT_REASON });
        await expect(page.getByTestId("op-support-active")).toBeVisible();
        expect((await htmlLook(page)).mode).toBe(mode);
        expect(await violations(page)).toEqual([]);
      });

      test("the tenant page with the refusal notice and the request form has no WCAG 2 A/AA violation", async ({
        page,
      }) => {
        await openSupport(page, { path: "?hinweis=SUPPORT_ACCESS_REQUIRED" });
        await expect(page.getByTestId("op-support-notice")).toBeVisible();
        await expect(page.getByTestId("op-support-request")).toBeVisible();
        expect(await violations(page)).toEqual([]);
      });

      test("the employees view has no WCAG 2 A/AA violation", async ({ page }) => {
        await openSupport(page, { active: SUPPORT_REASON, path: "/support" });
        await expect(page.getByTestId("op-support-employees")).toBeVisible();
        expect(await violations(page)).toEqual([]);
      });

      test("the month view has no WCAG 2 A/AA violation", async ({ page }) => {
        await openSupport(page, {
          active: SUPPORT_REASON,
          path: `/support/mitarbeitende/${SUPPORT_EMPLOYEE_ID}?monat=2026-09`,
        });
        await expect(page.getByTestId("op-support-month")).toBeVisible();
        expect((await htmlLook(page)).mode).toBe(mode);
        expect(await violations(page)).toEqual([]);
      });

      test("the contracts view has no WCAG 2 A/AA violation", async ({ page }) => {
        await openSupport(page, {
          active: SUPPORT_REASON,
          path: `/support/mitarbeitende/${SUPPORT_EMPLOYEE_ID}/vertraege`,
        });
        await expect(page.getByTestId("op-support-contracts")).toBeVisible();
        expect(await violations(page)).toEqual([]);
      });

      test("the protocol view with opened values has no WCAG 2 A/AA violation", async ({
        page,
      }) => {
        await openSupport(page, { active: SUPPORT_REASON, path: "/support/protokoll" });
        await expect(page.locator('[data-testid^="op-support-audit-row-"]').first()).toBeVisible();
        for (const summary of await page.locator("details > summary").all()) {
          await summary.click();
        }
        await expect(page.getByTestId("op-support-audit-redacted").first()).toBeVisible();
        expect(await violations(page)).toEqual([]);
      });
    });
  }
});
