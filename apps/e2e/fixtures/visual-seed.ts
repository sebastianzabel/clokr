/**
 * Phase 75 — Deterministic seed for visual regression.
 *
 * Design: every value below is frozen. No `new Date()` for IDs, no `nanoid()`,
 * no random data. The same call produces the same database state on every run
 * inside the same `mcr.microsoft.com/playwright:v1.60.0-jammy` image.
 *
 * Per CLAUDE.md memory `feedback_no_pii_in_github`: these names are obviously
 * synthetic (Anna Visual, Bob Regression, Clara Snapshot, Dirk Baseline) and
 * cannot collide with real the operator-tenant employees.
 *
 * Date anchor: 2025-06-16 (Monday) — deliberately a PAST date so the API's
 * "no time entries in the future" guard (apps/api/src/routes/time-entries.ts:905)
 * accepts the seeded shifts on every run. The system-clock-freeze happens at
 * the BROWSER level in visual.spec.ts via
 * `page.clock.install({ time: ANCHOR_DATE })`; the server clock continues to
 * report real time but every entry date is in the absolute past so the
 * future-check is satisfied regardless of when the test runs.
 *
 * API contracts validated against `apps/api/src/routes/`:
 *   * Bootstrap: POST /api/v1/test/bootstrap-tenant
 *     → returns `{ tenantId, adminToken, baseUrl }` (see test-bootstrap.ts:213-217)
 *   * Login (to get refreshToken + user for localStorage hydration):
 *     POST /api/v1/auth/login → `{ accessToken, refreshToken, user }`
 *   * Employee create: POST /api/v1/employees
 *     Body schema in employees.ts:38-99 is FLAT (no nested workSchedule);
 *     accepts `weeklyHours`, `scheduleType`, `workDays`, `hireDate` (ISO datetime).
 *   * Time entry create: POST /api/v1/time-entries/
 *     Body schema in time-entries.ts:42-54 — `{ employeeId, date (YYYY-MM-DD),
 *     startTime (ISO datetime), endTime (ISO datetime), breakMinutes }`.
 *   * Leave create: POST /api/v1/leave/requests
 *     Body schema in leave.ts:73-94 — `{ type, startDate (YYYY-MM-DD), endDate,
 *     halfDay, note?, employeeId? }`. Status defaults to PENDING; admin cannot
 *     self-approve so visual baselines capture PENDING badges only (acceptable
 *     for Plan 75-02 baseline scope — APPROVED-state visuals deferred to a
 *     follow-up plan that wires a second-manager fixture).
 */
import type { APIRequestContext } from "@playwright/test";

/**
 * Frozen "today" for every visual spec — 2025-06-16 is a Monday.
 * Past date (vs. real "now" 2026-06-05) so the API's future-entry guard
 * accepts every seeded shift while still landing the calendar widgets on
 * the same week/month relative to the seeded data.
 */
export const ANCHOR_DATE = "2025-06-16T08:00:00.000Z";

export interface DeterministicEmployee {
  firstName: string;
  lastName: string;
  employeeNumber: string;
  weeklyHours: number;
  workDays: readonly number[];
}

export const DETERMINISTIC_EMPLOYEES: readonly DeterministicEmployee[] = [
  {
    firstName: "Anna",
    lastName: "Visual",
    employeeNumber: "VIS-001",
    weeklyHours: 40,
    workDays: [1, 2, 3, 4, 5],
  },
  {
    firstName: "Bob",
    lastName: "Regression",
    employeeNumber: "VIS-002",
    weeklyHours: 30,
    workDays: [1, 2, 3, 4],
  },
  {
    firstName: "Clara",
    lastName: "Snapshot",
    employeeNumber: "VIS-003",
    weeklyHours: 20,
    workDays: [2, 3, 4],
  },
  {
    firstName: "Dirk",
    lastName: "Baseline",
    employeeNumber: "VIS-004",
    weeklyHours: 40,
    workDays: [1, 2, 3, 4, 5],
  },
] as const;

/**
 * Time entries for the visual month (June 2025). Fixed shift patterns chosen
 * to exercise calendar-cell variants:
 *   - regular full days (Mo-Fri 8:00-16:30 + 30min break)
 *   - one short day on Thu 2025-06-05 (proves the Soll/Ist delta renders)
 * Anna gets two weeks (06-02..06-13); Bob gets one Mo-Thu week to exercise
 * the workDays=[1,2,3,4] schedule.
 */
