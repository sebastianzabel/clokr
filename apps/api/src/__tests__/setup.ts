/**
 * Test setup: creates a fresh Fastify app instance for integration tests.
 *
 * Connects to the separate `clokr_test` database, provisioned by
 * `pnpm --filter @clokr/api run test:setup` (see docs/testing.md) — never the dev
 * database. Suites still share that one database within a run, so each test suite must
 * clean up its own data.
 */
import { buildApp } from "../app";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { createHash, randomBytes } from "node:crypto";
import { Secret, TOTP } from "otpauth";
// Re-export Prisma.JsonValue to keep it nameable in the inferred return type of
// seedTestData(). Adding `uiPreferences Json?` to User caused TS2883 because the
// inferred return type implicitly references JsonValue without a local binding.
import { Prisma, type FederalState, type TenantModule } from "@clokr/db";
import { leaveTypeFields } from "../contexts/absence/leave-type";
import {
  DEFAULT_SALON_OPENING_HOURS,
  findDefaultSalon,
  SYSTEM_ROLE_IDS,
  type SalonOpeningHours,
} from "../contexts/platform";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleepMs } from "node:timers/promises";
import type { JwtPayload } from "../middleware/auth";
import { createOperatorAccount } from "../contexts/platform/operator-credentials";
import { createTenantWithConfig } from "../contexts/platform/tenant-provisioning";

// Keep JsonValue reachable from this module's public types (intentional no-op type alias)
export type _SeedJsonValue = Prisma.JsonValue;

/**
 * Test-only lever that moves the year `seedTestData` provisions the fixture
 * LeaveEntitlement for. Absent or 0, this file behaves exactly as before.
 *
 * This is the calendar-axis counterpart to CLOKR_TEST_FAKE_CLOCK
 * (vitest.clock-setup.ts), which can only shift the time of day within today
 * and is structurally incapable of simulating a year rollover. Setting
 * CLOKR_TEST_SEED_YEAR_OFFSET=1 reproduces 2027-01-01 for the one thing that
 * actually depends on the year: whether the entitlement row a test books onto
 * exists at all.
 *
 * A non-zero offset is EXPECTED to break unrelated suites that legitimately
 * book into the live current year. It is a per-file diagnostic lever, never a
 * suite-wide mode.
 */
export const SEED_YEAR_OFFSET = Number(process.env.CLOKR_TEST_SEED_YEAR_OFFSET ?? 0);

let app: FastifyInstance;

export async function getTestApp(): Promise<FastifyInstance> {
  if (!app) {
    app = await buildApp();
    await app.ready();
  }
  return app;
}

// Phase 106 (D-03): bcrypt at cost factor 10 is ~65ms of pure CPU per call, and seedTestData()
// below calls it twice per invocation (admin + employee) for the SAME constant fixture password —
// 338 raw call sites across the suite, measured (106-MEASUREMENTS.md § "Cost-driver profile"),
// none of them varying the plaintext. The resulting hash is reusable — memoising it removes the
// repeated work WITHOUT changing the cost factor, the stored hash shape, or anything
// bcrypt.compare() sees (R6: not a weakened assertion — every auth test still verifies a real
// bcrypt-produced digest at the same cost factor).
//
// A plain module-level Map only survives WITHIN one test file: Vitest's `isolate: true` rebuilds
// this module's state fresh for every file, even inside the same forked worker process (measured
// directly — this file's own `app` singleton above rebuilds once per file, not once per worker;
// see 106-MEASUREMENTS.md's "S2 — app boot" section). `process.env` is the one primitive that DOES
// survive that reset — it is how `vitest.worker-setup.ts`'s own `DATABASE_URL` assignment survives
// across every file in a worker — so it backs this cache too, making it genuinely per WORKER
// PROCESS rather than merely per file.
const fixtureHashes = new Map<string, string>();
const FIXTURE_HASH_ENV_PREFIX = "__CLOKR_TEST_FIXTURE_HASH__";

async function fixturePasswordHash(plaintext: string): Promise<string> {
  const cached = fixtureHashes.get(plaintext);
  if (cached) return cached;

  const envKey = FIXTURE_HASH_ENV_PREFIX + plaintext;
  const fromEnv = process.env[envKey];
  if (fromEnv) {
    fixtureHashes.set(plaintext, fromEnv);
    return fromEnv;
  }

  const hash = await bcrypt.hash(plaintext, 10);
  fixtureHashes.set(plaintext, hash);
  process.env[envKey] = hash;
  return hash;
}

/**
 * Noop in test runs — the app instance is shared across suites.
 * Vitest handles cleanup when the process exits.
 */
export async function closeTestApp(): Promise<void> {
  // Intentionally empty — shared singleton
}

/**
 * Re-issue a previously minted access token at whatever "now" is CURRENTLY active for the
 * app's JWT plugin — real or faked.
 *
 * Root cause this fixes (issue #434): `seedTestData()` logs in under the REAL wall clock in
 * `beforeAll`, so `adminToken`/`empToken` carry `iat`/`exp` computed from the real `Date.now()`
 * at that moment (`JWT_EXPIRES_IN=15m` in `.env.test`). A test that later calls
 * `vi.useFakeTimers({ now: <some other instant>, toFake: ["Date"] })` and then reuses that same
 * token leaves the token's `exp` anchored to the REAL issuance time while the expiry check
 * against it now runs under the FAKED clock. If the faked "now" lands far enough past the real
 * issuance time (more than `JWT_EXPIRES_IN`), the token reads as already expired and the request
 * 401s — reproduced by `workschedule-validfrom-month1.test.ts` and
 * `schedule-type-switch-guard.test.ts`, whose derived "now" (`monthStartUtc(0) + 10 days`) can
 * land 10+ days ahead of the real token issuance in the first third of a calendar month.
 *
 * Decode-and-resign works under either clock, since both `app.jwt.decode` and `app.jwt.sign` read
 * `Date.now()` — call this AFTER `vi.useFakeTimers(...)` is active, before any `app.inject()` that
 * uses the returned token, and use the returned token (not the original) for the rest of that
 * faked-clock block.
 */
