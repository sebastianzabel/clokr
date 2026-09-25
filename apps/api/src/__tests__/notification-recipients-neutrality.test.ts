/**
 * Phase 75b (Issue #75, AC-75-12, D-16, D-17, D-27) — neutrality of every role-based
 * notification-recipient lookup.
 *
 * ── What it proves ──────────────────────────────────────────────────────────────────────────────
 * Issue #75 replaces the role predicate of every notification-recipient lookup
 * (`role: { in: ["ADMIN", "MANAGER"] }`, `role: "ADMIN"`, and the in-memory role filter of the
 * missing-entries scan) with a permission-holder lookup (D-16) and promises that nobody gains or
 * loses a notification. There are 17 such lookups: the 16 the issue names plus the
 * ACCOUNT_LOCKED admin notification in `platform/api/auth.ts` (D-17). This file triggers every one
 * of them through its REAL code path — an HTTP request, an existing test decorator, an exported
 * cron function, or one of the two decorators Phase 75b added for exactly this purpose
 * (`app.tryMissingEntriesCheck`, `app.tryPendingLeaveReminder`, D-27) — and records which fixture
 * users received the notification the trigger created.
 *
 * Why the real code path and not a comparison of `where` clauses: a test that copies the old and
 * the new predicate side by side compares two copies, and two copies drift in lockstep — a later
 * edit of the site would not touch either of them. Only the notification rows the site itself
 * writes answer "who is told" for the code that actually runs.
 *
 * ── The fixture (D-09, D-16) ────────────────────────────────────────────────────────────────────
 * Tenant R holds, built BEFORE the checked-in migration SQL runs (so they get migrated
 * assignments): an active and an inactive ADMIN, an active and an inactive MANAGER, two EMPLOYEEs
 * (the requester, whom most sites are about, and a colleague), an EMPLOYEE, an ADMIN and a MANAGER
 * with `exitDate` set, and a user whose only stored assignment is a SALONS-scope customer role that
 * holds every ZUGEWIESEN permission (the migration skips a user that already has an assignment).
 * After the migration: a fallback ADMIN, MANAGER and EMPLOYEE with zero stored assignments (D-08).
 * Tenant S holds an active ADMIN and MANAGER and nothing that could trigger a notification of its
 * own, so any row S receives is a cross-tenant leak.
 *
 * Never a recipient, before or after the switch: the inactive users, the exited EMPLOYEE, the
 * SALONS-scope user (a SALONS assignment grants nothing at the API in 75b, D-09) and tenant S.
 * The exited ADMIN/MANAGER are deliberately part of the recording: most sites do not filter on
 * `exitDate`, the missing-entries scan does — the switch must keep exactly that difference.
 * No TENANT customer-role holder is in the fixture: that such a holder is notified after the
 * switch is the intended new behaviour (D-16), not a neutrality question.
 *
 * ── RECORD vs VERIFY ────────────────────────────────────────────────────────────────────────────
 *   NEUTRALITY_RECIPIENTS_MODE=record  write every site's record (default
 *                                      `neutrality/recorded/recipients.json`, or
 *                                      NEUTRALITY_RECIPIENTS_OUT) in `afterAll`;
 *   (default) VERIFY                   compare with the recording (default path, or
 *                                      NEUTRALITY_RECIPIENTS_IN).
 * RECORD refuses once the legacy role guard's definition is gone from `middleware/auth.ts` — the
 * same guard as the permission matrix: a recording of the switched code would compare the new code
 * with itself. A recording that is not committed yet stays unstaged; every run starts with
 * `pnpm --filter @clokr/api run test:setup` (fresh worker databases).
 *
 * ── Record shape ────────────────────────────────────────────────────────────────────────────────
 * Per site: the notification `type`, the fixed trigger `actor`, the sorted multiset of tenant R
 * labels that received a row of that type from the trigger (`recipients`), the rows the subject of
 * the event received about itself where the site also notifies the subject with the same type
 * (`subjectRows` — not part of the role lookup, kept apart so the lookup's set stays readable),
 * and the tenant S labels that received one (`tenantS`, must be empty). Rows are found by type,
 * fixture user and "did not exist before the trigger" — cron functions iterate EVERY tenant of the
 * worker database, so nothing outside the two fixture tenants is looked at.
 *
 * Only `Date` is faked (full fake timers break the pg connection); "now" is pinned to a Wednesday
 * mid-month. One site is month-edge logic and moves the clock for its own trigger only (#12).
 * Mailer, storage and `fetch` are stubbed in both modes (`neutrality/external-stubs.ts`).
 * `afterAll` removes both fixture tenants, including the global audit rows the triggers wrote.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import type { Role } from "@clokr/db";
import { getTestApp, cleanupTestData, createTestSalon } from "./setup";
import { executeLegacyRoleMigration } from "./legacy-role-migration-sql";
import { LabelRegistry, cleanupMatrixExtras } from "./neutrality/fixture";
import { installExternalStubs, type ExternalStubs } from "./neutrality/external-stubs";
import { leaveTypeFields } from "../contexts/absence/leave-type";
import { PERMISSIONS, permissionKey } from "../contexts/platform";
import type { JwtPayload } from "../middleware/auth";

const MODE = process.env.NEUTRALITY_RECIPIENTS_MODE === "record" ? "record" : "verify";
const DEFAULT_RECORDING = join(__dirname, "neutrality", "recorded", "recipients.json");
const RECORD_OUT = process.env.NEUTRALITY_RECIPIENTS_OUT || DEFAULT_RECORDING;
const VERIFY_IN = process.env.NEUTRALITY_RECIPIENTS_IN || DEFAULT_RECORDING;

/** The legacy role guard's definition line; RECORD requires it (same guard as the matrix). */
const ROLE_GUARD_DEFINITION = "export function requireRole";
const AUTH_MIDDLEWARE = join(__dirname, "..", "middleware", "auth.ts");

