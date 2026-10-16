/**
 * Issue #654 — `POST /api/v1/imports/time-entries` narrows every row to the caller's
 * `time-entry:import` reach. A row for a person outside the reach is a per-row error that reads
 * exactly like an unknown employee number (no membership oracle); nothing is written for it and
 * no per-entry audit row exists for it. Whole-tenant callers are unchanged.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  createTestSalon,
  grantSystemRole,
  soleAuditRow,
  soleAuditRowOrNull,
} from "./setup";
import { normalizeRolePermissions, roleNameKey } from "../contexts/platform";
import { addDaysStr, mondayOfWeekStr } from "./test-dates";

const PASSWORD = "test1234";

describe("Issue #654 — time-entry import is narrowed to the import reach", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: { id: string };
  let salonB: { id: string };
  const people: Record<string, { id: string; number: string; userId: string; email: string }> = {};

  const day = addDaysStr(mondayOfWeekStr(), -14);
  const csv = (rows: string[]) => ["nr;datum;von;bis;pause;notiz", ...rows].join("\n");

  async function person(label: string, salonId: string) {
    const s = `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const email = `${s}@test.de`;
    const user = await app.prisma.user.create({
      data: {
        email,
        passwordHash: await bcrypt.hash(PASSWORD, 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const number = s.toUpperCase().slice(0, 20);
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: number,
        firstName: label,
        lastName: "Reach654",
        hireDate: new Date("2020-01-01"),
      },
    });
    await grantSystemRole(app.prisma, {
      tenantId: data.tenant.id,
      userId: user.id,
      role: "EMPLOYEE",
    });
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: data.tenant.id,
        employeeId: employee.id,
        salonId,
        kind: "HOME",
        validFrom: new Date("2020-01-01"),
        validUntil: null,
        weekdays: [],
      },
    });
    people[label] = { id: employee.id, number, userId: user.id, email };
    return people[label];
  }

  async function importAs(token: string, rows: string[]) {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/imports/time-entries",
      headers: { authorization: `Bearer ${token}` },
      payload: { csv: csv(rows) },
    });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body) as {
      imported: number;
      errors: number;
      details: { row: number; status: string; error?: string }[];
    };
  }

  let scopedToken = "";

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "ir654");
    salonA = await createTestSalon(app.prisma, data.tenant.id, { name: "IR654 Salon A" });
    salonB = await createTestSalon(app.prisma, data.tenant.id, { name: "IR654 Salon B" });
    await person("pa", salonA.id);
    await person("pb", salonB.id);
    const importer = await person("imp", salonA.id);

    const name = `Ir654 ${crypto.randomBytes(3).toString("hex")}`;
    const role = await app.prisma.accessRole.create({
      data: {
        tenantId: data.tenant.id,
        name,
        nameKey: roleNameKey(name),
        permissions: normalizeRolePermissions(["time-entry:import:ZUGEWIESEN"]),
      },
    });
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: data.tenant.id,
        userId: importer.userId,
        accessRoleId: role.id,
        scopeType: "SALONS",
        salonIds: [salonA.id],
        employeeIds: [],
      },
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: importer.email, password: PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    scopedToken = (JSON.parse(login.body) as { accessToken: string }).accessToken;
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("rejects a row for a person of salon B exactly like an unknown number, imports the salon A row", async () => {
    const body = await importAs(scopedToken, [
      `${people.pa.number};${day};08:00;16:00;30;`,
      `${people.pb.number};${day};08:00;16:00;30;`,
      `NOSUCH-654;${day};08:00;16:00;30;`,
    ]);
    expect(body.imported).toBe(1);
    expect(body.errors).toBe(2);
    expect(body.details[0].status).toBe("ok");

    // Same text up to the echoed number: no oracle between "foreign" and "unknown".
    const strip = (msg: string | undefined, nr: string) => (msg ?? "").replace(nr, "<NR>");
    expect(strip(body.details[1].error, people.pb.number)).toBe(
      strip(body.details[2].error, "NOSUCH-654"),
    );
    expect(body.details[1].error).toContain("nicht gefunden");

    expect(
      await app.prisma.timeEntry.count({ where: { employeeId: people.pb.id, deletedAt: null } }),
    ).toBe(0);
    const written = await app.prisma.timeEntry.findMany({
      where: { employeeId: people.pa.id, deletedAt: null },
    });
    expect(written).toHaveLength(1);

    // Audit: exactly one CREATE for the written entry, none for the rejected person.
    await soleAuditRow(app.prisma, {
      where: { entity: "TimeEntry", entityId: written[0].id, action: "CREATE" },
    });
    expect(
      await app.prisma.auditLog.count({
        where: {
          entity: "TimeEntry",
          action: "CREATE",
          newValue: { path: ["employeeId"], equals: people.pb.id },
        },
      }),
    ).toBe(0);
  });

  it("a whole-tenant importer imports both rows", async () => {
    const d = addDaysStr(day, -7);
    const body = await importAs(data.adminToken, [
      `${people.pa.number};${d};08:00;16:00;30;`,
      `${people.pb.number};${d};08:00;16:00;30;`,
    ]);
    expect(body.imported).toBe(2);
    expect(body.errors).toBe(0);
    const pbEntry = await app.prisma.timeEntry.findFirstOrThrow({
      where: { employeeId: people.pb.id, deletedAt: null },
    });
    expect(
      await soleAuditRowOrNull(app.prisma, {
        where: { entity: "TimeEntry", entityId: pbEntry.id, action: "CREATE" },
      }),
    ).not.toBeNull();
  });
});
