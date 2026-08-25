/**
 * Reusable steps for BS-Pattern (Berufsschule) E2E tests.
 *
 * Three primitives the bs-pattern spec composes: createAzubiEmployee (POST
 * /api/v1/employees with classification AZUBI), seedBSPattern (PUT the
 * active vocational-school-pattern set, replace-semantics), and
 * openPatternEditor (navigate to the admin page hosting the inline editor
 * per Phase 67). Non-2xx responses throw with structured detail so spec
 * failures surface at the API call site. Phase 67.2 federalStateOverride
 * accepts ISO-3166-2 codes ("BY") or Prisma FederalState enums ("BAYERN")
 * — the ISO map below normalises before PUT.
 */
import type { Page } from "@playwright/test";

const API_BASE = process.env.E2E_API_BASE ?? "http://localhost:4000";

/** Shape of the Phase 73 tenant fixture this module consumes (locally
 * declared rather than imported so the helper stays parallel-worktree safe;
 * Phase 73-02 MUST satisfy this contract per the plan's key_links). */
export interface BSPatternTenant {
  tenantId: string;
  adminToken: string;
}

export interface CreateAzubiOpts {
  firstName?: string;
  lastName?: string;
  /** Informational at this layer — actual lookup happens at PUT time. */
  federalState?: string;
  /**
   * YYYY-MM-DD. Defaults to today. Retroactive BS-pattern scenarios need a
   * hireDate that pre-dates the pattern's own `validFrom` — the generator's
   * `preHire` skip otherwise swallows every backdated day (Phase 103 plan 06).
   */
  hireDate?: string;
}
export interface CreateAzubiResult {
  employeeId: string;
  userId: string;
}

export interface SeedBSPatternOpts {
  mode: "WEEKLY" | "BLOCK";
  /** YYYY-MM-01 — must be the 1st of a calendar month per CLAUDE.md. */
  validFrom: string;
  /** WEEKLY only — array of 0=Sun..6=Sat (default Mo-Fr = [1,2,3,4,5]). */
  weeklyDays?: number[];
  /** BLOCK only — ISO week numbers 1..53 (default [37, 38]). */
  blockWeeks?: number[];
  /** BLOCK only — year for blockWeeks (default = current year). */
  blockYear?: number;
  /** Pendler-Azubi override per Phase 67.2 — ISO or Prisma enum. */
  federalStateOverride?: string;
  /** Pflegeschule opt-out per Phase 67.2 — default true (IHK-Berufe). */
  respectSchoolHolidays?: boolean;
}
export interface SeedBSPatternResult {
  patternId: string;
}

// ISO-3166-2 → Prisma FederalState. Mock fixture uses ISO codes; the
// vocational-school-pattern endpoint accepts the Prisma enum.
const ISO_TO_PRISMA: Record<string, string> = {
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

function authHeaders(t: BSPatternTenant): Record<string, string> {
  return { "content-type": "application/json", authorization: `Bearer ${t.adminToken}` };
}

/** POST /api/v1/employees with classification=AZUBI + Mo-Fr 40h defaults. */
export async function createAzubiEmployee(
  tenant: BSPatternTenant,
  opts: CreateAzubiOpts,
): Promise<CreateAzubiResult> {
  const stamp = Date.now().toString().slice(-8);
  const body = {
    firstName: opts.firstName ?? "Anna",
    lastName: opts.lastName ?? "Azubi",
    email: `azubi-${stamp}@${tenant.tenantId}.test`,
    employeeNumber: `AZB-${stamp}`,
    hireDate: opts.hireDate ? new Date(opts.hireDate).toISOString() : new Date().toISOString(),
    role: "EMPLOYEE",
    classification: "AZUBI",
    scheduleType: "FIXED_SCHEDULE",
    weeklyHours: 40,
    workDays: [1, 2, 3, 4, 5],
    // A directly-set password activates the user immediately (isActive: true) —
    // apps/api/src/routes/employees.ts:372. Without it the employee stays inactive
    // pending an invitation flow this fixture has no use for, and any manual
    // TimeEntry creation against them 403s ("Mitarbeiter ist deaktiviert") — a real
    // blocker for Phase 103 plan 06's TimeEntry-conflict scenarios.
    password: "Test1234!Secure",
  };
  const res = await fetch(`${API_BASE}/api/v1/employees`, {
    method: "POST",
    headers: authHeaders(tenant),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "<no body>");
    throw new Error(`createAzubiEmployee: ${res.status} (tenant=${tenant.tenantId}) — ${detail}`);
  }
  const e = (await res.json()) as { id: string; userId: string };
  return { employeeId: e.id, userId: e.userId };
}

/** PUT /api/v1/employees/:id/vocational-school-pattern with replace-semantics. */
export async function seedBSPattern(
  tenant: BSPatternTenant,
  employeeId: string,
  opts: SeedBSPatternOpts,
): Promise<SeedBSPatternResult> {
  const override = opts.federalStateOverride
    ? (ISO_TO_PRISMA[opts.federalStateOverride] ?? opts.federalStateOverride)
    : null;
  const item =
    opts.mode === "WEEKLY"
      ? {
          daysOfWeek: opts.weeklyDays ?? [1, 2, 3, 4, 5],
          blockWeeks: [] as number[],
          blockYear: null as number | null,
          validFrom: opts.validFrom,
          respectSchoolHolidays: opts.respectSchoolHolidays ?? true,
          federalStateOverride: override,
        }
      : {
          daysOfWeek: [] as number[],
          blockWeeks: opts.blockWeeks ?? [37, 38],
          blockYear: opts.blockYear ?? new Date().getFullYear(),
          validFrom: opts.validFrom,
          respectSchoolHolidays: opts.respectSchoolHolidays ?? true,
          federalStateOverride: override,
        };
  const res = await fetch(`${API_BASE}/api/v1/employees/${employeeId}/vocational-school-pattern`, {
    method: "PUT",
    headers: authHeaders(tenant),
    body: JSON.stringify({ patterns: [item] }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "<no body>");
    throw new Error(
      `seedBSPattern: ${res.status} (employee=${employeeId}, mode=${opts.mode}) — ${detail}`,
    );
  }
  const body = (await res.json()) as { patterns: { id: string }[] };
  if (!body.patterns?.length) {
    throw new Error(`seedBSPattern: empty patterns[] returned (employee=${employeeId})`);
  }
  return { patternId: body.patterns[0].id };
}

/** Navigate to /admin/employees/[id] — Phase 67's inline BS-Pattern editor. */
export async function openPatternEditor(page: Page, employeeId: string): Promise<void> {
  await page.goto(`/admin/employees/${employeeId}`);
}
