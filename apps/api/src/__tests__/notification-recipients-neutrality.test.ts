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
 * No TENANT customer-role holder is in the fixture: that such a holder is notified after the
 * switch is the intended new behaviour (D-16), not a neutrality question.
 *
 * Phase 355 (Issue #355): the exited ADMIN/MANAGER used to be deliberately part of the recording
 * (most sites did not filter on `exitDate`, only the missing-entries scan did). #355 made
 * `userIdsHoldingPermission` exclude a departed holder centrally, so they are now `NEVER_RECIPIENTS`
 * for every site, same as the missing-entries scan always treated them — the recorded fixture
 * (`neutrality/recorded/recipients.json`) was hand-updated to drop them from every site's
 * `recipients`, since RECORD mode has been permanently refused since `requireRole` was removed
 * (see below) and cannot regenerate it.
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
import { getTestApp, cleanupTestData, createTestSalon, salonIdForEmployee } from "./setup";
import { executeLegacyRoleMigration } from "./legacy-role-migration-sql";
import { LabelRegistry, cleanupMatrixExtras } from "./neutrality/fixture";
import { installExternalStubs, type ExternalStubs } from "./neutrality/external-stubs";
import { leaveTypeFields } from "../contexts/absence/leave-type";
import { runVocationalSchoolGeneration } from "../contexts/absence/vocational-school-generator";
import { runCarryoverWarningOnce } from "../contexts/absence/plugins/carryover-warning";
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

/**
 * Labels that must never receive a notification from any site.
 *
 * Phase 355 (Issue #355): `R.admin.exited` / `R.manager.exited` moved into this list. Before #355
 * they were deliberately part of the recording (16 of 17 sites notified them — the personal-data
 * leak the issue reports); `userIdsHoldingPermission` (`contexts/platform/facade/role-assignments.ts`)
 * now excludes a departed (`exitDate` in the past) holder centrally, so every site is affected the
 * same way #9's missing-entries scan already was.
 */
const NEVER_RECIPIENTS: readonly string[] = [
  "R.admin.inactive",
  "R.manager.inactive",
  "R.admin.exited",
  "R.manager.exited",
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
        salonId: await salonIdForEmployee(app.prisma, p.employeeId), // Phase 68b (#68)
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
    // Phase 68b (#68, merged from origin/main 704b1ee5): TimeEntry.salonId is required, so tenant S
    // needs a salon for its recent entries.
    await createTestSalon(app.prisma, tenantS);
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
    // person except the colleague, who is that site's subject. The requester's two entries below
    // count as well.
    const requester = person("R.requester");
    // #10: an open entry (no clock-out) older than the tenant's 14h auto-invalidate threshold.
    const openEntry = await app.prisma.timeEntry.create({
      data: {
        employeeId: requester.employeeId,
        date: day(DAY.recentEntry),
        startTime: at(DAY.recentEntry, "07:00"),
        endTime: null,
        breakMinutes: 0,
        source: "MANUAL",
        salonId: salonR, // Phase 68b (#68)
      },
    });
    registry.register("R.requester.openEntry", openEntry.id);
    // #15: an entry whose break was inserted automatically (breakStatus AUTO), waivable.
    const autoBreakEntry = await app.prisma.timeEntry.create({
      data: {
        employeeId: requester.employeeId,
        date: day(DAY.autoBreakEntry),
        startTime: at(DAY.autoBreakEntry, "07:00"),
        endTime: at(DAY.autoBreakEntry, "15:00"),
        breakMinutes: 30,
        breakStatus: "AUTO",
        source: "MANUAL",
        salonId: salonR, // Phase 68b (#68)
      },
    });
    registry.register("R.requester.autoBreakEntry", autoBreakEntry.id);
    await app.prisma.break.create({
      data: {
        timeEntryId: autoBreakEntry.id,
        startTime: at(DAY.autoBreakEntry, "11:00"),
        endTime: at(DAY.autoBreakEntry, "11:30"),
      },
    });
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
        // The Nachtrag's time entry references its request (Restrict), so it goes first.
        await app.prisma.timeEntry.deleteMany({
          where: { employee: { tenantId }, retroRequestId: { not: null } },
        });
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

    it("#2 SECTION9_AU_PENDING_MANAGER — approving a SICK request inside approved leave (leave.ts review)", async () => {
      // Actor: the active MANAGER approves; the site skips the actor.
      const requester = person("R.requester");
      const vacation = await app.prisma.leaveRequest.create({
        data: {
          employeeId: requester.employeeId,
          leaveTypeId: vacationTypeR,
          startDate: day(DAY.section9VacationStart),
          endDate: day(DAY.section9VacationEnd),
          days: 5,
          status: "APPROVED",
          reviewedBy: person("R.admin").userId,
          reviewedAt: PINNED_NOW,
        },
      });
      registry.register("R.leaveRequest.section9Vacation", vacation.id);
      const sick = await app.prisma.leaveRequest.create({
        data: {
          employeeId: requester.employeeId,
          leaveTypeId: sickTypeR,
          startDate: day(DAY.section9Sick),
          endDate: day(DAY.section9Sick),
          days: 1,
        },
      });
      registry.register("R.leaveRequest.section9Sick", sick.id);
      await measureSite(
        "#02 leave.ts PATCH /leave/requests/:id/review (section 9 detection)",
        { type: "SECTION9_AU_PENDING_MANAGER", actor: "R.manager" },
        async () => {
          const res = await inject({
            method: "PATCH",
            url: `/api/v1/leave/requests/${sick.id}/review`,
            authorization: bearer("R.manager", "MANAGER"),
            payload: { status: "APPROVED" },
          });
          expect(res.statusCode, res.body).toBe(200);
        },
      );
      const credit = await app.prisma.section9Credit.findFirstOrThrow({
        where: { sickRequestId: sick.id },
      });
      registry.register("R.section9Credit", credit.id);
    });

    it("#3 SHIFT_LEAVE_CONFLICT — approving leave over a planned shift (leave.ts review)", async () => {
      // Actor: the active MANAGER approves; the site does NOT skip the actor.
      const requester = person("R.requester");
      const shift = await app.prisma.shift.create({
        data: {
          employeeId: requester.employeeId,
          salonId: salonR,
          date: day(DAY.conflictLeave),
          startTime: "08:00",
          endTime: "16:00",
        },
      });
      registry.register("R.shift.conflict", shift.id);
      const leave = await app.prisma.leaveRequest.create({
        data: {
          employeeId: requester.employeeId,
          leaveTypeId: vacationTypeR,
          startDate: day(DAY.conflictLeave),
          endDate: day(DAY.conflictLeave),
          days: 1,
        },
      });
      registry.register("R.leaveRequest.conflict", leave.id);
      await measureSite(
        "#03 leave.ts PATCH /leave/requests/:id/review (shift conflict)",
        { type: "SHIFT_LEAVE_CONFLICT", actor: "R.manager" },
        async () => {
          const res = await inject({
            method: "PATCH",
            url: `/api/v1/leave/requests/${leave.id}/review`,
            authorization: bearer("R.manager", "MANAGER"),
            payload: { status: "APPROVED" },
          });
          expect(res.statusCode, res.body).toBe(200);
        },
      );
    });

    it("#4 SECTION9_AU_PENDING_MANAGER — POST /leave/section9/:id/reopen (leave.ts)", async () => {
      // Actor: the active MANAGER reopens; the site skips the actor. Precondition: the § 9 case
      // of #2, set to REJECTED directly (the rejection is not what this site is about).
      const creditId = registry.idOf("R.section9Credit");
      await app.prisma.section9Credit.update({
        where: { id: creditId },
        data: {
          status: "REJECTED",
          reason: "Keine AU vorgelegt",
          reviewedBy: person("R.admin").userId,
          reviewedAt: PINNED_NOW,
        },
      });
      await measureSite(
        "#04 leave.ts POST /leave/section9/:id/reopen",
        { type: "SECTION9_AU_PENDING_MANAGER", actor: "R.manager" },
        async () => {
          const res = await inject({
            method: "POST",
            url: `/api/v1/leave/section9/${creditId}/reopen`,
            authorization: bearer("R.manager", "MANAGER"),
          });
          expect(res.statusCode, res.body).toBe(200);
        },
      );
    });

    it("#5 SHIFT_BS_CLEANUP — runVocationalSchoolGeneration over a planned shift (vocational-school-generator.ts)", async () => {
      // Actor: none (generator). A Tuesday school pattern for the requester and a future shift on
      // the next Tuesday; the generator creates the school day and soft-deletes the shift.
      const requester = person("R.requester");
      const pattern = await app.prisma.employeeVocationalSchoolPattern.create({
        data: {
          employeeId: requester.employeeId,
          dayOfWeek: 1,
          daysOfWeek: [1],
          blockWeeks: [],
          validFrom: day("2026-06-01"),
          isActive: true,
        },
      });
      registry.register("R.vocationalSchoolPattern", pattern.id);
      const shift = await app.prisma.shift.create({
        data: {
          employeeId: requester.employeeId,
          salonId: salonR,
          date: day(DAY.bsShift),
          startTime: "08:00",
          endTime: "16:00",
        },
      });
      registry.register("R.shift.bsDay", shift.id);
      await measureSite(
        "#05 vocational-school-generator.ts runVocationalSchoolGeneration",
        { type: "SHIFT_BS_CLEANUP", actor: "<generator>" },
        async () => {
          const result = await runVocationalSchoolGeneration(app.prisma, app.audit, {
            tenantId: tenantR,
            weeksAhead: 4,
          });
          expect(result.created).toBeGreaterThan(0);
          const after = await app.prisma.shift.findUniqueOrThrow({ where: { id: shift.id } });
          expect(after.deletedAt).not.toBeNull();
        },
      );
    });

    it("#6 CARRYOVER_EXPIRING (admin CC) — runCarryoverWarningOnce (carryover-warning.ts)", async () => {
      // Actor: none (cron). The colleague's carry-over expires in exactly 30 days (a default
      // threshold); the colleague's own warning is the subject row, the CC goes to admins only.
      const entitlement = await app.prisma.leaveEntitlement.create({
        data: {
          employeeId: person("R.colleague").employeeId,
          leaveTypeId: vacationTypeR,
          year: 2026,
          totalDays: 30,
          usedDays: 0,
          carriedOverDays: 3,
          carryOverDeadline: new Date(DAY.carryOverDeadline),
        },
      });
      registry.register("R.colleague.entitlement", entitlement.id);
      await measureSite(
        "#06 carryover-warning.ts runCarryoverWarningOnce",
        { type: "CARRYOVER_EXPIRING", actor: "<cron>", subjects: ["R.colleague"] },
        async () => {
          const result = await runCarryoverWarningOnce(app);
          expect(result.warned).toBeGreaterThan(0);
        },
      );
    });

    it("#7 MONTH_CLOSE_BLOCKED — app.tryAutoCloseMonth (auto-close-month.ts)", async () => {
      // Actor: none (cron). Tenant R forbids closing a gap month (closeMonthWithGapsAllowed:
      // false), and nobody has entries in the first month after hiring, so every R person's
      // month is deferred and the managers are told once.
      await measureSite(
        "#07 auto-close-month.ts tryAutoCloseMonth",
        { type: "MONTH_CLOSE_BLOCKED", actor: "<cron>" },
        async () => {
          await app.tryAutoCloseMonth();
        },
      );
    });

    it("#8 MONTH_CLOSE_DEFERRED — app.remindDeferredMonthClose (deferred-month-close-reminder.ts)", async () => {
      // Actor: none (cron). The months #7 deferred are past their window, so the escalation fires.
      await measureSite(
        "#08 deferred-month-close-reminder.ts remindDeferredMonthClose",
        { type: "MONTH_CLOSE_DEFERRED", actor: "<cron>" },
        async () => {
          await app.remindDeferredMonthClose();
        },
      );
    });

    it("#9 MISSING_ENTRIES (manager copy) — app.tryMissingEntriesCheck (attendance-checker.ts)", async () => {
      // Actor: none (cron). The colleague is the only active, non-exited R person without a
      // recent entry; the colleague's own reminder is the subject row. The managers come from the
      // scan's own employee list (active, exitDate null) filtered by role in memory.
      await measureSite(
        "#09 attendance-checker.ts checkMissingEntries",
        { type: "MISSING_ENTRIES", actor: "<cron>", subjects: ["R.colleague"] },
        async () => {
          await app.tryMissingEntriesCheck();
        },
      );
    });

    it("#10 OPEN_ENTRY_INVALIDATED — app.tryAutoInvalidate (attendance-checker.ts)", async () => {
      // Actor: none (cron). The requester's open entry from yesterday 07:00 is older than 14h;
      // the requester's own row is the subject row, the owner is skipped among the managers.
      await measureSite(
        "#10 attendance-checker.ts autoInvalidateOpenEntries",
        { type: "OPEN_ENTRY_INVALIDATED", actor: "<cron>", subjects: ["R.requester"] },
        async () => {
          await app.tryAutoInvalidate();
          const entry = await app.prisma.timeEntry.findUniqueOrThrow({
            where: { id: registry.idOf("R.requester.openEntry") },
          });
          expect(entry.isInvalid).toBe(true);
        },
      );
    });

    it("#11 PENDING_LEAVE_REMINDER — app.tryPendingLeaveReminder (attendance-checker.ts)", async () => {
      // Actor: none (cron). One PENDING request older than the 48h threshold.
      const stale = await app.prisma.leaveRequest.create({
        data: {
          employeeId: person("R.requester").employeeId,
          leaveTypeId: vacationTypeR,
          startDate: day(DAY.staleLeaveStart),
          endDate: day(DAY.staleLeaveEnd),
          days: 2,
          createdAt: new Date(DAY.stalePendingCreatedAt),
        },
      });
      registry.register("R.leaveRequest.stale", stale.id);
      await measureSite(
        "#11 attendance-checker.ts checkPendingLeaveRequests",
        { type: "PENDING_LEAVE_REMINDER", actor: "<cron>" },
        async () => {
          await app.tryPendingLeaveReminder();
        },
      );
    });

    it("#12 GAP_WARNING_MANAGER — app.tryBeginningOfMonthGapReminder (attendance-checker.ts)", async () => {
      // Actor: none (cron). Month-edge logic: the scan acts only on days 1-3 of a month, so the
      // clock moves to 2 July for this trigger only; June has gap days for the R persons.
      await measureSite(
        "#12 attendance-checker.ts checkBeginningOfMonthGaps",
        { type: "GAP_WARNING_MANAGER", actor: "<cron>" },
        async () => {
          vi.setSystemTime(new Date(DAY.beginningOfMonth));
          try {
            await app.tryBeginningOfMonthGapReminder();
          } finally {
            vi.setSystemTime(PINNED_NOW);
          }
        },
      );
    });

    it("#13 RETRO_ENTRY_REQUESTED — POST /time-entries beyond the retro window (time-entries.ts)", async () => {
      // Actor: the requester submits a Nachtrag with a reason; the site skips the target.
      await measureSite(
        "#13 time-entries.ts POST /time-entries (pending Nachtrag)",
        { type: "RETRO_ENTRY_REQUESTED", actor: "R.requester" },
        async () => {
          const res = await inject({
            method: "POST",
            url: "/api/v1/time-entries",
            authorization: bearer("R.requester", "EMPLOYEE"),
            payload: {
              date: DAY.retroTarget,
              startTime: `${DAY.retroTarget}T07:00:00.000Z`,
              endTime: `${DAY.retroTarget}T15:00:00.000Z`,
              breakMinutes: 30,
              reason: "Eintrag vergessen",
            },
          });
          expect(res.statusCode, res.body).toBe(201);
          const entry = (JSON.parse(res.body) as { entry: { id: string; retroRequestId: string } })
            .entry;
          registry.register("R.requester.retroEntry", entry.id);
          registry.register("R.requester.retroRequest", entry.retroRequestId);
        },
      );
    });

    it("#14 RETRO_ENTRY_UPDATED — PUT own pending Nachtrag (time-entries.ts)", async () => {
      // Actor: the requester edits the pending entry of #13; the site skips the actor.
      await measureSite(
        "#14 time-entries.ts PUT /time-entries/:id (own pending Nachtrag)",
        { type: "RETRO_ENTRY_UPDATED", actor: "R.requester" },
        async () => {
          const res = await inject({
            method: "PUT",
            url: `/api/v1/time-entries/${registry.idOf("R.requester.retroEntry")}`,
            authorization: bearer("R.requester", "EMPLOYEE"),
            payload: {
              startTime: `${DAY.retroTarget}T08:00:00.000Z`,
              endTime: `${DAY.retroTarget}T16:00:00.000Z`,
              breakMinutes: 30,
            },
          });
          expect(res.statusCode, res.body).toBe(200);
        },
      );
    });

    it("#15 BREAK_COMPLIANCE_ALERT — PATCH /time-entries/:id/break-status waive (time-entries.ts)", async () => {
      // Actor: the requester declares "durchgearbeitet" on the AUTO entry; the site skips the owner.
      await measureSite(
        "#15 time-entries.ts PATCH /time-entries/:id/break-status (waive)",
        { type: "BREAK_COMPLIANCE_ALERT", actor: "R.requester" },
        async () => {
          const res = await inject({
            method: "PATCH",
            url: `/api/v1/time-entries/${registry.idOf("R.requester.autoBreakEntry")}/break-status`,
            authorization: bearer("R.requester", "EMPLOYEE"),
            payload: { action: "waive", reason: "Durchgearbeitet" },
          });
          expect(res.statusCode, res.body).toBe(200);
        },
      );
    });

    it("#16 RETRO_ENTRY_WITHDRAWN — DELETE /retro-entry-requests/:id (retro-entry-requests.ts)", async () => {
      // Actor: the requester withdraws the pending request of #13; the site skips the actor.
      await measureSite(
        "#16 retro-entry-requests.ts DELETE /retro-entry-requests/:id",
        { type: "RETRO_ENTRY_WITHDRAWN", actor: "R.requester" },
        async () => {
          const res = await inject({
            method: "DELETE",
            url: `/api/v1/retro-entry-requests/${registry.idOf("R.requester.retroRequest")}`,
            authorization: bearer("R.requester", "EMPLOYEE"),
          });
          expect(res.statusCode, res.body).toBe(200);
        },
      );
    });

    it("#17 ACCOUNT_LOCKED — failed logins up to the tenant's max attempts (auth.ts, D-17)", async () => {
      // Actor: an anonymous caller with the requester's e-mail and a wrong password, five times
      // (TenantConfig.loginMaxAttempts default). The site notifies ADMINs only.
      const { email } = await app.prisma.user.findUniqueOrThrow({
        where: { id: person("R.requester").userId },
        select: { email: true },
      });
      await measureSite(
        "#17 auth.ts POST /auth/login (ACCOUNT_LOCKED)",
        { type: "ACCOUNT_LOCKED", actor: "<anonymous>" },
        async () => {
          for (let attempt = 1; attempt <= 5; attempt++) {
            const res = await inject({
              method: "POST",
              url: "/api/v1/auth/login",
              payload: { email, password: `${FIXTURE_PASSWORD}-wrong` },
            });
            expect(res.statusCode, res.body).toBe(401);
          }
          const locked = await app.prisma.user.findUniqueOrThrow({
            where: { id: person("R.requester").userId },
            select: { lockedUntil: true },
          });
          expect(locked.lockedUntil).not.toBeNull();
        },
      );
    });
  });

  describe("completeness", () => {
    it("recorded all 17 recipient sites", () => {
      expect([...collected.keys()].sort()).toHaveLength(17);
      if (MODE === "verify") {
        expect(Object.keys(recording ?? {}).sort()).toEqual([...collected.keys()].sort());
      }
    });
  });
});
