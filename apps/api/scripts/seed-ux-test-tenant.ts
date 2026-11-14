/**
 * seed-ux-test-tenant.ts — Issue #952. DEVELOPMENT tool: a fresh, deterministic tenant for user
 * tests by persona (Mitarbeiterin, Salonleitung, Inhaberin, Personalabteilung).
 *
 * Why: the persona tests ran on a grown dev database, so some findings were data artefacts. Each
 * run of this script builds the SAME picture relative to "today" (tenant time zone Europe/Berlin)
 * in a NEW tenant, so every test starts from identical data.
 *
 * What one run does:
 *   1. Deactivates (never deletes) every earlier UX-test tenant — marker: slug prefix `ux-test-`.
 *   2. Provisions a new tenant „UX-Test <dd.mm.>“ through the operator's provisioning core
 *      (`provisionTenantWithAdmin` + the composition seam that seeds the default leave types);
 *      the first admin is the Inhaberin, her password is set through the real invitation accept.
 *   3. Books every package (the operator's `changeTenantPackages`), renames the default salon to
 *      „Salon Mitte“ and creates „Salon Nord“ (both NRW) through the tenant salon routes.
 *   4. Creates the persons through `POST /api/v1/employees` (contract, Stammsalon, vacation
 *      entitlement, system role) and the extra roles through `POST /api/v1/role-assignments`.
 *   5. Berufsschule pattern (real route + generator), carry-over (real route), leave requests and
 *      their approval (real routes), shift templates, shifts and a coverage rule (real routes).
 *   6. Writes the recorded working time directly (1st of the previous month through yesterday):
 *      the API's write path refuses entries outside the retro window for the person themself and
 *      books them as corrections for a manager, so a realistic history cannot come through it.
 *      Every entry carries its breaks and one CREATE audit row marked `trigger: "UX_TEST_SEED"`.
 *   7. Closes the previous month for every person through `POST /api/v1/overtime/close-month`
 *      (the real closer). The current month stays open.
 *   8. Writes the accounts (with freshly generated passwords) to a gitignored Markdown file; stdout
 *      only gets the file path and a summary — never a password.
 *
 * All API calls run in-process through `app.inject` with tokens this process signs for the
 * tenant's own users, so every permission, validation and audit of the real routes applies.
 *
 * Usage (local docker dev stack; the database must be the dev database on this machine):
 *   DATABASE_URL=postgresql://<user>:<password>@localhost:5432/clokr \
 *     pnpm --filter @clokr/api exec tsx scripts/seed-ux-test-tenant.ts [--out <file>]
 *
 * Guards: refuses NODE_ENV=production and any DATABASE_URL whose host is not localhost,
 * 127.0.0.1, ::1 or postgres (the docker service name). Both checks run before the app (and with
 * it any plugin or database connection) exists. The file is removed from the runtime image
 * (apps/api/Dockerfile). The JWT/encryption secrets the app config requires are generated per run
 * when they are not set: tokens are only used inside this process, and nothing this script
 * writes is encrypted.
 *
 * Exit codes: 0 success, 1 guard/usage/runtime error.
 */
import type { FastifyInstance } from "fastify";
import { randomBytes, randomInt } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Every UX-test tenant's slug starts with this; it is how earlier runs are found. */
export const UX_TEST_SLUG_PREFIX = "ux-test-";
/** Marker on every audit row this script writes itself. */
export const UX_TEST_TRIGGER = "UX_TEST_SEED";
const TZ = "Europe/Berlin";
const EMAIL_DOMAIN = "clokr.test";
const ALLOWED_DB_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "postgres"]);

/** Refuse a wrong target before anything else happens. */
export function assertUxSeedTarget(args: {
  nodeEnv: string | undefined;
  databaseUrl: string | undefined;
}): void {
  if (args.nodeEnv === "production") {
    throw new Error("seed-ux-test-tenant: refusing to run with NODE_ENV=production");
  }
  if (!args.databaseUrl) throw new Error("seed-ux-test-tenant: DATABASE_URL is required");
  let host: string;
  try {
    host = new URL(args.databaseUrl).hostname;
  } catch {
    throw new Error("seed-ux-test-tenant: DATABASE_URL is not a valid URL");
  }
  if (!ALLOWED_DB_HOSTS.has(host)) {
    throw new Error(
      `seed-ux-test-tenant: database host "${host}" is not a local dev host (localhost, 127.0.0.1, ::1, postgres); refusing`,
    );
  }
}

// ── Calendar helpers (calendar days as "YYYY-MM-DD", arithmetic at UTC midnight) ─────────────

type Day = string;
const DAY_MS = 86_400_000;
const toDate = (day: Day) => new Date(`${day}T00:00:00.000Z`);
const addDays = (day: Day, n: number): Day =>
  new Date(toDate(day).getTime() + n * DAY_MS).toISOString().slice(0, 10);
