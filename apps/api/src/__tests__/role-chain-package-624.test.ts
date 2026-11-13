/**
 * Issue #624 (revises #566 D-07) — extended roles belong to the Ketten-Paket, for NEW creations
 * only: a new customer role (create and copy) and a new role assignment with a salon or person
 * reach answer 409 MODULE_NOT_BOOKED without it. Existing roles and assignments keep working, and
 * editing and removing stay free (never retroactive).
 *
 * Tenants come from `seedGrundversionTenant` (nothing booked); the shared fixture books everything.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { TenantModule } from "@clokr/db";
import { getTestApp, seedGrundversionTenant, cleanupTestData, createTestSalon } from "./setup";
import { moduleNotBookedMessage } from "../contexts/platform/tenant-packages";
import { normalizeRolePermissions, roleNameKey } from "../contexts/platform";

type Seed = Awaited<ReturnType<typeof seedGrundversionTenant>>;

let app: FastifyInstance;
let t: Seed;
let n = 0;

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

function addr(): string {
  n += 1;
  return `10.62.${Math.floor(n / 250) % 250}.${(n % 250) + 1}`;
}

function inject(method: "POST" | "PATCH" | "DELETE" | "GET", url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: bearer(t.adminToken),
    remoteAddress: addr(),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

function expectRefusal(res: { statusCode: number; body: string }) {
  expect(res.statusCode, res.body).toBe(409);
  const body = JSON.parse(res.body) as Record<string, unknown>;
  expect(Object.keys(body).sort((a, b) => a.localeCompare(b))).toEqual(["code", "error"]);
  expect(body.code).toBe("MODULE_NOT_BOOKED");
  expect(body.error).toBe(moduleNotBookedMessage("CHAIN"));
}

async function setModules(bookedModules: TenantModule[]) {
  await app.prisma.tenant.update({ where: { id: t.tenant.id }, data: { bookedModules } });
}

const rolesIn = () => app.prisma.accessRole.count({ where: { tenantId: t.tenant.id } });
const assignmentsIn = () => app.prisma.roleAssignment.count({ where: { tenantId: t.tenant.id } });

beforeAll(async () => {
  app = await getTestApp();
  t = await seedGrundversionTenant(app, "a624");
});

afterAll(async () => {
  try {
    await app.prisma.roleAssignment.deleteMany({
      where: { tenantId: t.tenant.id, accessRole: { tenantId: t.tenant.id } },
    });
    await app.prisma.accessRole.deleteMany({ where: { tenantId: t.tenant.id } });
    await cleanupTestData(app, t.tenant.id);
  } catch (err) {
    console.error("Test cleanup failed:", err);
  }
});

describe("Issue #624 — without the Ketten-Paket", () => {
  it("refuses a new customer role and a copy, persists nothing", async () => {
    const before = await rolesIn();
    expectRefusal(
      await inject("POST", "/api/v1/roles", {
        name: `Rolle ${randomBytes(3).toString("hex")}`,
        permissions: ["shift:read:ZUGEWIESEN"],
      }),
    );
    const system = await app.prisma.accessRole.findFirstOrThrow({ where: { tenantId: null } });
    expectRefusal(await inject("POST", `/api/v1/roles/${system.id}/copy`, {}));
    expect(await rolesIn()).toBe(before);
  });

  it("the package gate wins over a name conflict and over the four-eyes confirmation", async () => {
    // A customer role that exists already (seeded directly, as a tenant that cancelled the package).
    const name = `Vorhanden ${randomBytes(3).toString("hex")}`;
    await app.prisma.accessRole.create({
      data: {
        tenantId: t.tenant.id,
        name,
        nameKey: roleNameKey(name),
        permissions: normalizeRolePermissions(["shift:read:ZUGEWIESEN"]),
      },
    });
    expectRefusal(
      await inject("POST", "/api/v1/roles", { name, permissions: ["shift:read:ZUGEWIESEN"] }),
    );
    expectRefusal(
      await inject("POST", "/api/v1/roles", {
        name: `Vier Augen ${randomBytes(3).toString("hex")}`,
        permissions: ["time-entry:update:EIGENE", "retro-request:approve:ZUGEWIESEN"],
      }),
    );
  });

  it("refuses a new SALONS or PERSONS assignment but allows a TENANT one", async () => {
    const role = await app.prisma.accessRole.findFirstOrThrow({
      where: { tenantId: t.tenant.id },
    });
    const salon = await app.prisma.salon.findFirstOrThrow({ where: { tenantId: t.tenant.id } });
    const before = await assignmentsIn();
    expectRefusal(
      await inject("POST", "/api/v1/role-assignments", {
        userId: t.empUser.id,
        accessRoleId: role.id,
        scope: { type: "SALONS", salonIds: [salon.id] },
      }),
    );
    expectRefusal(
      await inject("POST", "/api/v1/role-assignments", {
        userId: t.empUser.id,
        accessRoleId: role.id,
        scope: { type: "PERSONS", employeeIds: [t.employee.id] },
      }),
    );
    expect(await assignmentsIn()).toBe(before);

    const tenantWide = await inject("POST", "/api/v1/role-assignments", {
      userId: t.empUser.id,
      accessRoleId: role.id,
      scope: { type: "TENANT" },
    });
    expect(tenantWide.statusCode, tenantWide.body).toBe(201);
  });

  it("existing roles and assignments stay editable, removable and effective", async () => {
    const role = await app.prisma.accessRole.findFirstOrThrow({
      where: { tenantId: t.tenant.id },
    });
    const patch = await inject("PATCH", `/api/v1/roles/${role.id}`, {
      name: `Umbenannt ${randomBytes(3).toString("hex")}`,
    });
    expect(patch.statusCode, patch.body).toBe(200);

    const assignment = await app.prisma.roleAssignment.findFirstOrThrow({
      where: { tenantId: t.tenant.id, accessRoleId: role.id },
    });
    const remove = await inject("DELETE", `/api/v1/role-assignments/${assignment.id}`);
    expect(remove.statusCode, remove.body).toBe(204);

    // The admin's own stored system-role assignment still resolves permissions: the call above
    // passed `role-assignment:manage`, with nothing booked.
  });
});

describe("Issue #624 — with the Ketten-Paket", () => {
  beforeAll(async () => {
    await setModules([TenantModule.CHAIN]);
  });

  it("creates a role, copies it and assigns it with a salon reach", async () => {
    const created = await inject("POST", "/api/v1/roles", {
      name: `Gebucht ${randomBytes(3).toString("hex")}`,
      permissions: ["shift:read:ZUGEWIESEN"],
    });
    expect(created.statusCode, created.body).toBe(201);
    const roleId = (JSON.parse(created.body) as { id: string }).id;

    const copy = await inject("POST", `/api/v1/roles/${roleId}/copy`, {});
    expect(copy.statusCode, copy.body).toBe(201);

    const salon = await app.prisma.salon.findFirstOrThrow({ where: { tenantId: t.tenant.id } });
    const assigned = await inject("POST", "/api/v1/role-assignments", {
      userId: t.empUser.id,
      accessRoleId: roleId,
      scope: { type: "SALONS", salonIds: [salon.id] },
    });
    expect(assigned.statusCode, assigned.body).toBe(201);
  });

  it("cancelling the package afterwards revokes nothing: the salon-reach assignment remains", async () => {
    const before = await assignmentsIn();
    await setModules([]);
    expect(await assignmentsIn()).toBe(before);
    const list = await inject("GET", "/api/v1/role-assignments");
    expect(list.statusCode, list.body).toBe(200);
    const scopes = (
      JSON.parse(list.body) as { scopeType?: string; scope?: { type?: string } }[]
    ).map((r) => r.scopeType ?? r.scope?.type);
    expect(scopes).toContain("SALONS");
  });
});

describe("Issue #624 — PATCH of an assignment", () => {
  let roleId: string;
  let salonId: string;
  let otherSalonId: string;

  beforeAll(async () => {
    const name = `Patch ${randomBytes(3).toString("hex")}`;
    const role = await app.prisma.accessRole.create({
      data: {
        tenantId: t.tenant.id,
        name,
        nameKey: roleNameKey(name),
        permissions: normalizeRolePermissions(["shift:read:ZUGEWIESEN"]),
      },
    });
    roleId = role.id;
    salonId = (await app.prisma.salon.findFirstOrThrow({ where: { tenantId: t.tenant.id } })).id;
    otherSalonId = (await createTestSalon(app.prisma, t.tenant.id)).id;
  });

  async function assign(scope: Record<string, unknown>) {
    const res = await inject("POST", "/api/v1/role-assignments", {
      userId: t.empUser.id,
      accessRoleId: roleId,
      scope,
    });
    expect(res.statusCode, res.body).toBe(201);
    return (JSON.parse(res.body) as { id: string }).id;
  }

  it("without the package TENANT -> SALONS is refused and writes nothing; SALONS -> SALONS stays free", async () => {
    await setModules([TenantModule.CHAIN]);
    const salonsAssignment = await assign({ type: "SALONS", salonIds: [salonId] });
    await setModules([]);

    const edit = await inject("PATCH", `/api/v1/role-assignments/${salonsAssignment}`, {
      scope: { type: "SALONS", salonIds: [salonId, otherSalonId] },
    });
    expect(edit.statusCode, edit.body).toBe(200);

    const toPersons = await inject("PATCH", `/api/v1/role-assignments/${salonsAssignment}`, {
      scope: { type: "PERSONS", employeeIds: [t.employee.id] },
    });
    expectRefusal(toPersons);

    await app.prisma.roleAssignment.delete({ where: { id: salonsAssignment } });
    const tenantWide = await assign({ type: "TENANT" });
    expectRefusal(
      await inject("PATCH", `/api/v1/role-assignments/${tenantWide}`, {
        scope: { type: "SALONS", salonIds: [salonId] },
      }),
    );
    const row = await app.prisma.roleAssignment.findUniqueOrThrow({ where: { id: tenantWide } });
    expect(row.scopeType).toBe("TENANT");
    await app.prisma.roleAssignment.delete({ where: { id: tenantWide } });
  });

  it("with the package both TENANT -> SALONS and SALONS -> SALONS work", async () => {
    await setModules([TenantModule.CHAIN]);
    const id = await assign({ type: "TENANT" });
    const toSalons = await inject("PATCH", `/api/v1/role-assignments/${id}`, {
      scope: { type: "SALONS", salonIds: [salonId] },
    });
    expect(toSalons.statusCode, toSalons.body).toBe(200);
    const edit = await inject("PATCH", `/api/v1/role-assignments/${id}`, {
      scope: { type: "SALONS", salonIds: [salonId, otherSalonId] },
    });
    expect(edit.statusCode, edit.body).toBe(200);
    await app.prisma.roleAssignment.delete({ where: { id } });
  });
});
