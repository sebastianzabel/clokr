/**
 * Issue #583 (Phase 854, D-854-11) - `GET /audit-logs/export`: the filtered protocol as an audited
 * CSV. The file is the list of `GET /audit-logs` (same parser, same tenant scope), with the code AND
 * the German label of every action and object; the download is audited as EXPORT before the bytes;
 * a principal without `audit-log:read` is refused and nothing is written.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  soleAuditRow,
  soleAuditRowOrNull,
} from "./setup";
import { AUDIT_CSV_HEADER } from "../contexts/platform/audit-csv";

let app: FastifyInstance;
let tenantA: Awaited<ReturnType<typeof seedTestData>>;
let tenantB: Awaited<ReturnType<typeof seedTestData>>;
let addressCounter = 0;

function uniqueAddress(): string {
  const n = addressCounter++;
  return `10.92.${Math.floor(n / 250) % 250}.${(n % 250) + 1}`;
}

function exportCsv(query: string, token: string) {
  return app.inject({
    method: "GET",
    url: `/api/v1/audit-logs/export?${query}`,
    headers: { authorization: `Bearer ${token}` },
    remoteAddress: uniqueAddress(),
  });
}

/** The records of a CSV body without BOM; the fixtures here carry no quoted line break. */
function records(res: { rawPayload: Buffer }): string[][] {
  const text = res.rawPayload.toString("utf8").replace(/^\uFEFF/, "");
  return text
    .split("\r\n")
    .filter((line) => line.length > 0)
    .map((line) => line.split(";"));
}

async function row(data: {
  userId?: string | null;
  action?: string;
  entity?: string;
  entityId?: string;
  createdAt: Date;
  newValue?: object;
  oldValue?: object;
}) {
  await app.prisma.auditLog.create({
    data: {
      userId: data.userId === undefined ? tenantA.adminUser.id : data.userId,
      action: data.action ?? "UPDATE",
      entity: data.entity ?? "TimeEntry",
      entityId: data.entityId ?? randomUUID(),
      createdAt: data.createdAt,
      ...(data.newValue ? { newValue: data.newValue } : {}),
      ...(data.oldValue ? { oldValue: data.oldValue } : {}),
    },
  });
}

beforeAll(async () => {
  app = await getTestApp();
  tenantA = await seedTestData(app, "ale854a");
  tenantB = await seedTestData(app, "ale854b");
  await app.prisma.tenantConfig.update({
    where: { tenantId: tenantA.tenant.id },
    data: { timezone: "Europe/Berlin" },
  });
});

afterAll(async () => {
  await cleanupTestData(app, tenantA.tenant.id);
  await cleanupTestData(app, tenantB.tenant.id);
  await closeTestApp();
});