export function reissueTokenNow(app: FastifyInstance, token: string): string {
  const decoded = app.jwt.decode<JwtPayload>(token);
  if (!decoded) {
    throw new Error("reissueTokenNow: could not decode token");
  }
  // Issue #539 (D-05): no role claim - re-signed with exactly what a login issues.
  const { sub, tenantId, employeeId } = decoded;
  return app.jwt.sign({ sub, tenantId, employeeId });
}

/**
 * Issue #543: next automatic `Salon.createdAt` in epoch milliseconds — strictly greater than both
 * the previous automatic value and the current clock reading, so two salons never share an instant.
 */
export function nextSalonCreatedAtMs(lastMs: number, nowMs: number): number {
  return Math.max(lastMs, nowMs) + 1;
}

/** A target further ahead of the clock than this is a faked or skewed Date, not a short wait. */
const MAX_CLOCK_LEAD_MS = 50;
/** Consecutive 1 ms sleeps with an unchanged clock after which the Date is considered frozen. */
const MAX_CLOCK_STALLS = 3;

/**
 * Issue #543: let the wall clock pass `targetMs` so that every Node-clock timestamp generated after
 * this returns is strictly greater than `targetMs`. Resolves `true` once `now()` exceeds the target
 * and `false` when waiting cannot help — the target lies more than {@link MAX_CLOCK_LEAD_MS} ahead
 * of the clock, or the clock did not move across {@link MAX_CLOCK_STALLS} consecutive sleeps (a
 * `vi.useFakeTimers` frozen Date). It therefore never hangs, with or without fake timers. The clock
 * is read lazily on every call: a captured `Date.now` reference would miss a later fake install.
 */
export async function waitForClockPast(
  targetMs: number,
  deps: { now?: () => number; sleep?: (ms: number) => Promise<unknown> } = {},
): Promise<boolean> {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? sleepMs;
  let current = now();
  if (current > targetMs) return true;
  if (targetMs - current > MAX_CLOCK_LEAD_MS) return false;
  let stalls = 0;
  while (stalls < MAX_CLOCK_STALLS) {
    await sleep(1);
    const next = now();
    if (next > targetMs) return true;
    stalls = next === current ? stalls + 1 : 0;
    current = next;
  }
  return false;
}

// Last automatic Salon.createdAt handed out by createTestSalon, in epoch ms. Module state is per
// test FILE (Vitest isolates modules per file), which suffices: salon order is per tenant and
// fixture tenants never span files.
let lastAutoSalonCreatedAtMs = 0;

/**
 * Phase 325 (issue #325), D-17: create one salon for a fixture tenant. Accepts a
 * `Prisma.TransactionClient`-compatible client so both `app.prisma` and a `tx` inside a
 * transaction work. `isActive: false` also sets `deactivatedAt` (mirrors the real write path's
 * isActive<->deactivatedAt invariant, see `contexts/platform/facade/salons.ts`'s `createSalon`).
 * `createdAt` is accepted for deterministic ordering fixtures (e.g. proving "earliest active
 * salon wins" against a second, later-created salon).
 *
 * Phase 71b (issue #71), D-01: `federalState` defaults to the TENANT's own federalState (mirrors
 * `createSalon()`'s production default) — never a hardcoded value, so a fixture never silently
 * gets NIEDERSACHSEN for a tenant configured with a different state.
 *
 * Issue #543: without an explicit `createdAt`, the value is strictly increasing per test file and
 * strictly after every Node-clock `createdAt` generated before the call, and the helper waits for
 * the wall clock to pass it. With a real clock, every salon created after the call returns (this
 * helper, a raw `prisma.salon.create`, `POST /api/v1/salons`) is therefore strictly younger, so
 * `findDefaultSalon()` never reaches its random-UUID tie-break in a fixture. An explicit
 * `createdAt` is stored verbatim and sits outside the sequence. Under a frozen or far-off faked
 * Date only helper-versus-helper order is guaranteed.
 */
export async function createTestSalon(
  db: Prisma.TransactionClient,
  tenantId: string,
  overrides?: {
    name?: string;
    openingHours?: SalonOpeningHours;
    isActive?: boolean;
    createdAt?: Date;
    federalState?: FederalState;
  },
) {
  const isActive = overrides?.isActive ?? true;
  const federalState =
    overrides?.federalState ??
    (
      await db.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { federalState: true },
      })
    ).federalState;
  // Reserve synchronously (no await between read and write) so concurrent calls get distinct values.
  let autoCreatedAtMs: number | null = null;
  if (!overrides?.createdAt) {
    autoCreatedAtMs = nextSalonCreatedAtMs(lastAutoSalonCreatedAtMs, Date.now());
    lastAutoSalonCreatedAtMs = autoCreatedAtMs;
  }
  const autoCreatedAt = autoCreatedAtMs === null ? null : new Date(autoCreatedAtMs);
  const salon = await db.salon.create({
    data: {
      tenantId,
      name: overrides?.name ?? "Test Salon",
      federalState,
      openingHours: overrides?.openingHours ?? DEFAULT_SALON_OPENING_HOURS,
      isActive,
      deactivatedAt: isActive ? null : new Date(),
      // Production writes the same instant into both columns of a fresh row.
      ...(overrides?.createdAt ? { createdAt: overrides.createdAt } : {}),
      ...(autoCreatedAt ? { createdAt: autoCreatedAt, updatedAt: autoCreatedAt } : {}),
    },
  });
  if (autoCreatedAtMs !== null) await waitForClockPast(autoCreatedAtMs);
  return salon;
}