export const DETERMINISTIC_TIME_ENTRIES = [
  // Anna — first two weeks of June 2025
  {
    employeeKey: "VIS-001",
    date: "2025-06-02",
    startTime: "2025-06-02T08:00:00.000Z",
    endTime: "2025-06-02T16:30:00.000Z",
    breakMinutes: 30,
  },
  {
    employeeKey: "VIS-001",
    date: "2025-06-03",
    startTime: "2025-06-03T08:00:00.000Z",
    endTime: "2025-06-03T16:30:00.000Z",
    breakMinutes: 30,
  },
  {
    employeeKey: "VIS-001",
    date: "2025-06-04",
    startTime: "2025-06-04T08:00:00.000Z",
    endTime: "2025-06-04T17:00:00.000Z",
    breakMinutes: 60,
  },
  {
    employeeKey: "VIS-001",
    date: "2025-06-05",
    startTime: "2025-06-05T08:00:00.000Z",
    endTime: "2025-06-05T14:00:00.000Z",
    breakMinutes: 30,
  }, // short day
  {
    employeeKey: "VIS-001",
    date: "2025-06-06",
    startTime: "2025-06-06T08:00:00.000Z",
    endTime: "2025-06-06T16:30:00.000Z",
    breakMinutes: 30,
  },
  {
    employeeKey: "VIS-001",
    date: "2025-06-09",
    startTime: "2025-06-09T08:00:00.000Z",
    endTime: "2025-06-09T16:30:00.000Z",
    breakMinutes: 30,
  },
  {
    employeeKey: "VIS-001",
    date: "2025-06-10",
    startTime: "2025-06-10T08:00:00.000Z",
    endTime: "2025-06-10T16:30:00.000Z",
    breakMinutes: 30,
  },
  {
    employeeKey: "VIS-001",
    date: "2025-06-11",
    startTime: "2025-06-11T08:00:00.000Z",
    endTime: "2025-06-11T16:30:00.000Z",
    breakMinutes: 30,
  },
  {
    employeeKey: "VIS-001",
    date: "2025-06-12",
    startTime: "2025-06-12T08:00:00.000Z",
    endTime: "2025-06-12T16:30:00.000Z",
    breakMinutes: 30,
  },
  {
    employeeKey: "VIS-001",
    date: "2025-06-13",
    startTime: "2025-06-13T08:00:00.000Z",
    endTime: "2025-06-13T16:30:00.000Z",
    breakMinutes: 30,
  },
  // Bob — Mon-Thu only (workDays exercise) in 2025-06-02..05
  {
    employeeKey: "VIS-002",
    date: "2025-06-02",
    startTime: "2025-06-02T09:00:00.000Z",
    endTime: "2025-06-02T17:00:00.000Z",
    breakMinutes: 30,
  },
  {
    employeeKey: "VIS-002",
    date: "2025-06-03",
    startTime: "2025-06-03T09:00:00.000Z",
    endTime: "2025-06-03T17:00:00.000Z",
    breakMinutes: 30,
  },
  {
    employeeKey: "VIS-002",
    date: "2025-06-04",
    startTime: "2025-06-04T09:00:00.000Z",
    endTime: "2025-06-04T17:00:00.000Z",
    breakMinutes: 30,
  },
  {
    employeeKey: "VIS-002",
    date: "2025-06-05",
    startTime: "2025-06-05T09:00:00.000Z",
    endTime: "2025-06-05T17:00:00.000Z",
    breakMinutes: 30,
  },
] as const;

/**
 * Leave requests for the visual month — chosen to make the Urlaub-Overview
 * page show a realistic mix of statuses. All requests land in PENDING (the
 * default for POST /api/v1/leave/requests); the visual snapshots therefore
 * capture the PENDING-badge state. A second-manager fixture can be added in
 * a follow-up plan to also baseline the APPROVED state without re-engineering
 * the seed.
 */