describe("GET /api/v1/audit-logs/export - the file", () => {
  it("serves CSV (not the 404 of /:id) with BOM, header, CRLF and the attachment name", async () => {
    await row({ createdAt: new Date("2031-01-15T22:30:00Z"), action: "CREATE", entity: "Salon" });
    const res = await exportCsv("from=2031-01-15&to=2031-01-15", tenantA.adminToken);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toBe(
      'attachment; filename="protokoll-2031-01-15-2031-01-15.csv"',
    );
    // BOM first, CRLF line ends, the nine titles.
    expect([...res.rawPayload.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = res.rawPayload.toString("utf8");
    expect(text.endsWith("\r\n")).toBe(true);
    expect(text.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    const [header, ...body] = records(res);
    expect(header.join(";")).toBe(AUDIT_CSV_HEADER);
    expect(header).toHaveLength(9);
    expect(body).toHaveLength(1);
    // Zeitpunkt is tenant-local (22:30Z in January = 23:30), codes next to labels.
    expect(body[0][0]).toBe("15.01.2031 23:30");
    expect(body[0][1]).toBe("Angelegt");
    expect(body[0][2]).toBe("CREATE");
    expect(body[0][3]).toBe("Salon");
    expect(body[0][4]).toBe("Salon");
    expect(body[0][8]).toBe(tenantA.adminUser.email);
  });

  it("shows the fallback label for an unknown code and keeps the code in its own column", async () => {
    await row({
      createdAt: new Date("2031-02-10T10:00:00Z"),
      action: "SOME_FUTURE_ACTION",
      entity: "SomeFutureEntity",
    });
    const res = await exportCsv("from=2031-02-10&to=2031-02-10", tenantA.adminToken);
    const [, line] = records(res);
    expect(line[1]).toBe("Sonstige Änderung");
    expect(line[2]).toBe("SOME_FUTURE_ACTION");
    expect(line[3]).toBe("Sonstige Änderung");
    expect(line[4]).toBe("SomeFutureEntity");
  });

  it("names the affected person with the employee number, guarding a formula-shaped name", async () => {
    const person = await app.prisma.employee.update({
      where: { id: tenantA.employee.id },
      data: { firstName: "=SUM(1)", lastName: "Muster" },
    });
    await row({
      createdAt: new Date("2031-03-05T10:00:00Z"),
      entity: "TimeEntry",
      newValue: { employeeId: person.id },
    });
    const res = await exportCsv(
      `from=2031-03-05&to=2031-03-05&employeeId=${person.id}`,
      tenantA.adminToken,
    );
    const [, line] = records(res);
    expect(line[6]).toBe("'=SUM(1) Muster");
    expect(line[7]).toBe(person.employeeNumber);
  });

  it("reads Betreiber and System for rows without a user, decided by the actor type", async () => {
    await row({
      userId: null,
      createdAt: new Date("2031-04-01T10:00:00Z"),
      action: "UPDATE",
      entity: "Tenant",
      newValue: {
        actor: { type: "OPERATOR", operatorId: randomUUID(), tenantId: tenantA.tenant.id },
      },
    });
    await row({
      userId: null,
      createdAt: new Date("2031-04-01T11:00:00Z"),
      action: "UPDATE",
      entity: "Tenant",
      newValue: { actor: { type: "SYSTEM", tenantId: tenantA.tenant.id } },
    });
    const res = await exportCsv("from=2031-04-01&to=2031-04-01", tenantA.adminToken);
    const actors = records(res)
      .slice(1)
      .map((l) => l[8]);
    expect(actors.sort()).toEqual(["Betreiber", "System"]);
  });

  it("holds exactly the rows of the list for the same filters and never a foreign tenant's", async () => {
    const mine = randomUUID();
    await row({
      createdAt: new Date("2031-05-05T10:00:00Z"),
      entity: "Absence",
      entityId: mine,
    });
    await app.prisma.auditLog.create({
      data: {
        userId: tenantB.adminUser.id,
        action: "UPDATE",
        entity: "Absence",
        entityId: randomUUID(),
        createdAt: new Date("2031-05-05T11:00:00Z"),
        newValue: { employeeId: tenantA.employee.id },
      },
    });
    const query = "from=2031-05-05&to=2031-05-05&entity=Absence";
    const file = await exportCsv(query, tenantA.adminToken);
    const body = records(file).slice(1);
    const list = await app.inject({
      method: "GET",
      url: `/api/v1/audit-logs?${query}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
      remoteAddress: uniqueAddress(),
    });
    const listed = JSON.parse(list.body) as { logs: { entityId: string }[]; total: number };
    expect(body.map((l) => l[5])).toEqual(listed.logs.map((l) => l.entityId));
    expect(body).toHaveLength(1);
    expect(body[0][5]).toBe(mine);
    expect(listed.total).toBe(1);
  });
});

describe("GET /api/v1/audit-logs/export - audited before the bytes", () => {
  it("writes one EXPORT row naming the filters and the row count", async () => {
    await row({ createdAt: new Date("2031-06-10T10:00:00Z"), action: "DELETE", entity: "Salon" });
    await row({ createdAt: new Date("2031-06-10T11:00:00Z"), action: "DELETE", entity: "Salon" });
    const res = await exportCsv(
      "from=2031-06-10&to=2031-06-10&action=DELETE&entity=Salon",
      tenantA.adminToken,
    );
    expect(res.statusCode, res.body).toBe(200);
    const audit = await soleAuditRow(app.prisma, {
      where: {
        action: "EXPORT",
        entity: "AuditLog",
        userId: tenantA.adminUser.id,
        newValue: { path: ["from"], equals: "2031-06-10" },
      },
    });
    expect(audit.newValue).toEqual({
      type: "AUDIT_LOG_CSV",
      from: "2031-06-10",
      to: "2031-06-10",
      action: "DELETE",
      entity: "Salon",
      userId: null,
      employeeId: null,
      rowCount: 2,
    });
  });
});

describe("GET /api/v1/audit-logs/export - refusals write nothing", () => {
  it("refuses a principal without audit-log:read with 403 and writes no EXPORT row", async () => {
    // The employee role holds neither the protocol nor the reports.
    const res = await exportCsv("from=2031-07-01&to=2031-07-01", tenantA.empToken);
    expect(res.statusCode).toBe(403);
    const written = await soleAuditRowOrNull(app.prisma, {
      where: { action: "EXPORT", entity: "AuditLog", userId: tenantA.empUser.id },
    });
    expect(written).toBeNull();
  });

  it("refuses a missing from or to with 400", async () => {
    for (const q of ["", "from=2031-07-01", "to=2031-07-01"]) {
      const res = await exportCsv(q, tenantA.adminToken);
      expect(res.statusCode, q).toBe(400);
      expect(typeof JSON.parse(res.body).error).toBe("string");
    }
  });

  it("refuses an inverted range and a range above 366 days with 400", async () => {
    const inverted = await exportCsv("from=2031-07-02&to=2031-07-01", tenantA.adminToken);
    expect(inverted.statusCode).toBe(400);
    // 2031 has 365 days: 2031-01-01..2032-01-01 is exactly 366 days, one more day is refused.
    const tooLong = await exportCsv("from=2031-01-01&to=2032-01-02", tenantA.adminToken);
    expect(tooLong.statusCode).toBe(400);
    expect(JSON.parse(tooLong.body).error).toContain("366");
    const exactly = await exportCsv("from=2031-01-01&to=2032-01-01", tenantA.adminToken);
    expect(exactly.statusCode, exactly.body).toBe(200);
    // The two refusals wrote nothing; only the accepted export left its row.
    const refused = await soleAuditRowOrNull(app.prisma, {
      where: {
        action: "EXPORT",
        entity: "AuditLog",
        userId: tenantA.adminUser.id,
        newValue: { path: ["from"], equals: "2031-07-02" },
      },
    });
    expect(refused).toBeNull();
  });

  it("refuses a set above the cap before anything is written", async () => {
    const cap = 10_000;
    await app.prisma.auditLog.createMany({
      data: Array.from({ length: cap + 1 }, () => ({
        userId: tenantA.adminUser.id,
        action: "UPDATE",
        entity: "TimeEntry",
        entityId: randomUUID(),
        createdAt: new Date("2033-03-03T10:00:00Z"),
      })),
    });
    const res = await exportCsv("from=2033-03-03&to=2033-03-03", tenantA.adminToken);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe(
      "Zu viele Einträge für einen Export. Wähle einen kürzeren Zeitraum.",
    );
    const written = await soleAuditRowOrNull(app.prisma, {
      where: {
        action: "EXPORT",
        entity: "AuditLog",
        userId: tenantA.adminUser.id,
        newValue: { path: ["from"], equals: "2033-03-03" },
      },
    });
    expect(written).toBeNull();
  });
});
