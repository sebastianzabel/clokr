/**
 * Shared operator API mock for the e2e specs (Issue #89, #93; moved out of operator-console.spec.ts
 * by #843 D-843-09 so the all-routes overflow spec measures the /betreiber routes through the same
 * mock instead of skipping them).
 *
 * The operator API is mocked in the browser with page.route: CI has no operator account
 * (OPERATOR_JWT_SECRET is unset on the test stack). Every operator request is fulfilled, never
 * continued, so a request that escapes the mock cannot reach a real server by accident. The
 * operator session is seeded into sessionStorage with addInitScript, which is where the console
 * reads it. All values are synthetic.
 *
 * The code below is the verbatim former content of operator-console.spec.ts; only the `export`
 * keywords were added.
 */
import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";

// Synthetic credentials: random per run, never real.
export const OPERATOR_EMAIL = "betreiber@example.invalid";
export const OPERATOR_PASSWORD = randomUUID();
export const GOOD_CODE = "123456";
export const GOOD_RECOVERY = "AAAA-BBBB-CCCC-DDDD";
export const CHALLENGE_TOKEN = randomUUID();
export const ACCESS_TOKEN = randomUUID();

export const TOKEN_KEY = "clokr.operator.accessToken";
export const EXPIRES_KEY = "clokr.operator.expiresAt";

export interface MockSalon {
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

export const TENANT_ID = randomUUID();
export const DEFAULT_SALON_ID = randomUUID();
export const OLD_SALON_ID = randomUUID();
export const BRANCH_ID = "branch-4711";

export const HOURS = Array.from({ length: 7 }, (_, day) => ({
  day,
  open: "09:00",
  close: "18:00",
  ...(day >= 5 ? { closed: true } : {}),
}));

export const SALONS: MockSalon[] = [
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

export interface MockTenant {
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
export interface MockPackages {
  bookedModules: string[];
  salonQuota: number;
  activeSalonCount: number;
}

export const TENANT: MockTenant = {
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

export const OFF_TENANT_ID = randomUUID();
export const OFF_TENANT: MockTenant = {
  id: OFF_TENANT_ID,
  name: "Altbetrieb",
  slug: "altbetrieb",
  federalState: "BAYERN",
  createdAt: "2026-02-10T08:00:00.000Z",
  deactivatedAt: "2026-03-01T08:00:00.000Z",
  deactivatedReason: "Vertrag beendet",
  packages: { bookedModules: [], salonQuota: 1, activeSalonCount: 0 },
};

export interface RecordedCall {
  method: string;
  path: string;
  authorization: string | undefined;
  body: Record<string, unknown> | null;
}

/** How the mocked POST /tenants answers. */
export type CreateOutcome = "ok" | "SLUG_TAKEN" | "EMAIL_TAKEN";

/** How the mocked POST /tenants/:id/resend-admin-invitation answers. */
export type ResendOutcome =
  "sent" | "not-sent" | "TENANT_DEACTIVATED" | "TENANT_IN_USE" | "NO_PENDING_INVITATION";

/** Per-tenant aggregates of the mocked GET /dashboard (Issue #90). */
export interface MockMetrics {
  activeSalons: number;
  totalSalons: number;
  activeEmployees: number;
  lastActivityAt: string | null;
  inactive: boolean;
}

/** What the mock serves for a tenant that has no entry of its own (created, bulk or long-name tenants). */
export const DEFAULT_METRICS: MockMetrics = {
  activeSalons: 1,
  totalSalons: 1,
  activeEmployees: 1,
  lastActivityAt: "2026-10-01",
  inactive: false,
};

export interface OperatorMock {
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

export const GENERIC_401 = { error: "Anmeldung fehlgeschlagen" };

/** Fulfil every /api/v1/operator/** request from the in-spec state; record what was asked. */
export async function mockOperatorApi(page: Page): Promise<OperatorMock> {
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
export async function seedOperatorSession(page: Page): Promise<void> {
  const expiresAt = Date.now() + 15 * 60 * 1000;
  await page.addInitScript(
    ([tokenKey, expiresKey, expiry]) => {
      sessionStorage.setItem(tokenKey, "operator-token-for-e2e");
      sessionStorage.setItem(expiresKey, expiry);
    },
    [TOKEN_KEY, EXPIRES_KEY, String(expiresAt)] as const,
  );
}

// ── Support access (#93): request, read views, refusal, end ─────────────────────────────────────
//
// The support routes are mocked on top of mockOperatorApi (a route registered later answers first and
// hands everything else on with fallback()). One small state machine holds the grant, so a request
// switches the page to the running state and an end switches it back, exactly like the server. No
// person names, no real e-mails: every value is synthetic.

export const SUPPORT_EMPLOYEE_ID = randomUUID();
export const SUPPORT_EMPLOYEE_SHIFT_ID = randomUUID();
export const SUPPORT_SALON_ID = randomUUID();
export const SUPPORT_REASON = "Ticket zur Saldo-Abweichung im September prüfen";
export const SUPPORT_HOUR = 3_600_000;
export const SUPPORT_LONG_VALUE = "Wert".repeat(25);

export interface MockGrant {
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

export interface SupportMock {
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

export function newGrant(reason: string, hours: number): MockGrant {
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

export function supportMonthBody(employeeId: string, month: string) {
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

export function supportContractBody(id: string, type: string, validFrom: string) {
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

export function supportAuditItems() {
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
export async function mockSupportApi(page: Page): Promise<SupportMock> {
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