/** A Wednesday mid-month in the past, not a public holiday (the matrix's pinned "now"). */
const PINNED_NOW = new Date("2026-06-17T08:00:00.000Z");

/** The one password every fixture user has — only the lockout site (#17) logs in, and fails. */
const FIXTURE_PASSWORD = "recipients-neutrality";

/** Fixture calendar, relative to PINNED_NOW. */
const DAY = {
  recentEntry: "2026-06-16", // yesterday: keeps a person out of the missing-entries scan
  autoBreakEntry: "2026-06-15", // Monday: the entry whose auto break is waived (#15)
  retroTarget: "2026-06-03", // 14 days back, beyond the 10-day retro window (#13)
  leaveRequestStart: "2026-08-03",
  leaveRequestEnd: "2026-08-04",
  section9VacationStart: "2026-07-06",
  section9VacationEnd: "2026-07-10",
  section9Sick: "2026-07-08",
  conflictLeave: "2026-07-15", // Wednesday with a planned shift (#3)
  bsShift: "2026-06-23", // the Tuesday after PINNED_NOW, a vocational-school day (#5)
  stalePendingCreatedAt: "2026-06-10T08:00:00.000Z", // older than the 48h reminder threshold
  staleLeaveStart: "2026-09-07",
  staleLeaveEnd: "2026-09-08",
  carryOverDeadline: "2026-07-17T08:00:00.000Z", // exactly 30 days after PINNED_NOW (#6)
  beginningOfMonth: "2026-07-02T08:00:00.000Z", // day 2: the manager gap reminder window (#12)
} as const;

