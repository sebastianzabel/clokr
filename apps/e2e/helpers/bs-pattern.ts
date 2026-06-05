/**
 * Reusable steps for BS-Pattern (Berufsschule) E2E tests.
 *
 * Phase 67 introduced the BS-Pattern editor (Wöchentlich + Blockunterricht
 * modes) on `/admin/employees/[id]`. Phase 67.2 added Schulferien-Integration
 * + Shift Auto-Cleanup. This module exposes three primitives the bs-pattern
 * spec composes:
 *
 *   - `createAzubiEmployee(tenant, opts)`   — POST /api/v1/employees with
 *     `classification: "AZUBI"` + AZUBI-typical defaults. Returns the new
 *     employee + user IDs.
 *   - `seedBSPattern(tenant, empId, opts)`  — PUT the active vocational-
 *     school-pattern set for that employee (replace-semantics per Phase 67
 *     API design). Supports WEEKLY (daysOfWeek) and BLOCK (blockWeeks +
 *     blockYear), plus federalStateOverride and respectSchoolHolidays.
 *   - `openPatternEditor(page, empId)`      — navigate to the admin page
 *     that hosts the BS-Pattern editor.
 *
 * All API calls run against the test tenant's bearer token (Phase 73 fixture
 * convention). Non-2xx responses throw with a structured error so spec
 * failures surface immediately, not several assertions later.
 *
 * CLAUDE.md "Schedule Types": AZUBI employees use `FIXED_SCHEDULE` or
 * `MONTHLY_HOURS`. The `vocational-school-pattern` is per-employee and
 * orthogonal to the regular WorkSchedule — it only drives the BS-Absence
 * generator and is read-only for non-AZUBI classifications per BBiG §15
 * (v1.7.5 hotfix).
 */

import type { Page } from "@playwright/test";

const API_BASE = process.env.E2E_API_BASE ?? "http://localhost:4000";

/**
 * Shape of the Phase 73 `tenant` fixture this module consumes.
 *
 * We re-declare the contract here (rather than `import type { TestTenant }
 * from "../fixtures/tenant"`) because the fixture module is owned by Phase
 * 73 and may not be present in the worktree this plan is authored against.
 * The Plan's `key_links` documents this signature as the canonical contract
 * — Phase 73-02 MUST satisfy it.
 */
export interface BSPatternTenant {
  /** Tenant id, e.g. "test-abc12345". */
  tenantId: string;
  /** Bearer token for an ADMIN user inside the tenant. */
  adminToken: string;
}

export interface CreateAzubiOpts {
  /** First name (default "Anna"). */
  firstName?: string;
  /** Last name (default "Azubi"). */
  lastName?: string;
  /**
   * ISO-3166-2 federal state used by the BS-Pattern generator. Mostly
   * informational at this layer — the actual federal-state lookup happens
   * at PUT /vocational-school-pattern time. Kept for forward-compatibility
   * with future tenant-level federalState wiring.
   */
  federalState?: string;
}

export interface CreateAzubiResult {
  employeeId: string;
  userId: string;
}

export interface SeedBSPatternOpts {
  /** "WEEKLY" → daysOfWeek; "BLOCK" → blockWeeks + blockYear. */
  mode: "WEEKLY" | "BLOCK";
  /** YYYY-MM-01 — must be the 1st of a calendar month per CLAUDE.md. */
  validFrom: string;
  /** WEEKLY only: array of 0=Sun..6=Sat (default Mo-Fr = [1,2,3,4,5]). */
  weeklyDays?: number[];
  /** BLOCK only: array of ISO week numbers 1..53 (default [37, 38]). */
  blockWeeks?: number[];
  /** BLOCK only: year for blockWeeks (default = current year). */
  blockYear?: number;
  /**
   * Pendler-Azubi override per Phase 67.2 — when set, this pattern uses the
   * given federal state's Schulferien window, NOT the tenant's. Must be a
   * Prisma `FederalState` enum value (e.g. "BAYERN", "NORDRHEIN_WESTFALEN").
   */
  federalStateOverride?: string;
  /** Pflegeschule opt-out per Phase 67.2 — default true (IHK-Berufe). */
  respectSchoolHolidays?: boolean;
}

export interface SeedBSPatternResult {
  /**
   * Pattern id (the first row of the replaced set). The API returns the
   * full pattern list; we surface only the id of the first row because
   * the spec primarily targets single-pattern flows.
   */
  patternId: string;
}

/**
 * POST /api/v1/employees with `classification: "AZUBI"` and AZUBI-typical
 * defaults: hireDate=today, weeklyHours=40, scheduleType=FIXED_SCHEDULE.
 *
 * Throws on non-2xx with a descriptive error so the spec sees the failure
 * immediately rather than a downstream null-dereference.
 */