/**
 * Phase 71b (issue #71), Task 2 — reproduces the REAL migration history for a historical data
 * section (64b/325/68b/65b) that does `INSERT INTO "Salon"` WITHOUT a `federalState` column: those
 * four applied migrations predate this phase and insert salons the post-71b schema's NOT NULL,
 * default-less `federalState` column would reject outright. This helper recreates the legacy,
 * pre-71b shape for the DURATION of `replay()` — DROP NOT NULL, run `replay()` (which executes the
 * historical INSERT), then apply the 71b migration's OWN `UPDATE "Salon"` backfill statement (read
 * verbatim from the `*_holidays_per_salon` migration file, never restated here), then SET NOT NULL
 * again — instead of editing an applied migration (checksums would break) or giving the column a
 * schema default (see the column's own comment in schema.prisma for why not).
 *
 * `tx` MUST be an INTERACTIVE transaction's client — Postgres DDL is transactional, so a rolled-
 * back replay leaks nothing and a committed one restores the schema before commit. The DDL takes
 * an ACCESS EXCLUSIVE lock on Salon for the duration, same caveat as the 68b/325 replay tests'
 * own `DROP NOT NULL` calls (only one worker file runs against a given test database at a time).
 */
export async function withPre71bSalonSchema(
  tx: Prisma.TransactionClient,
  replay: () => Promise<void>,
): Promise<void> {
  const migrationsDir = join(__dirname, "..", "..", "..", "..", "packages/db/prisma/migrations");
  const migrationDirs = readdirSync(migrationsDir);
  if (migrationDirs.length === 0) {
    throw new Error(`withPre71bSalonSchema: ${migrationsDir} is empty — anti-vacuity guard`);
  }
  const dirName = migrationDirs.find((d) => d.endsWith("_holidays_per_salon"));
  if (!dirName) {
    throw new Error(
      "withPre71bSalonSchema: no packages/db/prisma/migrations/*_holidays_per_salon directory found",
    );
  }
  const sql = readFileSync(join(migrationsDir, dirName, "migration.sql"), "utf8");
  const beginIdx = sql.indexOf("-- 71b-data-migration:begin");
  const endIdx = sql.indexOf("-- 71b-data-migration:end");
  if (beginIdx === -1 || endIdx === -1) {
    throw new Error("withPre71bSalonSchema: 71b-data-migration markers not found in migration.sql");
  }
  const section = sql.slice(beginIdx, endIdx);
  const statements = section
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const updateSalonStmt = statements.find((s) => s.startsWith('UPDATE "Salon"'));
  if (!updateSalonStmt) {
    throw new Error(
      'withPre71bSalonSchema: no UPDATE "Salon" statement found in the 71b data section',
    );
  }

  await tx.$executeRawUnsafe(`ALTER TABLE "Salon" ALTER COLUMN "federalState" DROP NOT NULL`);
  await replay();
  await tx.$executeRawUnsafe(updateSalonStmt);
  await tx.$executeRawUnsafe(`ALTER TABLE "Salon" ALTER COLUMN "federalState" SET NOT NULL`);
}

/**
 * Phase 325 (issue #325), D-17/research Pitfall 1: resolve the salon a fixture shift/appointment
 * for `employeeId` should use — always the SAME tenant as that employee's, by construction (never
 * a hardcoded id, never another fixture's salon). Uses the production default-salon rule
 * (`findDefaultSalon`) so a two-tenant test cannot accidentally cross-wire a salon. Throws when
 * the employee's tenant has no active salon — the fixture is missing a `createTestSalon()` call
 * right after its `tenant.create`.
 */
export async function salonIdForEmployee(
  db: Prisma.TransactionClient,
  employeeId: string,
): Promise<string> {
  const employee = await db.employee.findUniqueOrThrow({
    where: { id: employeeId },
    select: { tenantId: true },
  });
  const salon = await findDefaultSalon(db, employee.tenantId);
  if (!salon) {
    throw new Error(
      `salonIdForEmployee: employee ${employeeId} — fixture tenant has no active salon — call createTestSalon() after its tenant.create`,
    );
  }
  return salon.id;
}

/**
 * Issue #539 (D-09): the system roles a fixture user can be given. Its own union, not the Prisma
 * `Role` enum, so it survives the removal of that enum in Release B.
 */
export type LegacySystemRoleName = "ADMIN" | "MANAGER" | "EMPLOYEE";

/**
 * Issue #539 (D-09): gives a fixture user its system role as a STORED tenant-wide
 * `RoleAssignment`. From Release A on, permissions come only from stored rows, so every fixture
 * user that is meant to hold a role says so explicitly, per user — Release B then only drops the
 * `role:` column values. Idempotent (upsert on the unique key `userId_accessRoleId_scopeType`) and
 * writes no `AuditLog` row: a fixture has no principal, while production writes go through
 * employee creation or the role-assignment API, both audited. Returns the row id.
 */
export async function grantSystemRole(
  prisma: Prisma.TransactionClient,
  input: { tenantId: string; userId: string; role: LegacySystemRoleName },
): Promise<string> {
  const accessRoleId = SYSTEM_ROLE_IDS[input.role];
  const row = await prisma.roleAssignment.upsert({
    where: {
      userId_accessRoleId_scopeType: {
        userId: input.userId,
        accessRoleId,
        scopeType: "TENANT",
      },
    },
    create: {
      tenantId: input.tenantId,
      userId: input.userId,
      accessRoleId,
      scopeType: "TENANT",
      salonIds: [],
      employeeIds: [],
    },
    update: {},
    select: { id: true },
  });
  return row.id;
}

/**
 * Issue #539 (D-14): a token for a user who can no longer SIGN IN. An active account whose effective
 * permission set is empty (no stored role assignment, or only a role that grants nothing at the
 * chosen scope) is refused at login with 403 `NO_ROLE_ASSIGNED`, but several tests exist precisely
 * to prove that such a principal gets 403 on a guarded route (an empty SALONS scope, a salon-scoped
 * holder of a whole-tenant key). They obtain their token here: signed with exactly the claims a
 * login would have issued (sub, tenant, employee - no role claim since #539 D-05). `email` is the user's login email.
 */
