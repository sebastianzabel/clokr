/**
 * Issue #609 (P-609-11) - two-stage evaluation: a tenant tick whose shifts lie outside every enabled
 * window issues no leave, absence, entry, person or notification read. The reads are proven by
 * spies on the Prisma delegates the job reaches through the facades.
 *
 * Every instant is built from an explicit tenant-local date and time (`localInstant`).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, cleanupTestData } from "./setup";
import {
  TEST_DAY,
  addPerson,
  createShift,
  localInstant,
  seedReminderTenant,
  type ReminderTenant,
} from "./shift-reminder-fixtures-609";

let app: FastifyInstance;
let tenant: ReminderTenant;

/** The reads a candidate-free tick must not issue. */
function spyOnStageTwoReads() {
  return {
    leave: vi.spyOn(app.prisma.leaveRequest, "findMany"),
    absence: vi.spyOn(app.prisma.absence, "findMany"),
    entries: vi.spyOn(app.prisma.timeEntry, "findMany"),
    people: vi.spyOn(app.prisma.employee, "findMany"),
    notices: vi.spyOn(app.prisma.notification, "findMany"),
  };
}

/** Restricts the tenant list of the tick to the fixture tenant, so other tenants' reads cannot count. */
function onlyThisTenant() {
  const original = app.prisma.tenant.findMany.bind(app.prisma.tenant) as (
    a: unknown,
  ) => Promise<{ id: string }[]>;
  vi.spyOn(app.prisma.tenant, "findMany").mockImplementation(((args: unknown) =>
    original(args).then((rows) => rows.filter((r) => r.id === tenant.tenantId))) as never);
}

beforeAll(async () => {
  app = await getTestApp();
  tenant = await seedReminderTenant(app, "perf", {
    startEnabled: true,
    endEnabled: true,
    dayCloseEnabled: true,
  });
  const p = await addPerson(app, tenant);
  await createShift(app, tenant, p.employeeId, TEST_DAY, "09:00", "17:00");
});

afterAll(async () => {
  await cleanupTestData(app, tenant.tenantId);
  await closeTestApp();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("an idle tick reads nothing (two-stage evaluation)", () => {
  it("issues no leave, absence, entry, person or notification read when every window is closed", async () => {
    onlyThisTenant();
    const spies = spyOnStageTwoReads();
    // 12:00: after the start window (09:15-10:15), before the end window (17:15) and the evening.
    await app.tryShiftReminders(localInstant(TEST_DAY, "12:00", tenant.tz));
    for (const [name, spy] of Object.entries(spies)) {
      expect(spy.mock.calls, name).toHaveLength(0);
    }
  });

  it("issues each of those reads when one shift is due (control)", async () => {
    onlyThisTenant();
    const spies = spyOnStageTwoReads();
    await app.tryShiftReminders(localInstant(TEST_DAY, "09:15", tenant.tz));
    await app.settlePushDispatch();
    for (const [name, spy] of Object.entries(spies)) {
      expect(spy.mock.calls.length, name).toBeGreaterThan(0);
    }
  });
});
