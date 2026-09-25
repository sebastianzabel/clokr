/**
 * Phase 75b (Issue #75, D-20, D-21, D-25) — the fixture of the permission neutrality matrix.
 *
 * Every actor gets its OWN tenant (`buildActorTenant`): one actor's successful mutation can never
 * mask another actor's cell, and tenant-wide writes (close-month, settings, holidays) stay inside
 * the actor that made them. Each tenant holds
 *   - the actor itself (a legacy-role user with an Employee, or a `clk_` API key),
 *   - an "own" person (for user actors: the actor's own Employee; for API-key actors a plain
 *     employee that is NOT linked to the key — a key has no employee),
 *   - a "foreign" person of the same tenant,
 *   - an anchor admin (legacy ADMIN with an Employee) that no cell ever targets, so the 74b
 *     lockout guard never trips when an actor deactivates or anonymizes someone (Pitfall 4),
 *   - a "holder" person that holds the tenant's customer-role assignment (never the actor),
 *   - an anonymized employee (for `GET /employees?includeAnonymized=true`),
 *   - per own and foreign person one entity of every person-bound kind, and per tenant one entity
 *     of every tenant-level kind (`TENANT_LEVEL_KINDS`).
 *
 * The fallback actors (D-21) use the same builder; the matrix test simply builds their tenants
 * AFTER the migration SQL ran, so their users hold no stored role assignment.
 *
 * Every id the builder creates — including the rows `seedTestData` creates — is registered in a
 * label registry under an actor-relative label (`own.employee`, `foreign.leaveRequest.pending`,
 * `tenant.leaveType.VACATION`, …). The cell runner replaces every uuid in a response with its
 * label, so a recording is comparable across runs although every run creates new ids. Creation is
 * deterministic: fixed order, fixed dates relative to the pinned "now" (2026-06-17), one time
 * entry per person and day, leave away from month edges, no randomness in anything a response
 * exposes (only key hashes and the seed's email suffix are random, and neither is recorded).
 *
 * No person names: fixture people carry role-descriptive names only.
 */
import { randomBytes, createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Role } from "@clokr/db";
import { configureDatevKanzlei, seedTestData } from "../setup";
import { leaveTypeFields } from "../../contexts/absence/leave-type";
import { DEFAULT_SALON_OPENING_HOURS } from "../../contexts/platform";
import type { JwtPayload } from "../../middleware/auth";
import { ACTIVITY_FEED_LIMIT, API_KEY_ACTORS, type ActorKind } from "./matrix-config";

/** A bijective id ↔ label map for one actor's tenant. */
export class LabelRegistry {
  private readonly labelById = new Map<string, string>();
  private readonly idByLabel = new Map<string, string>();

  register(label: string, id: string): void {
    const existingLabel = this.labelById.get(id);
    if (existingLabel !== undefined) {
      throw new Error(`fixture: id of "${label}" is already registered as "${existingLabel}"`);
    }
    if (this.idByLabel.has(label)) {
      throw new Error(`fixture: label "${label}" is registered twice`);
    }
    this.labelById.set(id, label);
    this.idByLabel.set(label, id);
  }

  labelOf(id: string): string | undefined {
    return this.labelById.get(id);
  }

  idOf(label: string): string {
    const id = this.idByLabel.get(label);
    if (id === undefined) {
      throw new Error(`fixture: no entity is registered under the label "${label}"`);
    }
    return id;
  }

  has(label: string): boolean {
    return this.idByLabel.has(label);
  }

  get size(): number {
    return this.idByLabel.size;
  }
}

export interface ActorFixture {
  actor: ActorKind;
  tenantId: string;
  /** The `authorization` header value the actor's requests carry. */
  authorization: string;
  /** The user id of a user actor; undefined for an API-key actor. */
  actorUserId?: string;
  registry: LabelRegistry;
}