export async function tokenWithoutSignIn(app: FastifyInstance, email: string): Promise<string> {
  const user = await app.prisma.user.findUniqueOrThrow({
    where: { email },
    include: { employee: { select: { id: true, tenantId: true } } },
  });
  return app.jwt.sign({
    sub: user.id,
    tenantId: user.employee?.tenantId ?? "",
    employeeId: user.employee?.id,
  } as JwtPayload);
}

/**
 * Issue #539: removes every stored role assignment of `userIds`. It exists only to restore a
 * recorded precondition (the neutrality fixture, whose recordings were taken on seed users
 * without stored rows) or — until plan 539-07 rewrites them — the pre-#539 seed state of a file
 * that deliberately tests the unassigned state. Never a way to make an incidental test green.
 */
export async function removeFixtureRoleAssignments(
  prisma: Prisma.TransactionClient,
  userIds: readonly string[],
): Promise<void> {
  if (userIds.length === 0) return;
  await prisma.roleAssignment.deleteMany({ where: { userId: { in: [...userIds] } } });
}

/**
 * Issue #539 (plan 07): an admin-scope API key of `tenantId` and its raw token. An API key resolves
 * to the Admin system role through its scope (`request-permissions.ts`), never through a stored
 * `RoleAssignment`, so it passes every guard an admin passes WITHOUT being a counted holder of the
 * guarded permissions (`countHoldersPerGuardedPermission` reads stored rows only). The lockout tests
 * use it as the acting principal: before #539 their seed admin was exactly such an uncounted actor
 * (it held its rights through the legacy-role fallback); a stored admin row would make it a holder
 * and change every holder count the scenarios arrange. `removeFixtureApiKeys` deletes the keys.
 */
export async function createAdminApiKey(
  prisma: Prisma.TransactionClient,
  input: { tenantId: string; createdBy: string },
): Promise<{ id: string; token: string }> {
  const token = `clk_${randomBytes(24).toString("hex")}`;
  const row = await prisma.apiKey.create({
    data: {
      tenantId: input.tenantId,
      name: `fixture-admin-${randomBytes(3).toString("hex")}`,
      keyHash: createHash("sha256").update(token).digest("hex"),
      keyPrefix: token.slice(0, 8),
      scopes: ["admin"],
      createdBy: input.createdBy,
    },
    select: { id: true },
  });
  return { id: row.id, token };
}

/** Deletes every API key of `tenantId` (fixture cleanup for `createAdminApiKey`). */
export async function removeFixtureApiKeys(
  prisma: Prisma.TransactionClient,
  tenantId: string,
): Promise<void> {
  await prisma.apiKey.deleteMany({ where: { tenantId } });
}

/** Phase 566 (D-10): what every shared fixture tenant books — all modules, a quota no scenario reaches. */
export const FIXTURE_PACKAGES = {
  bookedModules: ["CHAIN", "INTEGRATIONS", "HARDWARE_CLOCK", "ANALYTICS"] as TenantModule[],
  salonQuota: 500,
} as const;

/**
 * Phase 325 (issue #325), D-17: the pre-325 body of `seedTestData`, now called by it. Kept
 * module-private — the two overload signatures below are what callers see.
 */
async function seedTenantFixture(testApp: FastifyInstance, suffix = "") {
  const s =
    (suffix ? suffix + "-" : "") + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const prisma = testApp.prisma;
  // Issue #304: the DATEV export refuses non-numeric personnel numbers (LODAS pnr is numeric), and
  // these fixtures feed it, so their numbers are numeric (unique per tenant: two consecutive values).
  const numberBase = Math.floor(Math.random() * 40_000_000) * 2 + 10_000_000;

  // Create tenant + tenant config through the one provisioning rule (Phase 88, D-04a). Only L1:
  // the default salon is NOT created here, it comes afterwards from the withDefaultSalon wrapper
  // with strictly ascending createdAt (Issue #543), so provisionTenant (L2) must not be used.
  const { tenant: createdTenant } = await createTenantWithConfig(prisma, {
    name: `Test Tenant ${s}`,
    slug: `test-${s}`,
    federalState: "NIEDERSACHSEN",
    timezone: "Europe/Berlin",
  });
  // Phase 566 (D-10): shared fixtures book every package with a quota far above any scenario, so
  // the recorded neutrality cells and every pre-existing test stay byte-identical (never re-record).
  // Tests of the package rules create a Grundversion tenant explicitly (seedGrundversionTenant).
  const tenant = await prisma.tenant.update({
    where: { id: createdTenant.id },
    data: {
      bookedModules: [...FIXTURE_PACKAGES.bookedModules],
      salonQuota: FIXTURE_PACKAGES.salonQuota,
    },
  });

  // Create admin user
  const adminPasswordHash = await fixturePasswordHash("test1234");
  const adminUser = await prisma.user.create({
    data: {
      email: `admin-${s}@test.de`,
      passwordHash: adminPasswordHash,
      role: "ADMIN",
      isActive: true,
    },
  });

  // Create admin employee
  const adminEmployee = await prisma.employee.create({
    data: {
      tenantId: tenant.id,
      userId: adminUser.id,
      employeeNumber: String(numberBase),
      firstName: "Admin",
      lastName: "Test",
      hireDate: new Date("2024-01-01"),
    },
  });
  // Issue #539 (D-09): the seed users hold their system role as a stored assignment, before the
  // logins below — permissions come only from stored rows.
  await grantSystemRole(prisma, { tenantId: tenant.id, userId: adminUser.id, role: "ADMIN" });

  await prisma.workSchedule.create({
    data: {
      employeeId: adminEmployee.id,
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

  await prisma.overtimeAccount.create({
    data: { employeeId: adminEmployee.id, balanceHours: 0 },
  });

  // Create regular employee user
  const empPasswordHash = await fixturePasswordHash("test1234");
  const empUser = await prisma.user.create({
    data: {
      email: `emp-${s}@test.de`,
      passwordHash: empPasswordHash,
      role: "EMPLOYEE",
      isActive: true,
    },
  });

  const employee = await prisma.employee.create({
    data: {
      tenantId: tenant.id,
      userId: empUser.id,
      employeeNumber: String(numberBase + 1),
      firstName: "Max",
      lastName: "Test",
      hireDate: new Date("2024-01-01"),
    },
  });
  await grantSystemRole(prisma, { tenantId: tenant.id, userId: empUser.id, role: "EMPLOYEE" });

  await prisma.workSchedule.create({
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

  await prisma.overtimeAccount.create({
    data: { employeeId: employee.id, balanceHours: 0 },
  });

  // Create leave type for vacation. Phase 97 (T2): leaveTypeFields() pairs code and name
  // structurally, so this shared fixture — the highest-leverage one, reused across the whole
  // suite — cannot produce a row without a code.
  const vacationType = await prisma.leaveType.create({
    data: { tenantId: tenant.id, ...leaveTypeFields("VACATION"), color: "#3B82F6" },
  });

  // Create leave entitlement for current year
  const currentYear = new Date().getFullYear() + SEED_YEAR_OFFSET;
  await prisma.leaveEntitlement.create({
    data: {
      employeeId: employee.id,
      leaveTypeId: vacationType.id,
      year: currentYear,
      totalDays: 30,
      usedDays: 0,
    },
  });

  // Login as admin to get token
  const loginRes = await testApp.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: `admin-${s}@test.de`, password: "test1234" },
  });
  const { accessToken: adminToken } = JSON.parse(loginRes.body);

  // Login as employee
  const empLoginRes = await testApp.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: `emp-${s}@test.de`, password: "test1234" },
  });
  const { accessToken: empToken } = JSON.parse(empLoginRes.body);

  return {
    tenant,
    adminUser,
    adminEmployee,
    adminToken,
    empUser,
    employee,
    empToken,
    vacationType,
  };
}

