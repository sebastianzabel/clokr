/**
 * Phase 75b (Issue #75), D-14 — the compat role is DERIVED from role assignments at one place.
 *
 * `deriveCompatRole` is pure: ADMIN for a well-formed TENANT assignment on the Admin system role
 * (by id), MANAGER when any effective assignment's role grants a ZUGEWIESEN permission, EMPLOYEE
 * otherwise. `compatRoleForUser` reads the stored rows and falls back to the column when there
 * are none — which must equal deriving over the implicit fallback assignment (proved here for all
 * three system roles, so the shortcut cannot drift from the resolver's D-08 fallback).
 *
 * No person names in fixtures (CLAUDE.md PII rule).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import type { Role } from "@clokr/db";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../../__tests__/setup";
import {
  assignmentExceedsEmployee,
  assignmentsBlockingDemotionToEmployee,
  compatRoleForUser,
  compatRoleUserWhere,
  deriveCompatRole,
  isDemotionToEmployee,
  isLegacySystemRoleId,
  parseCompatRoleFilter,
  materializeLegacyRoleAssignment,
  replaceSystemRoleAssignment,
  requestedRoleUnchanged,
  RoleDemotionBlockedError,
  syncCompatRoleColumn,
  systemRoleIdForLegacyRole,
  type CompatRoleAssignmentRow,
} from "../compat-role";
import { SYSTEM_ROLE_IDS, SYSTEM_ROLE_PERMISSIONS, type SystemRoleSlot } from "../system-roles";
import { roleNameKey } from "../access-role";

const TENANT = "tenant-under-test";
const OTHER_TENANT = "another-tenant";

function systemRow(
  slot: SystemRoleSlot,
  scope: Pick<CompatRoleAssignmentRow, "scopeType" | "salonIds" | "employeeIds"> = {
    scopeType: "TENANT",
    salonIds: [],
    employeeIds: [],
  },
): CompatRoleAssignmentRow {
  return {
    ...scope,
    accessRole: {
      id: SYSTEM_ROLE_IDS[slot],
      tenantId: null,
      permissions: SYSTEM_ROLE_PERMISSIONS[slot],
    },
  };
}

function customerRow(
  permissions: string[],
  opts: { tenantId?: string; scopeType?: "TENANT" | "SALONS" | "PERSONS" } = {},
): CompatRoleAssignmentRow {
  const scopeType = opts.scopeType ?? "TENANT";
  return {
    scopeType,
    salonIds: scopeType === "SALONS" ? ["salon-1"] : [],
    employeeIds: scopeType === "PERSONS" ? ["employee-1"] : [],
    accessRole: { id: "customer-role", tenantId: opts.tenantId ?? TENANT, permissions },
  };
}

describe("compat role — pure derivation (D-14)", () => {
  it("systemRoleIdForLegacyRole maps each legacy value onto its system role id", () => {
    expect(systemRoleIdForLegacyRole("ADMIN")).toBe(SYSTEM_ROLE_IDS.ADMIN);
    expect(systemRoleIdForLegacyRole("MANAGER")).toBe(SYSTEM_ROLE_IDS.MANAGER);
    expect(systemRoleIdForLegacyRole("EMPLOYEE")).toBe(SYSTEM_ROLE_IDS.EMPLOYEE);
  });

  it("isDemotionToEmployee is true only for a requested role of EMPLOYEE (Issue #357 sub-fix B)", () => {
    expect(isDemotionToEmployee("EMPLOYEE")).toBe(true);
    expect(isDemotionToEmployee("MANAGER")).toBe(false);
    expect(isDemotionToEmployee("ADMIN")).toBe(false);
  });

  it("Admin system role at TENANT scope → ADMIN", () => {
    expect(deriveCompatRole(TENANT, [systemRow("ADMIN")])).toBe("ADMIN");
  });

  it("Admin system role via SALONS scope → EMPLOYEE (Issue #357 sub-fix A: never below TENANT scope, not even MANAGER)", () => {
    expect(
      deriveCompatRole(TENANT, [
        systemRow("ADMIN", { scopeType: "SALONS", salonIds: ["salon-1"], employeeIds: [] }),
      ]),
    ).toBe("EMPLOYEE");
  });

  it("Manager → MANAGER; Mitarbeiter → EMPLOYEE", () => {
    expect(deriveCompatRole(TENANT, [systemRow("MANAGER")])).toBe("MANAGER");
    expect(deriveCompatRole(TENANT, [systemRow("EMPLOYEE")])).toBe("EMPLOYEE");
  });

  it("a customer role with a ZUGEWIESEN key at TENANT scope → MANAGER", () => {
    expect(
      deriveCompatRole(TENANT, [
        customerRow(["time-entry:read:EIGENE", "audit-log:read:ZUGEWIESEN"], {
          scopeType: "TENANT",
        }),
      ]),
    ).toBe("MANAGER");
  });

  // Issue #357 sub-fix A: before the fix `deriveCompatRole` ignored scope entirely for the
  // MANAGER check, so a SALONS/PERSONS-scoped customer role holding a ZUGEWIESEN key wrongly
  // derived MANAGER even though `request-permissions.ts` grants that key tenant-wide from a
  // TENANT-scope source only (D-09) — the assignment holder could do NOTHING tenant-wide at the
  // API, yet the compat role (JWT claim, login body, company-PDF filter) reported MANAGER.
  it.each(["SALONS", "PERSONS"] as const)(
    "a customer role with a ZUGEWIESEN key at %s scope → EMPLOYEE (grants nothing tenant-wide)",
    (scopeType) => {
      expect(
        deriveCompatRole(TENANT, [
          customerRow(["time-entry:read:EIGENE", "audit-log:read:ZUGEWIESEN"], { scopeType }),
        ]),
      ).toBe("EMPLOYEE");
    },
  );

  it("a customer role with EIGENE keys only → EMPLOYEE", () => {
    expect(
      deriveCompatRole(TENANT, [customerRow(["time-entry:read:EIGENE", "overtime:read:EIGENE"])]),
    ).toBe("EMPLOYEE");
  });

  it("a foreign tenant's customer role and a malformed row contribute nothing", () => {
    expect(
      deriveCompatRole(TENANT, [
        customerRow(["audit-log:read:ZUGEWIESEN"], { tenantId: OTHER_TENANT }),
      ]),
    ).toBe("EMPLOYEE");
    expect(
      deriveCompatRole(TENANT, [
        systemRow("ADMIN", { scopeType: "TENANT", salonIds: ["salon-1"], employeeIds: [] }),
      ]),
    ).toBe("EMPLOYEE");
  });

  it("the union decides: Mitarbeiter plus Admin at TENANT → ADMIN; empty → EMPLOYEE", () => {
    expect(deriveCompatRole(TENANT, [systemRow("EMPLOYEE"), systemRow("ADMIN")])).toBe("ADMIN");
    expect(deriveCompatRole(TENANT, [])).toBe("EMPLOYEE");
  });

  it.each(["ADMIN", "MANAGER", "EMPLOYEE"] as const)(
    "deriving over the implicit fallback assignment of a legacy %s yields exactly that value",
    (role: Role) => {
      const slot = (Object.keys(SYSTEM_ROLE_IDS) as SystemRoleSlot[]).find(
        (s) => SYSTEM_ROLE_IDS[s] === systemRoleIdForLegacyRole(role),
      );
      expect(slot).toBeDefined();
      expect(deriveCompatRole(TENANT, [systemRow(slot as SystemRoleSlot)])).toBe(role);
    },
  );
});

describe("compat role — assignmentExceedsEmployee (Issue #357 sub-fix B)", () => {
  it("a TENANT customer role with a ZUGEWIESEN key exceeds Mitarbeiter", () => {
    expect(
      assignmentExceedsEmployee(
        TENANT,
        customerRow(["time-entry:read:EIGENE", "audit-log:read:ZUGEWIESEN"], {
          scopeType: "TENANT",
        }),
      ),
    ).toBe(true);
  });

  // Unlike deriveCompatRole (sub-fix A), this check does NOT restrict itself to TENANT scope: a
  // salon- or person-scoped assignment still hands out real, if scoped, power that a demotion to
  // Mitarbeiter in the employee form must not leave behind unnoticed.
  it.each(["SALONS", "PERSONS"] as const)(
    "a %s-scoped customer role with a ZUGEWIESEN key ALSO exceeds Mitarbeiter",
    (scopeType) => {
      expect(
        assignmentExceedsEmployee(
          TENANT,
          customerRow(["time-entry:read:EIGENE", "audit-log:read:ZUGEWIESEN"], { scopeType }),
        ),
      ).toBe(true);
    },
  );

  it("a salon-scoped Admin system-role assignment exceeds Mitarbeiter", () => {
    expect(
      assignmentExceedsEmployee(
        TENANT,
        systemRow("ADMIN", { scopeType: "SALONS", salonIds: ["salon-1"], employeeIds: [] }),
      ),
    ).toBe(true);
  });

  it("a customer role with EIGENE keys only does NOT exceed Mitarbeiter", () => {
    expect(
      assignmentExceedsEmployee(
        TENANT,
        customerRow(["time-entry:read:EIGENE", "overtime:read:EIGENE"]),
      ),
    ).toBe(false);
  });

  it("a foreign tenant's role and a malformed row contribute nothing", () => {
    expect(
      assignmentExceedsEmployee(
        TENANT,
        customerRow(["audit-log:read:ZUGEWIESEN"], { tenantId: OTHER_TENANT }),
      ),
    ).toBe(false);
    expect(
      assignmentExceedsEmployee(
        TENANT,
        systemRow("ADMIN", { scopeType: "TENANT", salonIds: ["salon-1"], employeeIds: [] }),
      ),
    ).toBe(false);
  });
});

// Phase 76b (Issue #76), P-01: `isSystemRoleId()` covers all seven system roles once Plan 76b-01
// lands (D-03), but the employee-form bridge (`replaceSystemRoleAssignment`,
// `assignmentsBlockingDemotionToEmployee`) must keep narrowing itself to the THREE legacy ids
// (Admin, Manager, Mitarbeiter). D-10 is a locked decision, pinned here unmodified: a TENANT
// Inhaber or Personalabteilung assignment derives MANAGER (never ADMIN, never a new value); a
// SALONS/PERSONS-scoped Salonmanager or Ausbilder assignment contributes nothing.
describe("Phase 76b — templates in the compat module (P-01, D-10)", () => {
  it("isLegacySystemRoleId is true only for Admin, Manager and Mitarbeiter", () => {
    expect(isLegacySystemRoleId(SYSTEM_ROLE_IDS.ADMIN)).toBe(true);
    expect(isLegacySystemRoleId(SYSTEM_ROLE_IDS.MANAGER)).toBe(true);
    expect(isLegacySystemRoleId(SYSTEM_ROLE_IDS.EMPLOYEE)).toBe(true);
    expect(isLegacySystemRoleId(SYSTEM_ROLE_IDS.OWNER)).toBe(false);
    expect(isLegacySystemRoleId(SYSTEM_ROLE_IDS.SALON_MANAGER)).toBe(false);
    expect(isLegacySystemRoleId(SYSTEM_ROLE_IDS.HR)).toBe(false);
    expect(isLegacySystemRoleId(SYSTEM_ROLE_IDS.TRAINER)).toBe(false);
    expect(isLegacySystemRoleId("00000000-0000-4000-8000-000000000000")).toBe(false);
    expect(isLegacySystemRoleId("")).toBe(false);
  });

  it("D-10 pinned: TENANT Inhaber and TENANT Personalabteilung derive MANAGER; SALONS Salonmanager and PERSONS Ausbilder contribute nothing", () => {
    expect(deriveCompatRole(TENANT, [systemRow("OWNER")])).toBe("MANAGER");
    expect(deriveCompatRole(TENANT, [systemRow("HR")])).toBe("MANAGER");
    expect(
      deriveCompatRole(TENANT, [
        systemRow("SALON_MANAGER", { scopeType: "SALONS", salonIds: ["salon-1"], employeeIds: [] }),
      ]),
    ).toBe("EMPLOYEE");
    expect(
      deriveCompatRole(TENANT, [
        systemRow("TRAINER", { scopeType: "PERSONS", salonIds: [], employeeIds: ["employee-1"] }),
      ]),
    ).toBe("EMPLOYEE");
    expect(deriveCompatRole(TENANT, [systemRow("ADMIN"), systemRow("OWNER")])).toBe("ADMIN");
  });
});

describe("compat role — report data filter (Phase 75b Plan 12, D-19)", () => {
  it("parseCompatRoleFilter allowlists MANAGER and EMPLOYEE; everything else is no filter", () => {
    expect(parseCompatRoleFilter("MANAGER")).toBe("MANAGER");
    expect(parseCompatRoleFilter("EMPLOYEE")).toBe("EMPLOYEE");
    for (const other of ["ADMIN", "SUPERADMIN", "manager", "", undefined, null, 1, ["MANAGER"]]) {
      expect(parseCompatRoleFilter(other)).toBeUndefined();
    }
  });

  it("compatRoleUserWhere yields exactly the fragment the company PDF spread before the move", () => {
    expect(compatRoleUserWhere("MANAGER")).toEqual({ role: "MANAGER" });
    expect(compatRoleUserWhere("EMPLOYEE")).toEqual({ role: "EMPLOYEE" });
    expect(compatRoleUserWhere(undefined)).toEqual({});
    expect(Object.keys(compatRoleUserWhere(undefined))).toEqual([]);
  });
});

describe("compat role — compatRoleForUser against the database (D-14, AC-75-5)", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;

  async function createUser(role: Role, label: string, withEmployee = true) {
    const s = `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const user = await app.prisma.user.create({
      data: {
        email: `cr-${s}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role,
        isActive: true,
      },
    });
    if (withEmployee) {
      await app.prisma.employee.create({
        data: {
          tenantId: seed.tenant.id,
          userId: user.id,
          employeeNumber: `CR-${s}`.slice(0, 20),
          firstName: label,
          lastName: "Test",
          hireDate: new Date("2024-01-01"),
        },
      });
    }
    return user;
  }

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "compat-role");
  });

  afterAll(async () => {
    try {
      await app.prisma.roleAssignment.deleteMany({ where: { tenantId: seed.tenant.id } });
      await app.prisma.accessRole.deleteMany({ where: { tenantId: seed.tenant.id } });
      await cleanupTestData(app, seed.tenant.id);
    } catch (err) {
      console.error("Cleanup failed:", err);
    }
    await closeTestApp();
  });

  it.each(["ADMIN", "MANAGER", "EMPLOYEE"] as const)(
    "a legacy %s without stored assignments keeps the column value",
    async (role) => {
      const user = await createUser(role, `fb-${role}`);
      expect(await compatRoleForUser(app.prisma, user.id, seed.tenant.id, role)).toBe(role);
    },
  );

  it("an empty tenant (user without Employee) keeps the column value without a query", async () => {
    const user = await createUser("ADMIN", "no-emp", false);
    try {
      expect(await compatRoleForUser(app.prisma, user.id, "", "ADMIN")).toBe("ADMIN");
    } finally {
      await app.prisma.user.delete({ where: { id: user.id } });
    }
  });

  it("stored assignments win over the column: a legacy EMPLOYEE with a TENANT customer role holding a ZUGEWIESEN key → MANAGER", async () => {
    const user = await createUser("EMPLOYEE", "customer");
    const name = `Rolle ${user.id.slice(0, 8)}`;
    const role = await app.prisma.accessRole.create({
      data: {
        tenantId: seed.tenant.id,
        name,
        nameKey: roleNameKey(name),
        permissions: ["team-overview:read:ZUGEWIESEN"],
      },
    });
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: seed.tenant.id,
        userId: user.id,
        accessRoleId: role.id,
        scopeType: "TENANT",
        salonIds: [],
        employeeIds: [],
      },
    });
    expect(await compatRoleForUser(app.prisma, user.id, seed.tenant.id, "EMPLOYEE")).toBe(
      "MANAGER",
    );
  });

  it("a stored Admin TENANT assignment → ADMIN even when the column says EMPLOYEE", async () => {
    const user = await createUser("EMPLOYEE", "stored-admin");
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: seed.tenant.id,
        userId: user.id,
        accessRoleId: SYSTEM_ROLE_IDS.ADMIN,
        scopeType: "TENANT",
        salonIds: [],
        employeeIds: [],
      },
    });
    expect(await compatRoleForUser(app.prisma, user.id, seed.tenant.id, "EMPLOYEE")).toBe("ADMIN");
  });
});

describe("compat role — login, OTP and refresh carry the derived role (D-14, D-12, AC-75-5)", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;
  let otpSeed: Awaited<ReturnType<typeof seedTestData>>;
  let ipCounter = 0;
  const otpCodes: string[] = [];
  let originalSendOtp: FastifyInstance["mailer"]["sendOtp"];

  /** A fresh client address per request, so no per-IP rate limit can interfere. */
  function nextIp(): string {
    ipCounter += 1;
    return `10.75.6.${ipCounter}`;
  }

  function tokenRole(token: string): unknown {
    return (app.jwt.decode(token) as { role?: unknown } | null)?.role;
  }

  async function createUser(tenantId: string | null, role: Role, label: string) {
    const s = `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const user = await app.prisma.user.create({
      data: {
        email: `ct-${s}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role,
        isActive: true,
      },
    });
    if (tenantId !== null) {
      await app.prisma.employee.create({
        data: {
          tenantId,
          userId: user.id,
          employeeNumber: `CT-${s}`.slice(0, 20),
          firstName: label,
          lastName: "Test",
          hireDate: new Date("2024-01-01"),
        },
      });
    }
    return user;
  }

  /** A TENANT assignment on a customer role of `tenantId` holding one ZUGEWIESEN key. */
  async function assignCustomerZugewiesen(tenantId: string, userId: string) {
    const name = `Rolle ${userId.slice(0, 8)}`;
    const role = await app.prisma.accessRole.create({
      data: {
        tenantId,
        name,
        nameKey: roleNameKey(name),
        permissions: ["time-entry:read:EIGENE", "team-overview:read:ZUGEWIESEN"],
      },
    });
    await app.prisma.roleAssignment.create({
      data: {
        tenantId,
        userId,
        accessRoleId: role.id,
        scopeType: "TENANT",
        salonIds: [],
        employeeIds: [],
      },
    });
  }

  async function login(email: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password: "test1234" },
      remoteAddress: nextIp(),
    });
    return {
      status: res.statusCode,
      body: JSON.parse(res.body) as {
        accessToken?: string;
        refreshToken?: string;
        user?: { role: string };
        requiresOtp?: boolean;
        userId?: string;
      },
    };
  }

  async function refreshRole(refreshToken: string): Promise<unknown> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken },
      remoteAddress: nextIp(),
    });
    expect(res.statusCode, res.body).toBe(200);
    return tokenRole((JSON.parse(res.body) as { accessToken: string }).accessToken);
  }

  async function otpLogin(email: string) {
    const before = otpCodes.length;
    const first = await login(email);
    expect(first.status).toBe(202);
    expect(first.body.requiresOtp).toBe(true);
    expect(otpCodes.length).toBe(before + 1);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/verify-otp",
      payload: { userId: first.body.userId, code: otpCodes[otpCodes.length - 1] },
      remoteAddress: nextIp(),
    });
    expect(res.statusCode, res.body).toBe(200);
    return JSON.parse(res.body) as { accessToken: string; user: { role: string } };
  }

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "compat-login");
    otpSeed = await seedTestData(app, "compat-otp");
    await app.prisma.tenantConfig.update({
      where: { tenantId: otpSeed.tenant.id },
      data: { twoFaEnabled: true },
    });
    originalSendOtp = app.mailer.sendOtp;
    app.mailer.sendOtp = async (params) => {
      otpCodes.push(params.code);
    };
  });

  afterAll(async () => {
    app.mailer.sendOtp = originalSendOtp;
    for (const s of [seed, otpSeed]) {
      try {
        await app.prisma.roleAssignment.deleteMany({ where: { tenantId: s.tenant.id } });
        await app.prisma.accessRole.deleteMany({ where: { tenantId: s.tenant.id } });
        await cleanupTestData(app, s.tenant.id);
      } catch (err) {
        console.error("Cleanup failed:", err);
      }
    }
    await closeTestApp();
  });

  it("a migrated MANAGER (stored Manager assignment) logs in with body and token role MANAGER", async () => {
    const user = await createUser(seed.tenant.id, "MANAGER", "migrated-m");
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: seed.tenant.id,
        userId: user.id,
        accessRoleId: SYSTEM_ROLE_IDS.MANAGER,
        scopeType: "TENANT",
        salonIds: [],
        employeeIds: [],
      },
    });
    const res = await login(user.email);
    expect(res.status).toBe(200);
    expect(res.body.user?.role).toBe("MANAGER");
    expect(tokenRole(res.body.accessToken as string)).toBe("MANAGER");
    expect(await refreshRole(res.body.refreshToken as string)).toBe("MANAGER");
  });

  it("a legacy EMPLOYEE holding a TENANT customer role with a ZUGEWIESEN key logs in and refreshes as MANAGER — the column still says EMPLOYEE", async () => {
    const user = await createUser(seed.tenant.id, "EMPLOYEE", "derived-m");
    await assignCustomerZugewiesen(seed.tenant.id, user.id);
    const res = await login(user.email);
    expect(res.status).toBe(200);
    expect(res.body.user?.role).toBe("MANAGER");
    expect(tokenRole(res.body.accessToken as string)).toBe("MANAGER");
    expect(await refreshRole(res.body.refreshToken as string)).toBe("MANAGER");
    const column = await app.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { role: true },
    });
    expect(column.role).toBe("EMPLOYEE");
  });

  it("the same derivation applies to the OTP login", async () => {
    const user = await createUser(otpSeed.tenant.id, "EMPLOYEE", "derived-otp");
    await assignCustomerZugewiesen(otpSeed.tenant.id, user.id);
    const body = await otpLogin(user.email);
    expect(body.user.role).toBe("MANAGER");
    expect(tokenRole(body.accessToken)).toBe("MANAGER");
  });

  it("a user without Employee (tenant '') carries exactly the User.role column (AC-75-5)", async () => {
    const user = await createUser(null, "ADMIN", "no-emp");
    try {
      const res = await login(user.email);
      expect(res.status).toBe(200);
      expect(res.body.user?.role).toBe("ADMIN");
      expect(tokenRole(res.body.accessToken as string)).toBe("ADMIN");
      expect(await refreshRole(res.body.refreshToken as string)).toBe("ADMIN");
    } finally {
      await app.prisma.refreshToken.deleteMany({ where: { userId: user.id } });
      await app.prisma.user.delete({ where: { id: user.id } });
    }
  });

  it.each(["ADMIN", "MANAGER", "EMPLOYEE"] as const)(
    "a fallback %s (no stored rows) carries the column in login, refresh and OTP",
    async (role) => {
      const user = await createUser(seed.tenant.id, role, `fb-${role}`);
      const res = await login(user.email);
      expect(res.status).toBe(200);
      expect(res.body.user?.role).toBe(role);
      expect(tokenRole(res.body.accessToken as string)).toBe(role);
      expect(await refreshRole(res.body.refreshToken as string)).toBe(role);

      const otpUser = await createUser(otpSeed.tenant.id, role, `fb-otp-${role}`);
      const otp = await otpLogin(otpUser.email);
      expect(otp.user.role).toBe(role);
      expect(tokenRole(otp.accessToken)).toBe(role);
    },
  );
});

