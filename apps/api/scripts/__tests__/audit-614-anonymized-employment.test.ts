/**
 * Issue #614, D-04 / AC-614-5 - fixture test for audit-614-anonymized-employment.ts.
 *
 * The script lists DSGVO-anonymized persons whose employment the pre-614 anonymization did not end.
 * This file covers the findings per category (including the persons that must NOT be listed), the
 * ids-only output, the exit codes 0 / 2 / 1, and the read-only guarantee (a database fingerprint
 * before and after a run, plus a source scan for write calls).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  seedTestData,
  cleanupTestData,
  seedEntitlementYears,
} from "../../src/__tests__/setup";
import { getTenantTimezone, todayInTz } from "../../src/contexts/working-time-account";
import {
  main,
  EXIT_OK,
  EXIT_ERROR,
  EXIT_FINDINGS,
  computeAnonymizedEmployment,
} from "../audit-614-anonymized-employment";

async function capture(fn: () => Promise<number>): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const code = await fn();
    return { code, lines };
  } finally {
    spy.mockRestore();
    errSpy.mockRestore();
  }
}

/** Strips block, JSDoc and line comments so a docblock explaining the read-only rule cannot trip a scan. */
function codeOnly(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join("\n");
}

const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

describe("audit-614-anonymized-employment (Issue #614, D-04)", () => {
  let app: FastifyInstance;
  let fixture: Awaited<ReturnType<typeof seedTestData>>;
  let clean: Awaited<ReturnType<typeof seedTestData>>;
  let run: { code: number; lines: string[] };
  let tz: string;

  const names = { first: "Vorname614Zebra", last: "Nachname614Zebra" };
  const numbers: string[] = [];
  const emails: string[] = [];
  const ids = {
    bestandLeave: "",
    bestandAbsence: "",
    viaRoute: "",
    live: "",
    leaveRequest: "",
    absence: "",
    liveLeave: "",
  };

  async function createEmployee(
    tenantId: string,
    label: string,
    overrides: {
      anonymized?: boolean;
      employeeNumber?: string;
      exitDate?: Date;
    } = {},
  ): Promise<string> {
    const s = `${label}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const email = `${s}@example.invalid`;
    const user = await app.prisma.user.create({
      data: {
        email,
        passwordHash: await bcrypt.hash("test1234", 4),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const number = overrides.employeeNumber ?? `N614-${s}`.toUpperCase().slice(0, 28);
    emails.push(email);
    numbers.push(number);
    const employee = await app.prisma.employee.create({
      data: {
        tenantId,
        userId: user.id,
        employeeNumber: number,
        firstName: overrides.anonymized ? "Gelöscht" : names.first,
        lastName: overrides.anonymized ? `GELÖSCHT-${s}`.slice(0, 40) : names.last,
        hireDate: new Date("2025-01-01T00:00:00Z"),
        exitDate: overrides.exitDate ?? null,
      },
    });
    await app.prisma.workSchedule.create({
      data: {
        employeeId: employee.id,
        type: "FIXED_SCHEDULE",
        weeklyHours: 40,
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
        workDays: [1, 2, 3, 4, 5],
        validFrom: new Date("2025-01-01T00:00:00Z"),
      },
    });
    await app.prisma.overtimeAccount.create({
      data: { employeeId: employee.id, balanceHours: 0 },
    });
    return employee.id;
  }

  async function approvedVacation(employeeId: string, start: Date): Promise<string> {
    await seedEntitlementYears(app, {
      employeeId,
      leaveTypeId: fixture.vacationType.id,
      years: [start.getUTCFullYear()],
    });
    const request = await app.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId: fixture.vacationType.id,
        startDate: start,
        endDate: addDays(start, 2),
        days: 3,
        status: "APPROVED",
      },
    });
    await app.prisma.leaveEntitlement.updateMany({
      where: { employeeId, year: start.getUTCFullYear(), leaveType: { code: "VACATION" } },
      data: { usedDays: 3 },
    });
    return request.id;
  }

  /** Row counts and newest timestamps of the four tables the script reads. */
  async function fingerprint(): Promise<string> {
    const [employee, leave, absence, audit] = await Promise.all([
      app.prisma.employee.aggregate({ _count: true, _max: { updatedAt: true } }),
      app.prisma.leaveRequest.aggregate({ _count: true, _max: { updatedAt: true } }),
      app.prisma.absence.aggregate({ _count: true, _max: { createdAt: true } }),
      app.prisma.auditLog.aggregate({ _count: true, _max: { createdAt: true } }),
    ]);
    return JSON.stringify([employee, leave, absence, audit]);
  }

  beforeAll(async () => {
    app = await getTestApp();
    fixture = await seedTestData(app, "audit614");
    clean = await seedTestData(app, "audit614clean");
    tz = await getTenantTimezone(app.prisma, fixture.tenant.id);
    const today = todayInTz(tz);
    const nextMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1));
    const monday = addDays(nextMonth, (1 - nextMonth.getUTCDay() + 7) % 7);

    // (1) Bestand: sentinel set directly, overwritten number, no exit date, leave next month.
    ids.bestandLeave = await createEmployee(fixture.tenant.id, "bl", {
      anonymized: true,
      employeeNumber: `GELÖSCHT-${randomUUID().slice(0, 8)}`,
    });
    ids.leaveRequest = await approvedVacation(ids.bestandLeave, monday);

    // (2) Bestand: exit date last month, a Berufsschule absence after it, original number.
    ids.bestandAbsence = await createEmployee(fixture.tenant.id, "ba", {
      anonymized: true,
      exitDate: addDays(today, -35),
    });
    const absence = await app.prisma.absence.create({
      data: {
        employeeId: ids.bestandAbsence,
        type: "VOCATIONAL_SCHOOL",
        startDate: addDays(today, 7),
        endDate: addDays(today, 7),
        days: 1,
        createdBy: fixture.adminUser.id,
      },
    });
    ids.absence = absence.id;

    // (3) Anonymized through the real route under the 614 rules: not listed.
    ids.viaRoute = await createEmployee(fixture.tenant.id, "vr");
    await approvedVacation(ids.viaRoute, addDays(monday, 7));
    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/employees/${ids.viaRoute}`,
      headers: { authorization: `Bearer ${fixture.adminToken}` },
    });
    expect(del.statusCode, del.body).toBe(204);

    // (4) Not anonymized, future leave: not listed.
    ids.live = await createEmployee(fixture.tenant.id, "lv");
    ids.liveLeave = await approvedVacation(ids.live, addDays(monday, 14));

    // The clean tenant holds one ordinary person.
    await createEmployee(clean.tenant.id, "cl");

    run = await capture(() => main(["--tenant", fixture.tenant.id], app.prisma));
  });

  afterAll(async () => {
    for (const tenantId of [fixture?.tenant.id, clean?.tenant.id]) {
      if (!tenantId) continue;
      try {
        await cleanupTestData(app, tenantId);
      } catch (err) {
        console.error("Test cleanup failed:", err);
      }
    }
  });

  it("lists the Bestand person with leave after the exit: NO_EXIT_DATE, LEAVE_AFTER_EXIT, NUMBER_OVERWRITTEN", () => {
    expect(run.code).toBe(EXIT_FINDINGS);
    const line = run.lines.find((l) => l.includes(`employee=${ids.bestandLeave} `));
    expect(line, "the leave Bestand person has a line").toBeDefined();
    expect(line).toContain(`tenant=${fixture.tenant.id} `);
    expect(line).toContain("findings=NO_EXIT_DATE,LEAVE_AFTER_EXIT,NUMBER_OVERWRITTEN");
    expect(line).toContain(`leaveRequests=${ids.leaveRequest}`);
    expect(line).not.toContain("absences=");
    expect(line).toContain("anonymizeAudit=absent");
  });

  it("lists the Bestand person with an absence after the stored exit date: ABSENCE_AFTER_EXIT only", () => {
    const line = run.lines.find((l) => l.includes(`employee=${ids.bestandAbsence} `));
    expect(line, "the absence Bestand person has a line").toBeDefined();
    expect(line).toContain("findings=ABSENCE_AFTER_EXIT ");
    expect(line).toContain(`absences=${ids.absence}`);
    expect(line).not.toContain("leaveRequests=");
    expect(line).not.toContain("NUMBER_OVERWRITTEN");
  });

  it("does not list a person anonymized under the 614 rules, nor a non-anonymized one", () => {
    const text = run.lines.join("\n");
    expect(text).not.toContain(ids.viaRoute);
    expect(text).not.toContain(ids.live);
    expect(text).not.toContain(ids.liveLeave);
    // Control: the route really anonymized that person and ended the employment.
    return app.prisma.employee
      .findUniqueOrThrow({
        where: { id: ids.viaRoute },
        select: { firstName: true, exitDate: true, employeeNumber: true },
      })
      .then((row) => {
        expect(row.firstName).toBe("Gelöscht");
        expect(row.exitDate).not.toBeNull();
        expect(row.employeeNumber.startsWith("GELÖSCHT-")).toBe(false);
      });
  });

  it("prints ids and category names only, a Totals line, and sorts by tenant then employee id", async () => {
    const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
    const rowLine = new RegExp(
      `^tenant=${UUID} employee=${UUID} findings=[A-Z_]+(,[A-Z_]+)*` +
        `( leaveRequests=${UUID}(,${UUID})*)?( absences=${UUID}(,${UUID})*)?` +
        `( anonymizeAudit=(present|absent))?$`,
    );
    const rowLines = run.lines.filter((l) => l.startsWith("tenant="));
    expect(rowLines).toHaveLength(2); // anti-vacuity: the regex ran on real lines
    for (const line of rowLines) expect(line).toMatch(rowLine);

    const totals = run.lines.filter((l) => l.startsWith("Totals:"));
    expect(totals).toEqual([
      "Totals: employees=2 noExitDate=1 leaveAfterExit=1 absenceAfterExit=1 numberOverwritten=1",
    ]);

    const text = run.lines.join("\n");
    for (const secret of [names.first, names.last, ...numbers, ...emails]) {
      expect(text).not.toContain(secret);
    }

    const rows = await computeAnonymizedEmployment(app.prisma, { tenantId: fixture.tenant.id });
    const keys = rows.map((r) => `${r.tenantId}/${r.employeeId}`);
    expect(keys).toEqual([...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });

  it("without a --tenant filter it still prints the fixture lines and exits 2 (other tenants may add findings)", async () => {
    const all = await capture(() => main([], app.prisma));
    expect(all.code).toBe(EXIT_FINDINGS);
    expect(all.lines.some((l) => l.includes(`employee=${ids.bestandLeave} `))).toBe(true);
    expect(all.lines.some((l) => l.includes(`employee=${ids.bestandAbsence} `))).toBe(true);
  });

  it("exits 0 for a tenant without findings and for a tenant id that does not exist", async () => {
    const cleanRun = await capture(() => main(["--tenant", clean.tenant.id], app.prisma));
    expect(cleanRun.code).toBe(EXIT_OK);
    expect(cleanRun.lines.filter((l) => l.startsWith("tenant="))).toHaveLength(0);
    expect(cleanRun.lines).toContain(
      "Totals: employees=0 noExitDate=0 leaveAfterExit=0 absenceAfterExit=0 numberOverwritten=0",
    );
    const unknown = await capture(() => main(["--tenant", randomUUID()], app.prisma));
    expect(unknown.code).toBe(EXIT_OK);
  });

  it("writes nothing: the database fingerprint is identical before and after a run", async () => {
    const before = await fingerprint();
    const again = await capture(() => main([], app.prisma));
    expect(again.code).toBe(EXIT_FINDINGS);
    expect(await fingerprint()).toBe(before);
  });

  it("is read-only in source: no write call, no raw execute, no name/e-mail selected", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../audit-614-anonymized-employment.ts", import.meta.url)),
      "utf8",
    );
    expect(source.length).toBeGreaterThan(1000); // anti-vacuity: the scan read a real file
    const code = codeOnly(source);
    expect(code).toContain("ANONYMIZED_EMPLOYEE_WHERE"); // anti-vacuity: the scan sees real code
    expect(code).not.toMatch(
      /\b(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/,
    );
    expect(code).not.toMatch(/\$executeRaw/);
    expect(code).not.toMatch(/\$queryRaw/);
    // No select clause names a person's name, number or e-mail address.
    expect(code).not.toMatch(/select:\s*\{[^}]*(employeeNumber|firstName|lastName|email)/);
    // The CLI declares exactly --help and --tenant; no write flag exists.
    expect(code).toMatch(/help: \{ type: "boolean", default: false \}/);
    expect(code).toMatch(/tenant: \{ type: "string" \}/);
    expect(code).not.toMatch(/\b(apply|confirm)\s*:\s*\{/);
  });

  it("rejects a write flag with exit 1 and --help exits 0", async () => {
    const before = await fingerprint();
    expect((await capture(() => main(["--apply"], app.prisma))).code).toBe(EXIT_ERROR);
    expect((await capture(() => main(["--confirm"], app.prisma))).code).toBe(EXIT_ERROR);
    expect(await fingerprint()).toBe(before);
    const help = await capture(() => main(["--help"], app.prisma));
    expect(help.code).toBe(EXIT_OK);
    expect(help.lines.join("\n")).toContain("READ-ONLY");
  });

  it("without DATABASE_URL and without an injected client it exits 1 and connects to nothing", async () => {
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      expect((await capture(() => main([]))).code).toBe(EXIT_ERROR);
    } finally {
      if (saved !== undefined) process.env.DATABASE_URL = saved;
    }
  });

  it("importing the module is side-effect-free (the entrypoint guard keeps it from running)", () => {
    expect(process.exitCode ?? 0).toBe(0);
  });
});