/**
 * Seed a test tenant + admin user + employee and return auth tokens — plus, by default, one
 * active default salon for the tenant (Phase 325, issue #325, D-17), mirroring the real-tenant
 * invariant that every tenant has a salon (64b D-18). Pass `{ withDefaultSalon: false }` to opt
 * out for the handful of tests whose own docblock states "seedTestData does not create a Salon"
 * (`salons.test.ts`, `settings-store-hours-salon-mirror.test.ts`, and the tracer describe-block of
 * `salon-migration.test.ts`) — those tests build an exact salon topology of their own, and an
 * unconditional default salon would either flip a salon-count assertion or make the migration
 * replay test's own `INSERT` a silent no-op (see 325-RESEARCH.md Q4/Pitfall 2).
 *
 * Two overloads so `Awaited<ReturnType<typeof seedTestData>>` — used all over the existing
 * ~38-file default-path suite — resolves from the LAST overload and therefore always sees
 * `salonId: string`; only a caller that explicitly writes `{ withDefaultSalon: false }` inline
 * sees the narrower `salonId: null` type.
 *
 * Phase 67b Plan 03 (issue #67, D-24) relies on the same default salon: POST /api/v1/employees
 * (D-22) resolves a new employee's Stammsalon against the tenant's active salons, and the test
 * files that call seedTestData() and then POST an employee without an explicit `homeSalonId`
 * depend on the tenant having EXACTLY ONE active salon for that resolution to succeed (research
 * Pitfall 5). Both phases share this one salon (name = tenant name, `DEFAULT_SALON_OPENING_HOURS`,
 * like test-bootstrap.ts's bootstrap-tenant handler) through `salonId`. The two employees
 * seedTestData creates deliberately do NOT get HOME rows — same convention as the fixtures that
 * insert an Employee row directly (D-24).
 */
export async function seedTestData(
  testApp: FastifyInstance,
  suffix: string,
  options: { withDefaultSalon: false },
): Promise<Awaited<ReturnType<typeof seedTenantFixture>> & { salonId: null }>;
export async function seedTestData(
  testApp: FastifyInstance,
  suffix?: string,
  options?: { withDefaultSalon?: true },
): Promise<Awaited<ReturnType<typeof seedTenantFixture>> & { salonId: string }>;
export async function seedTestData(
  testApp: FastifyInstance,
  suffix = "",
  options: { withDefaultSalon?: boolean } = {},
): Promise<Awaited<ReturnType<typeof seedTenantFixture>> & { salonId: string | null }> {
  const base = await seedTenantFixture(testApp, suffix);
  if (options.withDefaultSalon === false) {
    return { ...base, salonId: null };
  }
  const salon = await createTestSalon(testApp.prisma, base.tenant.id, { name: base.tenant.name });
  return { ...base, salonId: salon.id };
}

/**
 * Phase 566: `seedTestData` followed by the Grundversion (no module, quota 1), for the tests of the
 * package rules. Returns the same shape as `seedTestData`, with the tenant row updated.
 */
export async function seedGrundversionTenant(testApp: FastifyInstance, suffix = "") {
  const base = await seedTestData(testApp, suffix);
  const tenant = await testApp.prisma.tenant.update({
    where: { id: base.tenant.id },
    data: { bookedModules: [], salonQuota: 1 },
  });
  return { ...base, tenant };
}

/**
 * Issue #256 (Befund 3): the DATEV export refuses to build a file without a
 * Berater-/Mandantennummer (HTTP 409, DATEV_KANZLEI_MISSING_ERROR).
 *
 * `seedTestData` deliberately leaves both columns null — "not configured" is exactly the
 * state that guard exists for, and a seed that quietly pre-filled them would make the
 * guard impossible to test. Every fixture that wants a SUCCESSFUL export therefore says
 * so explicitly, through this helper.
 */
/**
 * Issue #304: a numeric, practically unique employee number for fixtures whose person is part of
 * a DATEV export (LODAS `pnr#bwd` is numeric; the export refuses anything else with a 422).
 */
