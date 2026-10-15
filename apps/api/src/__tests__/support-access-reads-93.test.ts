/**
 * Issue #93 (Phase 93b-04, Task 2) — the two person-level support reads over HTTP:
 * `GET /api/v1/operator/tenants/:id/support/employees/:employeeId/month?month=YYYY-MM` and
 * `GET …/employees/:employeeId/contracts`.
 *
 * What is proven here (D-05(2)/(3), D-06, D-11, D-13, D-19, AC-93-2, AC-93-4):
 *   - the response carries only allow-listed keys at every depth, and none of the seeded values of the
 *     six excluded sources (entry note, waived-break reason, leave note, review note, absence document
 *     path, day-break acknowledgement reason; plus the derived invalid-reason text, the absence note
 *     and the creator ids) appears anywhere in the JSON — each marker is a fresh random token per run;
 *   - every read writes one OperatorAuditLog row and one tenant AuditLog row BEFORE the data is read;
 *     a failing audit write is a 500, persists no operator row and never reaches the port;
 *   - a foreign tenant's employee id and an unknown id answer byte-identical 404s and write no read
 *     row; validation answers come only after the grant decision;
 *   - every answer carries `Cache-Control: private, no-store`;
 *   - an anonymised employee is read like any other, with its stored values (D-13);
 *   - the month figures equal a direct `computeMonthReportFigures` call.
 *
 * Operator accounts are never deleted by tests (audit rows reference them with onDelete Restrict), so
 * each case that needs a fresh principal seeds a fresh synthetic operator.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  seedOperator,
  seedSupportAccess,
  cleanupTestData,
} from "./setup";
import { signOperatorToken } from "../contexts/platform/operator-auth";
import { computeMonthReportFigures } from "../contexts/working-time-account";
import { operatorSupportPorts } from "../composition/operator-support-ports";

type Fixture = Awaited<ReturnType<typeof seedTestData>>;
type Principal = { id: string; token: string };

const MONTH = "2026-03";
const YEAR_NUM = 2026;
const MONTH_NUM = 3;

const byKey = (a: string, b: string) => a.localeCompare(b);

/** Every key at every depth of a JSON value, as dotted paths (array indices collapsed). */
function keyPaths(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => keyPaths(item, prefix));
  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => {
      const path = prefix === "" ? key : `${prefix}.${key}`;
      return [path, ...keyPaths(child, path)];
    });
  }
  return [];
}

const uniquePaths = (value: unknown): string[] => [...new Set(keyPaths(value))].sort(byKey);

/** The DTO allow-list of the month view, as dotted paths. A response may use a subset, never more. */
const MONTH_ALLOWED_PATHS = new Set([
  "employee",
  "employee.id",
  "employee.employeeNumber",
  "employee.firstName",
  "employee.lastName",
  "employee.status",
  "month",
  "timezone",
  "entries",
  "entries.id",
  "entries.date",
  "entries.startTime",
  "entries.endTime",
  "entries.breakMinutes",
  "entries.breaks",
  "entries.breaks.startTime",
  "entries.breaks.endTime",
  "entries.breakStatus",
  "entries.salon",
  "entries.salon.id",
  "entries.salon.name",
  "entries.type",
  "entries.source",
  "entries.isInvalid",
  "entries.invalidReasonCode",
  "entries.deleted",
  "entries.isLocked",
  "dayBreaks",
  "dayBreaks.id",
  "dayBreaks.date",
  "dayBreaks.startTime",
  "dayBreaks.endTime",
  "leaveRequests",
  "leaveRequests.id",
  "leaveRequests.typeCode",
  "leaveRequests.typeName",
  "leaveRequests.status",
  "leaveRequests.startDate",
  "leaveRequests.endDate",
  "leaveRequests.halfDay",
  "leaveRequests.days",
  "leaveRequests.daysProvisional",
  "absences",
  "absences.id",
  "absences.type",
  "absences.source",
  "absences.startDate",
  "absences.endDate",
  "absences.halfDay",
  "figures",
  "figures.workedMinutes",
  "figures.expectedMinutes",
  "figures.balanceMinutes",
  "figures.balanceAdjustmentMinutes",
  "figures.basis",
  "figuresUnavailableReason",
  "snapshot",
  "snapshot.confirmed",
  "snapshot.basis",
]);