function day(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

function at(iso: string, time: string): Date {
  return new Date(`${iso}T${time}:00.000Z`);
}

/** Labels that must never receive a notification from any site, before or after the switch. */
const NEVER_RECIPIENTS: readonly string[] = [
  "R.admin.inactive",
  "R.manager.inactive",
  "R.employee.exited",
  "R.salonsScope",
];

interface SiteRecord {
  type: string;
  actor: string;
  recipients: string[];
  subjectRows: string[];
  tenantS: string[];
}

/** Code-point key order and one site per line, so a later diff names exactly the sites that
 * changed (same serialization as the matrix recording). */
function serializeRecording(sites: ReadonlyMap<string, SiteRecord>): string {
  const keys = [...sites.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const lines = keys.map((key) => `    ${JSON.stringify(key)}: ${JSON.stringify(sites.get(key))}`);
  return `{\n  "sites": {\n${lines.join(",\n")}\n  }\n}\n`;
}

interface Person {
  userId: string;
  employeeId: string;
}

describe("notification recipient neutrality (Issue #75, AC-75-12)", () => {
  let app: FastifyInstance;
  let stubs: ExternalStubs | undefined;
  const registry = new LabelRegistry();
  const collected = new Map<string, SiteRecord>();
  let recording: Record<string, SiteRecord> | undefined;
  let setupComplete = false;

  let tenantR = "";
  let tenantS = "";
  let salonR = "";
  let vacationTypeR = "";
  let sickTypeR = "";
  const persons = new Map<string, Person>();
  /** user id → label, tenant R. */
  const labelOfRUser = new Map<string, string>();
  /** user id → label, tenant S. */
  const labelOfSUser = new Map<string, string>();
  let passwordHash = "";
  let remoteCounter = 0;

  function person(label: string): Person {
    const p = persons.get(label);
    if (!p) throw new Error(`recipients: no fixture person "${label}"`);
    return p;
  }

  /** A fresh inject address per request — the rate-limit store is keyed by it. */
  function nextRemoteAddress(): string {
    const n = remoteCounter++;
    return `10.175.${Math.floor(n / 250) % 250}.${(n % 250) + 1}`;
  }

  async function createTenant(slugPrefix: string): Promise<string> {
    const slug = `${slugPrefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const tenant = await app.prisma.tenant.create({
      data: { name: `Empfaenger ${slugPrefix}`, slug, federalState: "NIEDERSACHSEN" },
    });
    return tenant.id;
  }

  async function createPerson(
    tenantId: string,
    label: string,
    opts: { role: Role; isActive?: boolean; exitDate?: Date; exempt?: boolean },
  ): Promise<Person> {
    const slug = label.replace(/\./g, "-").toLowerCase();
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const user = await app.prisma.user.create({
      data: {
        email: `${slug}-${suffix}@recipients.test`,
        passwordHash,
        role: opts.role,
        isActive: opts.isActive ?? true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId,
        userId: user.id,
        employeeNumber: `${slug}-${suffix}`.toUpperCase(),
        firstName: "Empfaenger",
        lastName: label,
        hireDate: new Date("2024-01-01"),
        exitDate: opts.exitDate,
        isTimeTrackingExempt: opts.exempt ?? false,
      },
    });
    await app.prisma.workSchedule.create({
      data: {
        employeeId: employee.id,
        weeklyHours: 40,
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
        validFrom: new Date("2024-01-01"),
      },
    });
    await app.prisma.overtimeAccount.create({
      data: { employeeId: employee.id, balanceHours: 0 },
    });
    registry.register(`${label}.user`, user.id);
    registry.register(`${label}.employee`, employee.id);
    const p = { userId: user.id, employeeId: employee.id };
    persons.set(label, p);
    (tenantId === tenantS ? labelOfSUser : labelOfRUser).set(user.id, label);
    return p;
  }

  /** A closed time entry on `iso` — keeps the person out of the missing-entries scan (#9). */
  async function createRecentEntry(p: Person, iso: string): Promise<void> {
    await app.prisma.timeEntry.create({
      data: {
        employeeId: p.employeeId,
        date: day(iso),
        startTime: at(iso, "07:00"),
        endTime: at(iso, "15:00"),
        breakMinutes: 30,
        source: "MANUAL",
      },
    });
  }

  function bearer(label: string, role: Role): string {
    const p = person(label);
    const payload: JwtPayload = {
      sub: p.userId,
      role,
      tenantId: tenantR,
      employeeId: p.employeeId,
    };
    return `Bearer ${app.jwt.sign(payload)}`;
  }

  async function inject(opts: {
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    url: string;
    authorization?: string;
    payload?: unknown;
  }) {
    return app.inject({
      method: opts.method,
      url: opts.url,
      headers: opts.authorization ? { authorization: opts.authorization } : {},
      payload: opts.payload as Record<string, unknown> | undefined,
      remoteAddress: nextRemoteAddress(),
    });
  }

  function fixtureUserIds(): string[] {
    return [...labelOfRUser.keys(), ...labelOfSUser.keys()];
  }

  async function existingNotificationIds(): Promise<string[]> {
    const rows = await app.prisma.notification.findMany({
      where: { userId: { in: fixtureUserIds() } },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  /**
   * Runs one site: snapshots the fixture users' notifications, runs the trigger, and reduces the
   * rows of `type` the trigger created to labels. `subjects` are the persons the event is about
   * whose own same-type notification is kept apart from the role lookup's set.
   */
  async function measureSite(
    key: string,
    spec: { type: string; actor: string; subjects?: readonly string[] },
    trigger: () => Promise<void>,
  ): Promise<SiteRecord> {
    const before = await existingNotificationIds();
    await trigger();
    const rows = await app.prisma.notification.findMany({
      where: { type: spec.type, userId: { in: fixtureUserIds() }, id: { notIn: before } },
      select: { userId: true },
    });
    const subjects = new Set(spec.subjects ?? []);
    const recipients: string[] = [];
    const subjectRows: string[] = [];
    const inS: string[] = [];
    for (const row of rows) {
      const rLabel = labelOfRUser.get(row.userId);
      if (rLabel !== undefined) {
        (subjects.has(rLabel) ? subjectRows : recipients).push(rLabel);
        continue;
      }
      const sLabel = labelOfSUser.get(row.userId);
      if (sLabel !== undefined) inS.push(sLabel);
    }
    const record: SiteRecord = {
      type: spec.type,
      actor: spec.actor,
      recipients: recipients.sort(),
      subjectRows: subjectRows.sort(),
      tenantS: inS.sort(),
    };
    collected.set(key, record);

    // Harness and leak checks, in both modes.
    expect(record.recipients.length, `${key}: the trigger created no notification`).toBeGreaterThan(
      0,
    );
    expect(
      record.recipients.filter((label) => NEVER_RECIPIENTS.includes(label)),
      `${key}: a never-recipient was notified`,
    ).toEqual([]);
    expect(record.tenantS, `${key}: tenant S received a notification (cross-tenant leak)`).toEqual(
      [],
    );
    if (MODE === "verify") {
      const expected = recording?.[key];
      expect(expected, `${key}: not recorded`).toBeDefined();
      expect(record, key).toEqual(expected);
    }
    return record;
  }

  beforeAll(async () => {
    if (
      MODE === "record" &&
      !readFileSync(AUTH_MIDDLEWARE, "utf8").includes(ROLE_GUARD_DEFINITION)
    ) {
      throw new Error(
        `recipients: RECORD refused — "${ROLE_GUARD_DEFINITION}" is no longer defined in ` +
          `${AUTH_MIDDLEWARE}. The recording must come from the pre-switch code; recording the ` +
          `switched code would make the neutrality proof compare the new code with itself.`,
      );
    }
    app = await getTestApp();
    vi.useFakeTimers({ now: PINNED_NOW, toFake: ["Date"] });
    stubs = installExternalStubs(app);
    passwordHash = await bcrypt.hash(FIXTURE_PASSWORD, 10);

    // ── Tenant R ──
    tenantR = await createTenant("rcp-r");
    registry.register("R.tenant", tenantR);
    await app.prisma.tenantConfig.create({
      data: {
        tenantId: tenantR,
        defaultVacationDays: 30,
        timezone: "Europe/Berlin",
        // #7/#8: a gap month past its window is deferred, never force-closed, so the blocked and
        // the deferred notification both fire.
        closeMonthWithGapsAllowed: false,
        reminderPendingLeaveEnabled: true,
        vocationalSchoolAutoCleanupShifts: true,
      },
    });
    salonR = (await createTestSalon(app.prisma, tenantR, { name: "Empfaenger Salon" })).id;
    registry.register("R.salon", salonR);
    vacationTypeR = (
      await app.prisma.leaveType.create({
        data: { tenantId: tenantR, ...leaveTypeFields("VACATION"), color: "#3B82F6" },
      })
    ).id;
    sickTypeR = (
      await app.prisma.leaveType.create({
        data: { tenantId: tenantR, ...leaveTypeFields("SICK"), color: "#EF4444" },
      })
    ).id;

    await createPerson(tenantR, "R.admin", { role: "ADMIN" });
    await createPerson(tenantR, "R.admin.inactive", { role: "ADMIN", isActive: false });
    await createPerson(tenantR, "R.manager", { role: "MANAGER" });
    await createPerson(tenantR, "R.manager.inactive", { role: "MANAGER", isActive: false });
    await createPerson(tenantR, "R.requester", { role: "EMPLOYEE" });
    await createPerson(tenantR, "R.colleague", { role: "EMPLOYEE" });
    await createPerson(tenantR, "R.employee.exited", {
      role: "EMPLOYEE",
      exitDate: day("2026-03-31"),
    });
    await createPerson(tenantR, "R.admin.exited", { role: "ADMIN", exitDate: day("2026-03-31") });
    await createPerson(tenantR, "R.manager.exited", {
      role: "MANAGER",
      exitDate: day("2026-03-31"),
    });
    const salonsScope = await createPerson(tenantR, "R.salonsScope", { role: "EMPLOYEE" });

    // D-09: a SALONS-scope customer role with every ZUGEWIESEN permission, stored before the
    // migration runs — the migration skips a user who already has an assignment.
    const everyAssigned = PERMISSIONS.filter((p) => p.reach === "ZUGEWIESEN").map(permissionKey);
    const salonsRole = await app.prisma.accessRole.create({
      data: {
        tenantId: tenantR,
        name: "Empfaenger Salonrolle",
        nameKey: "empfaenger salonrolle",
        permissions: everyAssigned,
      },
    });
    registry.register("R.salonsRole", salonsRole.id);
    const salonsAssignment = await app.prisma.roleAssignment.create({
      data: {
        tenantId: tenantR,
        userId: salonsScope.userId,
        accessRoleId: salonsRole.id,
        scopeType: "SALONS",
        salonIds: [salonR],
        employeeIds: [],
      },
    });
    registry.register("R.salonsScope.assignment", salonsAssignment.id);

    // ── Tenant S: an ADMIN and a MANAGER, inert (exempt from time tracking, recent entries) ──
    tenantS = await createTenant("rcp-s");
    registry.register("S.tenant", tenantS);
    await app.prisma.tenantConfig.create({
      data: { tenantId: tenantS, defaultVacationDays: 30, timezone: "Europe/Berlin" },
    });
    const sAdmin = await createPerson(tenantS, "S.admin", { role: "ADMIN", exempt: true });
    const sManager = await createPerson(tenantS, "S.manager", { role: "MANAGER", exempt: true });
    await createRecentEntry(sAdmin, DAY.recentEntry);
    await createRecentEntry(sManager, DAY.recentEntry);

    // D-25: the checked-in migration SQL runs on the fixture before any trigger.
    await executeLegacyRoleMigration(app.prisma);

    // D-08: fallback users exist only after the migration, so they hold no stored assignment.
    await createPerson(tenantR, "R.fallback.admin", { role: "ADMIN" });
    await createPerson(tenantR, "R.fallback.manager", { role: "MANAGER" });
    await createPerson(tenantR, "R.fallback.employee", { role: "EMPLOYEE" });

    // Everyone the missing-entries scan (#9) would otherwise report — every active, non-exited R
    // person except the colleague, who is that site's subject.
    for (const label of [
      "R.admin",
      "R.manager",
      "R.salonsScope",
      "R.fallback.admin",
      "R.fallback.manager",
      "R.fallback.employee",
    ]) {
      await createRecentEntry(person(label), DAY.recentEntry);
    }
    await app.prisma.leaveEntitlement.create({
      data: {
        employeeId: person("R.requester").employeeId,
        leaveTypeId: vacationTypeR,
        year: 2026,
        totalDays: 30,
        usedDays: 0,
      },
    });

    if (MODE === "verify") {
      if (!existsSync(VERIFY_IN)) {
        throw new Error(
          `recipients: no recording at ${VERIFY_IN} — run with NEUTRALITY_RECIPIENTS_MODE=record first`,
        );
      }
      recording = (
        JSON.parse(readFileSync(VERIFY_IN, "utf8")) as { sites: Record<string, SiteRecord> }
      ).sites;
    }
    setupComplete = true;
  }, 300_000);

  afterAll(async () => {
    vi.useRealTimers();
    stubs?.restore();
    if (MODE === "record" && setupComplete) {
      mkdirSync(dirname(RECORD_OUT), { recursive: true });
      writeFileSync(RECORD_OUT, serializeRecording(collected));
    }
    for (const tenantId of [tenantR, tenantS]) {
      if (!tenantId) continue;
      try {
        await deleteGlobalAuditRows(tenantId);
        await cleanupMatrixExtras(app, tenantId);
        await cleanupTestData(app, tenantId);
      } catch (err) {
        console.error(`recipients: cleanup of tenant ${tenantId} failed:`, err);
      }
    }
  });

  /**
   * The triggers write audit rows without an actor (cron runs, the lockout, the generator). They
   * would stay behind as global `userId: null` rows that every later ADMIN activity feed of the
   * worker database shows, so they are removed by the entity they describe.
   */
  async function deleteGlobalAuditRows(tenantId: string): Promise<void> {
    const employees = await app.prisma.employee.findMany({
      where: { tenantId },
      select: { id: true, userId: true },
    });
    const employeeIds = employees.map((e) => e.id);
    const byEmployee = { employeeId: { in: employeeIds } };
    const ids = [
      ...employees.map((e) => e.userId),
      ...employeeIds,
      ...(await app.prisma.timeEntry.findMany({ where: byEmployee, select: { id: true } })),
      ...(await app.prisma.absence.findMany({ where: byEmployee, select: { id: true } })),
      ...(await app.prisma.shift.findMany({ where: byEmployee, select: { id: true } })),
      ...(await app.prisma.leaveRequest.findMany({ where: byEmployee, select: { id: true } })),
      ...(await app.prisma.leaveEntitlement.findMany({ where: byEmployee, select: { id: true } })),
      ...(await app.prisma.section9Credit.findMany({ where: byEmployee, select: { id: true } })),
      ...(await app.prisma.retroEntryRequest.findMany({ where: byEmployee, select: { id: true } })),
      ...(await app.prisma.saldoSnapshot.findMany({ where: byEmployee, select: { id: true } })),
    ].map((row) => (typeof row === "string" ? row : row.id));
    await app.prisma.auditLog.deleteMany({ where: { entityId: { in: ids } } });
  }

  describe("fixture", () => {
    it("migrated the legacy-role users, skipped the SALONS-scope user, and left the fallback users assignment-free", async () => {
      const counts = new Map<string, number>();
      for (const label of [
        "R.admin",
        "R.manager",
        "R.requester",
        "R.salonsScope",
        "R.fallback.admin",
        "R.fallback.manager",
        "R.fallback.employee",
      ]) {
        counts.set(
          label,
          await app.prisma.roleAssignment.count({ where: { userId: person(label).userId } }),
        );
      }
      expect(Object.fromEntries(counts)).toEqual({
        "R.admin": 1,
        "R.manager": 1,
        "R.requester": 1,
        "R.salonsScope": 1,
        "R.fallback.admin": 0,
        "R.fallback.manager": 0,
        "R.fallback.employee": 0,
      });
      const salonsOnly = await app.prisma.roleAssignment.findMany({
        where: { userId: person("R.salonsScope").userId },
        select: { scopeType: true, accessRoleId: true },
      });
      expect(salonsOnly).toEqual([
        { scopeType: "SALONS", accessRoleId: registry.idOf("R.salonsRole") },
      ]);
    });
  });

  describe("recipient sites", () => {
    it("#1 LEAVE_REQUEST — POST /leave/requests (leave.ts)", async () => {
      // Actor: the requester (an employee files a request). No skip.
      await measureSite(
        "#01 leave.ts POST /leave/requests",
        {
          type: "LEAVE_REQUEST",
          actor: "R.requester",
        },
        async () => {
          const res = await inject({
            method: "POST",
            url: "/api/v1/leave/requests",
            authorization: bearer("R.requester", "EMPLOYEE"),
            payload: {
              type: "VACATION",
              startDate: DAY.leaveRequestStart,
              endDate: DAY.leaveRequestEnd,
            },
          });
          expect(res.statusCode, res.body).toBe(201);
          registry.register("R.leaveRequest.new", JSON.parse(res.body).id as string);
        },
      );
    });
  });
});