export function numericEmployeeNumber(): string {
  return String(10_000_000 + Math.floor(Math.random() * 900_000_000));
}

export async function configureDatevKanzlei(
  testApp: FastifyInstance,
  tenantId: string,
  values: { beraterNr: number; mandantenNr: number } = { beraterNr: 28547, mandantenNr: 90909 },
) {
  await testApp.prisma.tenantConfig.update({
    where: { tenantId },
    data: { datevBeraterNr: values.beraterNr, datevMandantenNr: values.mandantenNr },
  });
}

/**
 * Idempotently ensure a `LeaveEntitlement` row exists for `employeeId` /
 * `leaveTypeId` for every year in `years`, in addition to whatever
 * `seedTestData` already provisioned for the live (or offset) current year.
 *
 * Issue #136 (batch B): `seedTestData` above seeds exactly ONE entitlement
 * row, for `new Date().getFullYear() + SEED_YEAR_OFFSET`, while several test
 * files book vacation deductions onto their own hardcoded fixture years
 * (2025/2026/2029/…). Those rows exist only while the live year happens to
 * match the literal — this helper provisions them explicitly so the fixture
 * is inert to the calendar, without rewriting the (often weekday-load-bearing,
 * see the plan's D-2) date literals themselves. Upsert, not create, so a
 * caller can safely re-request a year `seedTestData` (or a prior call) has
 * already provisioned.
 */
export async function seedEntitlementYears(
  app: FastifyInstance,
  opts: {
    employeeId: string;
    leaveTypeId: string;
    years: number[];
    totalDays?: number; // default 30, matching seedTestData
  },
): Promise<void> {
  const prisma = app.prisma;
  const totalDays = opts.totalDays ?? 30;
  for (const year of opts.years) {
    await prisma.leaveEntitlement.upsert({
      where: {
        employeeId_leaveTypeId_year: {
          employeeId: opts.employeeId,
          leaveTypeId: opts.leaveTypeId,
          year,
        },
      },
      create: {
        employeeId: opts.employeeId,
        leaveTypeId: opts.leaveTypeId,
        year,
        totalDays,
        usedDays: 0,
      },
      update: {},
    });
  }
}

/**
 * Clean up test data for a specific tenant.
 * MUST be called inside try/catch in afterAll to guarantee cleanup on test failure:
 *
 * afterAll(async () => {
 *   try {
 *     await cleanupTestData(testApp, tenant.id);
 *   } catch (err) {
 *     console.error("Test cleanup failed:", err);
 *   }
 * });
 */
export async function cleanupTestData(testApp: FastifyInstance, tenantId: string) {
  const prisma = testApp.prisma;

  // Delete in dependency order
  const employees = await prisma.employee.findMany({
    where: { tenantId },
    select: { id: true, userId: true },
  });
  const employeeIds = employees.map((e) => e.id);
  const userIds = employees.map((e) => e.userId);

  await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.employeeAvailability.deleteMany({ where: { employeeId: { in: employeeIds } } });
  await prisma.employeeShiftPattern.deleteMany({ where: { employeeId: { in: employeeIds } } });
  await prisma.employeeVocationalSchoolPattern.deleteMany({
    where: { employeeId: { in: employeeIds } },
  });
  await prisma.shift.deleteMany({ where: { employeeId: { in: employeeIds } } });
  // Issue #342: PhorestAppointment.employee AND .salon are onDelete: Restrict — these rows must
  // go before prisma.employee.deleteMany and prisma.salon.deleteMany below, otherwise the delete
  // fails and leaks fixture rows into the shared test database.
  await prisma.phorestAppointment.deleteMany({ where: { employeeId: { in: employeeIds } } });
  await prisma.absence.deleteMany({ where: { employeeId: { in: employeeIds } } });
  // Issue #468 — ParentalLeaveReduction's FKs onto Employee AND LeaveRequest are both
  // onDelete: Restrict — must be deleted before leaveRequest.deleteMany (and employee.deleteMany)
  // below, or the delete fails and leaks fixture rows into the shared test database.
  await prisma.parentalLeaveReduction.deleteMany({ where: { employeeId: { in: employeeIds } } });
  // Phase 104-05: Section9Credit's two LeaveRequest FKs (sickRequest/vacationRequest) are
  // onDelete: Restrict — must be deleted before leaveRequest.deleteMany, or the delete below
  // fails silently (afterAll only console.error's cleanup failures) and leaks fixture rows
  // into clokr_test, breaking the next run's unique-constraint assumptions (see 104-04-SUMMARY.md).
  await prisma.section9Credit.deleteMany({ where: { employeeId: { in: employeeIds } } });
  await prisma.leaveRequest.deleteMany({ where: { employeeId: { in: employeeIds } } });
  await prisma.leaveEntitlement.deleteMany({ where: { employeeId: { in: employeeIds } } });
  await prisma.saldoSnapshot.deleteMany({ where: { employeeId: { in: employeeIds } } });
  await prisma.timeEntry.deleteMany({ where: { employeeId: { in: employeeIds } } });
  await prisma.overtimeTransaction.deleteMany({
    where: { overtimeAccount: { employeeId: { in: employeeIds } } },
  });
  await prisma.overtimeAccount.deleteMany({ where: { employeeId: { in: employeeIds } } });
  await prisma.overtimePlan.deleteMany({ where: { employeeId: { in: employeeIds } } });
  await prisma.invitation.deleteMany({ where: { employeeId: { in: employeeIds } } });
  await prisma.workSchedule.deleteMany({ where: { employeeId: { in: employeeIds } } });
  // Plan 78b-05 (issue #78): RetroEntryRequest.employee is onDelete: Restrict — must be deleted
  // before prisma.employee.deleteMany below, or the delete fails and leaks fixture rows into the
  // shared test database. Safe here (after prisma.timeEntry.deleteMany above, :540): TimeEntry
  // owns the FK to RetroEntryRequest, so no TimeEntry row still references one of these rows.
  await prisma.retroEntryRequest.deleteMany({ where: { employeeId: { in: employeeIds } } });
  // Issue #80: DayBreak.employee and DayBreakAck.employee are onDelete: Restrict — must be deleted
  // before prisma.employee.deleteMany below, or the delete fails and leaks fixture rows into the
  // shared test database.
  await prisma.dayBreakAck.deleteMany({ where: { employeeId: { in: employeeIds } } });
  await prisma.dayBreak.deleteMany({ where: { employeeId: { in: employeeIds } } });
  // Phase 67b (issue #67): EmployeeSalonAssignment.employee AND .salon are onDelete: Restrict
  // (D-01) — must be deleted before prisma.employee.deleteMany below, or the delete fails and
  // leaks fixture rows into the shared test database.
  await prisma.employeeSalonAssignment.deleteMany({ where: { tenantId } });
  await prisma.employee.deleteMany({ where: { tenantId } });
  await prisma.refreshToken.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.otpToken.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.leaveType.deleteMany({ where: { tenantId } });
  await prisma.publicHoliday.deleteMany({ where: { tenantId } });
  await prisma.coverageRule.deleteMany({ where: { tenantId } });
  await prisma.shiftTemplate.deleteMany({ where: { tenantId } });
  await prisma.companyShutdown.deleteMany({ where: { tenantId } });
  await prisma.terminalApiKey.deleteMany({ where: { tenantId } });
  await prisma.tenantConfig.deleteMany({ where: { tenantId } });
  // Phase 64b (issue #64): Salon.tenant is onDelete: Restrict (D-01) — must be deleted before
  // prisma.tenant.delete below, or the delete fails and leaks fixture rows into the shared test
  // database. Phase 325 (issue #325) / Phase 67b Plan 03 (D-24): seedTestData() now creates ONE
  // default salon for its tenant (opt-out via `{ withDefaultSalon: false }`) — this deleteMany
  // covers that row as well as any salon a suite created directly. Shift/PhorestAppointment ->
  // Salon and EmployeeSalonAssignment -> Salon are ALSO onDelete: Restrict, but the
  // shift.deleteMany, phorestAppointment.deleteMany, and employeeSalonAssignment.deleteMany above
  // already run before this.
  // Phase 65b (issue #65): SalonCoupling -> Salon and PhorestSyncRun.salonId -> Salon are Restrict
  // too, so both must also be cleared before the salon delete below.
  await prisma.salonCoupling.deleteMany({ where: { tenantId } });
  await prisma.phorestSyncRun.deleteMany({ where: { tenantId } });
  await prisma.salon.deleteMany({ where: { tenantId } });
  // Issue #93 (D-20): SupportAccess.tenant is onDelete: Restrict AND the table is append-only by
  // trigger (DELETE refused), so a fixture tenant holding a grant could never be deleted and would leak
  // into the shared test database. The trigger is disabled for exactly this one transaction (DDL is
  // transactional, so a failure re-enables it) — test code only, app code never does this.
  await prisma.$transaction([
    prisma.$executeRawUnsafe(`ALTER TABLE "SupportAccess" DISABLE TRIGGER USER`),
    prisma.supportAccess.deleteMany({ where: { tenantId } }),
    prisma.$executeRawUnsafe(`ALTER TABLE "SupportAccess" ENABLE TRIGGER USER`),
  ]);
  await prisma.tenant.delete({ where: { id: tenantId } });
}

