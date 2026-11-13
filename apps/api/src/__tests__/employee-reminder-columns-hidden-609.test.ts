/**
 * Issue #609 (D-16, WR-02) - the employee API does not disclose a colleague's reminder opt-outs. The
 * three opt-out columns of Employee are omitted from every employee response (list, single, create,
 * update (PATCH /:id), reactivate) and from the Employee audit rows of a create and an update; only
 * the own-data route returns them.
 *
 * One place is deliberately NOT hidden (WR-02, ADR 0001-abweichungen entry AF): the person's own
 * change through PATCH /employees/me/reminders is audited with the changed keys, as every change of
 * a person's data is, so holders of `audit-log:read` can read it (and an operator under an active
 * support access, redacted by type). The last describe pins that, so the claim never drifts back to
 * "nobody else sees it".
 *
 * The colleague's columns are set to true through Prisma first, so an absent key can only mean the
 * route omitted it. The check runs on the raw response text, which also covers nested objects.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData, auditRowsFor } from "./setup";

const COLUMNS = ["reminderShiftStartOff", "reminderShiftEndOff", "reminderDayCloseOff"];

let app: FastifyInstance;
let data: Awaited<ReturnType<typeof seedTestData>>;
const admin = () => ({ authorization: `Bearer ${data.adminToken}` });

function expectNoColumns(text: string): void {
  for (const column of COLUMNS) expect(text, column).not.toContain(column);
}

beforeAll(async () => {
  app = await getTestApp();
  data = await seedTestData(app, "hid609");
  await app.prisma.employee.update({
    where: { id: data.employee.id },
    data: { reminderShiftStartOff: true, reminderShiftEndOff: true, reminderDayCloseOff: true },
  });
});

afterAll(async () => {
  try {
    await cleanupTestData(app, data.tenant.id);
  } catch (err) {
    console.error("Cleanup failed:", err);
  }
  await closeTestApp();
});

describe("the employee API omits the reminder opt-out columns (D-16)", () => {
  it("control: the colleague's own-data route still answers their three true values", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/employees/me/reminders",
      headers: { authorization: `Bearer ${data.empToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).own).toEqual({
      shiftStartOff: true,
      shiftEndOff: true,
      dayCloseOff: true,
    });
  });

  it("GET /employees lists the colleague without the columns", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/employees", headers: admin() });
    expect(res.statusCode).toBe(200);
    const rows = JSON.parse(res.body) as { id: string }[];
    // anti-vacuity: the colleague is in the list
    expect(rows.some((r) => r.id === data.employee.id)).toBe(true);
    expectNoColumns(res.body);
  });

  it("GET /employees/:id answers the colleague without the columns", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/employees/${data.employee.id}`,
      headers: admin(),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).id).toBe(data.employee.id);
    expectNoColumns(res.body);
  });

  it("POST /employees answers the new person without the columns", async () => {
    const uid = crypto.randomUUID().slice(0, 8);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/employees",
      headers: admin(),
      payload: {
        usualWorkDays: [1, 2, 3, 4, 5],
        email: `hid609-${uid}@example.invalid`,
        firstName: "Neu",
        lastName: "Angelegt",
        employeeNumber: `H-${uid}`,
        hireDate: new Date("2026-01-01").toISOString(),
        role: "EMPLOYEE",
        weeklyHours: 40,
        password: "Test@1234567!",
      },
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).firstName).toBe("Neu");
    expectNoColumns(res.body);

    // The creation audit row spreads the created row: it must not list the columns either (the
    // values are only the defaults, but an auditor-readable row carries no opt-out at all).
    const created = JSON.parse(res.body) as { id: string };
    const rows = await auditRowsFor(app, "Employee", created.id, "CREATE");
    // anti-vacuity: the creation was audited, and the audited value is a full row
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0]!.newValue)).toContain("employeeNumber");
    expectNoColumns(JSON.stringify([rows[0]!.oldValue, rows[0]!.newValue]));
  });

  it("PATCH /employees/:id answers the update and audits it without the columns", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/employees/${data.employee.id}`,
      headers: admin(),
      payload: { firstName: "Umbenannt" },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).firstName).toBe("Umbenannt");
    expectNoColumns(res.body);

    const rows = await auditRowsFor(app, "Employee", data.employee.id, "UPDATE");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const row of rows) expectNoColumns(JSON.stringify([row.oldValue, row.newValue]));
    // the column values themselves are untouched by the update
    const stored = await app.prisma.employee.findUniqueOrThrow({ where: { id: data.employee.id } });
    expect(stored.reminderShiftStartOff).toBe(true);
  });

  it("PATCH /employees/:id/reactivate answers without the columns", async () => {
    const off = await app.inject({
      method: "PATCH",
      url: `/api/v1/employees/${data.employee.id}/deactivate`,
      headers: admin(),
      payload: { exitDate: new Date(Date.UTC(2026, 5, 30)).toISOString() },
    });
    expect(off.statusCode).toBe(200);
    expectNoColumns(off.body);
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/employees/${data.employee.id}/reactivate`,
      headers: admin(),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).id).toBe(data.employee.id);
    expectNoColumns(res.body);
  });
});

describe("the own-data change is audited and readable by audit-log readers (WR-02)", () => {
  it("an admin with audit-log:read sees the person's own opt-out change, the generic routes still do not carry it", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/employees/me/reminders",
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: { shiftStartOff: false },
    });
    expect(res.statusCode).toBe(200);

    const logs = await app.inject({
      method: "GET",
      url: `/api/v1/audit-logs?entity=Employee&action=UPDATE&userId=${data.empUser.id}`,
      headers: admin(),
    });
    expect(logs.statusCode).toBe(200);
    const rows = (
      JSON.parse(logs.body) as {
        logs: { entityId: string; oldValue: unknown; newValue: unknown }[];
      }
    ).logs.filter((l) => l.entityId === data.employee.id);
    // anti-vacuity: the audited own-data change is in the page the admin reads
    const own = rows.filter((l) => JSON.stringify(l.newValue).includes("reminderShiftStartOff"));
    expect(own).toHaveLength(1);
    expect(own[0]!.oldValue).toEqual({ reminderShiftStartOff: true });
    expect(own[0]!.newValue).toEqual({ reminderShiftStartOff: false });

    // the employee read of the same admin still omits the column
    const read = await app.inject({
      method: "GET",
      url: `/api/v1/employees/${data.employee.id}`,
      headers: admin(),
    });
    expect(read.statusCode).toBe(200);
    expectNoColumns(read.body);
  });
});
