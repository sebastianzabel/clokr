/**
 * Issue #539 (Release A), D-01 — fixture test for backfill-539-role-assignments.ts.
 *
 * The script takes over every ACTIVE user that holds no stored role assignment in its tenant and
 * gives it, as one audited system assignment, exactly what the legacy-role fallback used to resolve
 * for it (the fallback itself is gone since #539 Release A: an unassigned user holds nothing, so the
 * takeover is what gives such a user its rights back). The worker test database may hold users left behind by other files, so every assertion is on
 * the fixture's own ids; global counts are asserted only through the exit codes and as lower bounds.
 *
 * The runs happen once, in `beforeAll`, in this order: dry run -> first `--confirm` -> second
 * `--confirm` -> dry run again. Each `it` then reads one aspect of that history.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import type { Role } from "@clokr/db";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  grantSystemRole,
  soleAuditRow,
} from "../../src/__tests__/setup";
import {
  PERMISSIONS,
  permissionKey,
  resolveAccessReach,
  userIdsHoldingPermission,
  type AccessContext,
  type PermissionKey,
} from "../../src/contexts/platform";
import { effectivePermissionKeysForUser } from "../../src/contexts/platform/request-permissions";
import { SYSTEM_ROLE_IDS } from "../../src/contexts/platform/system-roles";
import { deriveCompatRole } from "../../src/contexts/platform/compat-role";
import {
  main,
  parseCli,
  findTakeoverCandidates,
  takeOverUser,
  schemaProblem,
  EXIT_OK,
  EXIT_ERROR,
  EXIT_FINDINGS,
} from "../backfill-539-role-assignments";

const REASON = "Übernahme der Alt-Rolle (#75)";

/** Every ZUGEWIESEN key of the catalog — derived, never typed by hand. */
const ZUGEWIESEN_KEYS: PermissionKey[] = PERMISSIONS.filter((p) => p.reach === "ZUGEWIESEN").map(
  permissionKey,
);

async function capture(fn: () => Promise<number>): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  try {
    const code = await fn();
    return { code, lines };
  } finally {
    spy.mockRestore();
  }
}

type Seed = Awaited<ReturnType<typeof seedTestData>>;
type Run = { code: number; lines: string[] };