const MONTH_TOP_KEYS = [
  "absences",
  "dayBreaks",
  "employee",
  "entries",
  "figures",
  "figuresUnavailableReason",
  "leaveRequests",
  "month",
  "snapshot",
  "timezone",
];

const CONTRACT_KEYS = [
  "allowOvertimePayout",
  "contractWorkDaysPerWeek",
  "coreDays",
  "coreEnd",
  "coreStart",
  "dayHours",
  "id",
  "maxNegativeBalanceMinutes",
  "monthlyHours",
  "overtimeMode",
  "overtimeThreshold",
  "type",
  "usualWorkDays",
  "validFrom",
  "weeklyHours",
  "workDays",
];

let app: FastifyInstance;
let addressCounter = 0;
const tenants: Fixture[] = [];

function uniqueAddress(): string {
  const n = addressCounter++;
  return `10.94.${Math.floor(n / 250) % 250}.${(n % 250) + 1}`;
}

async function newTenant(label: string): Promise<Fixture> {
  const fixture = await seedTestData(app, `r93-${label}`);
  tenants.push(fixture);
  return fixture;
}

async function newPrincipal(): Promise<Principal> {
  const operator = await seedOperator(app);
  return {
    id: operator.id,
    token: signOperatorToken(app, operator.id, "access", operator.tokenVersion),
  };
}

/** A principal with a running one-hour grant on the tenant. */
async function grantedPrincipal(tenantId: string): Promise<Principal & { accessId: string }> {
  const principal = await newPrincipal();
  const access = await seedSupportAccess(app, { tenantId, operatorId: principal.id });
  return { ...principal, accessId: access.id };
}

function get(url: string, token: string) {
  return app.inject({
    method: "GET",
    url,
    headers: { authorization: `Bearer ${token}`, "user-agent": "vitest-support-reads" },
    remoteAddress: uniqueAddress(),
  });
}

const monthUrl = (tenantId: string, employeeId: string, month: string | null = MONTH) =>
  `/api/v1/operator/tenants/${tenantId}/support/employees/${employeeId}/month${
    month === null ? "" : `?month=${month}`
  }`;

const contractsUrl = (tenantId: string, employeeId: string) =>
  `/api/v1/operator/tenants/${tenantId}/support/employees/${employeeId}/contracts`;

function operatorReadRows(operatorId: string, tenantId: string) {
  return app.prisma.operatorAuditLog.findMany({
    where: { action: "SUPPORT_DATA_READ", operatorId, subjectTenantId: tenantId },
    orderBy: { createdAt: "asc" },
  });
}

function refusalRows(operatorId: string, tenantId: string) {
  return app.prisma.operatorAuditLog.findMany({
    where: { action: "SUPPORT_ACCESS_REFUSED", operatorId, subjectTenantId: tenantId },
  });
}