/** The legacy role of the actor's own person. API-key tenants get a plain employee. */
function ownPersonRole(actor: ActorKind): Role {
  if (actor === "MANAGER" || actor === "FALLBACK_MANAGER") return "MANAGER";
  if (actor === "ADMIN" || actor === "FALLBACK_ADMIN") return "ADMIN";
  return "EMPLOYEE";
}

/** A valid-shaped password hash no cell logs in with. */
const UNUSED_PASSWORD_HASH = "$2a$10$abcdefghijklmnopqrstuuMatrixFixtureHashNotUsedForLogin00";

/** Calendar days of the fixture, relative to the pinned "now" 2026-06-17 (a Wednesday). */
const DAY = {
  closedEntry: "2026-06-15", // Monday
  invalidEntry: "2026-06-16", // Tuesday
  openEntry: "2026-06-17", // today
  shift: "2026-06-18", // Thursday
  retroTarget: "2026-06-10", // Wednesday, last week
  approvedLeaveStart: "2026-06-22",
  approvedLeaveEnd: "2026-06-23",
  pendingLeaveStart: "2026-07-06",
  pendingLeaveEnd: "2026-07-08",
  section9VacationStart: "2026-05-11",
  section9VacationEnd: "2026-05-15",
  section9Sick: "2026-05-13",
  vocationalSchool: "2026-06-25", // Thursday
  patternsFrom: "2026-06-01",
  holiday: "2026-08-10",
  shutdownStart: "2026-12-28",
  shutdownEnd: "2026-12-30",
} as const;