export const DETERMINISTIC_LEAVE_REQUESTS = [
  // Anna — Sommerurlaub week (Mo 06-23 .. Fri 06-27, 2025)
  {
    employeeKey: "VIS-001",
    startDate: "2025-06-23",
    endDate: "2025-06-27",
    type: "VACATION",
    note: "Sommerurlaub",
  },
  // Bob — single Brückentag on the ANCHOR_DATE (Mon 2025-06-16)
  {
    employeeKey: "VIS-002",
    startDate: "2025-06-16",
    endDate: "2025-06-16",
    type: "VACATION",
    note: "Brückentag",
  },
  // Clara — single sick day in week 2
  {
    employeeKey: "VIS-003",
    startDate: "2025-06-11",
    endDate: "2025-06-11",
    type: "SICK",
    note: null,
  },
  // Dirk — month-end vacation
  {
    employeeKey: "VIS-004",
    startDate: "2025-06-30",
    endDate: "2025-06-30",
    type: "VACATION",
    note: null,
  },
] as const;

export interface SeedAuth {
  /** Token from POST /api/v1/auth/login — short-lived, used for Authorization header */
  accessToken: string;
  /** Long-lived refresh token — needed for the web auth store to skip re-login */
  refreshToken: string;
  /** Full user payload echoed by /api/v1/auth/login — required by the SvelteKit auth store */
  user: Record<string, unknown>;
}

export interface SeedResult {
  tenantId: string;
  adminEmail: string;
  baseUrl: string;
  auth: SeedAuth;
  /** Maps employeeNumber (VIS-001..VIS-004) → backend employee.id (uuid) */
  employeeMap: Record<string, string>;
}

/**
 * Bootstraps a deterministic tenant against the API. Layered on top of the
 * Phase 73 `/api/v1/test/bootstrap-tenant` endpoint:
 *
 *   1. Bootstrap: creates the tenant + ADMIN user + admin Employee + default
 *      WorkSchedule + LeaveType + LeaveEntitlement. Returns `adminToken`.
 *   2. Login: fetches a full `{ accessToken, refreshToken, user }` triple so
 *      the test can hydrate the SvelteKit auth store in localStorage.
 *   3. Employees: creates 4 deterministic employees with fixed schedules.
 *   4. Time entries: seeds 14 stable shifts covering both regular and short
 *      days plus the workDays Mon-Thu pattern for Bob.
 *   5. Leave: seeds 4 PENDING requests to populate the leave overview.
 *
 * `apiBaseUrl` defaults to the API the visual tests reach via the test stack
 * (`docker-compose.test.yml` exposes api-test on host port 4001). When a
 * developer overrides PLAYWRIGHT_BASE_URL to point at the dev stack
 * (http://localhost:3000), `apiBaseUrl` must also be overridden to
 * http://localhost:4000.
 */