/** Policy-conforming operator password used by every seeded operator (a fixture, not a secret). */
export const SEEDED_OPERATOR_PASSWORD = "Op-Fixture-Passw0rd!2026";

export type SeededOperator = {
  id: string;
  email: string;
  password: string;
  secretBase32: string;
  recoveryCodes: string[];
  /** The account's current token version (Issue #557); a hand-signed operator token must carry it as `ver`. */
  tokenVersion: number;
  /**
   * The TOTP code of the current 30 s step plus `stepOffset` steps. Two logins inside one 30 s window
   * need different offsets (0, then +1): the replay guard refuses a step that is not greater than the
   * last accepted one, and the validation window of 1 still accepts the next step.
   */
  totpFor: (stepOffset?: number) => string;
};

/**
 * Phase 88: creates a real operator account (TOTP + recovery codes) through the same function the server
 * CLI uses. Operator rows are never deleted by tests — audit rows reference them with onDelete Restrict
 * and the audit table is append-only — so every call uses a fresh synthetic email.
 */
export async function seedOperator(
  testApp: FastifyInstance,
  opts: { displayName?: string } = {},
): Promise<SeededOperator> {
  const email = `op-${randomBytes(6).toString("hex")}@example.invalid`;
  const result = await createOperatorAccount(testApp.prisma, {
    email,
    displayName: opts.displayName ?? "Test Operator",
    password: SEEDED_OPERATOR_PASSWORD,
    actor: { type: "SCRIPT", user: "vitest", host: "test" },
  });
  if (result.status !== "OK") {
    throw new Error(`seedOperator failed: ${result.status}`);
  }
  const { tokenVersion } = await testApp.prisma.operatorAccount.findUniqueOrThrow({
    where: { id: result.account.id },
    select: { tokenVersion: true },
  });
  const totp = new TOTP({
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(result.enrollment.secretBase32),
  });
  return {
    id: result.account.id,
    email: result.account.email,
    password: SEEDED_OPERATOR_PASSWORD,
    secretBase32: result.enrollment.secretBase32,
    recoveryCodes: result.recoveryCodes,
    tokenVersion,
    totpFor: (stepOffset = 0) => totp.generate({ timestamp: Date.now() + stepOffset * 30_000 }),
  };
}

/**
 * Issue #93: inserts a support access grant directly (an INSERT is allowed by the immutability trigger),
 * so a test can create grants the API never would — already expired, already ended, or backdated. Defaults
 * to a running one-hour grant. Returns the stored row.
 */