function day(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

function at(iso: string, time: string): Date {
  return new Date(`${iso}T${time}:00.000Z`);
}

function randomKey(): { raw: string; keyHash: string; keyPrefix: string } {
  const raw = `clk_${randomBytes(24).toString("hex")}`;
  return {
    raw,
    keyHash: createHash("sha256").update(raw).digest("hex"),
    keyPrefix: raw.slice(0, 8),
  };
}

interface PersonRows {
  userId: string;
  employeeId: string;
}

interface TenantContext {
  app: FastifyInstance;
  registry: LabelRegistry;
  tenantId: string;
  tenantSlug: string;
  anchorUserId: string;
}

/** Creates a user + employee with a work schedule and an overtime account, and registers all four
 * ids under `<prefix>.user`, `<prefix>.employee`, `<prefix>.workSchedule`, `<prefix>.overtimeAccount`. */
async function createPerson(
  t: TenantContext,
  opts: { prefix: string; role: Role; lastName: string; anonymized?: boolean },
): Promise<PersonRows> {
  const prisma = t.app.prisma;
  const user = await prisma.user.create({
    data: {
      email: opts.anonymized
        ? `geloescht-${opts.prefix}-${t.tenantSlug}@anonymized.invalid`
        : `${opts.prefix}-${t.tenantSlug}@matrix.test`,
      passwordHash: opts.anonymized ? "ANONYMIZED" : UNUSED_PASSWORD_HASH,
      role: opts.role,
      isActive: !opts.anonymized,
    },
  });
  const employee = await prisma.employee.create({
    data: {
      tenantId: t.tenantId,
      userId: user.id,
      employeeNumber: opts.anonymized
        ? `GELÖSCHT-${t.tenantSlug}`
        : `${opts.prefix.toUpperCase()}-${t.tenantSlug}`,
      firstName: opts.anonymized ? "Gelöscht" : "Matrix",
      lastName: opts.anonymized ? `GELÖSCHT-${t.tenantSlug}` : opts.lastName,
      hireDate: new Date("2024-01-01"),
    },
  });
  const schedule = await prisma.workSchedule.create({
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
  const account = await prisma.overtimeAccount.create({
    data: { employeeId: employee.id, balanceHours: 0 },
  });
  t.registry.register(`${opts.prefix}.user`, user.id);
  t.registry.register(`${opts.prefix}.employee`, employee.id);
  t.registry.register(`${opts.prefix}.workSchedule`, schedule.id);
  t.registry.register(`${opts.prefix}.overtimeAccount`, account.id);
  return { userId: user.id, employeeId: employee.id };
}

/** Registers the rows `seedTestData` created for one of its two persons. */
async function registerSeedPerson(
  t: TenantContext,
  prefix: string,
  person: PersonRows,
): Promise<void> {
  t.registry.register(`${prefix}.user`, person.userId);
  t.registry.register(`${prefix}.employee`, person.employeeId);
  const schedule = await t.app.prisma.workSchedule.findFirstOrThrow({
    where: { employeeId: person.employeeId },
  });
  t.registry.register(`${prefix}.workSchedule`, schedule.id);
  const account = await t.app.prisma.overtimeAccount.findUniqueOrThrow({
    where: { employeeId: person.employeeId },
  });
  t.registry.register(`${prefix}.overtimeAccount`, account.id);
}

/** Creates an API key with a known raw value; returns the raw `clk_` key. */
async function createApiKey(
  t: TenantContext,
  opts: { label: string; name: string; scopes: string[] },
): Promise<string> {
  const key = randomKey();
  const row = await t.app.prisma.apiKey.create({
    data: {
      tenantId: t.tenantId,
      name: opts.name,
      keyHash: key.keyHash,
      keyPrefix: key.keyPrefix,
      scopes: opts.scopes,
      createdBy: t.anchorUserId,
    },
  });
  t.registry.register(opts.label, row.id);
  return key.raw;
}

interface TenantLevelIds {
  vacationTypeId: string;
  sickTypeId: string;
  shiftTemplateId: string;
  defaultSalonId: string;
  secondSalonId: string;
}

/** Every tenant-level kind (`tenant.<kind>`). */
async function createTenantEntities(
  t: TenantContext,
  seed: { vacationTypeId: string; defaultSalonId: string; foreignEmployeeId: string },
): Promise<TenantLevelIds> {
  const prisma = t.app.prisma;
  const { registry, tenantId } = t;

  const sickType = await prisma.leaveType.create({
    data: { tenantId, ...leaveTypeFields("SICK"), color: "#EF4444" },
  });
  registry.register("tenant.leaveType.SICK", sickType.id);

  const rule = await prisma.specialLeaveRule.create({
    data: { tenantId, name: "Matrix Sonderurlaub", reason: "Matrix", defaultDays: 1 },
  });
  registry.register("tenant.specialLeaveRule", rule.id);

  const holiday = await prisma.publicHoliday.create({
    data: {
      tenantId,
      date: day(DAY.holiday),
      name: "Matrix Feiertag",
      federalState: "NIEDERSACHSEN",
      year: 2026,
    },
  });
  registry.register("tenant.holiday", holiday.id);

  const shutdown = await prisma.companyShutdown.create({
    data: {
      tenantId,
      name: "Matrix Betriebsurlaub",
      startDate: day(DAY.shutdownStart),
      endDate: day(DAY.shutdownEnd),
    },
  });
  registry.register("tenant.companyShutdown", shutdown.id);
  const exception = await prisma.companyShutdownException.create({
    data: { shutdownId: shutdown.id, employeeId: seed.foreignEmployeeId, reason: "Matrix" },
  });
  registry.register("tenant.companyShutdown.exception", exception.id);

  const template = await prisma.shiftTemplate.create({
    data: { tenantId, name: "Matrix Frühschicht", startTime: "06:00", endTime: "14:00" },
  });
  registry.register("tenant.shiftTemplate", template.id);
  const coverage = await prisma.coverageRule.create({
    data: { tenantId, templateId: template.id, dayOfWeek: 0, minStaff: 1 },
  });
  registry.register("tenant.coverageRule", coverage.id);

  const terminal = randomKey();
  const terminalRow = await prisma.terminalApiKey.create({
    data: {
      tenantId,
      name: "Matrix Terminal",
      keyHash: terminal.keyHash,
      keyPrefix: terminal.keyPrefix,
    },
  });
  registry.register("tenant.terminal", terminalRow.id);

  const source = randomKey();
  const sourceRow = await prisma.presenceSource.create({
    data: {
      tenantId,
      name: "Matrix Router",
      keyHash: source.keyHash,
      keyPrefix: source.keyPrefix,
    },
  });
  registry.register("tenant.presenceSource", sourceRow.id);

  const phorestStaffId = `matrix-staff-${t.tenantSlug}`;
  const mapping = await prisma.phorestStaffMapping.create({
    data: { tenantId, phorestStaffId, employeeId: seed.foreignEmployeeId },
  });
  registry.register("tenant.phorestMapping.row", mapping.id);
  registry.register("tenant.phorestMapping", phorestStaffId);

  const secondSalon = await prisma.salon.create({
    data: {
      tenantId,
      name: "Matrix Salon Zwei",
      openingHours: DEFAULT_SALON_OPENING_HOURS,
      isActive: true,
    },
  });
  registry.register("tenant.salon", secondSalon.id);
  const inactiveSalon = await prisma.salon.create({
    data: {
      tenantId,
      name: "Matrix Salon inaktiv",
      openingHours: DEFAULT_SALON_OPENING_HOURS,
      isActive: false,
      deactivatedAt: new Date("2026-06-01T10:00:00.000Z"),
    },
  });
  registry.register("tenant.salonInactive", inactiveSalon.id);

  const auditRow = await prisma.auditLog.create({
    data: {
      userId: t.anchorUserId,
      action: "UPDATE",
      entity: "TenantConfig",
      entityId: tenantId,
      newValue: { matrix: true },
    },
  });
  registry.register("tenant.auditLog", auditRow.id);

  return {
    vacationTypeId: seed.vacationTypeId,
    sickTypeId: sickType.id,
    shiftTemplateId: template.id,
    defaultSalonId: seed.defaultSalonId,
    secondSalonId: secondSalon.id,
  };
}

/** The first feed-pin instant: far after any real clock a run can see, so the pins are the newest
 * audit rows of the database whatever other files or earlier runs left behind. */
const FEED_PIN_BASE_MS = Date.UTC(2100, 0, 1, 0, 0, 0);

/**
 * `ACTIVITY_FEED_LIMIT` audit rows of the tenant's anchor admin, dated in the far future with an
 * explicit `createdAt` (1 s apart, no ties). The ADMIN activity feed takes the newest
 * `ACTIVITY_FEED_LIMIT` rows of "own tenant OR userId null (global)"; with these pins it returns
 * exactly them, never a leftover row of another file (see `ACTIVITY_FEED_LIMIT`). They are
 * deleted again by `cleanupMatrixExtras`, so they cannot pin a later file's feed.
 */
async function createActivityFeedPins(t: TenantContext): Promise<void> {
  for (let i = 0; i < ACTIVITY_FEED_LIMIT; i++) {
    const row = await t.app.prisma.auditLog.create({
      data: {
        userId: t.anchorUserId,
        action: "UPDATE",
        entity: "MatrixFeedPin",
        entityId: t.tenantId,
        newValue: { pin: i },
        createdAt: new Date(FEED_PIN_BASE_MS + i * 1000),
      },
    });
    t.registry.register(`tenant.auditLog.feedPin.${String(i).padStart(2, "0")}`, row.id);
  }
}

/** What differs between the own and the foreign person's entities. `macSuffix` keeps the
 * per-tenant unique device MAC distinct; the shift times differ so that routes whose rows carry
 * no id (`GET /shifts/range`) still show WHOSE shifts they returned. */
interface PersonVariation {
  macSuffix: string;
  shiftStart: string;
  shiftEnd: string;
}

/** Every person-bound kind for one person (`<prefix>.<kind>`). */
async function createPersonEntities(
  t: TenantContext,
  prefix: string,
  person: PersonRows,
  ids: TenantLevelIds,
  variation: PersonVariation,
): Promise<void> {
  const { macSuffix } = variation;
  const prisma = t.app.prisma;
  const { registry, tenantId } = t;
  const employeeId = person.employeeId;
  const reg = (kind: string, id: string) => registry.register(`${prefix}.${kind}`, id);

  // Avatar: the path is served through the stubbed storage, so GET /avatars/:employeeId reads it.
  await prisma.employee.update({
    where: { id: employeeId },
    data: { avatarPath: `avatars/${tenantId}/${employeeId}.webp` },
  });

  const closed = await prisma.timeEntry.create({
    data: {
      employeeId,
      date: day(DAY.closedEntry),
      startTime: at(DAY.closedEntry, "06:00"),
      endTime: at(DAY.closedEntry, "14:30"),
      breakMinutes: 30,
      createdBy: t.anchorUserId,
    },
  });
  reg("timeEntry.closed", closed.id);
  const brk = await prisma.break.create({
    data: {
      timeEntryId: closed.id,
      startTime: at(DAY.closedEntry, "10:00"),
      endTime: at(DAY.closedEntry, "10:30"),
    },
  });
  reg("timeEntry.closed.break", brk.id);
  const invalid = await prisma.timeEntry.create({
    data: {
      employeeId,
      date: day(DAY.invalidEntry),
      startTime: at(DAY.invalidEntry, "06:00"),
      isInvalid: true,
      invalidReasonCode: "MISSING_CLOCK_OUT",
      invalidReason: "Ausstempeln fehlt",
      createdBy: t.anchorUserId,
    },
  });
  reg("timeEntry.invalid", invalid.id);
  const open = await prisma.timeEntry.create({
    data: {
      employeeId,
      date: day(DAY.openEntry),
      startTime: at(DAY.openEntry, "06:00"),
      createdBy: t.anchorUserId,
    },
  });
  reg("timeEntry.open", open.id);

  const entitlementYear = 2026;
  const existingEntitlement = await prisma.leaveEntitlement.findUnique({
    where: {
      employeeId_leaveTypeId_year: {
        employeeId,
        leaveTypeId: ids.vacationTypeId,
        year: entitlementYear,
      },
    },
  });
  const entitlement =
    existingEntitlement ??
    (await prisma.leaveEntitlement.create({
      data: {
        employeeId,
        leaveTypeId: ids.vacationTypeId,
        year: entitlementYear,
        totalDays: 30,
        usedDays: 0,
      },
    }));
  reg("entitlement.VACATION", entitlement.id);

  const pending = await prisma.leaveRequest.create({
    data: {
      employeeId,
      leaveTypeId: ids.vacationTypeId,
      status: "PENDING",
      days: 3,
      startDate: day(DAY.pendingLeaveStart),
      endDate: day(DAY.pendingLeaveEnd),
    },
  });
  reg("leaveRequest.pending", pending.id);
  const approved = await prisma.leaveRequest.create({
    data: {
      employeeId,
      leaveTypeId: ids.vacationTypeId,
      status: "APPROVED",
      days: 2,
      startDate: day(DAY.approvedLeaveStart),
      endDate: day(DAY.approvedLeaveEnd),
      reviewedBy: t.anchorUserId,
      reviewedAt: new Date("2026-06-01T09:00:00.000Z"),
    },
  });
  reg("leaveRequest.approved", approved.id);
  const s9Vacation = await prisma.leaveRequest.create({
    data: {
      employeeId,
      leaveTypeId: ids.vacationTypeId,
      status: "APPROVED",
      days: 5,
      startDate: day(DAY.section9VacationStart),
      endDate: day(DAY.section9VacationEnd),
      reviewedBy: t.anchorUserId,
      reviewedAt: new Date("2026-04-20T09:00:00.000Z"),
    },
  });
  reg("leaveRequest.section9Vacation", s9Vacation.id);
  const sick = await prisma.leaveRequest.create({
    data: {
      employeeId,
      leaveTypeId: ids.sickTypeId,
      status: "APPROVED",
      days: 1,
      startDate: day(DAY.section9Sick),
      endDate: day(DAY.section9Sick),
      reviewedBy: t.anchorUserId,
      reviewedAt: new Date("2026-05-13T09:00:00.000Z"),
    },
  });
  reg("leaveRequest.sick", sick.id);
  const credit = await prisma.section9Credit.create({
    data: {
      employeeId,
      sickRequestId: sick.id,
      vacationRequestId: s9Vacation.id,
      overlapStart: day(DAY.section9Sick),
      overlapEnd: day(DAY.section9Sick),
      status: "AU_PENDING",
      documentPath: `section9/${tenantId}/${employeeId}.pdf`,
    },
  });
  reg("section9.credit", credit.id);

  const retro = await prisma.retroEntryRequest.create({
    data: {
      employeeId,
      targetDate: day(DAY.retroTarget),
      reason: "Matrix Nachtrag",
      startTime: "08:00",
      endTime: "16:00",
      breakMinutes: 30,
    },
  });
  reg("retroRequest.pending", retro.id);

  const absence = await prisma.absence.create({
    data: {
      employeeId,
      type: "VOCATIONAL_SCHOOL",
      startDate: day(DAY.vocationalSchool),
      endDate: day(DAY.vocationalSchool),
      days: 1,
      createdBy: t.anchorUserId,
    },
  });
  reg("vocationalSchool.absence", absence.id);
  const bsPattern = await prisma.employeeVocationalSchoolPattern.create({
    data: {
      employeeId,
      daysOfWeek: [3],
      blockWeeks: [],
      validFrom: day(DAY.patternsFrom),
    },
  });
  reg("vocationalSchool.pattern", bsPattern.id);

  const shift = await prisma.shift.create({
    data: {
      employeeId,
      templateId: ids.shiftTemplateId,
      salonId: ids.defaultSalonId,
      date: day(DAY.shift),
      startTime: variation.shiftStart,
      endTime: variation.shiftEnd,
      createdBy: t.anchorUserId,
    },
  });
  reg("shift", shift.id);
  const shiftPattern = await prisma.employeeShiftPattern.create({
    data: {
      employeeId,
      dayOfWeek: 0,
      templateId: ids.shiftTemplateId,
      validFrom: day(DAY.patternsFrom),
    },
  });
  reg("shiftPattern", shiftPattern.id);
  const availability = await prisma.employeeAvailability.create({
    data: {
      employeeId,
      dayOfWeek: 4,
      status: "PREFERRED",
      validFrom: day(DAY.patternsFrom),
      createdBy: t.anchorUserId,
    },
  });
  reg("availability", availability.id);
  const appointment = await prisma.phorestAppointment.create({
    data: {
      employeeId,
      salonId: ids.defaultSalonId,
      date: day(DAY.shift),
      startTime: "09:00",
      endTime: "10:00",
    },
  });
  reg("phorestAppointment", appointment.id);

  const snapshot = await prisma.saldoSnapshot.create({
    data: {
      employeeId,
      periodType: "MONTHLY",
      periodStart: day("2026-04-01"),
      periodEnd: day("2026-04-30"),
      workedMinutes: 0,
      expectedMinutes: 0,
      balanceMinutes: 0,
      carryOver: 0,
      closedAt: new Date("2026-05-01T02:00:00.000Z"),
    },
  });
  reg("saldoSnapshot", snapshot.id);

  const notification = await prisma.notification.create({
    data: {
      userId: person.userId,
      type: "LEAVE_REQUEST",
      title: "Matrix",
      message: "Matrix Benachrichtigung",
      link: "/leave",
      createdAt: new Date("2026-06-16T09:00:00.000Z"),
    },
  });
  reg("notification", notification.id);

  const device = await prisma.presenceDevice.create({
    data: {
      tenantId,
      employeeId,
      mac: `02:00:00:00:00:${macSuffix}`,
      label: "Matrix Geraet",
      addedByUserId: person.userId,
    },
  });
  reg("wifiDevice", device.id);
  registry.register(`${prefix}.presenceDevice.mac`, device.mac);

  const assignment = await prisma.employeeSalonAssignment.create({
    data: {
      tenantId,
      employeeId,
      salonId: ids.secondSalonId,
      kind: "DEPLOYMENT",
      validFrom: day(DAY.patternsFrom),
      weekdays: [0],
    },
  });
  reg("salonAssignment", assignment.id);
}

/**
 * Builds one actor's tenant: `seedTestData` (its admin becomes the anchor admin, its employee the
 * foreign person), the own person with the actor's legacy role, the holder of the customer role,
 * an anonymized employee, the API keys, and every entity kind the route specs substitute.
 */
export async function buildActorTenant(
  app: FastifyInstance,
  actor: ActorKind,
): Promise<ActorFixture> {
  const registry = new LabelRegistry();
  const seed = await seedTestData(app, `75b-matrix-${actor.toLowerCase()}`);
  const tenantId = seed.tenant.id;
  const t: TenantContext = {
    app,
    registry,
    tenantId,
    tenantSlug: seed.tenant.slug,
    anchorUserId: seed.adminUser.id,
  };
  registry.register("tenant", tenantId);
  // A configured DATEV Kanzlei, so the DATEV export cells reach the export instead of the 409.
  await configureDatevKanzlei(app, tenantId);
  const config = await app.prisma.tenantConfig.findUniqueOrThrow({ where: { tenantId } });
  registry.register("tenant.config", config.id);
  registry.register("tenant.salon.default", seed.salonId);
  registry.register("tenant.leaveType.VACATION", seed.vacationType.id);

  await registerSeedPerson(t, "anchor.admin", {
    userId: seed.adminUser.id,
    employeeId: seed.adminEmployee.id,
  });
  const foreign = { userId: seed.empUser.id, employeeId: seed.employee.id };
  await registerSeedPerson(t, "foreign", foreign);
  // seedTestData logs both of its users in once through the API (a LOGIN audit row each).
  for (const [prefix, userId] of [
    ["anchor.admin", seed.adminUser.id],
    ["foreign", seed.empUser.id],
  ] as const) {
    const logins = await app.prisma.auditLog.findMany({
      where: { userId, action: "LOGIN" },
      select: { id: true },
    });
    if (logins.length !== 1) {
      throw new Error(
        `fixture: expected one seed LOGIN audit of ${prefix}, found ${logins.length}`,
      );
    }
    registry.register(`${prefix}.login.audit`, logins[0].id);
  }

  const ownRole = ownPersonRole(actor);
  const own = await createPerson(t, {
    prefix: "own",
    role: ownRole,
    lastName: API_KEY_ACTORS.has(actor) ? "Ohne Schluessel" : "Akteur",
  });
  const holder = await createPerson(t, { prefix: "holder", role: "EMPLOYEE", lastName: "Rolle" });
  await createPerson(t, {
    prefix: "anonymized",
    role: "EMPLOYEE",
    lastName: "",
    anonymized: true,
  });

  const ids = await createTenantEntities(t, {
    vacationTypeId: seed.vacationType.id,
    defaultSalonId: seed.salonId,
    foreignEmployeeId: foreign.employeeId,
  });
  await createPersonEntities(t, "own", own, ids, {
    macSuffix: "01",
    shiftStart: "08:00",
    shiftEnd: "16:00",
  });
  await createPersonEntities(t, "foreign", foreign, ids, {
    macSuffix: "02",
    shiftStart: "09:00",
    shiftEnd: "17:00",
  });
  await createActivityFeedPins(t);

  // Customer roles: one held by the holder (TENANT scope), one held by nobody.
  const assignedRole = await app.prisma.accessRole.create({
    data: {
      tenantId,
      name: "Matrix Kundenrolle",
      nameKey: "matrix kundenrolle",
      permissions: ["role:read:ZUGEWIESEN"],
    },
  });
  registry.register("tenant.customRole.assigned", assignedRole.id);
  const freeRole = await app.prisma.accessRole.create({
    data: {
      tenantId,
      name: "Matrix Freie Rolle",
      nameKey: "matrix freie rolle",
      permissions: ["role:read:ZUGEWIESEN"],
    },
  });
  registry.register("tenant.customRole.free", freeRole.id);
  const customerAssignment = await app.prisma.roleAssignment.create({
    data: {
      tenantId,
      userId: holder.userId,
      accessRoleId: assignedRole.id,
      scopeType: "TENANT",
      salonIds: [],
      employeeIds: [],
    },
  });
  registry.register("tenant.roleAssignment.customer", customerAssignment.id);

  // The DELETE target of `/api-keys/:id` — never the actor's own key (75b-RESEARCH Q6).
  await createApiKey(t, {
    label: "tenant.apiKey.secondary",
    name: "Matrix Zweitschluessel",
    scopes: [],
  });

  let authorization: string;
  let actorUserId: string | undefined;
  if (API_KEY_ACTORS.has(actor)) {
    const raw = await createApiKey(t, {
      label: "actor.apiKey",
      name: "Matrix Akteur-Schluessel",
      scopes: actor === "APIKEY_ADMIN" ? ["admin"] : [],
    });
    authorization = `Bearer ${raw}`;
  } else {
    const payload: JwtPayload = {
      sub: own.userId,
      role: ownRole,
      tenantId,
      employeeId: own.employeeId,
    };
    authorization = `Bearer ${app.jwt.sign(payload)}`;
    actorUserId = own.userId;
  }

  return { actor, tenantId, authorization, actorUserId, registry };
}

/**
 * Deletes the rows `cleanupTestData` does not know about, in dependency order, so its own deletes
 * (and the final `tenant.delete`) succeed. Never throws on a missing row.
 */
export async function cleanupMatrixExtras(app: FastifyInstance, tenantId: string): Promise<void> {
  const prisma = app.prisma;
  const employees = await prisma.employee.findMany({
    where: { tenantId },
    select: { id: true, userId: true },
  });
  const employeeIds = employees.map((e) => e.id);
  const userIds = employees.map((e) => e.userId);
  // Audit rows are deleted, not left to `onDelete: SetNull`: a row whose user is gone becomes a
  // global `userId: null` row that every later ADMIN activity feed of the worker database shows
  // (the feed pins above most of all). The migration's SYSTEM rows already carry `userId: null`
  // and are found through the assignment they describe.
  const assignmentIds = (
    await prisma.roleAssignment.findMany({ where: { tenantId }, select: { id: true } })
  ).map((a) => a.id);
  await prisma.auditLog.deleteMany({
    where: {
      OR: [
        { userId: { in: userIds } },
        { entity: "RoleAssignment", entityId: { in: assignmentIds } },
      ],
    },
  });
  await prisma.roleAssignment.deleteMany({ where: { tenantId } });
  await prisma.accessRole.deleteMany({ where: { tenantId } });
  await prisma.phorestAppointment.deleteMany({ where: { employeeId: { in: employeeIds } } });
  await prisma.phorestStaffMapping.deleteMany({ where: { tenantId } });
  await prisma.retroEntryRequest.deleteMany({ where: { employeeId: { in: employeeIds } } });
  await prisma.openingBalance.deleteMany({ where: { employeeId: { in: employeeIds } } });
  await prisma.presenceDevice.deleteMany({ where: { tenantId } });
}