export async function seedDeterministicTenant(
  request: APIRequestContext,
  options?: { apiBaseUrl?: string; webBaseUrl?: string },
): Promise<SeedResult> {
  const apiBaseUrl = options?.apiBaseUrl ?? process.env.E2E_API_BASE ?? "http://localhost:4001";
  const webBaseUrl =
    options?.webBaseUrl ??
    process.env.PLAYWRIGHT_BASE_URL ??
    process.env.BASE_URL ??
    "http://localhost:3001";

  // 1. Bootstrap a fresh tenant via Phase 73 endpoint.
  const bootstrapRes = await request.post(`${apiBaseUrl}/api/v1/test/bootstrap-tenant`, {
    headers: { "content-type": "application/json" },
    data: {},
  });
  if (!bootstrapRes.ok()) {
    throw new Error(
      `Bootstrap failed: ${bootstrapRes.status()} ${await bootstrapRes.text()}. ` +
        `Is ALLOW_TEST_BOOTSTRAP=true? (Phase 73-01)`,
    );
  }
  const bootstrap = (await bootstrapRes.json()) as { tenantId: string; adminToken: string };
  const adminEmail = `admin@${bootstrap.tenantId}.test`;

  // 2. Login with admin credentials so we get a full auth response that the
  //    SvelteKit store can hydrate from. The bootstrap endpoint only returns
  //    `adminToken` (no refreshToken, no user) so a separate login call is
  //    cheaper than rebuilding the user payload manually.
  const loginRes = await request.post(`${apiBaseUrl}/api/v1/auth/login`, {
    headers: { "content-type": "application/json" },
    data: { email: adminEmail, password: "test1234" },
  });
  if (!loginRes.ok()) {
    throw new Error(`Login failed: ${loginRes.status()} ${await loginRes.text()}`);
  }
  const loginBody = (await loginRes.json()) as {
    accessToken: string;
    refreshToken: string;
    user: Record<string, unknown>;
  };

  const authHeaders = {
    Authorization: `Bearer ${loginBody.accessToken}`,
    "content-type": "application/json",
  };

  // 3. Create the 4 deterministic employees. The createEmployeeSchema is FLAT
  //    (no nested workSchedule); the API creates a WorkSchedule row internally
  //    from `weeklyHours` + tenant defaults.
  const employeeMap: Record<string, string> = {};
  for (const emp of DETERMINISTIC_EMPLOYEES) {
    const res = await request.post(`${apiBaseUrl}/api/v1/employees`, {
      headers: authHeaders,
      data: {
        firstName: emp.firstName,
        lastName: emp.lastName,
        employeeNumber: emp.employeeNumber,
        // hireDate must be ISO datetime per createEmployeeSchema.hireDate.
        // Before the seeded time-entry month so saldo calculation has runway.
        hireDate: "2025-01-01T00:00:00.000Z",
        // Stable email — User.email is globally unique. Pairing this with
        // the test.afterEach teardown in visual.spec.ts (DELETE
        // /api/v1/test/tenant/:id) means the previous tenant's rows are
        // dropped before the next bootstrap call, so the seeded employees
        // get back this exact address on every run → byte-stable snapshot.
        email: `${emp.employeeNumber.toLowerCase()}@visual.clokr.test`,
        role: "EMPLOYEE",
        weeklyHours: emp.weeklyHours,
        scheduleType: "FIXED_SCHEDULE",
        workDays: [...emp.workDays],
        // Password must satisfy the tenant policy: ≥12 chars, ≥1 uppercase,
        // ≥1 special character. The seeded employees never actually log in
        // (the admin token drives all baseline flows) but the create endpoint
        // still validates the field.
        password: "VisualSeed!2026",
      },
    });
    if (!res.ok()) {
      throw new Error(
        `Employee ${emp.employeeNumber} creation failed: ${res.status()} ${await res.text()}`,
      );
    }
    const created = (await res.json()) as { id: string };
    employeeMap[emp.employeeNumber] = created.id;
  }

  // 4. Seed time entries. POST /api/v1/time-entries/ — note trailing slash
  //    is not required; the route is registered at the bare prefix.
  for (const entry of DETERMINISTIC_TIME_ENTRIES) {
    const employeeId = employeeMap[entry.employeeKey];
    const res = await request.post(`${apiBaseUrl}/api/v1/time-entries`, {
      headers: authHeaders,
      data: {
        employeeId,
        date: entry.date,
        startTime: entry.startTime,
        endTime: entry.endTime,
        breakMinutes: entry.breakMinutes,
      },
    });
    if (!res.ok()) {
      throw new Error(
        `TimeEntry ${entry.employeeKey}/${entry.date} failed: ${res.status()} ${await res.text()}`,
      );
    }
  }

  // 5. Seed leave requests (PENDING by default). The admin user is the
  //    manager-on-behalf-of for each request.
  for (const leave of DETERMINISTIC_LEAVE_REQUESTS) {
    const employeeId = employeeMap[leave.employeeKey];
    const res = await request.post(`${apiBaseUrl}/api/v1/leave/requests`, {
      headers: authHeaders,
      data: {
        employeeId,
        type: leave.type,
        startDate: leave.startDate,
        endDate: leave.endDate,
        halfDay: false,
        note: leave.note,
      },
    });
    if (!res.ok()) {
      throw new Error(
        `Leave ${leave.employeeKey}/${leave.startDate} failed: ${res.status()} ${await res.text()}`,
      );
    }
  }

  return {
    tenantId: bootstrap.tenantId,
    adminEmail,
    baseUrl: webBaseUrl,
    auth: {
      accessToken: loginBody.accessToken,
      refreshToken: loginBody.refreshToken,
      user: loginBody.user,
    },
    employeeMap,
  };
}
