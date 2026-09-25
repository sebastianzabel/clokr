/**
 * Phase 75b (Issue #75, AC-75-13, AC-75-14, AC-75-5, C-4, D-13) — neutrality of the activity feed
 * and of the role the login, OTP and refresh responses carry.
 *
 * ── Activity feed (AC-75-13, D-13) ──────────────────────────────────────────────────────────────
 * `GET /api/v1/activity` answers from exactly one of two exclusive branches: the audit-log branch
 * for ADMIN (after the switch: the holder of `audit-log:read`, which wins) and the domain branch
 * for everyone else, with the team events of the MANAGER branch on top. The audit branch reads
 * three kinds of rows — actors of the caller's tenant, rows without an actor (`userId: null`:
 * cron runs, anonymized actors) and rows of a user without an Employee — and takes the newest
 * `limit`. The permission matrix pins its ADMIN cell to tenant rows only (feed pins), so the two
 * global kinds are proven HERE: tenant A gets 20 labelled audit rows whose `createdAt` is set
 * explicitly later than every other row of the worker database — 12 of tenant actors, 4 without an
 * actor, 4 of a user without an Employee — and 4 rows of a FOREIGN tenant's actor are interleaved
 * between them. `take: 20` therefore returns exactly the 20 labelled rows when the tenant filter
 * holds, and a foreign row would push one out. The feed is called with `limit=20` (the schema's
 * maximum) by the migrated ADMIN, MANAGER and EMPLOYEE and by their three fallback twins; each
 * feed is recorded as its fixture-labelled id multiset (composite ids such as `rev-<uuid>` keep
 * their prefix, via the matrix's cell runner). The ADMIN-class feeds must hold no `<new>` id and
 * no foreign row, and the ADMIN feed must differ from the MANAGER feed (the exclusivity is visible).
 *
 * ── Token role (AC-75-14, AC-75-5, C-4) ────────────────────────────────────────────────────────
 * The frontend decides its UI from the role it receives until #83. For every migrated user, every
 * fallback user and a user WITHOUT an Employee (role ADMIN, AC-75-5), the test logs in and records
 * the body's `user.role` and the access token's `role` claim (plus its tenant and employee claim,
 * as labels), then refreshes and records the new access token's `role` claim — the refresh body
 * carries no user object (C-4). One user of a tenant with two-factor login goes through the OTP
 * path: the code is captured from the stubbed mailer's `sendOtp` call and sent to
 * `POST /auth/verify-otp`. Pre-switch, every recorded role must equal the user's `User.role`
 * column — that column IS the source today — and the test asserts that in both modes.
 *
 * ── RECORD vs VERIFY ────────────────────────────────────────────────────────────────────────────
 *   NEUTRALITY_ACTIVITY_AUTH_MODE=record  write the records (default
 *                                         `neutrality/recorded/activity-auth.json`, or
 *                                         NEUTRALITY_ACTIVITY_AUTH_OUT) in `afterAll`;
 *   (default) VERIFY                      compare with the recording (default path, or
 *                                         NEUTRALITY_ACTIVITY_AUTH_IN).
 * RECORD refuses once the legacy role guard's definition is gone from `middleware/auth.ts` (same
 * guard as the matrix). Both modes build the fixture, run the checked-in migration SQL (D-25), then
 * create the fallback users. Every run starts with `pnpm --filter @clokr/api run test:setup`.
 * Mailer, storage and `fetch` are stubbed in both modes; every request carries its own
 * `remoteAddress`, so no rate limit (verify-otp: 5 per 10 minutes) can interfere.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import type { Role } from "@clokr/db";
import { getTestApp, cleanupTestData, createTestSalon, salonIdForEmployee } from "./setup";
import { executeLegacyRoleMigration } from "./legacy-role-migration-sql";
import { LabelRegistry, cleanupMatrixExtras, type ActorFixture } from "./neutrality/fixture";
import { installExternalStubs, type ExternalStubs } from "./neutrality/external-stubs";
import { runCell, type CellResult, type LabelContext } from "./neutrality/cell-runner";
import type { ActorKind, RouteSpec, VariantSpec } from "./neutrality/matrix-config";
import { leaveTypeFields } from "../contexts/absence/leave-type";
import type { JwtPayload } from "../middleware/auth";

const MODE = process.env.NEUTRALITY_ACTIVITY_AUTH_MODE === "record" ? "record" : "verify";
const DEFAULT_RECORDING = join(__dirname, "neutrality", "recorded", "activity-auth.json");
const RECORD_OUT = process.env.NEUTRALITY_ACTIVITY_AUTH_OUT || DEFAULT_RECORDING;
const VERIFY_IN = process.env.NEUTRALITY_ACTIVITY_AUTH_IN || DEFAULT_RECORDING;

/** The legacy role guard's definition line; RECORD requires it (same guard as the matrix). */
const ROLE_GUARD_DEFINITION = "export function requireRole";
const AUTH_MIDDLEWARE = join(__dirname, "..", "middleware", "auth.ts");