export async function createAzubiEmployee(
  tenant: BSPatternTenant,
  opts: CreateAzubiOpts,
): Promise<CreateAzubiResult> {
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${tenant.adminToken}`,
  };

  const firstName = opts.firstName ?? "Anna";
  const lastName = opts.lastName ?? "Azubi";
  const stamp = Date.now().toString().slice(-8);
  const employeeNumber = `AZB-${stamp}`;
  const email = `azubi-${stamp}@${tenant.tenantId}.test`;

  const body = {
    firstName,
    lastName,
    email,
    employeeNumber,
    // hireDate must be an ISO datetime per createEmployeeSchema.
    hireDate: new Date().toISOString(),
    role: "EMPLOYEE",
    classification: "AZUBI",
    scheduleType: "FIXED_SCHEDULE",
    weeklyHours: 40,
    workDays: [1, 2, 3, 4, 5],
  };

  const res = await fetch(`${API_BASE}/api/v1/employees`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "<no body>");
    throw new Error(
      `createAzubiEmployee: POST /employees ${res.status} ` +
        `(tenant=${tenant.tenantId}, federalState=${opts.federalState ?? "<unset>"}) — ${detail}`,
    );
  }
  const employee = (await res.json()) as { id: string; userId: string };
  return { employeeId: employee.id, userId: employee.userId };
}

/**
 * Map ISO-3166-2 codes to the Prisma `FederalState` enum used by the API.
 * The Schulferien-mock fixture uses ISO codes ("NW", "BY") but the
 * vocational-school-pattern endpoint accepts the Prisma enum. Keeping the
 * mapping in this helper means the spec can write tests in human-readable
 * ISO codes throughout.
 */
const ISO_TO_PRISMA_FEDERAL_STATE: Record<string, string> = {
  NW: "NORDRHEIN_WESTFALEN",
  BY: "BAYERN",
  NI: "NIEDERSACHSEN",
  BE: "BERLIN",
  BB: "BRANDENBURG",
  HB: "BREMEN",
  HH: "HAMBURG",
  HE: "HESSEN",
  MV: "MECKLENBURG_VORPOMMERN",
  RP: "RHEINLAND_PFALZ",
  SL: "SAARLAND",
  SN: "SACHSEN",
  ST: "SACHSEN_ANHALT",
  SH: "SCHLESWIG_HOLSTEIN",
  TH: "THUERINGEN",
  BW: "BADEN_WUERTTEMBERG",
};

/**
 * PUT /api/v1/employees/:id/vocational-school-pattern with replace-semantics.
 *
 * The endpoint accepts an array of pattern items; this helper authors a
 * single pattern (the common test case). Supports either WEEKLY
 * (daysOfWeek) or BLOCK (blockWeeks + blockYear) per Phase 67's locked
 * decision: at least one of daysOfWeek OR blockWeeks must be set.
 */
export async function seedBSPattern(
  tenant: BSPatternTenant,
  employeeId: string,
  opts: SeedBSPatternOpts,
): Promise<SeedBSPatternResult> {
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${tenant.adminToken}`,
  };

  // Normalise federalStateOverride: accept either ISO ("BY") or Prisma enum
  // ("BAYERN"). The API requires the Prisma enum.
  const normalisedOverride = opts.federalStateOverride
    ? (ISO_TO_PRISMA_FEDERAL_STATE[opts.federalStateOverride] ??
      opts.federalStateOverride)
    : null;

  const isWeekly = opts.mode === "WEEKLY";
  const patternItem = isWeekly
    ? {
        daysOfWeek: opts.weeklyDays ?? [1, 2, 3, 4, 5],
        blockWeeks: [] as number[],
        blockYear: null as number | null,
        validFrom: opts.validFrom,
        respectSchoolHolidays: opts.respectSchoolHolidays ?? true,
        federalStateOverride: normalisedOverride,
      }
    : {
        daysOfWeek: [] as number[],
        blockWeeks: opts.blockWeeks ?? [37, 38],
        blockYear: opts.blockYear ?? new Date().getFullYear(),
        validFrom: opts.validFrom,
        respectSchoolHolidays: opts.respectSchoolHolidays ?? true,
        federalStateOverride: normalisedOverride,
      };

  const res = await fetch(
    `${API_BASE}/api/v1/employees/${employeeId}/vocational-school-pattern`,
    {
      method: "PUT",
      headers,
      body: JSON.stringify({ patterns: [patternItem] }),
    },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "<no body>");
    throw new Error(
      `seedBSPattern: PUT /vocational-school-pattern ${res.status} ` +
        `(employee=${employeeId}, mode=${opts.mode}) — ${detail}`,
    );
  }
  const body = (await res.json()) as { patterns: { id: string }[] };
  if (!body.patterns?.length) {
    throw new Error(
      `seedBSPattern: API returned 200 but patterns[] was empty ` +
        `(employee=${employeeId})`,
    );
  }
  return { patternId: body.patterns[0].id };
}

/**
 * Navigate the Playwright page to the BS-Pattern editor surface.
 *
 * Phase 67 settled the editor on `/admin/employees/[id]` (the per-employee
 * admin detail page). The editor is rendered inline on that page; there's
 * no separate `/admin/azubis/...` route. If a future phase moves the editor
 * to a dedicated sub-route, update this single helper rather than touching
 * every spec.
 */
export async function openPatternEditor(page: Page, employeeId: string): Promise<void> {
  await page.goto(`/admin/employees/${employeeId}`);
}