beforeAll(async () => {
  app = await getTestApp();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  for (const t of tenants) {
    try {
      await cleanupTestData(app, t.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
  }
  await closeTestApp();
});

describe("GET …/support/employees/:employeeId/month", () => {
  // The seeded values of every excluded source; fresh per run so a coincidental match is impossible.
  const markers = {
    entryNote: `entry-note-${randomUUID()}`,
    waivedReason: `waived-${randomUUID()}`,
    invalidText: `invalid-text-${randomUUID()}`,
    leaveNote: `leave-note-${randomUUID()}`,
    reviewNote: `review-note-${randomUUID()}`,
    absenceNote: `absence-note-${randomUUID()}`,
    documentPath: `documents/${randomUUID()}.pdf`,
    ackReason: `ack-reason-${randomUUID()}`,
    creator: randomUUID(),
  };

  let fx: Fixture;

  async function seedMonth(employeeId: string, salonId: string) {
    const entry = (day: string, extra: Record<string, unknown> = {}) =>
      app.prisma.timeEntry.create({
        data: {
          employeeId,
          date: new Date(`${day}T00:00:00Z`),
          startTime: new Date(`${day}T08:00:00Z`),
          endTime: new Date(`${day}T16:00:00Z`),
          type: "WORK",
          salonId,
          ...extra,
        },
      });
    const withBreak = await entry("2026-03-10", {
      note: markers.entryNote,
      breakWaivedReason: markers.waivedReason,
      createdBy: markers.creator,
      breakMinutes: 30,
      breakStatus: "WAIVED",
    });
    await app.prisma.break.create({
      data: {
        timeEntryId: withBreak.id,
        startTime: new Date("2026-03-10T12:00:00Z"),
        endTime: new Date("2026-03-10T12:30:00Z"),
      },
    });
    await entry("2026-03-11", { deletedAt: new Date(), note: markers.entryNote });
    await entry("2026-03-12", {
      isInvalid: true,
      invalidReasonCode: "MISSING_CLOCK_OUT",
      invalidReason: markers.invalidText,
    });
    // Previous month's last day: must not appear.
    await app.prisma.timeEntry.create({
      data: {
        employeeId,
        date: new Date("2026-02-28T00:00:00Z"),
        startTime: new Date("2026-02-28T20:00:00Z"),
        endTime: new Date("2026-02-28T23:00:00Z"),
        type: "WORK",
        salonId,
      },
    });
    await app.prisma.dayBreak.create({
      data: {
        employeeId,
        date: new Date("2026-03-13T00:00:00Z"),
        startTime: new Date("2026-03-13T12:00:00Z"),
        endTime: new Date("2026-03-13T12:20:00Z"),
        createdBy: markers.creator,
      },
    });
    await app.prisma.dayBreakAck.create({
      data: {
        employeeId,
        date: new Date("2026-03-13T00:00:00Z"),
        reason: markers.ackReason,
        snapshot: {},
        acknowledgedBy: markers.creator,
      },
    });
    await app.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId: fx.vacationType.id,
        startDate: new Date("2026-03-16T00:00:00Z"),
        endDate: new Date("2026-03-18T00:00:00Z"),
        days: 3,
        status: "APPROVED",
        note: markers.leaveNote,
        reviewNote: markers.reviewNote,
        reviewedBy: markers.creator,
        attestPresent: true,
        attestValidFrom: new Date("2026-03-16T00:00:00Z"),
        attestValidTo: new Date("2026-03-18T00:00:00Z"),
      },
    });
    await app.prisma.absence.create({
      data: {
        employeeId,
        type: "VOCATIONAL_SCHOOL",
        startDate: new Date("2026-03-24T00:00:00Z"),
        endDate: new Date("2026-03-24T00:00:00Z"),
        days: 1,
        note: markers.absenceNote,
        documentPath: markers.documentPath,
        createdBy: markers.creator,
        unterrichtsMinutes: 480,
      },
    });
  }

  beforeAll(async () => {
    fx = await newTenant("month");
    await seedMonth(fx.employee.id, fx.salonId);
  });

  it("serves the month with allow-listed keys only and none of the excluded values", async () => {
    const operator = await grantedPrincipal(fx.tenant.id);
    const res = await get(monthUrl(fx.tenant.id, fx.employee.id), operator.token);
    expect(res.statusCode, res.body).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;

    expect(Object.keys(body).sort(byKey)).toEqual(MONTH_TOP_KEYS);
    const unexpected = uniquePaths(body).filter((path) => !MONTH_ALLOWED_PATHS.has(path));
    expect(unexpected).toEqual([]);

    // The six excluded sources (and three more free-text/creator values) appear nowhere in the JSON.
    for (const [name, value] of Object.entries(markers)) {
      expect(res.body, `marker ${name} leaked`).not.toContain(value);
    }
    expect(res.body).not.toContain('"note"');
    expect(res.body).not.toContain('"documentPath"');
    expect(res.body).not.toContain('"attest');
    expect(res.body).not.toContain('"createdBy"');
    expect(res.body).not.toContain('"unterrichtsMinutes"');
    expect(body.month).toBe(MONTH);
    expect(body.timezone).toBe("Europe/Berlin");
  });

  it("lists the deleted entry as a flag, omits the previous month's last day and carries the contents", async () => {
    const operator = await grantedPrincipal(fx.tenant.id);
    const res = await get(monthUrl(fx.tenant.id, fx.employee.id), operator.token);
    const body = JSON.parse(res.body) as {
      entries: { date: string; deleted: boolean; breaks: unknown[]; breakStatus: string }[];
      dayBreaks: { date: string }[];
      leaveRequests: { typeCode: string; status: string; startDate: string }[];
      absences: { type: string }[];
    };
    expect(body.entries.map((e) => e.date)).toEqual(["2026-03-10", "2026-03-11", "2026-03-12"]);
    expect(body.entries.map((e) => e.deleted)).toEqual([false, true, false]);
    expect(body.entries[0].breaks).toHaveLength(1);
    expect(body.entries[0].breakStatus).toBe("WAIVED");
    expect(body.dayBreaks.map((d) => d.date)).toEqual(["2026-03-13"]);
    expect(body.leaveRequests).toHaveLength(1);
    expect(body.leaveRequests[0].typeCode).toBe("VACATION");
    expect(body.leaveRequests[0].startDate).toBe("2026-03-16");
    expect(body.absences.map((a) => a.type)).toEqual(["VOCATIONAL_SCHOOL"]);
    // Each entry row carries exactly the entry allow-list.
    for (const entry of body.entries) {
      expect(Object.keys(entry).sort(byKey)).toEqual(
        [
          "breakMinutes",
          "breakStatus",
          "breaks",
          "date",
          "deleted",
          "endTime",
          "id",
          "invalidReasonCode",
          "isInvalid",
          "isLocked",
          "salon",
          "source",
          "startTime",
          "type",
        ].sort(byKey),
      );
    }
  });

  it("returns figures equal to computeMonthReportFigures and mirrors its confirmed flag", async () => {
    const operator = await grantedPrincipal(fx.tenant.id);
    const res = await get(monthUrl(fx.tenant.id, fx.employee.id), operator.token);
    const body = JSON.parse(res.body) as {
      figures: Record<string, unknown>;
      snapshot: { confirmed: boolean; basis: string };
      figuresUnavailableReason: unknown;
    };
    const direct = await computeMonthReportFigures(app, fx.employee.id, YEAR_NUM, MONTH_NUM);
    expect(body.figures).toEqual({
      workedMinutes: direct.workedMinutes,
      expectedMinutes: direct.expectedMinutes,
      balanceMinutes: direct.balanceMinutes,
      balanceAdjustmentMinutes: direct.balanceAdjustmentMinutes,
      basis: direct.basis,
    });
    expect(body.snapshot).toEqual({ confirmed: direct.confirmed, basis: direct.basis });
    expect(body.figuresUnavailableReason).toBeNull();
  });

  it("writes one operator row and one tenant row per read, two reads two rows, with category, employee, month and reason", async () => {
    const operator = await grantedPrincipal(fx.tenant.id);
    const tenantBefore = await app.prisma.auditLog.count({
      where: { action: "SUPPORT_DATA_READ", entityId: operator.accessId },
    });
    expect((await get(monthUrl(fx.tenant.id, fx.employee.id), operator.token)).statusCode).toBe(
      200,
    );
    const afterOne = await operatorReadRows(operator.id, fx.tenant.id);
    expect(afterOne).toHaveLength(1);
    expect(afterOne[0].newValue).toMatchObject({
      category: "EMPLOYEE_MONTH",
      employeeId: fx.employee.id,
      month: MONTH,
      reason: "Support ticket: fixture grant for a test",
    });
    expect(afterOne[0].entityId).toBe(operator.accessId);
    expect(afterOne[0].ipAddress).toBeTruthy();
    const tenantRows = await app.prisma.auditLog.findMany({
      where: { action: "SUPPORT_DATA_READ", entityId: operator.accessId },
    });
    expect(tenantRows).toHaveLength(tenantBefore + 1);
    expect(tenantRows[0].ipAddress).toBeNull();
    expect(tenantRows[0].newValue).toMatchObject({
      category: "EMPLOYEE_MONTH",
      employeeId: fx.employee.id,
      month: MONTH,
      actor: { type: "OPERATOR", operatorId: operator.id, tenantId: fx.tenant.id },
    });

    expect((await get(monthUrl(fx.tenant.id, fx.employee.id), operator.token)).statusCode).toBe(
      200,
    );
    expect(await operatorReadRows(operator.id, fx.tenant.id)).toHaveLength(2);
    expect(
      await app.prisma.auditLog.count({
        where: { action: "SUPPORT_DATA_READ", entityId: operator.accessId },
      }),
    ).toBe(tenantBefore + 2);
  });

  it("is fail-closed: a failing audit write is a 500 with no data, no persisted operator row and no port call", async () => {
    const operator = await grantedPrincipal(fx.tenant.id);
    const portSpy = vi.spyOn(operatorSupportPorts, "employeeMonth");
    const auditSpy = vi.spyOn(app, "audit").mockRejectedValueOnce(new Error("audit store down"));

    const res = await get(monthUrl(fx.tenant.id, fx.employee.id), operator.token);

    expect(auditSpy).toHaveBeenCalledTimes(1);
    expect(res.statusCode, res.body).toBe(500);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(Object.keys(body)).not.toContain("entries");
    expect(Object.keys(body)).not.toContain("figures");
    expect(res.body).not.toContain(fx.employee.employeeNumber);
    expect(await operatorReadRows(operator.id, fx.tenant.id)).toHaveLength(0);
    expect(portSpy).not.toHaveBeenCalled();

    // The next read (audit healthy again) works and is logged once.
    const retry = await get(monthUrl(fx.tenant.id, fx.employee.id), operator.token);
    expect(retry.statusCode, retry.body).toBe(200);
    expect(await operatorReadRows(operator.id, fx.tenant.id)).toHaveLength(1);
  });

  it("answers a foreign tenant's employee and an unknown id with byte-identical 404s and no read row", async () => {
    const other = await newTenant("month-other");
    const operator = await grantedPrincipal(fx.tenant.id);
    const foreign = await get(monthUrl(fx.tenant.id, other.employee.id), operator.token);
    const unknown = await get(monthUrl(fx.tenant.id, randomUUID()), operator.token);
    expect(foreign.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(`${foreign.statusCode} ${foreign.body}`).toBe(`${unknown.statusCode} ${unknown.body}`);
    expect(await operatorReadRows(operator.id, fx.tenant.id)).toHaveLength(0);
    expect(String(foreign.headers["cache-control"])).toContain("no-store");
    expect(String(unknown.headers["cache-control"])).toContain("no-store");

    const foreignContracts = await get(
      contractsUrl(fx.tenant.id, other.employee.id),
      operator.token,
    );
    const unknownContracts = await get(contractsUrl(fx.tenant.id, randomUUID()), operator.token);
    expect(`${foreignContracts.statusCode} ${foreignContracts.body}`).toBe(
      `${unknownContracts.statusCode} ${unknownContracts.body}`,
    );
    expect(foreignContracts.statusCode).toBe(404);
    expect(await operatorReadRows(operator.id, fx.tenant.id)).toHaveLength(0);
  });

  it("validates the month after the grant decision: 400 under a grant, 403 plus a refusal row without one", async () => {
    const operator = await grantedPrincipal(fx.tenant.id);
    for (const month of ["2026-13", "2026-00", "26-03", "2026-3", "1999-12", "abc"]) {
      const res = await get(monthUrl(fx.tenant.id, fx.employee.id, month), operator.token);
      expect(res.statusCode, `${month}: ${res.body}`).toBe(400);
      expect(String(res.headers["cache-control"])).toContain("no-store");
    }
    const missing = await get(monthUrl(fx.tenant.id, fx.employee.id, null), operator.token);
    expect(missing.statusCode).toBe(400);
    const notUuid = await get(monthUrl(fx.tenant.id, "not-a-uuid"), operator.token);
    expect(notUuid.statusCode).toBe(400);
    expect(await operatorReadRows(operator.id, fx.tenant.id)).toHaveLength(0);

    const bare = await newPrincipal();
    const refusedBefore = (await refusalRows(bare.id, fx.tenant.id)).length;
    const refused = await get(monthUrl(fx.tenant.id, fx.employee.id, "2026-13"), bare.token);
    expect(refused.statusCode).toBe(403);
    expect(JSON.parse(refused.body).code).toBe("SUPPORT_ACCESS_REQUIRED");
    expect(String(refused.headers["cache-control"])).toContain("no-store");
    expect(await refusalRows(bare.id, fx.tenant.id)).toHaveLength(refusedBefore + 1);
    const refusedMissing = await get(monthUrl(fx.tenant.id, fx.employee.id, null), bare.token);
    expect(refusedMissing.statusCode).toBe(403);
    expect(await operatorReadRows(bare.id, fx.tenant.id)).toHaveLength(0);
  });

  it("sets no-store on the 200 answer", async () => {
    const operator = await grantedPrincipal(fx.tenant.id);
    const res = await get(monthUrl(fx.tenant.id, fx.employee.id), operator.token);
    expect(res.statusCode).toBe(200);
    expect(String(res.headers["cache-control"])).toContain("no-store");
  });

  it("refuses a tenant admin token", async () => {
    const res = await get(monthUrl(fx.tenant.id, fx.employee.id), fx.adminToken);
    expect(res.statusCode).toBe(403);
  });

  it("reads an anonymised employee like any other, with the stored values and status ANONYMIZED (D-13)", async () => {
    const anon = await newTenant("month-anon");
    // Stored sentinel values of an anonymised employee (the shape `anonymizeEmployeeData` writes);
    // written directly because only the stored values matter to this read.
    await app.prisma.employee.update({
      where: { id: anon.employee.id },
      data: {
        firstName: "Gelöscht",
        lastName: `GELÖSCHT-${anon.employee.employeeNumber}`,
        employeeNumber: `GELÖSCHT-${anon.employee.employeeNumber}`,
      },
    });
    await app.prisma.timeEntry.create({
      data: {
        employeeId: anon.employee.id,
        date: new Date("2026-03-10T00:00:00Z"),
        startTime: new Date("2026-03-10T08:00:00Z"),
        endTime: new Date("2026-03-10T16:00:00Z"),
        type: "WORK",
        salonId: anon.salonId,
      },
    });
    const operator = await grantedPrincipal(anon.tenant.id);

    const list = await get(
      `/api/v1/operator/tenants/${anon.tenant.id}/support/employees`,
      operator.token,
    );
    const listed = (
      JSON.parse(list.body) as { items: { id: string; status: string }[] }
    ).items.find((item) => item.id === anon.employee.id);
    expect(listed?.status).toBe("ANONYMIZED");

    const res = await get(monthUrl(anon.tenant.id, anon.employee.id), operator.token);
    expect(res.statusCode, res.body).toBe(200);
    const body = JSON.parse(res.body) as {
      employee: { firstName: string; status: string };
      entries: unknown[];
    };
    expect(body.employee.firstName).toBe("Gelöscht");
    expect(body.employee.status).toBe("ANONYMIZED");
    expect(body.entries).toHaveLength(1);
  });
});