const FIXTURE_PASSWORD = "activity-auth-neutrality";

/** The activity schema's maximum `limit`. */
const FEED_LIMIT = 20;

/**
 * The labelled audit rows: far in the future, one second apart, so they are newer than every other
 * row of the worker database (other files leave audit rows behind at "now"). `F` = a foreign
 * tenant's actor, interleaved so a broken tenant filter would push a labelled row out.
 */
const AUDIT_BASE = Date.parse("2101-01-01T00:00:00.000Z");
const AUDIT_PLAN: readonly string[] = [
  "A.admin",
  "A.manager",
  "<null>",
  "F",
  "A.employee",
  "A.noEmployee",
  "A.fallback.admin",
  "A.admin",
  "<null>",
  "F",
  "A.fallback.manager",
  "A.noEmployee",
  "A.manager",
  "A.employee",
  "<null>",
  "F",
  "A.admin",
  "A.noEmployee",
  "A.fallback.admin",
  "A.manager",
  "<null>",
  "F",
  "A.fallback.manager",
  "A.noEmployee",
];

/** The activity feeds recorded: the label of the caller and the matrix actor kind it plays. */
const FEED_CALLERS: readonly { label: string; actor: ActorKind }[] = [
  { label: "A.employee", actor: "EMPLOYEE" },
  { label: "A.manager", actor: "MANAGER" },
  { label: "A.admin", actor: "ADMIN" },
  { label: "A.fallback.employee", actor: "FALLBACK_EMPLOYEE" },
  { label: "A.fallback.manager", actor: "FALLBACK_MANAGER" },
  { label: "A.fallback.admin", actor: "FALLBACK_ADMIN" },
];

/** The users whose login and refresh are recorded, with their `User.role` column. */
const LOGIN_USERS: readonly string[] = [
  "A.admin",
  "A.manager",
  "A.employee",
  "A.fallback.admin",
  "A.fallback.manager",
  "A.fallback.employee",
  "A.noEmployee",
];

const ACTIVITY_ROUTE = "GET /api/v1/activity";
const ACTIVITY_SPEC: RouteSpec = { phase: "read" };
const ACTIVITY_VARIANT: VariantSpec = {
  name: "limit20",
  target: "none",
  query: { limit: String(FEED_LIMIT) },
};

type Entry = CellResult | TokenRecord;

interface TokenRecord {
  status: number;
  bodyRole?: string;
  tokenRole?: string;
  tokenTenant?: string;
  tokenEmployee?: string;
}

