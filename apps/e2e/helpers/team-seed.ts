/**
 * Issue #853 (plan 853-15) - seeding helpers shared by the Team specs.
 *
 * `createEmployee`, `ensureEntitlement` and `fileVacation` were lifted unchanged from
 * `leave-area-840.spec.ts`; the rest is new for `team-pages-853.spec.ts`. Everything goes through the
 * API with the throwaway tenant's admin token. Persons are synthetic (`.test` / `.invalid`
 * addresses), the tenant is the per-test fixture tenant.
 */
import type { APIRequestContext, Locator } from "@playwright/test";
import { expect } from "@playwright/test";
import type { TestTenant } from "../fixtures";

export const API_BASE = process.env.E2E_API_BASE ?? "http://localhost:4001";

export function authHeaders(tenant: TestTenant) {
  return { "content-type": "application/json", Authorization: `Bearer ${tenant.adminToken}` };
}

export interface Person {
  id: string;
  /** Present for a person created with a password. */
  email: string;
  firstName: string;
  lastName: string;
}

/**
 * An employee homed in the tenant's default salon. A `password` gives the person a direct sign-in
 * (the Mitarbeiter role), the way an admin sets one at creation.
 */
export async function createEmployee(
  request: APIRequestContext,
  tenant: TestTenant,
  spec: { key?: string; firstName?: string; lastName?: string; password?: string } = {},
): Promise<Person> {
  const key = spec.key ?? "uebersicht";
  const firstName = spec.firstName ?? "Uebersicht";
  const lastName = spec.lastName ?? "Balken";
  const stamp = Date.now();
  const email = `${key}-${stamp}@${tenant.tenantId}.test`;
  const res = await request.post(`${API_BASE}/api/v1/employees`, {
    headers: authHeaders(tenant),
    data: {
      usualWorkDays: [1, 2, 3, 4, 5],
      email,
      firstName,
      lastName,
      employeeNumber: `${key.slice(0, 2).toUpperCase()}-${stamp.toString(36).slice(-6)}`,
      hireDate: new Date("2024-01-01T00:00:00.000Z").toISOString(),
      role: "EMPLOYEE",
      ...(spec.password ? { password: spec.password } : {}),
    },
  });
  expect(res.status(), `create the employee (${await res.text()})`).toBeLessThan(300);
  const body = (await res.json()) as { id: string };
  return { id: body.id, email, firstName, lastName };
}

/** Reading the entitlements of a year creates the regular VACATION row for it, as the app does. */
export async function ensureEntitlement(
  request: APIRequestContext,
  tenant: TestTenant,
  employeeId: string,
  year: number,
): Promise<void> {
  const res = await request.get(
    `${API_BASE}/api/v1/leave/entitlements/${employeeId}?year=${year}`,
    {
      headers: authHeaders(tenant),
    },
  );
  expect(res.ok(), `read the ${year} entitlement (${res.status()})`).toBe(true);
}

export async function fileVacation(
  request: APIRequestContext,
  tenant: TestTenant,
  employeeId: string,
  startDate: string,
  endDate: string,
): Promise<string> {
  const res = await request.post(`${API_BASE}/api/v1/leave/requests`, {
    headers: authHeaders(tenant),
    data: { employeeId, type: "VACATION", startDate, endDate },
  });
  expect(res.status(), `file the request (${await res.text()})`).toBeLessThan(300);
  return ((await res.json()) as { id: string }).id;
}

/** Approves a pending leave request as the tenant admin. */
export async function approveRequest(
  request: APIRequestContext,
  tenant: TestTenant,
  requestId: string,
): Promise<void> {
  const res = await request.patch(`${API_BASE}/api/v1/leave/requests/${requestId}/review`, {
    headers: authHeaders(tenant),
    data: { status: "APPROVED" },
  });
  expect(res.status(), `approve the request (${await res.text()})`).toBeLessThan(300);
}

export interface SalonRow {
  id: string;
  name: string;
}

/** The tenant's active salons (the fixture tenant starts with one). */
export async function listSalons(
  request: APIRequestContext,
  tenant: TestTenant,
): Promise<SalonRow[]> {
  const res = await request.get(`${API_BASE}/api/v1/salons`, { headers: authHeaders(tenant) });
  expect(res.ok(), `list the salons (${res.status()})`).toBe(true);
  return ((await res.json()) as { salons: SalonRow[] }).salons;
}