describe("GET …/support/employees/:employeeId/contracts", () => {
  let fx: Fixture;

  beforeAll(async () => {
    fx = await newTenant("contracts");
    // A second, older contract and a newer one with a diverging legacy hour pattern (served as stored).
    await app.prisma.workSchedule.create({
      data: {
        employeeId: fx.employee.id,
        type: "FLEXTIME",
        weeklyHours: 30,
        mondayHours: 1,
        tuesdayHours: 1,
        wednesdayHours: 1,
        thursdayHours: 1,
        fridayHours: 0,
        saturdayHours: 0,
        sundayHours: 0,
        workDays: [1, 2, 3, 4],
        coreStart: "09:00",
        coreEnd: "15:00",
        coreDays: [1, 2, 3, 4],
        validFrom: new Date("2025-07-01T00:00:00Z"),
      },
    });
  });

  it("serves the contract history newest first with exactly the contract keys and audits it", async () => {
    const operator = await grantedPrincipal(fx.tenant.id);
    const res = await get(contractsUrl(fx.tenant.id, fx.employee.id), operator.token);
    expect(res.statusCode, res.body).toBe(200);
    expect(String(res.headers["cache-control"])).toContain("no-store");
    const body = JSON.parse(res.body) as { items: Record<string, unknown>[] };
    expect(Object.keys(body)).toEqual(["items"]);
    expect(body.items).toHaveLength(2);
    for (const item of body.items) {
      expect(Object.keys(item).sort(byKey)).toEqual(CONTRACT_KEYS);
      expect(Object.keys(item.dayHours as object).sort(byKey)).toEqual(
        ["friday", "monday", "saturday", "sunday", "thursday", "tuesday", "wednesday"].sort(byKey),
      );
    }
    const validFrom = body.items.map((item) => String(item.validFrom));
    expect(validFrom[0] > validFrom[1]).toBe(true);
    // The seeded base contract starts 2024-01-01, the FLEXTIME row 2025-07-01: newest first.
    expect(body.items[0].type).toBe("FLEXTIME");
    expect(body.items[1].type).toBe("FIXED_SCHEDULE");
    // Served as stored: the FLEXTIME row's placeholder hours are not "corrected".
    expect((body.items[0].dayHours as Record<string, number>).monday).toBe(1);
    expect(body.items[0].workDays).toEqual([1, 2, 3, 4]);

    const rows = await operatorReadRows(operator.id, fx.tenant.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].newValue).toMatchObject({
      category: "CONTRACTS",
      employeeId: fx.employee.id,
    });
    expect((rows[0].newValue as Record<string, unknown>).month).toBeUndefined();
    expect(
      await app.prisma.auditLog.count({
        where: { action: "SUPPORT_DATA_READ", entityId: operator.accessId },
      }),
    ).toBe(1);
  });

  it("refuses without a grant (403 plus refusal row) and returns no data", async () => {
    const bare = await newPrincipal();
    const res = await get(contractsUrl(fx.tenant.id, fx.employee.id), bare.token);
    expect(res.statusCode).toBe(403);
    expect(String(res.headers["cache-control"])).toContain("no-store");
    expect(res.body).not.toContain("validFrom");
    expect(await refusalRows(bare.id, fx.tenant.id)).toHaveLength(1);
    expect(await operatorReadRows(bare.id, fx.tenant.id)).toHaveLength(0);
  });

  it("is fail-closed: a failing audit write is a 500 and the port is never called", async () => {
    const operator = await grantedPrincipal(fx.tenant.id);
    const portSpy = vi.spyOn(operatorSupportPorts, "employeeContracts");
    vi.spyOn(app, "audit").mockRejectedValueOnce(new Error("audit store down"));
    const res = await get(contractsUrl(fx.tenant.id, fx.employee.id), operator.token);
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("validFrom");
    expect(portSpy).not.toHaveBeenCalled();
    expect(await operatorReadRows(operator.id, fx.tenant.id)).toHaveLength(0);
  });
});