function serializeRecording(entries: ReadonlyMap<string, Entry>): string {
  const keys = [...entries.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const lines = keys.map(
    (key) => `    ${JSON.stringify(key)}: ${JSON.stringify(entries.get(key))}`,
  );
  return `{\n  "entries": {\n${lines.join(",\n")}\n  }\n}\n`;
}

function day(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

/** `YYYY-MM-DD` of today minus `n` days (UTC) — the feed reads the last seven days. */
function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

describe("activity feed and token role neutrality (Issue #75, AC-75-13, AC-75-14)", () => {
  let app: FastifyInstance;
  let stubs: ExternalStubs | undefined;
  const registry = new LabelRegistry();
  const collected = new Map<string, Entry>();
  let recording: Record<string, Entry> | undefined;
  let setupComplete = false;

  let tenantA = "";
  let tenantF = "";
  let tenantO = "";
  let vacationTypeA = "";
  let passwordHash = "";
  let remoteCounter = 0;
  const userIdOf = new Map<string, string>();
  const employeeIdOf = new Map<string, string>();
  const columnRoleOf = new Map<string, Role>();
  const emailOf = new Map<string, string>();
  /** Access tokens from the login step, used for the activity calls. */
  const accessTokenOf = new Map<string, string>();
  const otpCodes: string[] = [];

  function nextRemoteAddress(): string {
    const n = remoteCounter++;
    return `10.176.${Math.floor(n / 250) % 250}.${(n % 250) + 1}`;
  }

  function userId(label: string): string {
    const id = userIdOf.get(label);
    if (!id) throw new Error(`activity-auth: no fixture user "${label}"`);
    return id;
  }

  function record(key: string, entry: Entry): void {
    collected.set(key, entry);
    if (MODE === "verify") {
      const expected = recording?.[key];
      expect(expected, `${key}: not recorded`).toBeDefined();
      expect(entry, key).toEqual(expected);
    }
  }

  async function createTenant(prefix: string, twoFaEnabled = false): Promise<string> {
    const slug = `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const tenant = await app.prisma.tenant.create({
      data: { name: `Aktivitaet ${prefix}`, slug, federalState: "NIEDERSACHSEN" },
    });
    await app.prisma.tenantConfig.create({
      data: { tenantId: tenant.id, timezone: "Europe/Berlin", twoFaEnabled },
    });
    // Phase 68b (#68, merged from origin/main 704b1ee5): TimeEntry.salonId is required, so every
    // fixture tenant needs a salon for createEntry below.
    await createTestSalon(app.prisma, tenant.id);
    return tenant.id;
  }

  async function createUser(
    tenantId: string | null,
    label: string,
    role: Role,
  ): Promise<{ userId: string; employeeId?: string }> {
    const slug = label.replace(/\./g, "-").toLowerCase();
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const email = `${slug}-${suffix}@activity-auth.test`;
    const user = await app.prisma.user.create({
      data: { email, passwordHash, role, isActive: true },
    });
    registry.register(`${label}.user`, user.id);
    userIdOf.set(label, user.id);
    columnRoleOf.set(label, role);
    emailOf.set(label, email);
    if (tenantId === null) return { userId: user.id };
    const employee = await app.prisma.employee.create({
      data: {
        tenantId,
        userId: user.id,
        employeeNumber: `${slug}-${suffix}`.toUpperCase(),
        firstName: "Aktivitaet",
        lastName: label,
        hireDate: new Date("2024-01-01"),
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
    registry.register(`${label}.employee`, employee.id);
    employeeIdOf.set(label, employee.id);
    return { userId: user.id, employeeId: employee.id };
  }

  /** A closed time entry yesterday — the feed shows own entries created in the last seven days. */
  async function createEntry(label: string): Promise<void> {
    const iso = daysAgo(1);
    const entry = await app.prisma.timeEntry.create({
      data: {
        employeeId: employeeIdOf.get(label) as string,
        date: day(iso),
        startTime: new Date(`${iso}T07:00:00.000Z`),
        endTime: new Date(`${iso}T15:00:00.000Z`),
        breakMinutes: 30,
        source: "MANUAL",
        salonId: await salonIdForEmployee(app.prisma, employeeIdOf.get(label) as string), // Phase 68b (#68)
      },
    });
    registry.register(`${label}.timeEntry`, entry.id);
  }

  async function createLeave(
    label: string,
    name: string,
    opts: { start: string; end: string; approvedBy?: string },
  ): Promise<void> {
    const leave = await app.prisma.leaveRequest.create({
      data: {
        employeeId: employeeIdOf.get(label) as string,
        leaveTypeId: vacationTypeA,
        startDate: day(opts.start),
        endDate: day(opts.end),
        days: 1,
        status: opts.approvedBy ? "APPROVED" : "PENDING",
        reviewedBy: opts.approvedBy ? userId(opts.approvedBy) : null,
        reviewedAt: opts.approvedBy ? new Date() : null,
      },
    });
    registry.register(`${label}.leave.${name}`, leave.id);
  }

  async function createMonthClose(label: string): Promise<void> {
    const snapshot = await app.prisma.saldoSnapshot.create({
      data: {
        employeeId: employeeIdOf.get(label) as string,
        periodType: "MONTHLY",
        periodStart: day("2026-05-01"),
        periodEnd: day("2026-05-31"),
        workedMinutes: 9600,
        expectedMinutes: 9600,
        balanceMinutes: 0,
        carryOver: 0,
        closedAt: new Date(),
      },
    });
    registry.register(`${label}.monthClose`, snapshot.id);
  }

  /** The claims of a token, decoded (not verified by hand — the API verified it when issuing). */
  function claims(token: string): JwtPayload {
    const decoded = app.jwt.decode<JwtPayload>(token);
    if (!decoded) throw new Error("activity-auth: token did not decode");
    return decoded;
  }

  function tenantLabel(tenantId: string): string {
    if (tenantId === "") return "<empty>";
    return registry.labelOf(tenantId) ?? "<unlabelled>";
  }

  function employeeLabel(employeeId: string | undefined): string {
    if (employeeId === undefined) return "<none>";
    return registry.labelOf(employeeId) ?? "<unlabelled>";
  }

  beforeAll(async () => {
    if (
      MODE === "record" &&
      !readFileSync(AUTH_MIDDLEWARE, "utf8").includes(ROLE_GUARD_DEFINITION)
    ) {
      throw new Error(
        `activity-auth: RECORD refused — "${ROLE_GUARD_DEFINITION}" is no longer defined in ` +
          `${AUTH_MIDDLEWARE}. The recording must come from the pre-switch code; recording the ` +
          `switched code would make the neutrality proof compare the new code with itself.`,
      );
    }
    app = await getTestApp();
    stubs = installExternalStubs(app);
    const stubSendOtp = app.mailer.sendOtp;
    app.mailer.sendOtp = async (params) => {
      otpCodes.push(params.code);
      await stubSendOtp(params);
    };
    passwordHash = await bcrypt.hash(FIXTURE_PASSWORD, 10);

    tenantA = await createTenant("act-a");
    registry.register("A.tenant", tenantA);
    tenantF = await createTenant("act-f");
    registry.register("F.tenant", tenantF);
    tenantO = await createTenant("act-o", true);
    registry.register("O.tenant", tenantO);
    vacationTypeA = (
      await app.prisma.leaveType.create({
        data: { tenantId: tenantA, ...leaveTypeFields("VACATION"), color: "#3B82F6" },
      })
    ).id;
    registry.register("A.leaveType.VACATION", vacationTypeA);

    await createUser(tenantA, "A.admin", "ADMIN");
    await createUser(tenantA, "A.manager", "MANAGER");
    await createUser(tenantA, "A.employee", "EMPLOYEE");
    await createUser(null, "A.noEmployee", "ADMIN");
    await createUser(tenantF, "F.admin", "ADMIN");
    await createUser(tenantO, "O.manager", "MANAGER");

    // D-25: the checked-in migration SQL runs before anything is measured.
    await executeLegacyRoleMigration(app.prisma);
    const migrated = await app.prisma.roleAssignment.findMany({
      where: { userId: { in: [...userIdOf.values()] } },
      select: { id: true, userId: true },
    });
    for (const assignment of migrated) {
      const userLabel = registry.labelOf(assignment.userId) as string;
      registry.register(`${userLabel.replace(/\.user$/, "")}.roleAssignment`, assignment.id);
    }

    // D-08: the fallback users exist only after the migration.
    await createUser(tenantA, "A.fallback.admin", "ADMIN");
    await createUser(tenantA, "A.fallback.manager", "MANAGER");
    await createUser(tenantA, "A.fallback.employee", "EMPLOYEE");

    // Domain material of the EMPLOYEE / MANAGER branch.
    for (const label of ["A.employee", "A.manager", "A.fallback.manager", "A.fallback.employee"]) {
      await createEntry(label);
    }
    await createLeave("A.employee", "reviewed", {
      start: "2026-11-02",
      end: "2026-11-02",
      approvedBy: "A.manager",
    });
    await createLeave("A.employee", "pending", { start: "2026-11-09", end: "2026-11-09" });
    await createLeave("A.manager", "pending", { start: "2026-11-16", end: "2026-11-16" });
    await createMonthClose("A.employee");
    await createMonthClose("A.manager");

    // The audit branch: 20 labelled rows for tenant A, 4 foreign rows interleaved.
    for (const [i, actor] of AUDIT_PLAN.entries()) {
      const actorUserId =
        actor === "<null>" ? null : actor === "F" ? userId("F.admin") : userId(actor);
      const row = await app.prisma.auditLog.create({
        data: {
          userId: actorUserId,
          action: "UPDATE",
          entity: "Employee",
          entityId: `activity-auth-${i}`,
          createdAt: new Date(AUDIT_BASE + i * 1000),
        },
      });
      const kind = actor === "<null>" ? "global" : actor === "F" ? "foreign" : actor;
      registry.register(`audit.${String(i).padStart(2, "0")}.${kind}`, row.id);
    }

    if (MODE === "verify") {
      if (!existsSync(VERIFY_IN)) {
        throw new Error(
          `activity-auth: no recording at ${VERIFY_IN} — run with NEUTRALITY_ACTIVITY_AUTH_MODE=record first`,
        );
      }
      recording = (
        JSON.parse(readFileSync(VERIFY_IN, "utf8")) as { entries: Record<string, Entry> }
      ).entries;
    }
    setupComplete = true;
  }, 300_000);

  afterAll(async () => {
    stubs?.restore();
    if (MODE === "record" && setupComplete) {
      mkdirSync(dirname(RECORD_OUT), { recursive: true });
      writeFileSync(RECORD_OUT, serializeRecording(collected));
    }
    try {
      // The labelled audit rows without a tenant actor, and everything of the user without an
      // Employee (cleanupTestData only reaches users through their Employee).
      const noEmployee = userIdOf.get("A.noEmployee");
      await app.prisma.auditLog.deleteMany({
        where: { entityId: { startsWith: "activity-auth-" } },
      });
      if (noEmployee) {
        await app.prisma.auditLog.deleteMany({ where: { userId: noEmployee } });
        await app.prisma.auditLog.deleteMany({ where: { entityId: noEmployee } });
        await app.prisma.refreshToken.deleteMany({ where: { userId: noEmployee } });
        await app.prisma.user.delete({ where: { id: noEmployee } });
      }
    } catch (err) {
      console.error("activity-auth: cleanup of the global rows failed:", err);
    }
    for (const tenantId of [tenantA, tenantF, tenantO]) {
      if (!tenantId) continue;
      try {
        const users = await app.prisma.employee.findMany({
          where: { tenantId },
          select: { userId: true },
        });
        await app.prisma.auditLog.deleteMany({
          where: { entityId: { in: users.map((u) => u.userId) } },
        });
        await cleanupMatrixExtras(app, tenantId);
        await cleanupTestData(app, tenantId);
      } catch (err) {
        console.error(`activity-auth: cleanup of tenant ${tenantId} failed:`, err);
      }
    }
  });

  describe("token role (AC-75-14, AC-75-5, C-4)", () => {
    for (const label of LOGIN_USERS) {
      it(`login and refresh — ${label}`, async () => {
        const login = await app.inject({
          method: "POST",
          url: "/api/v1/auth/login",
          payload: { email: emailOf.get(label), password: FIXTURE_PASSWORD },
          remoteAddress: nextRemoteAddress(),
        });
        const loginBody = JSON.parse(login.body) as {
          accessToken?: string;
          refreshToken?: string;
          user?: { role: string };
        };
        const loginRecord: TokenRecord = { status: login.statusCode };
        if (loginBody.accessToken) {
          const c = claims(loginBody.accessToken);
          loginRecord.bodyRole = loginBody.user?.role;
          loginRecord.tokenRole = c.role;
          loginRecord.tokenTenant = tenantLabel(c.tenantId);
          loginRecord.tokenEmployee = employeeLabel(c.employeeId);
          accessTokenOf.set(label, loginBody.accessToken);
        }
        record(`auth | ${label} | login`, loginRecord);

        const refresh = await app.inject({
          method: "POST",
          url: "/api/v1/auth/refresh",
          payload: { refreshToken: loginBody.refreshToken },
          remoteAddress: nextRemoteAddress(),
        });
        const refreshBody = JSON.parse(refresh.body) as { accessToken?: string; user?: unknown };
        const refreshRecord: TokenRecord = { status: refresh.statusCode };
        if (refreshBody.accessToken) refreshRecord.tokenRole = claims(refreshBody.accessToken).role;
        record(`auth | ${label} | refresh`, refreshRecord);

        // Pre-switch sanity: the column IS the source, so every recorded role equals it; the
        // refresh body carries no user object (C-4).
        const column = columnRoleOf.get(label);
        expect(loginRecord).toMatchObject({ status: 200, bodyRole: column, tokenRole: column });
        expect(refreshRecord).toEqual({ status: 200, tokenRole: column });
        expect(refreshBody.user).toBeUndefined();
        if (label === "A.noEmployee") {
          expect(loginRecord.tokenTenant).toBe("<empty>");
          expect(loginRecord.tokenEmployee).toBe("<none>");
        }
      });
    }

    it("OTP login — O.manager (tenant with two-factor login)", async () => {
      const label = "O.manager";
      const login = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: emailOf.get(label), password: FIXTURE_PASSWORD },
        remoteAddress: nextRemoteAddress(),
      });
      const loginBody = JSON.parse(login.body) as { requiresOtp?: boolean; userId?: string };
      expect(login.statusCode, login.body).toBe(202);
      expect(loginBody.requiresOtp).toBe(true);
      expect(otpCodes).toHaveLength(1);

      const verify = await app.inject({
        method: "POST",
        url: "/api/v1/auth/verify-otp",
        payload: { userId: loginBody.userId, code: otpCodes[0] },
        remoteAddress: nextRemoteAddress(),
      });
      const verifyBody = JSON.parse(verify.body) as {
        accessToken?: string;
        refreshToken?: string;
        user?: { role: string };
      };
      const verifyRecord: TokenRecord = { status: verify.statusCode };
      if (verifyBody.accessToken) {
        const c = claims(verifyBody.accessToken);
        verifyRecord.bodyRole = verifyBody.user?.role;
        verifyRecord.tokenRole = c.role;
        verifyRecord.tokenTenant = tenantLabel(c.tenantId);
        verifyRecord.tokenEmployee = employeeLabel(c.employeeId);
      }
      record(`auth | ${label} | otp`, { status: login.statusCode });
      record(`auth | ${label} | verify-otp`, verifyRecord);

      const refresh = await app.inject({
        method: "POST",
        url: "/api/v1/auth/refresh",
        payload: { refreshToken: verifyBody.refreshToken },
        remoteAddress: nextRemoteAddress(),
      });
      const refreshBody = JSON.parse(refresh.body) as { accessToken?: string };
      const refreshRecord: TokenRecord = { status: refresh.statusCode };
      if (refreshBody.accessToken) refreshRecord.tokenRole = claims(refreshBody.accessToken).role;
      record(`auth | ${label} | refresh`, refreshRecord);

      const column = columnRoleOf.get(label);
      expect(verifyRecord).toMatchObject({ status: 200, bodyRole: column, tokenRole: column });
      expect(refreshRecord).toEqual({ status: 200, tokenRole: column });
    });
  });

  describe("activity feed (AC-75-13, D-13)", () => {
    const feeds = new Map<string, CellResult>();

    for (const [index, caller] of FEED_CALLERS.entries()) {
      it(`GET /activity?limit=20 — ${caller.label}`, async () => {
        const token = accessTokenOf.get(caller.label);
        if (!token) throw new Error(`activity-auth: ${caller.label} has no token from the login`);
        const self: ActorFixture = {
          actor: caller.actor,
          tenantId: tenantA,
          authorization: `Bearer ${token}`,
          actorUserId: userId(caller.label),
          registry,
        };
        const ctx: LabelContext = { self, others: [], global: new Map() };
        const result = await runCell({
          app,
          ctx,
          actorSlot: 100 + index,
          route: ACTIVITY_ROUTE,
          spec: ACTIVITY_SPEC,
          variant: ACTIVITY_VARIANT,
        });
        feeds.set(caller.label, result);
        record(`activity | ${caller.label}`, result);
        expect(result.status).toBe(200);
      });
    }

    it("the ADMIN-class feeds are fully labelled: 20 tenant/global rows, no <new>, no foreign row", () => {
      for (const label of ["A.admin", "A.fallback.admin"]) {
        const ids = feeds.get(label)?.ids ?? [];
        expect(ids, label).toHaveLength(FEED_LIMIT);
        expect(
          ids.filter((id) => id === "<new>"),
          label,
        ).toEqual([]);
        expect(
          ids.filter((id) => id.includes("foreign")),
          label,
        ).toEqual([]);
        // All three audit kinds are present: tenant actors, no actor, user without Employee.
        expect(ids.some((id) => id.endsWith(".global"))).toBe(true);
        expect(ids.some((id) => id.endsWith(".A.noEmployee"))).toBe(true);
        expect(ids.some((id) => id.endsWith(".A.admin"))).toBe(true);
      }
    });

    it("the ADMIN feed and the MANAGER feed differ (the branches are exclusive)", () => {
      const admin = feeds.get("A.admin");
      const manager = feeds.get("A.manager");
      expect(admin).toBeDefined();
      expect(manager).toBeDefined();
      expect(manager).not.toEqual(admin);
      expect((manager?.ids ?? []).some((id) => id.startsWith("audit."))).toBe(false);
      expect((manager?.ids ?? []).some((id) => id.startsWith("rev-"))).toBe(true);
      expect((manager?.ids ?? []).some((id) => id.startsWith("tlr-"))).toBe(true);
    });
  });

  describe("completeness", () => {
    it("recorded every login, refresh, OTP and feed entry", () => {
      const expected = LOGIN_USERS.length * 2 + 3 + FEED_CALLERS.length;
      expect(collected.size).toBe(expected);
      if (MODE === "verify") {
        expect(Object.keys(recording ?? {}).sort()).toEqual([...collected.keys()].sort());
      }
    });
  });
});
