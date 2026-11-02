/**
 * Phase 75b (Issue #75), D-14 — the form role is DERIVED from role assignments at one place.
 *
 * `deriveFormRole` is pure: ADMIN for a well-formed TENANT assignment on the Admin system role
 * (by id), MANAGER when any effective assignment's role grants a ZUGEWIESEN permission, EMPLOYEE
 * otherwise. Since #539 the derived value is no longer published in a token or a sign-in body
 * (`token-claims-539.test.ts`); no column stores it any more (#641, Release B).
 *
 * No person names in fixtures (CLAUDE.md PII rule).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../../__tests__/setup";
import {
  assignmentExceedsEmployee,
  assignmentsBlockingDemotionToEmployee,
  deriveFormRole,
  isDemotionToEmployee,
  isLegacySystemRoleId,
  replaceSystemRoleAssignment,
  requestedRoleUnchanged,
  RoleDemotionBlockedError,
  systemRoleIdForLegacyRole,
  type FormRoleAssignmentRow,
  type SystemRoleName,
} from "../system-role-assignment";
import * as systemRoleAssignmentModule from "../system-role-assignment";
import { SYSTEM_ROLE_IDS, SYSTEM_ROLE_PERMISSIONS, type SystemRoleSlot } from "../system-roles";
import { roleNameKey } from "../access-role";
import { TENANT_REQUIRED_ERROR } from "../tenant-status";
import { NO_ROLE_ASSIGNED_ERROR } from "../request-permissions";

const TENANT = "tenant-under-test";
const OTHER_TENANT = "another-tenant";

function systemRow(
  slot: SystemRoleSlot,
  scope: Pick<FormRoleAssignmentRow, "scopeType" | "salonIds" | "employeeIds"> = {
    scopeType: "TENANT",
    salonIds: [],
    employeeIds: [],
  },
): FormRoleAssignmentRow {
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
): FormRoleAssignmentRow {
  const scopeType = opts.scopeType ?? "TENANT";
  return {
    scopeType,
    salonIds: scopeType === "SALONS" ? ["salon-1"] : [],
    employeeIds: scopeType === "PERSONS" ? ["employee-1"] : [],
    accessRole: { id: "customer-role", tenantId: opts.tenantId ?? TENANT, permissions },
  };
}

describe("system-role assignment — pure derivation (D-14)", () => {
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
    expect(deriveFormRole(TENANT, [systemRow("ADMIN")])).toBe("ADMIN");
  });

  it("Admin system role via SALONS scope → EMPLOYEE (Issue #357 sub-fix A: never below TENANT scope, not even MANAGER)", () => {
    expect(
      deriveFormRole(TENANT, [
        systemRow("ADMIN", { scopeType: "SALONS", salonIds: ["salon-1"], employeeIds: [] }),
      ]),
    ).toBe("EMPLOYEE");
  });

  it("Manager → MANAGER; Mitarbeiter → EMPLOYEE", () => {
    expect(deriveFormRole(TENANT, [systemRow("MANAGER")])).toBe("MANAGER");
    expect(deriveFormRole(TENANT, [systemRow("EMPLOYEE")])).toBe("EMPLOYEE");
  });

  it("a customer role with a ZUGEWIESEN key at TENANT scope → MANAGER", () => {
    expect(
      deriveFormRole(TENANT, [
        customerRow(["time-entry:read:EIGENE", "audit-log:read:ZUGEWIESEN"], {
          scopeType: "TENANT",
        }),
      ]),
    ).toBe("MANAGER");
  });

  // Issue #357 sub-fix A: before the fix `deriveFormRole` ignored scope entirely for the
  // MANAGER check, so a SALONS/PERSONS-scoped customer role holding a ZUGEWIESEN key wrongly
  // derived MANAGER even though `request-permissions.ts` grants that key tenant-wide from a
  // TENANT-scope source only (D-09) — the assignment holder could do NOTHING tenant-wide at the
  // API, yet the compat role (JWT claim, login body, company-PDF filter) reported MANAGER.
  it.each(["SALONS", "PERSONS"] as const)(
    "a customer role with a ZUGEWIESEN key at %s scope → EMPLOYEE (grants nothing tenant-wide)",
    (scopeType) => {
      expect(
        deriveFormRole(TENANT, [
          customerRow(["time-entry:read:EIGENE", "audit-log:read:ZUGEWIESEN"], { scopeType }),
        ]),
      ).toBe("EMPLOYEE");
    },
  );

  it("a customer role with EIGENE keys only → EMPLOYEE", () => {
    expect(
      deriveFormRole(TENANT, [customerRow(["time-entry:read:EIGENE", "overtime:read:EIGENE"])]),
    ).toBe("EMPLOYEE");
  });

  it("a foreign tenant's customer role and a malformed row contribute nothing", () => {
    expect(
      deriveFormRole(TENANT, [
        customerRow(["audit-log:read:ZUGEWIESEN"], { tenantId: OTHER_TENANT }),
      ]),
    ).toBe("EMPLOYEE");
    expect(
      deriveFormRole(TENANT, [
        systemRow("ADMIN", { scopeType: "TENANT", salonIds: ["salon-1"], employeeIds: [] }),
      ]),
    ).toBe("EMPLOYEE");
  });

  it("the union decides: Mitarbeiter plus Admin at TENANT → ADMIN; empty → EMPLOYEE", () => {
    expect(deriveFormRole(TENANT, [systemRow("EMPLOYEE"), systemRow("ADMIN")])).toBe("ADMIN");
    expect(deriveFormRole(TENANT, [])).toBe("EMPLOYEE");
  });

  it.each(["ADMIN", "MANAGER", "EMPLOYEE"] as const)(
    "deriving over the stored system-role row of %s yields exactly that value",
    (role: SystemRoleName) => {
      const slot = (Object.keys(SYSTEM_ROLE_IDS) as SystemRoleSlot[]).find(
        (s) => SYSTEM_ROLE_IDS[s] === systemRoleIdForLegacyRole(role),
      );
      expect(slot).toBeDefined();
      expect(deriveFormRole(TENANT, [systemRow(slot as SystemRoleSlot)])).toBe(role);
    },
  );
});

describe("system-role assignment — assignmentExceedsEmployee (Issue #357 sub-fix B)", () => {
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

  // Unlike deriveFormRole (sub-fix A), this check does NOT restrict itself to TENANT scope: a
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
describe("Phase 76b — templates in the system-role assignment module (P-01, D-10)", () => {
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
    expect(deriveFormRole(TENANT, [systemRow("OWNER")])).toBe("MANAGER");
    expect(deriveFormRole(TENANT, [systemRow("HR")])).toBe("MANAGER");
    expect(
      deriveFormRole(TENANT, [
        systemRow("SALON_MANAGER", { scopeType: "SALONS", salonIds: ["salon-1"], employeeIds: [] }),
      ]),
    ).toBe("EMPLOYEE");
    expect(
      deriveFormRole(TENANT, [
        systemRow("TRAINER", { scopeType: "PERSONS", salonIds: [], employeeIds: ["employee-1"] }),
      ]),
    ).toBe("EMPLOYEE");
    expect(deriveFormRole(TENANT, [systemRow("ADMIN"), systemRow("OWNER")])).toBe("ADMIN");
  });
});

describe("system-role assignment — sign-in refusals for accounts without a stored assignment (D-14, #539 D-05)", () => {
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

  async function createUser(tenantId: string | null, label: string) {
    const s = `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const user = await app.prisma.user.create({
      data: {
        email: `ct-${s}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
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
        requiresOtp?: boolean;
        userId?: string;
      },
    };
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

  it("a user without Employee (tenant '') cannot sign in any more — 403 TENANT_REQUIRED, no token (#551)", async () => {
    // Before Issue #551 this user logged in with a role derived from the account (AC-75-5) and a
    // refresh kept it. Such a principal has no tenant and gets no token now; the derivation for an
    // derivation is gone with the claim (#539 D-05).
    const user = await createUser(null, "no-emp");
    try {
      const res = await login(user.email);
      expect(res.status).toBe(403);
      expect(res.body).toEqual(TENANT_REQUIRED_ERROR);
      expect(res.body.accessToken).toBeUndefined();
      expect(res.body.refreshToken).toBeUndefined();
      expect(await app.prisma.refreshToken.count({ where: { userId: user.id } })).toBe(0);
    } finally {
      await app.prisma.auditLog.deleteMany({
        where: { OR: [{ userId: user.id }, { entityId: user.id }] },
      });
      await app.prisma.refreshToken.deleteMany({ where: { userId: user.id } });
      await app.prisma.user.delete({ where: { id: user.id } });
    }
  });

  it("a user without any stored assignment is refused at login with 403 NO_ROLE_ASSIGNED (D-14)", async () => {
    // Since #539 only stored assignments grant anything and the sign-in of an account without any
    // effective permission is refused (verify-otp and refresh: no-role-assigned-539.test.ts).
    const user = await createUser(seed.tenant.id, "no-assignment");
    const res = await login(user.email);
    expect(res.status).toBe(403);
    expect(res.body).toEqual(NO_ROLE_ASSIGNED_ERROR);
    expect(res.body.accessToken).toBeUndefined();
    expect(res.body.refreshToken).toBeUndefined();
    expect(await app.prisma.refreshToken.count({ where: { userId: user.id } })).toBe(0);

    // In a two-factor tenant the refusal comes before any code is created.
    const otpUser = await createUser(otpSeed.tenant.id, "no-assignment-otp");
    const codesBefore = otpCodes.length;
    const otpRes = await login(otpUser.email);
    expect(otpRes.status).toBe(403);
    expect(otpRes.body).toEqual(NO_ROLE_ASSIGNED_ERROR);
    expect(otpCodes.length).toBe(codesBefore);
    expect(await app.prisma.otpToken.count({ where: { userId: otpUser.id } })).toBe(0);
  });
});

describe("system-role assignment — write half against the database (D-14, D-15, #539)", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;
  let other: Awaited<ReturnType<typeof seedTestData>>;

  async function createUser(tenantId: string, label: string) {
    const s = `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const user = await app.prisma.user.create({
      data: {
        email: `cw-${s}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
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

  it("nothing is stored on a user's behalf (#539 D-11): the module has no materialization, a replacement writes exactly the requested row", async () => {
    // The D-26 function is gone: with the fallback removed it would be an implicit grant.
    expect("materializeLegacyRoleAssignment" in systemRoleAssignmentModule).toBe(false);

    const user = await createUser(seed.tenant.id, "mat");
    expect(await rowsOf(user.id)).toEqual([]);
    const { removed, created } = await replaceSystemRoleAssignment(
      app.prisma,
      seed.tenant.id,
      user.id,
      "EMPLOYEE",
    );
    expect(removed).toEqual([]);
    expect(created).toMatchObject({
      userId: user.id,
      accessRoleId: SYSTEM_ROLE_IDS.EMPLOYEE,
      scopeType: "TENANT",
    });
    // Exactly the requested Mitarbeiter row exists, nothing else is stored.
    expect((await rowsOf(user.id)).map((row) => row.accessRoleId)).toEqual([
      SYSTEM_ROLE_IDS.EMPLOYEE,
    ]);
  });

  it("requestedRoleUnchanged compares with the role DERIVED from the stored rows; no row means no role (#539 D-11)", async () => {
    // No stored row: the person holds no role, so every requested role is a change.
    const unassigned = await createUser(seed.tenant.id, "unchanged");
    const yields = (userId: string, role: SystemRoleName) =>
      requestedRoleUnchanged(app.prisma, seed.tenant.id, userId, role);
    expect(await yields(unassigned.id, "EMPLOYEE")).toBe(false);
    expect(await yields(unassigned.id, "MANAGER")).toBe(false);
    expect(await yields(unassigned.id, "ADMIN")).toBe(false);

    await assign(unassigned.id, SYSTEM_ROLE_IDS.EMPLOYEE);
    expect(await yields(unassigned.id, "EMPLOYEE")).toBe(true);
    expect(await yields(unassigned.id, "MANAGER")).toBe(false);

    const hrHolder = await createUser(seed.tenant.id, "unchanged-hr");
    await assign(hrHolder.id, SYSTEM_ROLE_IDS.HR);
    await assign(hrHolder.id, SYSTEM_ROLE_IDS.EMPLOYEE);
    expect(await yields(hrHolder.id, "MANAGER")).toBe(true);
    expect(await yields(hrHolder.id, "EMPLOYEE")).toBe(false);
    expect(await yields(hrHolder.id, "ADMIN")).toBe(false);

    // The derived role is what counts: the stored HR row derives MANAGER, so echoing EMPLOYEE is a
    // change and echoing MANAGER is not.
    const stale = await createUser(seed.tenant.id, "unchanged-stale");
    await assign(stale.id, SYSTEM_ROLE_IDS.HR);
    expect(await yields(stale.id, "MANAGER")).toBe(true);
    expect(await yields(stale.id, "EMPLOYEE")).toBe(false);

    const foreign = await createUser(other.tenant.id, "unchanged-foreign");
    expect(await yields(foreign.id, "EMPLOYEE")).toBe(false);
    expect(await yields(foreign.id, "MANAGER")).toBe(false);
    expect(await yields(foreign.id, "ADMIN")).toBe(false);
  });

  it("replaceSystemRoleAssignment swaps only the TENANT system row; customer and SALONS rows stay", async () => {
    const user = await createUser(seed.tenant.id, "replace");
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
    const user = await createUser(seed.tenant.id, "template-replace");
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
    const user = await createUser(seed.tenant.id, "blocking");
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
    const user = await createUser(seed.tenant.id, "unblocked");
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
    const user = await createUser(seed.tenant.id, "malformed");
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
});
