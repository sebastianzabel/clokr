/**
 * Issue #609 (D-02) - GET/PATCH /api/v1/employees/me/reminders: the person's own reminder opt-outs.
 *
 * Own data only: the employee id comes from the token, a colleague's row never changes, every real
 * change writes one UPDATE Employee audit row with only the changed keys, an unchanged body writes
 * nothing, and the job honours the opt-out (end-to-end link to the start reminder).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  createAdminApiKey,
  removeFixtureApiKeys,
  auditRowChangingField,
  auditRowsFor,
} from "./setup";
import {
  DEFAULT_TZ,
  TEST_DAY,
  addPerson,
  createShift,
  localInstant,
  remindersOf,
  setReminderConfig,
  type ReminderTenant,
} from "./shift-reminder-fixtures-609";

const URL = "/api/v1/employees/me/reminders";

let app: FastifyInstance;
let data: Awaited<ReturnType<typeof seedTestData>>;
let tenant: ReminderTenant;
let apiKeyToken: string;
let colleague: { employeeId: string; userId: string };
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const patch = (payload: unknown, token = data.empToken) =>
  app.inject({ method: "PATCH", url: URL, headers: auth(token), payload: payload as object });
interface RemindersBody {
  error?: string;
  tenant: Record<string, unknown>;
  own: Record<string, boolean>;
}
const body = (res: { body: string }) => JSON.parse(res.body) as RemindersBody;

beforeAll(async () => {
  app = await getTestApp();
  data = await seedTestData(app, "mr609");
  await app.prisma.employee.update({
    where: { id: data.employee.id },
    data: { hireDate: new Date("2025-01-01T00:00:00Z") },
  });
  tenant = {
    tenantId: data.tenant.id,
    salonId: data.salonId,
    tz: DEFAULT_TZ,
    employeeId: data.employee.id,
    userId: data.empUser.id,
  };
  colleague = await addPerson(app, tenant);
  apiKeyToken = (
    await createAdminApiKey(app.prisma, { tenantId: data.tenant.id, createdBy: data.adminUser.id })
  ).token;
});

afterAll(async () => {
  try {
    await removeFixtureApiKeys(app.prisma, data.tenant.id);
    await cleanupTestData(app, data.tenant.id);
  } catch (err) {
    console.error("Cleanup failed:", err);
  }
  await closeTestApp();
});

describe("GET /employees/me/reminders", () => {
  it("answers the tenant defaults and no opt-out for a fresh person", async () => {
    const res = await app.inject({ method: "GET", url: URL, headers: auth(data.empToken) });
    expect(res.statusCode).toBe(200);
    expect(body(res)).toEqual({
      tenant: {
        shiftStartEnabled: false,
        shiftEndEnabled: false,
        dayCloseEnabled: false,
        offsetMinutes: 15,
        dayCloseTime: "20:00",
      },
      own: { shiftStartOff: false, shiftEndOff: false, dayCloseOff: false },
    });
  });

  it("reflects the tenant configuration and the caller's own row", async () => {
    await setReminderConfig(app, data.tenant.id, {
      startEnabled: true,
      endEnabled: false,
      dayCloseEnabled: true,
      offsetMinutes: 25,
      dayCloseTime: "21:30",
    });
    await app.prisma.employee.update({
      where: { id: colleague.employeeId },
      data: { reminderDayCloseOff: true },
    });
    const res = await app.inject({ method: "GET", url: URL, headers: auth(data.empToken) });
    expect(body(res).tenant).toEqual({
      shiftStartEnabled: true,
      shiftEndEnabled: false,
      dayCloseEnabled: true,
      offsetMinutes: 25,
      dayCloseTime: "21:30",
    });
    // the colleague's opt-out is not mine
    expect(body(res).own.dayCloseOff).toBe(false);
    await app.prisma.employee.update({
      where: { id: colleague.employeeId },
      data: { reminderDayCloseOff: false },
    });
    await setReminderConfig(app, data.tenant.id, {
      startEnabled: true,
      endEnabled: false,
      dayCloseEnabled: false,
      offsetMinutes: 15,
      dayCloseTime: "20:00",
    });
  });

  it("answers 401 without a token", async () => {
    const res = await app.inject({ method: "GET", url: URL });
    expect(res.statusCode).toBe(401);
  });

  it("answers 400 to an API key", async () => {
    const res = await app.inject({ method: "GET", url: URL, headers: auth(apiKeyToken) });
    expect(res.statusCode).toBe(400);
  });

  it("answers 400 to a tenant user without an employee profile", async () => {
    const user = await app.prisma.user.create({
      data: {
        email: `mr609-${crypto.randomUUID()}@example.invalid`,
        passwordHash: "x",
      },
    });
    const token = app.jwt.sign({ sub: user.id, tenantId: data.tenant.id } as never);
    const res = await app.inject({ method: "GET", url: URL, headers: auth(token) });
    expect(res.statusCode).toBe(400);
    expect(body(res).error).toBe("Kein Mitarbeiterprofil vorhanden");
    expect((await patch({ shiftStartOff: true }, token)).statusCode).toBe(400);
    await app.prisma.user.delete({ where: { id: user.id } });
  });
});

describe("PATCH /employees/me/reminders", () => {
  it("switches the start reminder off for the caller only and audits exactly that change", async () => {
    const res = await patch({ shiftStartOff: true });
    expect(res.statusCode).toBe(200);
    expect(body(res).own).toEqual({
      shiftStartOff: true,
      shiftEndOff: false,
      dayCloseOff: false,
    });
    const mine = await app.prisma.employee.findUniqueOrThrow({ where: { id: data.employee.id } });
    expect(mine.reminderShiftStartOff).toBe(true);
    const other = await app.prisma.employee.findUniqueOrThrow({
      where: { id: colleague.employeeId },
    });
    expect(other.reminderShiftStartOff).toBe(false);
    expect(await auditRowsFor(app, "Employee", colleague.employeeId, "UPDATE")).toHaveLength(0);

    const row = await auditRowChangingField(
      app,
      "Employee",
      data.employee.id,
      "UPDATE",
      "reminderShiftStartOff",
    );
    expect(row.userId).toBe(data.empUser.id);
    expect(row.oldValue).toEqual({ reminderShiftStartOff: false });
    expect(row.newValue).toEqual({ reminderShiftStartOff: true });
  });

  it("writes nothing and no audit row when the value is unchanged", async () => {
    const before = await auditRowsFor(app, "Employee", data.employee.id, "UPDATE");
    const res = await patch({ shiftStartOff: true });
    expect(res.statusCode).toBe(200);
    expect(body(res).own.shiftStartOff).toBe(true);
    expect(await auditRowsFor(app, "Employee", data.employee.id, "UPDATE")).toHaveLength(
      before.length,
    );
  });

  it("two changed keys write one audit row holding exactly those two keys", async () => {
    const res = await patch({ shiftStartOff: false, dayCloseOff: true, shiftEndOff: false });
    expect(res.statusCode).toBe(200);
    expect(body(res).own).toEqual({
      shiftStartOff: false,
      shiftEndOff: false,
      dayCloseOff: true,
    });
    const row = await auditRowChangingField(
      app,
      "Employee",
      data.employee.id,
      "UPDATE",
      "reminderDayCloseOff",
    );
    expect(row.oldValue).toEqual({ reminderShiftStartOff: true, reminderDayCloseOff: false });
    expect(row.newValue).toEqual({ reminderShiftStartOff: false, reminderDayCloseOff: true });
    // restore
    expect((await patch({ dayCloseOff: false })).statusCode).toBe(200);
  });

  it.each([
    ["an empty body", {}],
    ["an extra key (employeeId)", { shiftStartOff: true, employeeId: "x" }],
    ["a foreign id only", { id: "x" }],
    ["a non-boolean", { shiftStartOff: "true" }],
    ["null", { dayCloseOff: null }],
  ])("refuses %s with 400 and writes nothing", async (_label, payload) => {
    const before = await app.prisma.employee.findUniqueOrThrow({ where: { id: data.employee.id } });
    const auditBefore = await auditRowsFor(app, "Employee", data.employee.id, "UPDATE");
    const res = await patch(payload);
    expect(res.statusCode).toBe(400);
    const after = await app.prisma.employee.findUniqueOrThrow({ where: { id: data.employee.id } });
    expect(after.reminderShiftStartOff).toBe(before.reminderShiftStartOff);
    expect(after.reminderShiftEndOff).toBe(before.reminderShiftEndOff);
    expect(after.reminderDayCloseOff).toBe(before.reminderDayCloseOff);
    expect(await auditRowsFor(app, "Employee", data.employee.id, "UPDATE")).toHaveLength(
      auditBefore.length,
    );
  });

  it("names the empty body with the German message", async () => {
    const res = await patch({});
    expect(body(res).error).toBe("Keine Änderung angegeben");
  });

  it("answers 400 to an API key and 401 without a token", async () => {
    expect((await patch({ shiftStartOff: true }, apiKeyToken)).statusCode).toBe(400);
    const res = await app.inject({ method: "PATCH", url: URL, payload: { shiftStartOff: true } });
    expect(res.statusCode).toBe(401);
  });
});

describe("the job honours the opt-out (link to the start reminder)", () => {
  it("a due start reminder reaches the colleague but not the person who switched it off", async () => {
    await setReminderConfig(app, data.tenant.id, { startEnabled: true });
    await createShift(app, tenant, tenant.employeeId, TEST_DAY, "09:00", "17:00");
    await createShift(app, tenant, colleague.employeeId, TEST_DAY, "09:00", "17:00");
    expect((await patch({ shiftStartOff: true })).statusCode).toBe(200);

    await app.tryShiftReminders(localInstant(TEST_DAY, "09:15"));
    await app.settlePushDispatch();

    expect(await remindersOf(app, tenant.userId, "REMINDER_SHIFT_START")).toHaveLength(0);
    expect(await remindersOf(app, colleague.userId, "REMINDER_SHIFT_START")).toHaveLength(1);
  });
});