describe("compat role — write half against the database (D-14, D-15, D-26)", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;
  let other: Awaited<ReturnType<typeof seedTestData>>;

  async function createUser(tenantId: string, role: Role, label: string) {
    const s = `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const user = await app.prisma.user.create({
      data: {
        email: `cw-${s}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role,
        isActive: true,
      },
    });
    await app.prisma.employee.create({
      data: {
        tenantId,
        userId: user.id,
        employeeNumber: `CW-${s}`.slice(0, 20),
        firstName: label,
        lastName: "Test",
        hireDate: new Date("2024-01-01"),
      },
    });
    return user;
  }

  function assign(
    userId: string,
    accessRoleId: string,
    scope: { scopeType: "TENANT" | "SALONS"; salonIds?: string[] } = { scopeType: "TENANT" },
  ) {
    return app.prisma.roleAssignment.create({
      data: {
        tenantId: seed.tenant.id,
        userId,
        accessRoleId,
        scopeType: scope.scopeType,
        salonIds: scope.salonIds ?? [],
        employeeIds: [],
      },
    });
  }

  function rowsOf(userId: string) {
    return app.prisma.roleAssignment.findMany({
      where: { tenantId: seed.tenant.id, userId },
      orderBy: { createdAt: "asc" },
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "compat-write");
    other = await seedTestData(app, "compat-write-other");
  });

  afterAll(async () => {
    try {
      await app.prisma.roleAssignment.deleteMany({ where: { tenantId: seed.tenant.id } });
      await app.prisma.accessRole.deleteMany({ where: { tenantId: seed.tenant.id } });
      await cleanupTestData(app, seed.tenant.id);
      await cleanupTestData(app, other.tenant.id);
    } catch (err) {
      console.error("Cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("materializeLegacyRoleAssignment stores the fallback once, and never for a user of another tenant", async () => {
    const user = await createUser(seed.tenant.id, "MANAGER", "mat");
    const first = await materializeLegacyRoleAssignment(app.prisma, seed.tenant.id, user.id);
    expect(first).toMatchObject({
      legacyRole: "MANAGER",
      assignment: {
        userId: user.id,
        accessRoleId: SYSTEM_ROLE_IDS.MANAGER,
        roleName: "Manager",
        scopeType: "TENANT",
        salonIds: [],
        employeeIds: [],
      },
    });
    expect(await materializeLegacyRoleAssignment(app.prisma, seed.tenant.id, user.id)).toBeNull();
    expect((await rowsOf(user.id)).map((row) => row.id)).toEqual([first!.assignment.id]);

    const foreign = await createUser(other.tenant.id, "ADMIN", "mat-foreign");
    expect(
      await materializeLegacyRoleAssignment(app.prisma, seed.tenant.id, foreign.id),
    ).toBeNull();
    expect(await app.prisma.roleAssignment.count({ where: { userId: foreign.id } })).toBe(0);
  });

  it("requestedRoleUnchanged compares with the User.role column, stored rows or not (D-16, P-05)", async () => {
    const fallback = await createUser(seed.tenant.id, "EMPLOYEE", "unchanged");
    const yields = (userId: string, role: Role) =>
      requestedRoleUnchanged(app.prisma, seed.tenant.id, userId, role);
    expect(await yields(fallback.id, "EMPLOYEE")).toBe(true);
    expect(await yields(fallback.id, "MANAGER")).toBe(false);
    expect(await yields(fallback.id, "ADMIN")).toBe(false);

    await assign(fallback.id, SYSTEM_ROLE_IDS.EMPLOYEE);
    // Before D-16 the fallback-only predicate answered false here — it required no stored row at
    // all — and that exclusion sent every form save of a user with stored rows through the bridge,
    // including an unrelated save by a Personalabteilung/customer-role holder.
    expect(await yields(fallback.id, "EMPLOYEE")).toBe(true);

    const hrHolder = await createUser(seed.tenant.id, "EMPLOYEE", "unchanged-hr");
    await assign(hrHolder.id, SYSTEM_ROLE_IDS.HR);
    await assign(hrHolder.id, SYSTEM_ROLE_IDS.EMPLOYEE);
    expect(await syncCompatRoleColumn(app.prisma, seed.tenant.id, hrHolder.id)).toEqual({
      from: "EMPLOYEE",
      to: "MANAGER",
    });
    expect(await yields(hrHolder.id, "MANAGER")).toBe(true);
    expect(await yields(hrHolder.id, "EMPLOYEE")).toBe(false);
    expect(await yields(hrHolder.id, "ADMIN")).toBe(false);

    // P-05: a stale column wins over the derivation. The column stays EMPLOYEE (never synced)
    // while the stored HR row derives MANAGER — input proof via compatRoleForUser.
    const stale = await createUser(seed.tenant.id, "EMPLOYEE", "unchanged-stale");
    await assign(stale.id, SYSTEM_ROLE_IDS.HR);
    expect(await compatRoleForUser(app.prisma, stale.id, seed.tenant.id, "EMPLOYEE")).toBe(
      "MANAGER",
    );
    expect(await yields(stale.id, "EMPLOYEE")).toBe(true);
    expect(await yields(stale.id, "MANAGER")).toBe(false);

    const foreign = await createUser(other.tenant.id, "EMPLOYEE", "unchanged-foreign");
    expect(await yields(foreign.id, "EMPLOYEE")).toBe(false);
    expect(await yields(foreign.id, "MANAGER")).toBe(false);
    expect(await yields(foreign.id, "ADMIN")).toBe(false);
  });

  it("replaceSystemRoleAssignment swaps only the TENANT system row; customer and SALONS rows stay", async () => {
    const user = await createUser(seed.tenant.id, "ADMIN", "replace");
    const name = `Schreibhaelfte ${user.id.slice(0, 8)}`;
    const customerRole = await app.prisma.accessRole.create({
      data: {
        tenantId: seed.tenant.id,
        name,
        nameKey: roleNameKey(name),
        permissions: ["role:read:ZUGEWIESEN"],
      },
    });
    const adminRow = await assign(user.id, SYSTEM_ROLE_IDS.ADMIN);
    const customerRow = await assign(user.id, customerRole.id);
    const salonRow = await assign(user.id, SYSTEM_ROLE_IDS.MANAGER, {
      scopeType: "SALONS",
      salonIds: [seed.salonId],
    });

    const { removed, created } = await replaceSystemRoleAssignment(
      app.prisma,
      seed.tenant.id,
      user.id,
      "EMPLOYEE",
    );
    expect(removed.map((row) => row.id)).toEqual([adminRow.id]);
    expect(removed[0].roleName).toBe("Admin");
    expect(created).toMatchObject({ accessRoleId: SYSTEM_ROLE_IDS.EMPLOYEE, scopeType: "TENANT" });

    const rows = await rowsOf(user.id);
    expect(rows.map((row) => row.id).sort()).toEqual(
      [customerRow.id, salonRow.id, created!.id].sort(),
    );

    // Idempotent: the target already stored → nothing removed, nothing created.
    expect(
      await replaceSystemRoleAssignment(app.prisma, seed.tenant.id, user.id, "EMPLOYEE"),
    ).toEqual({ removed: [], created: null });
  });

  // Phase 76b (Issue #76), P-01: a Phase 76b template (here Personalabteilung/HR) held at TENANT
  // scope is NOT one of the three legacy system roles `replaceSystemRoleAssignment` swaps — it
  // must survive a demotion to Mitarbeiter exactly like a customer-role row does, and it must be
  // named by `assignmentsBlockingDemotionToEmployee` beforehand.
  it("replaceSystemRoleAssignment leaves a TENANT Personalabteilung (HR) template row untouched; the guard names it first", async () => {
    const user = await createUser(seed.tenant.id, "MANAGER", "template-replace");
    const hrRow = await assign(user.id, SYSTEM_ROLE_IDS.HR);
    const managerRow = await assign(user.id, SYSTEM_ROLE_IDS.MANAGER);

    const blocking = await assignmentsBlockingDemotionToEmployee(
      app.prisma,
      seed.tenant.id,
      user.id,
    );
    expect(blocking.map((row) => row.id)).toEqual([hrRow.id]);
    expect(blocking[0]).toMatchObject({ roleName: "Personalabteilung", scopeType: "TENANT" });

    const { removed, created } = await replaceSystemRoleAssignment(
      app.prisma,
      seed.tenant.id,
      user.id,
      "EMPLOYEE",
    );
    expect(removed.map((row) => row.id)).toEqual([managerRow.id]);
    expect(created).toMatchObject({ accessRoleId: SYSTEM_ROLE_IDS.EMPLOYEE, scopeType: "TENANT" });

    const rows = await rowsOf(user.id);
    expect(rows.map((row) => row.id).sort()).toEqual([hrRow.id, created!.id].sort());
    expect(rows.find((row) => row.id === hrRow.id)).toEqual(hrRow);
  });

  // Issue #357 sub-fix B: before this fix nothing stopped `replaceSystemRoleAssignment` (called by
  // the employee-form PATCH handler) from demoting a user to Mitarbeiter while a customer-role
  // TENANT assignment and a salon-scoped Manager assignment survived untouched (proven by the
  // PREVIOUS test above, which asserts exactly that survival) — the form showed "Mitarbeiter", the
  // rights stayed. `assignmentsBlockingDemotionToEmployee` is the guard the handler now runs FIRST.
  it("assignmentsBlockingDemotionToEmployee finds the customer-role and salon-scoped assignments a demotion would leave behind", async () => {
    const user = await createUser(seed.tenant.id, "ADMIN", "blocking");
    const name = `Blockierend ${user.id.slice(0, 8)}`;
    const customerRole = await app.prisma.accessRole.create({
      data: {
        tenantId: seed.tenant.id,
        name,
        nameKey: roleNameKey(name),
        permissions: ["role:read:ZUGEWIESEN"],
      },
    });
    await assign(user.id, SYSTEM_ROLE_IDS.ADMIN); // the TENANT system row about to be replaced
    const customerRow = await assign(user.id, customerRole.id);
    const salonRow = await assign(user.id, SYSTEM_ROLE_IDS.MANAGER, {
      scopeType: "SALONS",
      salonIds: [seed.salonId],
    });

    const blocking = await assignmentsBlockingDemotionToEmployee(
      app.prisma,
      seed.tenant.id,
      user.id,
    );
    expect(blocking.map((row) => row.id).sort()).toEqual([customerRow.id, salonRow.id].sort());
    expect(blocking.find((row) => row.id === customerRow.id)).toMatchObject({
      roleName: name,
      scopeType: "TENANT",
    });
    expect(blocking.find((row) => row.id === salonRow.id)).toMatchObject({
      roleName: "Manager",
      scopeType: "SALONS",
      salonIds: [seed.salonId],
    });
  });

  it("assignmentsBlockingDemotionToEmployee is empty for a user with only the TENANT system row", async () => {
    const user = await createUser(seed.tenant.id, "ADMIN", "unblocked");
    await assign(user.id, SYSTEM_ROLE_IDS.ADMIN);
    expect(
      await assignmentsBlockingDemotionToEmployee(app.prisma, seed.tenant.id, user.id),
    ).toEqual([]);
  });

  it("RoleDemotionBlockedError carries the blocking rows for the caller's 409", () => {
    const blocking = [
      {
        id: "ra-1",
        roleName: "Kundenrolle",
        scopeType: "TENANT" as const,
        salonIds: [],
        employeeIds: [],
      },
    ];
    const err = new RoleDemotionBlockedError(blocking);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("RoleDemotionBlockedError");
    expect(err.blocking).toBe(blocking);
  });

  it("replaceSystemRoleAssignment replaces a malformed TENANT row on the target role", async () => {
    const user = await createUser(seed.tenant.id, "EMPLOYEE", "malformed");
    // A TENANT row carrying a salon list violates the D-03 shape and grants nothing (IN-02).
    const malformed = await assign(user.id, SYSTEM_ROLE_IDS.EMPLOYEE, {
      scopeType: "TENANT",
      salonIds: [seed.salonId],
    });
    const { removed, created } = await replaceSystemRoleAssignment(
      app.prisma,
      seed.tenant.id,
      user.id,
      "EMPLOYEE",
    );
    expect(removed.map((row) => row.id)).toEqual([malformed.id]);
    expect(created).toMatchObject({ accessRoleId: SYSTEM_ROLE_IDS.EMPLOYEE, salonIds: [] });
  });

  it("syncCompatRoleColumn writes the derived value only on a change and reports it", async () => {
    const user = await createUser(seed.tenant.id, "MANAGER", "sync");
    const adminRow = await assign(user.id, SYSTEM_ROLE_IDS.ADMIN);
    expect(await syncCompatRoleColumn(app.prisma, seed.tenant.id, user.id)).toEqual({
      from: "MANAGER",
      to: "ADMIN",
    });
    expect(await syncCompatRoleColumn(app.prisma, seed.tenant.id, user.id)).toBeNull();

    // D-08: no stored row left → EMPLOYEE, never a lingering ADMIN.
    await app.prisma.roleAssignment.delete({ where: { id: adminRow.id } });
    expect(await syncCompatRoleColumn(app.prisma, seed.tenant.id, user.id)).toEqual({
      from: "ADMIN",
      to: "EMPLOYEE",
    });
    const stored = await app.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(stored.role).toBe("EMPLOYEE");
  });
});