/** 0 = Monday … 6 = Sunday. */
const monIdx = (day: Day) => (toDate(day).getUTCDay() + 6) % 7;
const daysBetween = (from: Day, to: Day): Day[] => {
  const out: Day[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
};
const hm = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const deDay = (day: Day) => `${day.slice(8, 10)}.${day.slice(5, 7)}.${day.slice(0, 4)}`;

/** A strong random password that satisfies the default policy (upper, lower, digit, special). */
function generatePassword(): string {
  const sets = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "!#%+-=?@_"];
  const all = sets.join("");
  const chars = sets.map((s) => s[randomInt(s.length)]);
  while (chars.length < 20) chars.push(all[randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

// ── Personas ─────────────────────────────────────────────────────────────────────────────────

type SalonKey = "MITTE" | "NORD";
type Handle =
  | "inhaberin"
  | "salonleitung"
  | "personal"
  | "vollzeit"
  | "teilzeit"
  | "schicht"
  | "azubi"
  | "minijob";

interface Block {
  start: number; // minutes since local midnight
  end: number;
  breaks: Array<[number, number]>;
}

interface PersonSpec {
  handle: Exclude<Handle, "inhaberin">;
  label: string;
  firstName: string;
  lastName: string;
  employeeNumber: string;
  home: SalonKey;
  classification: "VOLLZEIT" | "TEILZEIT" | "MINIJOB" | "AZUBI";
  contract: string; // human-readable, for the output file
  body: Record<string, unknown>; // the schedule part of the POST /employees body
  /** The working blocks of a normal day, or null when the person does not work that weekday. */
  dayPlan: (day: Day) => Block | null;
  extraRole?: { slot: "SALON_MANAGER" | "HR"; scope: "SALON_NORD" | "TENANT"; label: string };
}

const EIGHT_HOURS: Block = { start: 9 * 60, end: 17 * 60 + 30, breaks: [[12 * 60 + 30, 13 * 60]] };
const fixedDays = (weekdays: number[], block: Block) => (day: Day) =>
  weekdays.includes(monIdx(day)) ? block : null;

function personSpecs(): PersonSpec[] {
  return [
    {
      handle: "salonleitung",
      label: "Salonleitung",
      firstName: "Sophie",
      lastName: "Lenz",
      employeeNumber: "2",
      home: "NORD",
      classification: "VOLLZEIT",
      contract: "Feste Arbeitszeit 40 h, Mo–Fr 8 h",
      body: { scheduleType: "FIXED_SCHEDULE", weeklyHours: 40, workDays: [1, 2, 3, 4, 5] },
      dayPlan: fixedDays([0, 1, 2, 3, 4], EIGHT_HOURS),
      extraRole: { slot: "SALON_MANAGER", scope: "SALON_NORD", label: "Salonmanager (Salon Nord)" },
    },
    {
      handle: "personal",
      label: "Personalabteilung",
      firstName: "Paula",
      lastName: "Roth",
      employeeNumber: "3",
      home: "MITTE",
      classification: "TEILZEIT",
      contract: "Feste Arbeitszeit 30 h, Mo–Fr 6 h",
      body: { scheduleType: "FIXED_SCHEDULE", weeklyHours: 30, workDays: [1, 2, 3, 4, 5] },
      dayPlan: fixedDays([0, 1, 2, 3, 4], {
        start: 8 * 60 + 30,
        end: 15 * 60,
        breaks: [[12 * 60, 12 * 60 + 30]],
      }),
      extraRole: { slot: "HR", scope: "TENANT", label: "Personalabteilung (ganzer Mandant)" },
    },
    {
      handle: "vollzeit",
      label: "Mitarbeiterin Vollzeit",
      firstName: "Vera",
      lastName: "Kühn",
      employeeNumber: "4",
      home: "MITTE",
      classification: "VOLLZEIT",
      contract: "Feste Arbeitszeit 40 h, Mo–Fr 8 h",
      body: { scheduleType: "FIXED_SCHEDULE", weeklyHours: 40, workDays: [1, 2, 3, 4, 5] },
      dayPlan: fixedDays([0, 1, 2, 3, 4], EIGHT_HOURS),
    },
    {
      handle: "teilzeit",
      label: "Mitarbeiterin Teilzeit",
      firstName: "Tina",
      lastName: "Brandt",
      employeeNumber: "5",
      home: "NORD",
      classification: "TEILZEIT",
      contract: "Feste Arbeitszeit 32 h, Di–Fr 8 h",
      body: { scheduleType: "FIXED_SCHEDULE", weeklyHours: 32, workDays: [2, 3, 4, 5] },
      dayPlan: fixedDays([1, 2, 3, 4], EIGHT_HOURS),
    },
    {
      handle: "schicht",
      label: "Mitarbeiter Schicht",
      firstName: "Sami",
      lastName: "Yildiz",
      employeeNumber: "6",
      home: "NORD",
      classification: "VOLLZEIT",
      contract: "Schichtdienst 40 h, 5 Tage/Woche, übliche Arbeitstage Mo–Fr",
      body: {
        scheduleType: "SHIFT_BASED",
        weeklyHours: 40,
        workDays: [1, 2, 3, 4, 5],
        contractWorkDaysPerWeek: 5,
        usualWorkDays: [1, 2, 3, 4, 5],
      },
      // The roster decides; this is the shift of the day (see shiftBlock()).
      dayPlan: (day) => (monIdx(day) < 5 ? shiftBlock(day) : null),
    },
    {
      handle: "azubi",
      label: "Azubi (unter 18)",
      firstName: "Lea",
      lastName: "Wolf",
      employeeNumber: "7",
      home: "NORD",
      classification: "AZUBI",
      contract: "Feste Arbeitszeit 40 h, Mo–Fr 8 h, Berufsschule dienstags",
      body: {
        scheduleType: "FIXED_SCHEDULE",
        weeklyHours: 40,
        workDays: [1, 2, 3, 4, 5],
        requiresSupervision: true,
      },
      // § 11 JArbSchG: 60 min break above 6 h, at most 4.5 h in a row, none in the first/last hour.
      dayPlan: fixedDays([0, 1, 2, 3, 4], {
        start: 8 * 60,
        end: 17 * 60,
        breaks: [
          [11 * 60 + 30, 12 * 60],
          [14 * 60, 14 * 60 + 30],
        ],
      }),
    },
    {
      handle: "minijob",
      label: "Minijob",
      firstName: "Mia",
      lastName: "Sander",
      employeeNumber: "8",
      home: "MITTE",
      classification: "MINIJOB",
      contract: "Monatsstunden 40 h (arbeitet Mo und Do je 4,5 h)",
      body: { scheduleType: "MONTHLY_HOURS", monthlyHours: 40, workDays: [1, 2, 3, 4, 5] },
      dayPlan: fixedDays([0, 3], { start: 9 * 60, end: 13 * 60 + 30, breaks: [] }),
    },
  ];
}

/** Early and late weeks alternate (ISO week parity). Net 8 h each. */
function shiftBlock(day: Day): Block {
  const week = Math.floor((toDate(addDays(day, -monIdx(day))).getTime() / DAY_MS + 3) / 7);
  return week % 2 === 0
    ? { start: 8 * 60, end: 16 * 60 + 30, breaks: [[12 * 60, 12 * 60 + 30]] }
    : { start: 11 * 60 + 30, end: 20 * 60, breaks: [[15 * 60 + 30, 16 * 60]] };
}

// ── Run ──────────────────────────────────────────────────────────────────────────────────────

interface Account {
  role: string;
  name: string;
  email: string;
  password: string;
  employeeId: string;
  homeSalon: string;
  contract: string;
  roles: string;
}

export interface UxSeedSummary {
  tenantId: string;
  tenantName: string;
  slug: string;
  deactivatedTenants: number;
  persons: number;
  timeEntries: number;
  closedMonth: string;
  notes: string[];
  outFile: string;
}

export async function runUxSeed(app: FastifyInstance, opts: { outFile: string }) {
  const { fromZonedTime } = await import("date-fns-tz");
  const { dateStrInTz, monthRangeUtc } = await import("../src/contexts/working-time-account");
  const platform = await import("../src/contexts/platform");
  const { provisionTenantWithAdmin } = await import("../src/contexts/platform/tenant-provisioning");
  const { recordOperatorAudit, OPERATOR_AUDIT_ACTIONS } =
    await import("../src/contexts/platform/operator-audit");
  const { changeTenantPackages } = await import("../src/contexts/platform/tenant-packages");
  const { seedDefaultsForNewTenant } = await import("../src/composition/tenant-onboarding");
  type EmployeeCreationAudit =
    import("../src/contexts/platform/employee-creation").EmployeeCreationAudit;

  const prisma = app.prisma;
  const notes: string[] = [];
  const now = new Date();
  const today = dateStrInTz(now, TZ);
  const yesterday = addDays(today, -1);
  const [ty, tm] = today.split("-").map(Number) as [number, number];
  const prev = tm === 1 ? { year: ty - 1, month: 12 } : { year: ty, month: tm - 1 };
  const prevStart: Day = `${prev.year}-${String(prev.month).padStart(2, "0")}-01`;
  const curStart: Day = `${today.slice(0, 7)}-01`;
  const monday = addDays(today, -monIdx(today));
  const lastMonday = addDays(monday, -7);
  const nextWeekEnd = addDays(monday, 13);
  const runSuffix = `${today.replaceAll("-", "")}-${randomBytes(3).toString("hex")}`;
  const tenantName = `UX-Test ${today.slice(8, 10)}.${today.slice(5, 7)}.`;
  const slug = `${UX_TEST_SLUG_PREFIX}${runSuffix}`;
  const emailFor = (handle: Handle) => `ux-${handle}+${runSuffix}@${EMAIL_DOMAIN}`;
  const at = (day: Day, minutes: number) => fromZonedTime(`${day}T${hm(minutes)}:00`, TZ);

  // ── 1. Deactivate earlier UX-test tenants (never delete) ──────────────────────────────────
  const earlier = await prisma.tenant.findMany({
    where: { slug: { startsWith: UX_TEST_SLUG_PREFIX }, ...platform.ACTIVE_TENANT_WHERE },
    select: { id: true, slug: true },
  });
  for (const old of earlier) {
    await prisma.$transaction(async (tx) => {
      const deactivatedAt = new Date();
      const reason = "UX-Testmandant ersetzt durch einen neuen Lauf";
      await tx.tenant.update({
        where: { id: old.id },
        data: { deactivatedAt, deactivatedReason: reason },
        select: { id: true },
      });
      const { count } = await tx.refreshToken.updateMany({
        where: { revokedAt: null, user: { employee: { tenantId: old.id } } },
        data: { revokedAt: deactivatedAt },
      });
      await recordOperatorAudit(tx, {
        operatorId: null, // a script action, not an operator principal
        action: OPERATOR_AUDIT_ACTIONS.TENANT_DEACTIVATED,
        subjectTenantId: old.id,
        entity: "Tenant",
        entityId: old.id,
        oldValue: { deactivatedAt: null },
        newValue: {
          deactivatedAt: deactivatedAt.toISOString(),
          reason,
          revokedRefreshTokens: count,
          trigger: UX_TEST_TRIGGER,
        },
      });
    });
  }

  // ── 2. Tenant + Inhaberin through the provisioning core ───────────────────────────────────
  const scriptAudit = (tenantId: string): EmployeeCreationAudit => {
    const write = (
      e: {
        action: string;
        entity: string;
        entityId?: string;
        oldValue?: unknown;
        newValue?: unknown;
      },
      tx?: import("@clokr/db").Prisma.TransactionClient,
    ) =>
      app.audit({
        action: e.action,
        entity: e.entity,
        entityId: e.entityId,
        oldValue: e.oldValue,
        newValue: { ...(e.newValue as object), tenantId, trigger: UX_TEST_TRIGGER },
        tx,
      });
    return {
      vacationEntitlement: (entry, tx) => write(entry, tx),
      roleAssignmentChange: async (change, tx) => {
        for (const entry of change.entries) await write({ ...entry, entity: "RoleAssignment" }, tx);
      },
      salonAssignmentCreated: (entry, tx) =>
        write({ action: "CREATE", entity: "EmployeeSalonAssignment", ...entry }, tx),
      employeeCreated: (entry, tx) => write({ action: "CREATE", entity: "Employee", ...entry }, tx),
    };
  };

  const ownerPassword = generatePassword();
  const provisioned = await prisma.$transaction(async (tx) => {
    const result = await provisionTenantWithAdmin(
      tx,
      {
        tenant: { name: tenantName, slug, federalState: "NORDRHEIN_WESTFALEN", timezone: TZ },
        admin: { email: emailFor("inhaberin"), firstName: "Inga", lastName: "Haller" },
        onTenantCreated: seedDefaultsForNewTenant,
      },
      scriptAudit,
    );
    if (result.status !== "OK") throw new Error(`provisioning failed: ${result.status}`);
    await recordOperatorAudit(tx, {
      operatorId: null,
      action: OPERATOR_AUDIT_ACTIONS.TENANT_CREATED,
      subjectTenantId: result.tenant.id,
      entity: "Tenant",
      entityId: result.tenant.id,
      newValue: { name: tenantName, slug, trigger: UX_TEST_TRIGGER },
    });
    // Every package, so salon reach and the second salon are available (operator writer).
    const packages = await changeTenantPackages(tx, result.tenant.id, {
      bookedModules: [...platform.TENANT_MODULES],
      salonQuota: 5,
    });
    if (packages.status === "OK") {
      await recordOperatorAudit(tx, {
        operatorId: null,
        action: OPERATOR_AUDIT_ACTIONS.TENANT_PACKAGES_CHANGED,
        subjectTenantId: result.tenant.id,
        entity: "Tenant",
        entityId: result.tenant.id,
        oldValue: packages.before,
        newValue: { ...packages.after, trigger: UX_TEST_TRIGGER },
      });
    }
    return result;
  });
  const tenantId = provisioned.tenant.id;
  const ownerUserId = provisioned.user.id;
  const ownerEmployeeId = provisioned.employee.id;

  // ── In-process API access ────────────────────────────────────────────────────────────────
  const tokenFor = (userId: string, employeeId: string) =>
    app.jwt.sign({ sub: userId, tenantId, employeeId });
  async function api<T = unknown>(
    method: "GET" | "POST" | "PUT" | "PATCH",
    url: string,
    token: string | null,
    payload?: unknown,
  ): Promise<T> {
    const res = await app.inject({
      method,
      url,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });
    if (res.statusCode >= 400) {
      throw new Error(`${method} ${url} answered ${res.statusCode}: ${res.body.slice(0, 400)}`);
    }
    return (res.body ? res.json() : undefined) as T;
  }

  // The Inhaberin sets her password through the real invitation accept.
  await api("POST", "/api/v1/invitations/accept", null, {
    token: provisioned.invitationToken,
    password: ownerPassword,
  });
  const owner = tokenFor(ownerUserId, ownerEmployeeId);

  // Her stored system role becomes Inhaber (TENANT) — the role she holds in a salon business.
  const ownerAssignment = await prisma.roleAssignment.findFirst({
    where: { tenantId, userId: ownerUserId, accessRoleId: platform.SYSTEM_ROLE_IDS.ADMIN },
    select: { id: true },
  });
  if (ownerAssignment) {
    await api("PATCH", `/api/v1/role-assignments/${ownerAssignment.id}`, owner, {
      accessRoleId: platform.SYSTEM_ROLE_IDS.OWNER,
    });
  }

  // ── 3. Salons ────────────────────────────────────────────────────────────────────────────
  // Every persona works Monday to Friday, so both salons open Monday to Friday only (the
  // default hours open Saturday too, which would show an unplanned Saturday as understaffed).
  const openingHours = platform.DEFAULT_SALON_OPENING_HOURS.map((d) =>
    d.day === 5 ? { ...d, closed: true } : d,
  );
  await api("PATCH", `/api/v1/salons/${provisioned.salon.id}`, owner, {
    name: "Salon Mitte",
    openingHours,
  });
  const nord = await api<{ id: string }>("POST", "/api/v1/salons", owner, {
    name: "Salon Nord",
    openingHours,
    federalState: "NORDRHEIN_WESTFALEN",
  });
  const salonId: Record<SalonKey, string> = { MITTE: provisioned.salon.id, NORD: nord.id };
  const salonName: Record<SalonKey, string> = { MITTE: "Salon Mitte", NORD: "Salon Nord" };

  const holidays: Record<SalonKey, Set<Day>> = { MITTE: new Set(), NORD: new Set() };
  for (const key of ["MITTE", "NORD"] as const) {
    const list = await platform.holidaysForSalon(
      prisma,
      tenantId,
      salonId[key],
      prevStart,
      addDays(nextWeekEnd, 21),
    );
    for (const h of list) holidays[key].add(h.date);
  }

  // ── 4. Persons ───────────────────────────────────────────────────────────────────────────
  const specs = personSpecs();
  const birth16 = `${ty - 16}-${today.slice(5, 7)}-01T00:00:00.000Z`;
  // The Vollzeit person was hired years ago (so a carry-over is plausible); tracking in Clokr
  // starts with the previous month for everyone (see the pre-tracking rows below).
  const vollzeitHire = `${ty - 2}-03-01T00:00:00.000Z`;
  const people = new Map<
    PersonSpec["handle"],
    { spec: PersonSpec; employeeId: string; userId: string; token: string; password: string }
  >();
  for (const spec of specs) {
    const password = generatePassword();
    await api("POST", "/api/v1/employees", owner, {
      email: emailFor(spec.handle),
      firstName: spec.firstName,
      lastName: spec.lastName,
      employeeNumber: spec.employeeNumber,
      hireDate: spec.handle === "vollzeit" ? vollzeitHire : `${prevStart}T00:00:00.000Z`,
      role: "EMPLOYEE",
      password,
      classification: spec.classification,
      homeSalonId: salonId[spec.home],
      ...(spec.handle === "azubi" ? { birthDate: birth16 } : {}),
      ...spec.body,
    });
    const emp = await prisma.employee.findFirst({
      where: { tenantId, user: { email: emailFor(spec.handle) } },
      select: { id: true, userId: true },
    });
    if (!emp) throw new Error(`employee ${spec.handle} not found after creation`);
    people.set(spec.handle, {
      spec,
      employeeId: emp.id,
      userId: emp.userId,
      token: tokenFor(emp.userId, emp.id),
      password,
    });
    if (spec.extraRole) {
      await api("POST", "/api/v1/role-assignments", owner, {
        userId: emp.userId,
        accessRoleId: platform.SYSTEM_ROLE_IDS[spec.extraRole.slot],
        scope:
          spec.extraRole.scope === "TENANT"
            ? { type: "TENANT" }
            : { type: "SALONS", salonIds: [salonId.NORD] },
      });
    }
  }
  const P = (h: PersonSpec["handle"]) => people.get(h)!;

  // Vollzeit: a still valid carry-over from last year (illness, 15 months — EuGH).
  const vollzeitEnt = await prisma.leaveEntitlement.findFirst({
    where: { employeeId: P("vollzeit").employeeId, year: ty, leaveType: { code: "VACATION" } },
    select: { totalDays: true },
  });
  await api("PUT", `/api/v1/settings/vacation/${P("vollzeit").employeeId}`, owner, {
    year: ty,
    totalDays: Number(vollzeitEnt?.totalDays ?? 30),
    carriedOverDays: 3,
    carryOverDeadline: `${ty + 1}-03-31`,
    carryOverReason: "ILLNESS",
    carryOverNote: "Resturlaub aus dem Vorjahr, wegen Krankheit übertragen (UX-Test)",
  });

  // Azubi: Berufsschule every Tuesday from the start of tracking (real route + generator).
  await api("PUT", `/api/v1/employees/${P("azubi").employeeId}/vocational-school-pattern`, owner, {
    patterns: [
      { daysOfWeek: [1], validFrom: prevStart, respectSchoolHolidays: false, blockWeeks: [] },
    ],
  });
  await app.waitForPendingBSGenerations?.();
  // The pattern route generates forward from today; the past days come from the retroactive
  // apply an admin runs after entering a pattern late (same generator, explicit window).
  await api("POST", "/api/v1/vocational-school/retroactive-apply", owner, {
    employeeId: P("azubi").employeeId,
  });
  const schoolDays = new Set(
    (
      await prisma.absence.findMany({
        where: {
          employeeId: P("azubi").employeeId,
          type: "VOCATIONAL_SCHOOL",
          deletedAt: null,
          startDate: { lte: toDate(yesterday) },
        },
        select: { startDate: true },
      })
    ).map((a) => a.startDate.toISOString().slice(0, 10)),
  );
  if (schoolDays.size === 0) notes.push("Berufsschule: der Generator hat keine Tage angelegt.");

  // ── Plan helpers ────────────────────────────────────────────────────────────────────────
  const isWorkday = (h: PersonSpec["handle"], day: Day) =>
    !holidays[P(h).spec.home].has(day) && P(h).spec.dayPlan(day) !== null;
  /** The n consecutive workdays of a person starting on or after `from`. */
  const workdaysFrom = (h: PersonSpec["handle"], from: Day, n: number): Day[] => {
    const out: Day[] = [];
    for (let d = from; out.length < n; d = addDays(d, 1)) if (isWorkday(h, d)) out.push(d);
    return out;
  };

  // Deliberate cases.
  const overtimeDay = workdaysFrom("vollzeit", addDays(lastMonday, 3), 1)[0]; // last week's Thursday
  const sickDay = workdaysFrom("vollzeit", lastMonday, 1)[0]; // last week's Monday
  const pastVacation = workdaysFrom("vollzeit", addDays(prevStart, 7), 3);
  const futureVacation = workdaysFrom("schicht", addDays(monday, 14), 3); // after the roster ends
  const pendingRequest = workdaysFrom("teilzeit", addDays(monday, 22), 2);
  const missingCandidates = daysBetween(addDays(lastMonday, 1), addDays(lastMonday, 4))
    .filter((d) => d >= curStart && d <= yesterday && isWorkday("teilzeit", d))
    .reverse();
  const fallbackMissing = daysBetween(curStart, yesterday)
    .filter((d) => isWorkday("teilzeit", d))
    .reverse();
  const missingDay: Day | null = missingCandidates[0] ?? fallbackMissing[0] ?? null;
  if (missingDay === null) {
    notes.push(
      "Fehlender Tag (Teilzeit): im laufenden Monat gibt es vor heute noch keinen Arbeitstag — der Fall entfällt bei diesem Lauf.",
    );
  } else if (missingCandidates.length === 0) {
    notes.push(
      `Fehlender Tag (Teilzeit): letzte Woche liegt im abgeschlossenen Vormonat, daher ${deDay(missingDay)}.`,
    );
  }

  // ── 5. Leave through the real routes (requests by the person, decision by the Inhaberin) ──
  const leaveDays = new Map<PersonSpec["handle"], Set<Day>>();
  async function requestLeave(
    h: PersonSpec["handle"],
    type: "VACATION" | "SICK",
    days: Day[],
    decide: boolean,
    note: string,
  ) {
    const created = await api<{ id: string; status: string }>(
      "POST",
      "/api/v1/leave/requests",
      P(h).token,
      { type, startDate: days[0], endDate: days[days.length - 1], note },
    );
    if (decide && created.status === "PENDING") {
      await api("PATCH", `/api/v1/leave/requests/${created.id}/review`, owner, {
        status: "APPROVED",
        reviewNote: "Genehmigt",
      });
    }
    if (decide) {
      const set = leaveDays.get(h) ?? new Set<Day>();
      for (const d of daysBetween(days[0], days[days.length - 1])) set.add(d);
      leaveDays.set(h, set);
    }
  }
  await requestLeave("vollzeit", "VACATION", pastVacation, true, "Herbsturlaub");
  await requestLeave("vollzeit", "SICK", [sickDay], true, "krank gemeldet (Testdaten)");
  await requestLeave("schicht", "VACATION", futureVacation, true, "Familienbesuch");
  await requestLeave("teilzeit", "VACATION", pendingRequest, false, "Brückentage");

  // ── 6. Shifts and coverage (real routes) ────────────────────────────────────────────────
  const fruh = await api<{ id: string }>("POST", "/api/v1/shifts/templates", owner, {
    name: "Frühschicht",
    startTime: "08:00",
    endTime: "16:30",
    color: "#F59E0B",
  });
  const spat = await api<{ id: string }>("POST", "/api/v1/shifts/templates", owner, {
    name: "Spätschicht",
    startTime: "11:30",
    endTime: "20:00",
    color: "#3B82F6",
  });
  const tag = await api<{ id: string }>("POST", "/api/v1/shifts/templates", owner, {
    name: "Tagschicht",
    startTime: "09:00",
    endTime: "17:30",
    color: "#10B981",
  });
  const shifts: Array<Record<string, unknown>> = [];
  const nordPeople = (["salonleitung", "teilzeit", "schicht", "azubi"] as const).map(P);
  for (const person of nordPeople) {
    // The SHIFT_BASED person's roster covers the whole tracked period (it drives the Soll);
    // everyone else in Salon Nord is planned for this and next week.
    const from = person.spec.handle === "schicht" ? prevStart : monday;
    for (const day of daysBetween(from, nextWeekEnd)) {
      if (!isWorkday(person.spec.handle, day)) continue;
      if (leaveDays.get(person.spec.handle)?.has(day)) continue;
      if (person.spec.handle === "azubi" && monIdx(day) === 1) continue; // Berufsschule
      const block = person.spec.dayPlan(day)!;
      const templateId =
        person.spec.handle === "schicht"
          ? block.start === 8 * 60
            ? fruh.id
            : spat.id
          : block.start === 9 * 60 && block.end === 17 * 60 + 30
            ? tag.id
            : undefined;
      shifts.push({
        employeeId: person.employeeId,
        date: day,
        startTime: hm(block.start),
        endTime: hm(block.end),
        salonId: salonId.NORD,
        ...(templateId ? { templateId } : {}),
      });
    }
  }
  await api("POST", "/api/v1/shifts/bulk", owner, { shifts });
  // Salon Nord needs two people on every weekday, one of them not under supervision (the Azubi).
  for (let weekday = 0; weekday < 5; weekday++) {
    await api("POST", "/api/v1/shifts/coverage-rules", owner, {
      templateId: null,
      dayOfWeek: weekday,
      minStaff: 2,
      requiresNonSupervised: true,
      salonId: salonId.NORD,
    });
  }

  // ── 7. Recorded working time, 1st of the previous month through yesterday ──────────────
  let timeEntries = 0;
  for (const person of people.values()) {
    const h = person.spec.handle;
    for (const day of daysBetween(prevStart, yesterday)) {
      if (!isWorkday(h, day)) continue;
      if (leaveDays.get(h)?.has(day)) continue;
      if (h === "azubi" && schoolDays.has(day)) continue;
      if (h === "teilzeit" && day === missingDay) continue;
      let block = person.spec.dayPlan(day)!;
      if (h === "vollzeit" && day === overtimeDay) {
        block = { start: 8 * 60, end: 18 * 60 + 15, breaks: [[12 * 60, 12 * 60 + 45]] }; // 9.5 h
      }
      const breakMinutes = block.breaks.reduce((sum, [a, b]) => sum + (b - a), 0);
      const entry = await prisma.timeEntry.create({
        data: {
          employeeId: person.employeeId,
          date: toDate(day),
          startTime: at(day, block.start),
          endTime: at(day, block.end),
          breakMinutes,
          type: "WORK",
          source: "MANUAL",
          createdBy: person.userId,
          salonId: salonId[person.spec.home],
          breaks: {
            create: block.breaks.map(([a, b]) => ({ startTime: at(day, a), endTime: at(day, b) })),
          },
        },
        select: { id: true },
      });
      await app.audit({
        userId: person.userId,
        action: "CREATE",
        entity: "TimeEntry",
        entityId: entry.id,
        newValue: {
          employeeId: person.employeeId,
          date: day,
          start: hm(block.start),
          end: hm(block.end),
          breakMinutes,
          salonId: salonId[person.spec.home],
          trigger: UX_TEST_TRIGGER,
        },
      });
      timeEntries++;
    }
  }

  // ── 8. Close the previous month with the real closer ────────────────────────────────────
  // The Vollzeit person was hired before tracking began: the months of this year before the
  // previous one get a zero pre-tracking snapshot (the demo-seed convention), so the closer's
  // "earlier months first" rule holds and the saldo chain starts at zero.
  const vollzeit = P("vollzeit");
  for (let m = 1; m < prev.month; m++) {
    const bounds = monthRangeUtc(prev.year, m, TZ);
    const snap = await prisma.saldoSnapshot.create({
      data: {
        employeeId: vollzeit.employeeId,
        periodType: "MONTHLY",
        periodStart: bounds.start,
        periodEnd: bounds.end,
        workedMinutes: 0,
        expectedMinutes: 0,
        balanceMinutes: 0,
        carryOver: 0,
        closedAt: now,
        closedBy: ownerUserId,
        note: "Vor Erfassungsbeginn (UX-Test)",
        superseded: false,
      },
      select: { id: true },
    });
    await app.audit({
      userId: ownerUserId,
      action: "CREATE",
      entity: "SaldoSnapshot",
      entityId: snap.id,
      newValue: {
        employeeId: vollzeit.employeeId,
        year: prev.year,
        month: m,
        balanceMinutes: 0,
        note: "Vor Erfassungsbeginn (UX-Test)",
        trigger: UX_TEST_TRIGGER,
      },
    });
  }
  for (const person of people.values()) {
    await api("POST", "/api/v1/overtime/close-month", owner, {
      employeeId: person.employeeId,
      year: prev.year,
      month: prev.month,
    });
  }

  // ── 9. Output file (passwords only here) ───────────────────────────────────────────────
  const accounts: Account[] = [
    {
      role: "Inhaberin",
      name: "Inga Haller",
      email: emailFor("inhaberin"),
      password: ownerPassword,
      employeeId: ownerEmployeeId,
      homeSalon: salonName.MITTE,
      contract: "Nur Zeiterfassung (Monatsstunden ohne Soll), eingestellt heute",
      roles: "Inhaber (ganzer Mandant)",
    },
    ...[...people.values()].map((p) => ({
      role: p.spec.label,
      name: `${p.spec.firstName} ${p.spec.lastName}`,
      email: emailFor(p.spec.handle),
      password: p.password,
      employeeId: p.employeeId,
      homeSalon: salonName[p.spec.home],
      contract: p.spec.contract,
      roles: ["Mitarbeiter (ganzer Mandant)", p.spec.extraRole?.label].filter(Boolean).join(", "),
    })),
  ];
  const monthLabel = `${String(prev.month).padStart(2, "0")}/${prev.year}`;
  const lines = [
    `# UX-Test-Personas`,
    ``,
    `Erzeugt am ${deDay(today)} um ${now.toLocaleTimeString("de-DE", { timeZone: TZ })} durch \`apps/api/scripts/seed-ux-test-tenant.ts\` (Issue #952).`,
    `Jeder Lauf legt einen neuen Mandanten an und deaktiviert die früheren — diese Datei wird jedes Mal überschrieben.`,
    ``,
    `- Mandant: **${tenantName}** (Slug \`${slug}\`, Id \`${tenantId}\`)`,
    `- Anmeldung: http://localhost:3000/login`,
    `- Salons: Salon Mitte, Salon Nord (beide NRW, geöffnet Mo–Fr)`,
    `- Vormonat ${monthLabel} abgeschlossen, laufender Monat offen; Zeiten bis gestern (${deDay(yesterday)}), keine laufende Uhr.`,
    ``,
    `| Rolle | Name | E-Mail | Passwort | Mitarbeiter-Id | Stammsalon | Vertrag | Rollen |`,
    `| --- | --- | --- | --- | --- | --- | --- | --- |`,
    ...accounts.map(
      (a) =>
        `| ${a.role} | ${a.name} | \`${a.email}\` | \`${a.password}\` | \`${a.employeeId}\` | ${a.homeSalon} | ${a.contract} | ${a.roles} |`,
    ),
    ``,
    `## Absichtliche Fälle`,
    ``,
    `- Vollzeit: Urlaub genehmigt ${deDay(pastVacation[0])}–${deDay(pastVacation[pastVacation.length - 1])}, krank am ${deDay(sickDay)}, Überstundentag ${deDay(overtimeDay)} (9,5 h), Resturlaub Vorjahr 3 Tage (Krankheit, bis 31.03.${ty + 1}).`,
    `- Teilzeit: ${missingDay ? `kein Eintrag am ${deDay(missingDay)} (fehlt)` : "kein fehlender Tag in diesem Lauf"}, offener Urlaubsantrag ${deDay(pendingRequest[0])}–${deDay(pendingRequest[pendingRequest.length - 1])} (Aufgaben).`,
    `- Schicht: Dienstplan in Salon Nord ab ${deDay(prevStart)} bis ${deDay(nextWeekEnd)} (Früh-/Spätwochen), Urlaub genehmigt ${deDay(futureVacation[0])}–${deDay(futureVacation[futureVacation.length - 1])}.`,
    `- Azubi: unter 18, Berufsschule dienstags (${schoolDays.size} Tage bis gestern), Pausen nach § 11 JArbSchG.`,
    `- Minijob: 40 Monatsstunden, arbeitet Mo und Do je 4,5 h.`,
    `- Salon Nord: Besetzungsregel Mo–Fr mindestens 2 Personen, davon eine ohne Aufsichtspflicht.`,
    ...(notes.length > 0 ? [``, `## Hinweise`, ``, ...notes.map((n) => `- ${n}`)] : []),
    ``,
  ];
  mkdirSync(dirname(opts.outFile), { recursive: true });
  writeFileSync(opts.outFile, lines.join("\n"), { mode: 0o600 });

  const summary: UxSeedSummary = {
    tenantId,
    tenantName,
    slug,
    deactivatedTenants: earlier.length,
    persons: accounts.length,
    timeEntries,
    closedMonth: monthLabel,
    notes,
    outFile: opts.outFile,
  };
  return summary;
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────

const isCli = process.argv[1] !== undefined && /seed-ux-test-tenant\.[tj]s$/.test(process.argv[1]);

if (isCli) {
  (async () => {
    const { parseArgs } = await import("node:util");
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: { out: { type: "string" } },
      strict: true,
    });
    try {
      assertUxSeedTarget({
        nodeEnv: process.env.NODE_ENV,
        databaseUrl: process.env.DATABASE_URL,
      });
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }

    // Per-run secrets for the in-process app when none are set (see the header).
    for (const key of ["JWT_SECRET", "JWT_REFRESH_SECRET", "ENCRYPTION_KEY"]) {
      if (!process.env[key]) process.env[key] = randomBytes(32).toString("hex");
    }
    process.env.LOG_LEVEL ??= "warn";

    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    const outFile = resolve(
      values.out ?? resolve(repoRoot, ".planning/redesign/ux-test-personas.md"),
    );

    const { buildApp } = await import("../src/app");
    const app = await buildApp();
    await app.ready();

    let exitCode = 0;
    try {
      const s = await runUxSeed(app, { outFile });
      console.info(`seed-ux-test-tenant: tenant "${s.tenantName}" (${s.slug}, id ${s.tenantId})`);
      console.info(
        `  ${s.persons} accounts, ${s.timeEntries} time entries, month ${s.closedMonth} closed, ${s.deactivatedTenants} earlier UX-test tenant(s) deactivated`,
      );
      for (const note of s.notes) console.info(`  note: ${note}`);
      console.info(`  accounts written to ${s.outFile}`);
    } catch (err) {
      console.error((err as Error).message ?? err);
      exitCode = 1;
    } finally {
      await app.close();
    }
    process.exit(exitCode);
  })();
}
