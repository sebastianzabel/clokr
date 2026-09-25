/**
 * Phase 77b (Issue #77, D-05/D-12) — `employeeScopeWhere()` is fail-closed.
 *
 * Unit block: every variant binds the tenant (`employee: { tenantId }`) and an empty, undefined or
 * whitespace-only tenant throws `AccessContextError` before any filter is returned.
 *
 * Integration block: before Phase 77b the `employee` / `employees` variants filtered by
 * `employeeId` alone, so a scope naming tenant A but carrying tenant B's employeeId returned B's
 * rows. With the tenant bound in every variant the facade answers `[]` for that scope, and the
 * control with B's own tenant still returns the row (the filter is not simply empty).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../../__tests__/setup";
import { employeeScopeWhere, type EmployeeScope } from "../facade/employee-scope";
import { AccessContextError } from "../access-context-error";
import { getValidWorkedEntriesInRange } from "../../time-tracking";

describe("employeeScopeWhere — fail-closed per variant (Phase 77b, D-05)", () => {
  const badTenants: Array<[string, unknown]> = [
    ["empty", ""],
    ["undefined", undefined],
    ["whitespace-only", "   "],
  ];

  const variants: Array<[string, (tenantId: string) => EmployeeScope]> = [
    ["employee", (tenantId) => ({ kind: "employee", employeeId: "emp-1", tenantId })],
    ["employees", (tenantId) => ({ kind: "employees", employeeIds: ["emp-1", "emp-2"], tenantId })],
    ["tenant", (tenantId) => ({ kind: "tenant", tenantId })],
  ];

  for (const [variant, build] of variants) {
    for (const [label, tenantId] of badTenants) {
      it(`${variant} variant throws AccessContextError for a ${label} tenant`, () => {
        expect(() => employeeScopeWhere(build(tenantId as string))).toThrow(AccessContextError);
      });
    }
  }

  it("employee variant binds the employee AND the tenant", () => {
    expect(
      employeeScopeWhere({ kind: "employee", employeeId: "emp-1", tenantId: "tenant-a" }),
    ).toEqual({ employeeId: "emp-1", employee: { tenantId: "tenant-a" } });
  });

  it("employees variant binds the employee set AND the tenant", () => {
    expect(
      employeeScopeWhere({ kind: "employees", employeeIds: ["emp-1", "emp-2"], tenantId: "t-a" }),
    ).toEqual({ employeeId: { in: ["emp-1", "emp-2"] }, employee: { tenantId: "t-a" } });
  });

  it("tenant variant binds the tenant", () => {
    expect(employeeScopeWhere({ kind: "tenant", tenantId: "tenant-a" })).toEqual({
      employee: { tenantId: "tenant-a" },
    });
  });
});

describe("employeeScopeWhere — a foreign employeeId never passes the facade filter (Phase 77b, D-12)", () => {
  let app: FastifyInstance;
  let tenantA: Awaited<ReturnType<typeof seedTestData>>;
  let tenantB: Awaited<ReturnType<typeof seedTestData>>;
  const day = new Date("2026-02-02T00:00:00Z");

  beforeAll(async () => {
    app = await getTestApp();
    tenantA = await seedTestData(app, "scope-xt-a");
    tenantB = await seedTestData(app, "scope-xt-b");
    await app.prisma.timeEntry.create({
      data: {
        employeeId: tenantB.employee.id,
        date: day,
        startTime: new Date("2026-02-02T08:00:00Z"),
        endTime: new Date("2026-02-02T16:00:00Z"),
        type: "WORK",
        isInvalid: false,
        salonId: tenantB.salonId, // Phase 68b (issue #68)
      },
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantA.tenant.id);
      await cleanupTestData(app, tenantB.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("employee variant: tenant A's scope on tenant B's employee returns nothing", async () => {
    const rows = await getValidWorkedEntriesInRange(
      app.prisma,
      { kind: "employee", employeeId: tenantB.employee.id, tenantId: tenantA.tenant.id },
      day,
      day,
    );
    expect(rows).toEqual([]);
  });

  it("employees variant: tenant A's scope on tenant B's employee returns nothing", async () => {
    const rows = await getValidWorkedEntriesInRange(
      app.prisma,
      { kind: "employees", employeeIds: [tenantB.employee.id], tenantId: tenantA.tenant.id },
      day,
      day,
    );
    expect(rows).toEqual([]);
  });

  it("control: tenant B's own scope returns exactly that entry", async () => {
    const rows = await getValidWorkedEntriesInRange(
      app.prisma,
      { kind: "employee", employeeId: tenantB.employee.id, tenantId: tenantB.tenant.id },
      day,
      day,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].date.toISOString().slice(0, 10)).toBe("2026-02-02");
  });
});