/** A further salon of the tenant (the fixtures book every package, so the quota allows it). */
export async function createSalon(
  request: APIRequestContext,
  tenant: TestTenant,
  name: string,
): Promise<SalonRow> {
  const res = await request.post(`${API_BASE}/api/v1/salons`, {
    headers: authHeaders(tenant),
    data: {
      name,
      federalState: "HESSEN",
      openingHours: [0, 1, 2, 3, 4, 5, 6].map((day) => ({
        day,
        open: "09:00",
        close: "18:00",
        ...(day === 6 ? { closed: true } : {}),
      })),
    },
  });
  expect(res.status(), `create the salon ${name} (${await res.text()})`).toBe(201);
  return (await res.json()) as SalonRow;
}

/** The system role template ids of `SYSTEM_ROLE_IDS` (this package cannot import apps/api). */
export const ROLE_TEMPLATE = {
  OWNER: "00000000-0000-4000-8000-00000000a004",
  SALON_MANAGER: "00000000-0000-4000-8000-00000000a005",
  HR: "00000000-0000-4000-8000-00000000a006",
} as const;

export interface HomedPerson extends Person {
  userId: string;
  password: string;
}

/**
 * A person homed in `homeSalonId` with a direct sign-in. With `template` the person also gets that
 * system role template, scoped as given (e.g. the Salonmanager template on one salon).
 */
export async function createHomedPerson(
  request: APIRequestContext,
  tenant: TestTenant,
  spec: {
    key: string;
    firstName: string;
    lastName: string;
    homeSalonId: string;
    password: string;
    template?: { id: string; scope: Record<string, unknown> };
  },
): Promise<HomedPerson> {
  const email = `${spec.key}.${tenant.tenantId.toLowerCase()}@example.invalid`;
  const res = await request.post(`${API_BASE}/api/v1/employees`, {
    headers: authHeaders(tenant),
    data: {
      email,
      firstName: spec.firstName,
      lastName: spec.lastName,
      employeeNumber: `E853-${spec.key}-${tenant.tenantId.slice(-4)}`,
      hireDate: new Date("2024-01-01T00:00:00.000Z").toISOString(),
      scheduleType: "FIXED_SCHEDULE",
      weeklyHours: 40,
      password: spec.password,
      homeSalonId: spec.homeSalonId,
    },
  });
  expect(res.status(), `create ${spec.key} (${await res.text()})`).toBe(201);
  const body = (await res.json()) as { id: string; userId: string };
  if (spec.template) {
    const assign = await request.post(`${API_BASE}/api/v1/role-assignments`, {
      headers: authHeaders(tenant),
      data: { userId: body.userId, accessRoleId: spec.template.id, scope: spec.template.scope },
    });
    expect(assign.status(), `assign the role of ${spec.key} (${await assign.text()})`).toBe(201);
  }
  return {
    id: body.id,
    userId: body.userId,
    email,
    firstName: spec.firstName,
    lastName: spec.lastName,
    password: spec.password,
  };
}

/**
 * An OPEN work entry (no end time) that began `daysAgo` days ago - the "Ausstempeln fehlt" task of
 * `GET /tasks/open`. Written as the tenant admin on behalf of the person.
 */
export async function createOpenEntry(
  request: APIRequestContext,
  tenant: TestTenant,
  employeeId: string,
  daysAgo: number,
): Promise<string> {
  const day = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const res = await request.post(`${API_BASE}/api/v1/time-entries`, {
    headers: authHeaders(tenant),
    data: { employeeId, date: day, startTime: `${day}T07:00:00.000Z` },
  });
  expect(res.status(), `open an entry (${await res.text()})`).toBeLessThan(300);
  return ((await res.json()) as { entry: { id: string } }).entry.id;
}

/**
 * Types into a Combobox and picks the named option. The roster behind a person picker arrives
 * after the picker is drawn, and a list that was empty when the first character was typed does not
 * open by itself later - so the text is typed again until the option is offered.
 */
export async function chooseFromCombobox(
  combobox: Locator,
  option: Locator,
  text: string,
): Promise<void> {
  await expect(async () => {
    await combobox.fill("");
    await combobox.fill(text);
    await expect(option).toBeVisible({ timeout: 1_500 });
  }).toPass({ timeout: 15_000 });
  await option.click();
}