export async function seedSupportAccess(
  testApp: FastifyInstance,
  opts: {
    tenantId: string;
    operatorId: string;
    reason?: string;
    startedAt?: Date;
    expiresAt?: Date;
    endedAt?: Date | null;
    endedBy?: "OPERATOR" | "TENANT" | null;
    endedByUserId?: string | null;
    createdAt?: Date;
  },
) {
  const startedAt = opts.startedAt ?? new Date();
  return testApp.prisma.supportAccess.create({
    data: {
      tenantId: opts.tenantId,
      operatorId: opts.operatorId,
      reason: opts.reason ?? "Support ticket: fixture grant for a test",
      startedAt,
      expiresAt: opts.expiresAt ?? new Date(startedAt.getTime() + 3_600_000),
      endedAt: opts.endedAt ?? null,
      endedBy: opts.endedBy ?? null,
      endedByUserId: opts.endedByUserId ?? null,
      createdAt: opts.createdAt,
    },
  });
}

// ── Ordered audit reads (Issue #561, flake class of #555) ────────────────────────────────────────

export type AuditRow = Awaited<
  ReturnType<FastifyInstance["prisma"]["auditLog"]["findMany"]>
>[number];

/**
 * Every audit row of an entity (optionally one action), in creation order — `createdAt`, then `id`
 * as the tie-break for rows written in the same millisecond. One action can write several audit
 * rows (an approval heals `totalDays` AND recomputes `carriedOverDays`), so a test never picks
 * "the" row with an unordered `findFirst`: it reads all of them here and selects by what it means.
 * `lint:unordered-test-reads` fails on the unordered shape.
 */
export async function auditRowsFor(
  app: FastifyInstance,
  entity: string,
  entityId: string,
  action?: string,
): Promise<AuditRow[]> {
  return app.prisma.auditLog.findMany({
    where: { entity, entityId, ...(action === undefined ? {} : { action }) },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

const ORDERED = [{ createdAt: "asc" as const }, { id: "asc" as const }];

function describeRows(rows: { id: string; createdAt: Date; action?: string }[]): string {
  return rows
    .map((r) => `${r.id}${r.action ? ` ${r.action}` : ""} @ ${r.createdAt.toISOString()}`)
    .join("; ");
}

/**
 * The ONE audit row matching `args.where`, or `null` when none matches. Throws, listing the matched
 * rows, when several match — a later second write of the same action must fail the test instead of
 * being silently ignored (Issue #561, #555). Narrow the `where` when the test means one specific
 * row, or read all rows with `auditRowsFor()` and assert on every one.
 */
export async function soleAuditRowOrNull<T extends Prisma.AuditLogFindManyArgs>(
  db: { auditLog: FastifyInstance["prisma"]["auditLog"] },
  args: T,
): Promise<Prisma.AuditLogGetPayload<T> | null> {
  const rows = (await db.auditLog.findMany({
    ...args,
    orderBy: ORDERED,
  })) as unknown as (Prisma.AuditLogGetPayload<T> & {
    id: string;
    createdAt: Date;
    action?: string;
  })[];
  if (rows.length > 1) {
    throw new Error(
      `expected at most one audit row for ${JSON.stringify(args.where)}, matched ${rows.length}: ${describeRows(rows)}`,
    );
  }
  return rows[0] ?? null;
}

/** Like {@link soleAuditRowOrNull}, but throws when no row matches. */
export async function soleAuditRow<T extends Prisma.AuditLogFindManyArgs>(
  db: { auditLog: FastifyInstance["prisma"]["auditLog"] },
  args: T,
): Promise<Prisma.AuditLogGetPayload<T>> {
  const row = await soleAuditRowOrNull(db, args);
  if (row === null) {
    throw new Error(`expected exactly one audit row for ${JSON.stringify(args.where)}, matched 0`);
  }
  return row;
}

/** The ONE notification matching `args.where`, or `null`; throws when several match. */
export async function soleNotificationOrNull<T extends Prisma.NotificationFindManyArgs>(
  db: { notification: FastifyInstance["prisma"]["notification"] },
  args: T,
): Promise<Prisma.NotificationGetPayload<T> | null> {
  const rows = (await db.notification.findMany({
    ...args,
    orderBy: ORDERED,
  })) as unknown as (Prisma.NotificationGetPayload<T> & {
    id: string;
    createdAt: Date;
  })[];
  if (rows.length > 1) {
    throw new Error(
      `expected at most one notification for ${JSON.stringify(args.where)}, matched ${rows.length}: ${describeRows(rows)}`,
    );
  }
  return rows[0] ?? null;
}

/** Like {@link soleNotificationOrNull}, but throws when no notification matches. */
export async function soleNotification<T extends Prisma.NotificationFindManyArgs>(
  db: { notification: FastifyInstance["prisma"]["notification"] },
  args: T,
): Promise<Prisma.NotificationGetPayload<T>> {
  const row = await soleNotificationOrNull(db, args);
  if (row === null) {
    throw new Error(
      `expected exactly one notification for ${JSON.stringify(args.where)}, matched 0`,
    );
  }
  return row;
}

/** The rows whose `newValue` carries `field` — exactly the audits that changed that column. */
export function auditRowsChangingField(rows: AuditRow[], field: string): AuditRow[] {
  return rows.filter(
    (r) => typeof r.newValue === "object" && r.newValue !== null && field in r.newValue,
  );
}

/**
 * The ONE audit row that changed `field`. Throws (instead of picking one) when zero or several rows
 * carry it, so an accidental double write surfaces as a red test, never as a coin flip.
 */
export async function auditRowChangingField(
  app: FastifyInstance,
  entity: string,
  entityId: string,
  action: string,
  field: string,
): Promise<AuditRow> {
  const rows = auditRowsChangingField(await auditRowsFor(app, entity, entityId, action), field);
  if (rows.length !== 1) {
    throw new Error(
      `expected exactly one ${entity} ${action} audit row changing "${field}" for ${entityId}, found ${rows.length}`,
    );
  }
  return rows[0]!;
}
