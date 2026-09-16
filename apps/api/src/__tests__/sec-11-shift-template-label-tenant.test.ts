/**
 * fix(sec-11 / #224): POST /api/v1/shifts resolved a `body.templateId` via an unfiltered
 * `shiftTemplate.findUnique({ where: { id } })` to auto-fill the shift's `label` when none was
 * supplied. ShiftTemplate has its own tenantId — a caller could reference a foreign tenant's
 * template id and have that tenant's TEMPLATE NAME leak into their own tenant's shift label.
 * Fixed with a combined `findFirst({ where: { id, tenantId } })`, mirroring sec-03's fix for the
 * PUT /shifts/:id tenant guard on the same route file.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

function tomorrowIso(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const TENANT_B_TEMPLATE_NAME = "Sec11 TenantB Geheimvorlage";

describe("POST /api/v1/shifts — ShiftTemplate label tenant isolation (#224)", () => {
  let app: FastifyInstance;
  let tenantA: Awaited<ReturnType<typeof seedTestData>>;
  let tenantB: Awaited<ReturnType<typeof seedTestData>>;
  let tenantBTemplateId: string;

  beforeAll(async () => {
    app = await getTestApp();
    tenantA = await seedTestData(app, "sec11-a");
    tenantB = await seedTestData(app, "sec11-b");

    // tenantA's employee must be SHIFT_BASED for the route's eligibility gate.
    await app.prisma.workSchedule.create({
      data: {
        employeeId: tenantA.employee.id,
        type: "SHIFT_BASED",
        weeklyHours: 40,
        // Later than seedTestData's default 2024-01-01 FIXED_SCHEDULE row, so this one wins
        // the `orderBy: { validFrom: "desc" }` tie the eligibility check uses.
        validFrom: new Date("2024-06-01"),
      },
    });

    const template = await app.prisma.shiftTemplate.create({
      data: {
        tenantId: tenantB.tenant.id,
        name: TENANT_B_TEMPLATE_NAME,
        startTime: "09:00",
        endTime: "17:00",
      },
    });
    tenantBTemplateId = template.id;
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantA.tenant.id);
    } catch (err) {
      console.error("Cleanup tenantA failed:", err);
    }
    try {
      await cleanupTestData(app, tenantB.tenant.id);
    } catch (err) {
      console.error("Cleanup tenantB failed:", err);
    }
  });

  it("tenantA admin creating a shift with tenantB's templateId does NOT leak tenantB's template name", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/shifts",
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
      payload: {
        employeeId: tenantA.employee.id,
        templateId: tenantBTemplateId,
        date: tomorrowIso(),
        startTime: "09:00",
        endTime: "17:00",
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.label).not.toBe(TENANT_B_TEMPLATE_NAME);

    const persisted = await app.prisma.shift.findUnique({ where: { id: body.id } });
    expect(persisted?.label).not.toBe(TENANT_B_TEMPLATE_NAME);
  });

  it("tenantB admin creating a shift with their OWN templateId still fills the label (no regression)", async () => {
    // tenantB's employee also needs to be SHIFT_BASED.
    await app.prisma.workSchedule.create({
      data: {
        employeeId: tenantB.employee.id,
        type: "SHIFT_BASED",
        weeklyHours: 40,
        validFrom: new Date("2024-06-01"),
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/shifts",
      headers: { authorization: `Bearer ${tenantB.adminToken}` },
      payload: {
        employeeId: tenantB.employee.id,
        templateId: tenantBTemplateId,
        date: tomorrowIso(),
        startTime: "09:00",
        endTime: "17:00",
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.label).toBe(TENANT_B_TEMPLATE_NAME);
  });
});