describe("backfill-539-role-assignments (Issue #539, D-01)", () => {
  let app: FastifyInstance;
  let seed: Seed;
  let deactivatedSeed: Seed;
  const userIds: string[] = [];
  /** The ids the dry run listed anywhere in the worker database (fixture or leftover). */
  let everyListedUserId: string[] = [];

  const fixture: Record<
    | "admin"
    | "manager"
    | "employee"
    | "inactive"
    | "anonymised"
    | "noEmployee"
    | "malformed"
    | "deactivatedTenant"
    | "drift",
    { id: string; role: Role; email: string }
  > = {} as never;

  let dryRun: Run;
  let confirmRun: Run;
  let secondConfirmRun: Run;
  let finalDryRun: Run;
  let rowsBefore: Map<string, number>;
  let columnsBefore: Map<string, Role>;
  /** What each fixture user resolved to BEFORE the first --confirm (nothing, if unassigned: #539). */
  const profilesBefore = new Map<string, Awaited<ReturnType<typeof profileOf>>>();

  async function createUser(input: {
    key: keyof typeof fixture;
    tenantId: string | null;
    role: Role;
    isActive: boolean;
    anonymised?: boolean;
  }) {
    const s = `${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
    const email = `bf539-${input.key}-${s}@example.invalid`;
    const user = await app.prisma.user.create({
      data: {
        email,
        passwordHash: await bcrypt.hash("Test@1234567!", 4),
        role: input.role,
        isActive: input.isActive,
      },
    });
    userIds.push(user.id);
    if (input.tenantId !== null) {
      await app.prisma.employee.create({
        data: {
          tenantId: input.tenantId,
          userId: user.id,
          employeeNumber: input.anonymised ? `GELÖSCHT-${s}`.slice(0, 20) : `BF-${s}`.slice(0, 20),
          firstName: input.anonymised ? "Gelöscht" : input.key,
          lastName: input.anonymised ? `GELÖSCHT-${s.slice(0, 6)}` : "Fixture",
          hireDate: new Date("2024-01-01"),
        },
      });
    }
    fixture[input.key] = { id: user.id, role: input.role, email };
    return user;
  }

  const eligibleKeys = ["admin", "manager", "employee", "deactivatedTenant"] as const;
  const excludedKeys = ["inactive", "anonymised", "noEmployee", "malformed", "drift"] as const;

  function listedIds(run: Run): string[] {
    return run.lines
      .map((line) => /^userId=(\S+) tenantId=(\S+) legacyRole=(\S+)$/.exec(line)?.[1])
      .filter((id): id is string => id !== undefined);
  }

  /**
   * The three answers a takeover must not change: the effective permission keys, the reach for
   * every ZUGEWIESEN key, and membership in the recipient list of every ZUGEWIESEN key.
   */
  async function profileOf(userId: string, tenantId: string) {
    const ctx: AccessContext = {
      tenantId,
      actor: { kind: "user", userId },
      reach: { kind: "wholeTenant" },
    };
    const keys = await effectivePermissionKeysForUser(app.prisma, userId, tenantId);
    const reach: Record<string, unknown> = {};
    const recipient: Record<string, boolean> = {};
    for (const key of ZUGEWIESEN_KEYS) {
      reach[key] = await resolveAccessReach(app.prisma, ctx, key);
      recipient[key] = (await userIdsHoldingPermission(app.prisma, tenantId, key)).includes(userId);
    }
    return { keys, reach, recipient };
  }

  function tenantOf(key: keyof typeof fixture): string {
    return key === "deactivatedTenant" ? deactivatedSeed.tenant.id : seed.tenant.id;
  }

  async function rowsOf(userId: string) {
    return app.prisma.roleAssignment.findMany({
      where: { userId },
      select: {
        id: true,
        tenantId: true,
        accessRoleId: true,
        scopeType: true,
        salonIds: true,
        employeeIds: true,
        accessRole: { select: { id: true, tenantId: true, permissions: true, name: true } },
      },
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "bf539");
    deactivatedSeed = await seedTestData(app, "bf539d");
    // A deactivated tenant is a tenant state, not something the shared seed offers: the fixture
    // flips it directly. The takeover is not tenant-state-aware (the fallback used to serve such a user too).
    await app.prisma.tenant.update({
      where: { id: deactivatedSeed.tenant.id },
      data: { deactivatedAt: new Date() },
    });
    const t = seed.tenant.id;

    await createUser({ key: "admin", tenantId: t, role: "ADMIN", isActive: true });
    await createUser({ key: "manager", tenantId: t, role: "MANAGER", isActive: true });
    await createUser({ key: "employee", tenantId: t, role: "EMPLOYEE", isActive: true });
    await createUser({ key: "inactive", tenantId: t, role: "MANAGER", isActive: false });
    // Active, so that only the anonymisation sentinel keeps it out of the takeover.
    await createUser({
      key: "anonymised",
      tenantId: t,
      role: "ADMIN",
      isActive: true,
      anonymised: true,
    });
    await createUser({ key: "noEmployee", tenantId: null, role: "ADMIN", isActive: true });
    const malformed = await createUser({
      key: "malformed",
      tenantId: t,
      role: "MANAGER",
      isActive: true,
    });
    // A SALONS row without a salon violates the stored-row shape: it grants nothing, yet it
    // used to switch the old fallback off — so the user must keep holding nothing.
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: t,
        userId: malformed.id,
        accessRoleId: SYSTEM_ROLE_IDS.MANAGER,
        scopeType: "SALONS",
        salonIds: [],
        employeeIds: [],
      },
    });
    await createUser({
      key: "deactivatedTenant",
      tenantId: deactivatedSeed.tenant.id,
      role: "MANAGER",
      isActive: true,
    });
    const drift = await createUser({ key: "drift", tenantId: t, role: "EMPLOYEE", isActive: true });
    await grantSystemRole(app.prisma, { tenantId: t, userId: drift.id, role: "MANAGER" });

    rowsBefore = new Map();
    columnsBefore = new Map();
    for (const key of [...eligibleKeys, ...excludedKeys]) {
      const id = fixture[key].id;
      rowsBefore.set(id, (await rowsOf(id)).length);
      columnsBefore.set(id, fixture[key].role);
    }

    for (const key of [...eligibleKeys, ...excludedKeys]) {
      if (key === "noEmployee") continue; // no tenant, nothing resolves
      profilesBefore.set(fixture[key].id, await profileOf(fixture[key].id, tenantOf(key)));
    }

    dryRun = await capture(() => main([], app.prisma));
    everyListedUserId = listedIds(dryRun);
    confirmRun = await capture(() => main(["--confirm"], app.prisma));
    secondConfirmRun = await capture(() => main(["--confirm"], app.prisma));
    finalDryRun = await capture(() => main([], app.prisma));
  });

  afterAll(async () => {
    try {
      // The runs also took over any leftover user of the worker database. Undo exactly that:
      // those assignments and their userId-null audit rows would otherwise outlive this file and
      // leak into the activity feeds and recipient lists of later files on the same database.
      const created = await app.prisma.roleAssignment.findMany({
        where: { userId: { in: [...new Set([...everyListedUserId, ...userIds])] } },
        select: { id: true },
      });
      await app.prisma.auditLog.deleteMany({
        where: { entity: "RoleAssignment", entityId: { in: created.map((row) => row.id) } },
      });
      await app.prisma.roleAssignment.deleteMany({
        where: { userId: { in: [...new Set([...everyListedUserId, ...userIds])] } },
      });
      await cleanupTestData(app, seed.tenant.id);
      await cleanupTestData(app, deactivatedSeed.tenant.id);
      await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
    } catch (err) {
      console.error("backfill-539 cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("the fixture and the walked sets are not empty (anti-vacuity)", () => {
    expect(eligibleKeys.length).toBe(4);
    expect(excludedKeys.length).toBe(5);
    expect(userIds.length).toBe(9);
    expect(dryRun.lines.length).toBeGreaterThan(0);
    expect(confirmRun.lines.length).toBeGreaterThan(0);
  });

  describe("dry run (the default)", () => {
    it("exits 2 and lists exactly the eligible fixture users, one line each with tenant and compat role", () => {
      expect(dryRun.code).toBe(EXIT_FINDINGS);
      for (const key of eligibleKeys) {
        const own = dryRun.lines.filter((l) => l.includes(`userId=${fixture[key].id} `));
        expect(own, key).toHaveLength(1);
        expect(own[0]).toContain(`legacyRole=${fixture[key].role}`);
      }
      for (const key of eligibleKeys) {
        const line = dryRun.lines.find((l) => l.includes(`userId=${fixture[key].id} `));
        expect(line).toContain(`tenantId=${tenantOf(key)}`);
      }
    });

    it("never lists an excluded fixture user, nor a seed user that already holds a stored assignment", () => {
      const output = dryRun.lines.join("\n");
      for (const key of excludedKeys) expect(output, key).not.toContain(fixture[key].id);
      for (const id of [
        seed.adminUser.id,
        seed.empUser.id,
        deactivatedSeed.adminUser.id,
        deactivatedSeed.empUser.id,
      ]) {
        expect(output).not.toContain(id);
      }
    });

    it("prints totals per compat role and the informational counts, and they cover the fixture", () => {
      const totals = dryRun.lines.find((l) => l.startsWith("Totals: "));
      expect(totals).toBeDefined();
      const num = (line: string, name: string) =>
        Number(new RegExp(`${name}=(\\d+)`).exec(line)?.[1] ?? Number.NaN);
      const eligible = num(totals!, "eligible");
      expect(eligible).toBe(listedIds(dryRun).length);
      expect(num(totals!, "ADMIN") + num(totals!, "MANAGER") + num(totals!, "EMPLOYEE")).toBe(
        eligible,
      );
      expect(num(totals!, "ADMIN")).toBeGreaterThanOrEqual(1);
      expect(num(totals!, "MANAGER")).toBeGreaterThanOrEqual(2);
      expect(num(totals!, "EMPLOYEE")).toBeGreaterThanOrEqual(1);
      expect(num(totals!, "inDeactivatedTenants")).toBeGreaterThanOrEqual(1);

      const info = dryRun.lines.find((l) => l.startsWith("Informational: "));
      expect(info).toBeDefined();
      expect(num(info!, "inactiveWithoutAssignment")).toBeGreaterThanOrEqual(1);
      expect(num(info!, "anonymisedWithoutAssignment")).toBeGreaterThanOrEqual(1);
      expect(num(info!, "withoutEmployee")).toBeGreaterThanOrEqual(1);
      expect(num(info!, "malformedOnly")).toBeGreaterThanOrEqual(1);
      expect(num(info!, "columnDrift")).toBeGreaterThanOrEqual(1);
    });

    it("prints ids and counts only: no output line of any run carries an @ or a fixture e-mail", () => {
      for (const run of [dryRun, confirmRun, secondConfirmRun, finalDryRun]) {
        for (const line of run.lines) expect(line).not.toContain("@");
        const output = run.lines.join("\n");
        for (const key of [...eligibleKeys, ...excludedKeys]) {
          expect(output).not.toContain(fixture[key].email);
        }
      }
    });

    it("writes nothing: the dry run alone leaves no assignment and no audit row for a fixture user", async () => {
      // The history of this file runs the dry run first; a fresh dry run must also change nothing.
      const probe = await app.prisma.user.create({
        data: {
          email: `bf539-probe-${randomBytes(4).toString("hex")}@example.invalid`,
          passwordHash: "x",
          role: "EMPLOYEE",
          isActive: true,
        },
      });
      userIds.push(probe.id);
      await app.prisma.employee.create({
        data: {
          tenantId: seed.tenant.id,
          userId: probe.id,
          employeeNumber: `BFP-${randomBytes(4).toString("hex")}`,
          firstName: "probe",
          lastName: "Fixture",
          hireDate: new Date("2024-01-01"),
        },
      });
      const run = await capture(() => main([], app.prisma));
      expect(run.code).toBe(EXIT_FINDINGS);
      expect(run.lines.some((l) => l.includes(`userId=${probe.id} `))).toBe(true);
      expect(await app.prisma.roleAssignment.count({ where: { userId: probe.id } })).toBe(0);
      const audits = await app.prisma.auditLog.count({
        where: { entity: "RoleAssignment", newValue: { path: ["userId"], equals: probe.id } },
      });
      expect(audits).toBe(0);
    });
  });

  describe("--confirm", () => {
    it("exits 0, prints written and skipped counts, and the fixture's eligible users were all written", () => {
      expect(confirmRun.code).toBe(EXIT_OK);
      const line = confirmRun.lines.find((l) => /^written=\d+ skipped=\d+$/.test(l));
      expect(line).toBeDefined();
      const written = Number(/written=(\d+)/.exec(line!)?.[1]);
      expect(written).toBeGreaterThanOrEqual(eligibleKeys.length);
      expect(written).toBe(listedIds(dryRun).length);
    });

    it("gives each eligible user exactly one TENANT row on the system role of its column", async () => {
      const expectedRoleId: Record<Role, string> = {
        ADMIN: SYSTEM_ROLE_IDS.ADMIN,
        MANAGER: SYSTEM_ROLE_IDS.MANAGER,
        EMPLOYEE: SYSTEM_ROLE_IDS.EMPLOYEE,
      };
      for (const key of eligibleKeys) {
        const rows = await rowsOf(fixture[key].id);
        expect(rows, key).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          scopeType: "TENANT",
          salonIds: [],
          employeeIds: [],
          accessRoleId: expectedRoleId[fixture[key].role],
          tenantId: tenantOf(key),
        });
      }
    });

    it("writes exactly one SYSTEM CREATE audit row per created assignment", async () => {
      for (const key of eligibleKeys) {
        const [row] = await rowsOf(fixture[key].id);
        const audits = await app.prisma.auditLog.count({
          where: { entity: "RoleAssignment", entityId: row.id },
        });
        expect(audits, key).toBe(1);
        const audit = await soleAuditRow(app.prisma, {
          where: { entity: "RoleAssignment", entityId: row.id },
        });
        expect(audit).toMatchObject({
          action: "CREATE",
          entity: "RoleAssignment",
          entityId: row.id,
          userId: null,
          ipAddress: null,
          userAgent: null,
          oldValue: null,
        });
        expect(audit.newValue).toEqual({
          userId: fixture[key].id,
          accessRoleId: row.accessRoleId,
          roleName: row.accessRole.name,
          scopeType: "TENANT",
          salonIds: [],
          employeeIds: [],
          origin: "SYSTEM",
          reason: REASON,
          legacyRole: fixture[key].role,
        });
      }
    });

    it("leaves every excluded user untouched: rows, audit rows and columns are unchanged", async () => {
      for (const key of excludedKeys) {
        const id = fixture[key].id;
        const rows = await rowsOf(id);
        expect(rows.length, key).toBe(rowsBefore.get(id));
        const audits = await app.prisma.auditLog.count({
          where: {
            entity: "RoleAssignment",
            entityId: { in: rows.map((row) => row.id) },
          },
        });
        // The pre-existing rows of the malformed and drift users were created by the fixture, not by
        // the script, so no SYSTEM audit row exists for any of them.
        expect(audits, key).toBe(0);
      }
      const malformedRows = await rowsOf(fixture.malformed.id);
      expect(malformedRows).toHaveLength(1);
      expect(malformedRows[0]).toMatchObject({ scopeType: "SALONS", salonIds: [] });
      const driftRows = await rowsOf(fixture.drift.id);
      expect(driftRows).toHaveLength(1);
      expect(driftRows[0].accessRoleId).toBe(SYSTEM_ROLE_IDS.MANAGER);
    });

    it("never writes User.role: every column is unchanged and the taken-over ones equal the compat role derived from their rows", async () => {
      for (const key of [...eligibleKeys, ...excludedKeys]) {
        const user = await app.prisma.user.findUniqueOrThrow({
          where: { id: fixture[key].id },
          select: { role: true },
        });
        expect(user.role, key).toBe(columnsBefore.get(fixture[key].id));
      }
      for (const key of eligibleKeys) {
        const rows = await rowsOf(fixture[key].id);
        expect(deriveCompatRole(tenantOf(key), rows), key).toBe(fixture[key].role);
      }
    });
  });

  describe("idempotency", () => {
    it("a second --confirm writes nothing and exits 0, and a dry run afterwards exits 0", async () => {
      expect(secondConfirmRun.code).toBe(EXIT_OK);
      expect(secondConfirmRun.lines).toContain("written=0 skipped=0");
      expect(listedIds(secondConfirmRun)).toHaveLength(0);
      expect(finalDryRun.code).toBe(EXIT_OK);
      expect(listedIds(finalDryRun)).toHaveLength(0);
      for (const key of eligibleKeys) {
        expect(
          await app.prisma.roleAssignment.count({ where: { userId: fixture[key].id } }),
          key,
        ).toBe(1);
      }
    });
  });

  describe("rights neutrality (AC-539-2)", () => {
    describe("before the takeover a user holds nothing (fail-closed), after it the rights of the production-created reference (#539 Release A)", () => {
      /** An empty profile: no keys, a scoped-empty reach for every ZUGEWIESEN key, never a recipient. */
      function expectHoldsNothing(
        profile: Awaited<ReturnType<typeof profileOf>> | undefined,
        label: string,
      ) {
        expect(profile, label).toBeDefined();
        expect(profile!.keys, `${label} keys`).toEqual([]);
        for (const key of ZUGEWIESEN_KEYS) {
          expect(profile!.reach[key], `${label} reach ${key}`).toEqual({
            kind: "scoped",
            salonIds: [],
            employeeIds: [],
          });
          expect(profile!.recipient[key], `${label} recipient ${key}`).toBe(false);
        }
      }

      it("the profiles compared tell the three roles apart after the takeover, and every eligible user held nothing before (anti-vacuity)", async () => {
        expect(ZUGEWIESEN_KEYS.length).toBeGreaterThan(0);
        for (const key of eligibleKeys) {
          expectHoldsNothing(profilesBefore.get(fixture[key].id), `${key} before`);
        }
        const admin = await profileOf(fixture.admin.id, tenantOf("admin"));
        const manager = await profileOf(fixture.manager.id, tenantOf("manager"));
        const employee = await profileOf(fixture.employee.id, tenantOf("employee"));
        expect(admin.keys.length).toBeGreaterThan(0);
        expect(employee.keys.length).toBeGreaterThan(0);
        // Not the same thing for each role: Admin holds a recipient slot the Mitarbeiter does not,
        // and the Mitarbeiter holds no whole-tenant reach at all.
        expect(Object.values(admin.recipient).some(Boolean)).toBe(true);
        expect(Object.values(employee.recipient).some(Boolean)).toBe(false);
        expect(admin.keys.length).toBeGreaterThan(manager.keys.length);
        expect(manager.keys.length).toBeGreaterThan(employee.keys.length);
      });

      it("each taken-over user held nothing before the takeover and holds the rights of its system role after it", async () => {
        for (const key of eligibleKeys) {
          expectHoldsNothing(profilesBefore.get(fixture[key].id), `${key} before`);
          const after = await profileOf(fixture[key].id, tenantOf(key));
          expect(after.keys.length, `${key} permission keys`).toBeGreaterThan(0);
          expect(after, `${key} after differs from before`).not.toEqual(
            profilesBefore.get(fixture[key].id),
          );
        }
      });

      it("no excluded user changes: what it resolved to before, it resolves to after — and a user without a stored row still holds nothing", async () => {
        for (const key of excludedKeys) {
          if (key === "noEmployee") continue;
          const before = profilesBefore.get(fixture[key].id);
          expect(before, key).toBeDefined();
          expect(await profileOf(fixture[key].id, tenantOf(key)), key).toEqual(before);
        }
        for (const key of ["inactive", "anonymised", "malformed"] as const) {
          expectHoldsNothing(await profileOf(fixture[key].id, tenantOf(key)), `${key} after`);
        }
        // The drift user holds a stored Manager row, so its rights are the stored ones, before and after.
        expect(profilesBefore.get(fixture.drift.id)!.keys.length).toBeGreaterThan(0);
      });
    });

    describe("against a holder created through the production path", () => {
      async function createThroughApi(role: Role) {
        const uid = randomBytes(4).toString("hex");
        const email = `bf539-api-${role.toLowerCase()}-${uid}@example.invalid`;
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/employees",
          headers: { authorization: `Bearer ${seed.adminToken}` },
          payload: {
            usualWorkDays: [1, 2, 3, 4, 5],
            email,
            firstName: role,
            lastName: "Fixture",
            employeeNumber: `BA-${uid}`,
            hireDate: "2026-01-01T00:00:00.000Z",
            role,
            password: "Test@1234567!",
          },
        });
        expect(res.statusCode).toBe(201);
        const user = await app.prisma.user.findUniqueOrThrow({ where: { email } });
        userIds.push(user.id);
        return user;
      }

      for (const [key, role] of [
        ["admin", "ADMIN"],
        ["manager", "MANAGER"],
        ["employee", "EMPLOYEE"],
      ] as const) {
        it(`the taken-over ${role} equals a ${role} created through POST /api/v1/employees`, async () => {
          const reference = await createThroughApi(role);
          // Same stored row, not merely the same answers: the takeover writes what employee creation writes.
          const taken = await rowsOf(fixture[key].id);
          const referenceRows = await rowsOf(reference.id);
          expect(referenceRows).toHaveLength(1);
          expect(taken).toHaveLength(1);
          expect({
            accessRoleId: taken[0].accessRoleId,
            scopeType: taken[0].scopeType,
            salonIds: taken[0].salonIds,
            employeeIds: taken[0].employeeIds,
            tenantId: taken[0].tenantId,
          }).toEqual({
            accessRoleId: referenceRows[0].accessRoleId,
            scopeType: referenceRows[0].scopeType,
            salonIds: referenceRows[0].salonIds,
            employeeIds: referenceRows[0].employeeIds,
            tenantId: referenceRows[0].tenantId,
          });
          const takenProfile = await profileOf(fixture[key].id, seed.tenant.id);
          const referenceProfile = await profileOf(reference.id, seed.tenant.id);
          expect(takenProfile.keys.length).toBeGreaterThan(0);
          expect(takenProfile.keys).toEqual(referenceProfile.keys);
          expect(takenProfile.reach).toEqual(referenceProfile.reach);
          expect(takenProfile.recipient).toEqual(referenceProfile.recipient);
        });
      }
    });
  });

  describe("race", () => {
    it("takeOverUser skips a candidate that gained an assignment after it was selected and creates no second row", async () => {
      const racer = await app.prisma.user.create({
        data: {
          email: `bf539-race-${randomBytes(4).toString("hex")}@example.invalid`,
          passwordHash: "x",
          role: "MANAGER",
          isActive: true,
        },
      });
      userIds.push(racer.id);
      await app.prisma.employee.create({
        data: {
          tenantId: seed.tenant.id,
          userId: racer.id,
          employeeNumber: `BFR-${randomBytes(4).toString("hex")}`,
          firstName: "racer",
          lastName: "Fixture",
          hireDate: new Date("2024-01-01"),
        },
      });
      const { candidates } = await findTakeoverCandidates(app.prisma);
      const candidate = candidates.find((c) => c.userId === racer.id);
      expect(candidate).toBeDefined();
      // A concurrent assignment write commits between the selection and the takeover.
      await grantSystemRole(app.prisma, {
        tenantId: seed.tenant.id,
        userId: racer.id,
        role: "ADMIN",
      });
      expect(await takeOverUser(app.prisma, candidate!)).toBe("SKIPPED");
      const rows = await rowsOf(racer.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].accessRoleId).toBe(SYSTEM_ROLE_IDS.ADMIN);
      const audits = await app.prisma.auditLog.count({
        where: { entity: "RoleAssignment", entityId: rows[0].id },
      });
      expect(audits).toBe(0);
    });

    it("takeOverUser skips a candidate that was deactivated after it was selected", async () => {
      const late = await app.prisma.user.create({
        data: {
          email: `bf539-late-${randomBytes(4).toString("hex")}@example.invalid`,
          passwordHash: "x",
          role: "EMPLOYEE",
          isActive: true,
        },
      });
      userIds.push(late.id);
      await app.prisma.employee.create({
        data: {
          tenantId: seed.tenant.id,
          userId: late.id,
          employeeNumber: `BFL-${randomBytes(4).toString("hex")}`,
          firstName: "late",
          lastName: "Fixture",
          hireDate: new Date("2024-01-01"),
        },
      });
      const { candidates } = await findTakeoverCandidates(app.prisma);
      const candidate = candidates.find((c) => c.userId === late.id);
      expect(candidate).toBeDefined();
      await app.prisma.user.update({ where: { id: late.id }, data: { isActive: false } });
      expect(await takeOverUser(app.prisma, candidate!)).toBe("SKIPPED");
      expect(await app.prisma.roleAssignment.count({ where: { userId: late.id } })).toBe(0);
    });
  });

  describe("schema pre-check (Issue #707)", () => {
    it("a database without Tenant.deactivatedAt exits 1 with an operator message and runs no candidate query", async () => {
      const findMany = vi.fn();
      const fake = {
        $queryRaw: vi.fn().mockResolvedValue([]),
        user: { findMany },
      } as unknown as typeof app.prisma;
      const errors: string[] = [];
      const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
        errors.push(a.map(String).join(" "));
      });
      try {
        expect(await main([], fake)).toBe(EXIT_ERROR);
      } finally {
        spy.mockRestore();
      }
      expect(errors.join("\n")).toMatch(/Tenant"\."deactivatedAt" is missing/);
      expect(errors.join("\n")).toMatch(/migrate deploy/);
      expect(findMany).not.toHaveBeenCalled();
    });

    it("the migrated test database passes the pre-check", async () => {
      expect(await schemaProblem(app.prisma)).toBeNull();
    });
  });

  describe("command line", () => {
    it("--help exits 0 and prints the usage; an unknown flag is rejected", async () => {
      const help = await capture(() => main(["--help"], app.prisma));
      expect(help.code).toBe(EXIT_OK);
      expect(help.lines.join("\n")).toContain("--confirm");
      expect(parseCli(["--confirm"])).toEqual({ help: false, confirm: true });
      expect(parseCli([])).toEqual({ help: false, confirm: false });
      await expect(main(["--apply"], app.prisma)).rejects.toThrow();
    });

    it("without DATABASE_URL and without an injected client it exits 1 and connects to nothing", async () => {
      const saved = process.env.DATABASE_URL;
      delete process.env.DATABASE_URL;
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        expect(await main([])).toBe(EXIT_ERROR);
        expect(await main(["--confirm"])).toBe(EXIT_ERROR);
      } finally {
        errSpy.mockRestore();
        if (saved !== undefined) process.env.DATABASE_URL = saved;
      }
    });

    it("the source calls no delete and never writes User.role, and importing the module is side-effect-free", () => {
      const source = readFileSync(
        fileURLToPath(new URL("../backfill-539-role-assignments.ts", import.meta.url)),
        "utf8",
      );
      expect(source.length).toBeGreaterThan(2000); // anti-vacuity: the scan read a real file
      expect(source).not.toMatch(/\.delete(Many)?\(/);
      expect(source).not.toMatch(/\.(update|updateMany|upsert)\(/);
      expect(source).not.toMatch(/\$executeRaw|\$executeRawUnsafe|\$queryRawUnsafe/);
      expect(process.exitCode ?? 0).toBe(0);
    });
  });
});
