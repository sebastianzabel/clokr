/**
 * Issue #666 - fixture test for backfill-666-anonymized-employment.ts.
 *
 * The script corrects persons anonymized BEFORE Issue #614: it sets the missing exit date (the
 * tenant-local day of the ANONYMIZE audit), runs the one exit rule of employment-exit.ts and
 * restores the employee number from the audit oldValue.
 *
 * Every date is fixed and lies in the past of the real run (September / August 2026): the "faked
 * clock" is the stored ANONYMIZE audit timestamp, the script never reads the current day.
 *
 *   A  number restorable, no exit date, spanning + later vacation, Berufsschule before / after
 *   B  ANONYMIZE audit without a usable oldValue (redacted)
 *   C  the restored number is already held by another employee of the tenant
 *   D  vacation inside a month that was closed meanwhile
 *   E  a stored exit date that is EARLIER than the audit day
 *   F  no exit date and no ANONYMIZE audit at all
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
  auditRowsFor,
  soleAuditRow,
} from "../../src/__tests__/setup";
import { computeAnonymizedEmployment } from "../audit-614-anonymized-employment";
import { main, EXIT_OK, EXIT_ERROR } from "../backfill-666-anonymized-employment";

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

/** Strips block, JSDoc and line comments so a docblock cannot trip a source scan. */
function codeOnly(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join("\n");
}

const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
const MARKER_REASON = "Bestandskorrektur #666";
const MARKER_TRIGGER = "BACKFILL_666";

describe("backfill-666-anonymized-employment (Issue #666)", () => {
  let app: FastifyInstance;
  let fixture: Awaited<ReturnType<typeof seedTestData>>;
  let other: Awaited<ReturnType<typeof seedTestData>>;

  const people = {} as Record<"A" | "B" | "C" | "D" | "E" | "F", string>;
  const originalNumber = {} as Record<string, string>;
  const secrets: string[] = [];
  const ids = {
    spanning: "",
    later: "",
    bsAfter: "",
    bsBefore: "",
    bLeave: "",
    dLeave: "",
    eLeave: "",
    holder: "",
  };
  let dSnapshotsBefore = "";
  let dry: { code: number; lines: string[] };
  let confirm: { code: number; lines: string[] };
  let again: { code: number; lines: string[] };
  let fingerprintAround: { before: string; after: string };

  /** A pre-614 anonymized person: sentinel names, the overwritten number, no exit date. */
  async function legacyAnonymized(
    tenantId: string,
    label: string,
    opts: {
      number: string;
      hireDate?: Date;
      exitDate?: Date;
      /** The ANONYMIZE audit row; omitted = none. */
      audit?: { at: string; oldValue: object };
    },
  ): Promise<string> {
    const s = `${label}${Math.random().toString(36).slice(2, 8)}`;
    const email = `${s}@example.invalid`;
    secrets.push(email);
    const user = await app.prisma.user.create({
      data: {
        email,
        passwordHash: await bcrypt.hash("test1234", 4),
        role: "EMPLOYEE",
        isActive: false,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId,
        userId: user.id,
        employeeNumber: `GELÖSCHT-${opts.number}`,
        firstName: "Gelöscht",
        lastName: `GELÖSCHT-${opts.number}`,
        hireDate: opts.hireDate ?? day("2025-01-01"),
        exitDate: opts.exitDate ?? null,
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
        validFrom: day("2025-01-01"),
      },
    });
    await app.prisma.overtimeAccount.create({ data: { employeeId: employee.id, balanceHours: 0 } });
    await seedEntitlementYears(app, {
      employeeId: employee.id,
      leaveTypeId: fixture.vacationType.id,
      years: [2026],
    });
    if (opts.audit) {
      await app.prisma.auditLog.create({
        data: {
          action: "ANONYMIZE",
          entity: "Employee",
          entityId: employee.id,
          oldValue: opts.audit.oldValue,
          createdAt: new Date(`${opts.audit.at}T10:00:00Z`),
        },
      });
    }
    return employee.id;
  }

  async function approvedVacation(
    employeeId: string,
    start: string,
    end: string,
    days: number,
  ): Promise<string> {
    const row = await app.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId: fixture.vacationType.id,
        startDate: day(start),
        endDate: day(end),
        days,
        status: "APPROVED",
      },
    });
    await app.prisma.leaveEntitlement.updateMany({
      where: { employeeId, year: 2026, leaveType: { code: "VACATION" } },
      data: { usedDays: { increment: days } },
    });
    return row.id;
  }

  const usedDays = async (employeeId: string) =>
    Number(
      (
        await app.prisma.leaveEntitlement.findFirstOrThrow({
          where: { employeeId, year: 2026, leaveType: { code: "VACATION" } },
        })
      ).usedDays,
    );

  async function bsAbsence(employeeId: string, iso: string): Promise<string> {
    const row = await app.prisma.absence.create({
      data: {
        employeeId,
        type: "VOCATIONAL_SCHOOL",
        startDate: day(iso),
        endDate: day(iso),
        days: 1,
        createdBy: fixture.adminUser.id,
      },
    });
    return row.id;
  }

  /** Row counts and newest timestamps of every table the script can write. */
  async function fingerprint(): Promise<string> {
    const p = app.prisma;
    const parts = await Promise.all([
      p.employee.aggregate({ _count: true, _max: { updatedAt: true } }),
      p.leaveRequest.aggregate({ _count: true, _max: { updatedAt: true } }),
      p.absence.aggregate({ _count: true, _max: { deletedAt: true } }),
      p.leaveEntitlement.aggregate({ _count: true, _max: { updatedAt: true } }),
      p.saldoSnapshot.aggregate({ _count: true, _max: { closedAt: true } }),
      p.overtimeAccount.aggregate({ _count: true, _max: { updatedAt: true } }),
      p.section9Credit.aggregate({ _count: true, _max: { updatedAt: true } }),
      p.auditLog.aggregate({ _count: true, _max: { createdAt: true } }),
    ]);
    return JSON.stringify(parts);
  }

  const snapshotsOf = async (employeeId: string) =>
    JSON.stringify(
      await app.prisma.saldoSnapshot.findMany({
        where: { employeeId },
        orderBy: [{ periodStart: "asc" }, { id: "asc" }],
      }),
    );

  const employeeRow = (id: string) =>
    app.prisma.employee.findUniqueOrThrow({
      where: { id },
      select: { exitDate: true, employeeNumber: true, firstName: true, lastName: true },
    });

  beforeAll(async () => {
    app = await getTestApp();
    fixture = await seedTestData(app, "bf666");
    other = await seedTestData(app, "bf666other");
    const tenantId = fixture.tenant.id;

    // A: audit on Wed 2026-09-09. Spanning vacation Mon 09-07..Fri 09-11 (5 days), later vacation
    // Mon 09-14..Tue 09-15 (2 days), Berufsschule Tue 09-08 (before) and Mon 09-14 (after).
    originalNumber.A = `A666${randomUUID().slice(0, 8)}`;
    people.A = await legacyAnonymized(tenantId, "a", {
      number: originalNumber.A,
      audit: { at: "2026-09-09", oldValue: { employeeNumber: originalNumber.A } },
    });
    ids.spanning = await approvedVacation(people.A, "2026-09-07", "2026-09-11", 5);
    ids.later = await approvedVacation(people.A, "2026-09-14", "2026-09-15", 2);
    ids.bsBefore = await bsAbsence(people.A, "2026-09-08");
    ids.bsAfter = await bsAbsence(people.A, "2026-09-14");

    // B: the audit exists but its oldValue was redacted by a later sweep.
    originalNumber.B = `B666${randomUUID().slice(0, 8)}`;
    people.B = await legacyAnonymized(tenantId, "b", {
      number: originalNumber.B,
      audit: { at: "2026-09-09", oldValue: { anonymized: true, redacted: "COMP-V1814-01" } },
    });
    ids.bLeave = await approvedVacation(people.B, "2026-09-14", "2026-09-16", 3);

    // C: another employee of the tenant holds the number the audit would restore.
    originalNumber.C = `C666${randomUUID().slice(0, 8)}`;
    people.C = await legacyAnonymized(tenantId, "c", {
      number: originalNumber.C,
      audit: { at: "2026-09-09", oldValue: { employeeNumber: originalNumber.C } },
    });
    const holderUser = await app.prisma.user.create({
      data: {
        email: `holder666${Math.random().toString(36).slice(2, 8)}@example.invalid`,
        passwordHash: "x",
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    secrets.push(holderUser.email);
    const holder = await app.prisma.employee.create({
      data: {
        tenantId,
        userId: holderUser.id,
        employeeNumber: originalNumber.C,
        firstName: "Holder",
        lastName: "Holder",
        hireDate: day("2025-01-01"),
      },
    });
    ids.holder = holder.id;

    // D: anonymized Wed 2026-08-05; vacation Mon 08-10..Wed 08-12 inside August, which is closed
    // afterwards (months close in order from the first tracked month, so August is the first).
    originalNumber.D = `D666${randomUUID().slice(0, 8)}`;
    people.D = await legacyAnonymized(tenantId, "d", {
      number: originalNumber.D,
      hireDate: day("2026-08-01"),
      audit: { at: "2026-08-05", oldValue: { employeeNumber: originalNumber.D } },
    });
    ids.dLeave = await approvedVacation(people.D, "2026-08-10", "2026-08-12", 3);
    const close = await app.inject({
      method: "POST",
      url: "/api/v1/overtime/close-month",
      headers: { authorization: `Bearer ${fixture.adminToken}` },
      payload: { employeeId: people.D, year: 2026, month: 8, confirmGaps: true },
    });
    expect(close.statusCode, close.body).toBe(201);
    dSnapshotsBefore = await snapshotsOf(people.D);
    expect(JSON.parse(dSnapshotsBefore).length, "anti-vacuity: August is really closed").toBe(1);

    // E: a stored exit date (Wed 09-02) EARLIER than the audit day; vacation after it.
    originalNumber.E = `E666${randomUUID().slice(0, 8)}`;
    people.E = await legacyAnonymized(tenantId, "e", {
      number: originalNumber.E,
      exitDate: day("2026-09-02"),
      audit: { at: "2026-09-09", oldValue: { employeeNumber: originalNumber.E } },
    });
    ids.eLeave = await approvedVacation(people.E, "2026-09-07", "2026-09-11", 5);

    // F: nothing to decide the exit day from.
    originalNumber.F = `F666${randomUUID().slice(0, 8)}`;
    people.F = await legacyAnonymized(tenantId, "f", { number: originalNumber.F });

    secrets.push(...Object.values(originalNumber), "Gelöscht");

    // ── dry run, then confirm, then a second confirm ──────────────────────────
    const before = await fingerprint();
    dry = await capture(() => main(["--tenant", tenantId], app));
    fingerprintAround = { before, after: await fingerprint() };
    confirm = await capture(() => main(["--tenant", tenantId, "--confirm"], app));
    again = await capture(() => main(["--tenant", tenantId, "--confirm"], app));
  });

  afterAll(async () => {
    for (const tenantId of [fixture?.tenant.id, other?.tenant.id]) {
      if (!tenantId) continue;
      try {
        await cleanupTestData(app, tenantId);
      } catch (err) {
        console.error("Test cleanup failed:", err);
      }
    }
  });

  const lineOf = (run: { lines: string[] }, employeeId: string) =>
    run.lines.find((l) => l.includes(`employee=${employeeId} `));

  describe("dry run (the default)", () => {
    it("writes nothing: the database fingerprint is identical before and after", () => {
      expect(dry.code).toBe(EXIT_OK);
      expect(fingerprintAround.after).toBe(fingerprintAround.before);
      expect(dry.lines).toContain("Dry run: this run wrote nothing.");
    });

    it("prints the plan per person: planned exit date, number outcome, exit-rule counts, skips", () => {
      const a = lineOf(dry, people.A);
      expect(a).toContain(`tenant=${fixture.tenant.id} `);
      expect(a).toContain(
        "exitDate=set:2026-09-09 number=restore cancelled=1 shortened=1 deleted=1",
      );
      expect(a).toContain("skipped=none result=planned");
      expect(lineOf(dry, people.B)).toContain(
        "exitDate=set:2026-09-09 number=no-oldValue cancelled=1",
      );
      expect(lineOf(dry, people.C)).toContain("number=collision");
      expect(lineOf(dry, people.D)).toContain(
        `skipped=LeaveRequest:${ids.dLeave}:CLOSED_MONTH result=planned`,
      );
      expect(lineOf(dry, people.E)).toContain(
        "exitDate=keep:2026-09-02 number=restore cancelled=1",
      );
      expect(lineOf(dry, people.F)).toContain("exitDate=unknown number=no-oldValue");
      expect(lineOf(dry, people.F)).toContain("result=unchanged");
    });

    it("prints ids, dates, counts and codes only - never a name, number or e-mail address", () => {
      const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
      const rows = dry.lines.filter((l) => l.startsWith("tenant="));
      expect(rows.length).toBeGreaterThanOrEqual(6); // anti-vacuity: the regex ran on real lines
      for (const row of rows) {
        expect(row).toMatch(
          new RegExp(
            `^tenant=${UUID} employee=${UUID} exitDate=(unknown|(set|keep):\\d{4}-\\d{2}-\\d{2}) ` +
              `number=(restore|none|collision|no-oldValue) cancelled=\\d+ shortened=\\d+ deleted=\\d+ ` +
              `skipped=(none|[A-Za-z]+:${UUID}:[A-Z_]+(,[A-Za-z]+:${UUID}:[A-Z_]+)*) ` +
              `result=(planned|written|unchanged|failed:\\w+)$`,
          ),
        );
      }
      const text = [...dry.lines, ...confirm.lines, ...again.lines].join("\n");
      for (const secret of secrets) expect(text).not.toContain(secret);
    });
  });

  describe("--confirm", () => {
    it("A: exit date set to the tenant-local audit day, the exit rule ran, the number is back", async () => {
      expect(confirm.code).toBe(EXIT_OK);
      const row = await employeeRow(people.A);
      expect(row.exitDate?.toISOString()).toBe("2026-09-09T00:00:00.000Z");
      expect(row.employeeNumber).toBe(originalNumber.A);
      expect(row.firstName).toBe("Gelöscht"); // still anonymized

      const later = await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id: ids.later } });
      expect(later.status).toBe("CANCELLED");
      const spanning = await app.prisma.leaveRequest.findUniqueOrThrow({
        where: { id: ids.spanning },
      });
      expect(spanning.status).toBe("APPROVED");
      expect(spanning.endDate.toISOString()).toBe("2026-09-09T00:00:00.000Z");
      // Mon-Wed minus the Berufsschule Tuesday (an imposed day is no vacation day).
      expect(Number(spanning.days)).toBe(2);
      expect(await usedDays(people.A)).toBe(2); // 7 booked: 2 given back by the cancel, 3 by the shortening

      const after = await app.prisma.absence.findUniqueOrThrow({ where: { id: ids.bsAfter } });
      expect(after.deletedAt).not.toBeNull();
      const before = await app.prisma.absence.findUniqueOrThrow({ where: { id: ids.bsBefore } });
      expect(before.deletedAt).toBeNull();
    });

    it("A: every write is audited with the Bestandskorrektur marker and no free text", async () => {
      for (const [entity, entityId, action] of [
        ["LeaveRequest", ids.later, "CANCEL"],
        ["LeaveRequest", ids.spanning, "LEAVE_CORRECTED"],
        ["Absence", ids.bsAfter, "DELETE"],
      ] as const) {
        const row = await soleAuditRow(app.prisma, { where: { entity, entityId, action } });
        const nv = row.newValue as Record<string, unknown>;
        expect(nv.auditReason, `${entity} ${action}`).toBe(MARKER_REASON);
        expect(nv.trigger, `${entity} ${action}`).toBe(MARKER_TRIGGER);
        expect(row.userId).toBeNull(); // the system acts, no user
      }
      expect(await auditRowsFor(app, "Absence", ids.bsBefore)).toHaveLength(0);

      const employeeAudit = await soleAuditRow(app.prisma, {
        where: { entity: "Employee", entityId: people.A, action: "UPDATE" },
      });
      expect(employeeAudit.oldValue).toEqual({
        exitDate: null,
        employeeNumber: `GELÖSCHT-${originalNumber.A}`,
      });
      expect(employeeAudit.newValue).toEqual({
        exitDate: "2026-09-09",
        employeeNumber: originalNumber.A,
        auditReason: MARKER_REASON,
        trigger: MARKER_TRIGGER,
      });
    });

    it("A: the #447 exit-year entitlement sync leaves the row consistent (a re-run changes nothing)", async () => {
      const { syncExitYearVacationEntitlement } = await import("../../src/contexts/absence");
      const result = await syncExitYearVacationEntitlement(
        app.prisma,
        people.A,
        fixture.tenant.id,
        2026,
        async () => undefined,
      );
      expect(result.changed).toBe(false);
    });

    it("B: no usable oldValue - the number stays overwritten, reported NO_OLD_VALUE, the exit still ran", async () => {
      const row = await employeeRow(people.B);
      expect(row.employeeNumber).toBe(`GELÖSCHT-${originalNumber.B}`);
      expect(row.exitDate?.toISOString()).toBe("2026-09-09T00:00:00.000Z");
      expect(
        (await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id: ids.bLeave } })).status,
      ).toBe("CANCELLED");
      expect(lineOf(confirm, people.B)).toContain("number=no-oldValue");
      expect(await usedDays(people.B)).toBe(0);
    });

    it("C: a taken number is never written - reported COLLISION, the holder is untouched", async () => {
      const row = await employeeRow(people.C);
      expect(row.employeeNumber).toBe(`GELÖSCHT-${originalNumber.C}`);
      expect(row.exitDate?.toISOString()).toBe("2026-09-09T00:00:00.000Z");
      expect(lineOf(confirm, people.C)).toContain("number=collision");
      const holder = await app.prisma.employee.findUniqueOrThrow({ where: { id: ids.holder } });
      expect(holder.employeeNumber).toBe(originalNumber.C);
      const audit = await soleAuditRow(app.prisma, {
        where: { entity: "Employee", entityId: people.C, action: "UPDATE" },
      });
      expect(Object.keys(audit.newValue as object).sort()).toEqual([
        "auditReason",
        "exitDate",
        "trigger",
      ]);
    });

    it("D: the closed month stays sum-identical (full SaldoSnapshot rows), the vacation is reported CLOSED_MONTH", async () => {
      expect(await snapshotsOf(people.D)).toBe(dSnapshotsBefore);
      const leave = await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id: ids.dLeave } });
      expect(leave.status).toBe("APPROVED");
      expect(await usedDays(people.D)).toBe(3);
      expect((await employeeRow(people.D)).exitDate?.toISOString()).toBe(
        "2026-08-05T00:00:00.000Z",
      );
      expect(lineOf(confirm, people.D)).toContain(
        `skipped=LeaveRequest:${ids.dLeave}:CLOSED_MONTH result=written`,
      );
    });

    it("E: a stored exit date is never moved; the rule runs against it", async () => {
      const row = await employeeRow(people.E);
      expect(row.exitDate?.toISOString()).toBe("2026-09-02T00:00:00.000Z");
      expect(row.employeeNumber).toBe(originalNumber.E);
      expect(
        (await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id: ids.eLeave } })).status,
      ).toBe("CANCELLED");
      const audit = await soleAuditRow(app.prisma, {
        where: { entity: "Employee", entityId: people.E, action: "UPDATE" },
      });
      expect(Object.keys(audit.oldValue as object)).toEqual(["employeeNumber"]);
    });

    it("F: without an exit day nothing is written for the person", async () => {
      const row = await employeeRow(people.F);
      expect(row.exitDate).toBeNull();
      expect(row.employeeNumber).toBe(`GELÖSCHT-${originalNumber.F}`);
      expect(await auditRowsFor(app, "Employee", people.F, "UPDATE")).toHaveLength(0);
    });

    it("the audit-614 listing no longer reports the corrected persons", async () => {
      const rows = await computeAnonymizedEmployment(app.prisma, { tenantId: fixture.tenant.id });
      const byId = new Map(rows.map((r) => [r.employeeId, r.findings]));
      expect(byId.has(people.A)).toBe(false);
      expect(byId.has(people.E)).toBe(false);
      // Reported, not corrected: each keeps exactly the finding the script named.
      expect(byId.get(people.B)).toEqual(["NUMBER_OVERWRITTEN"]);
      expect(byId.get(people.C)).toEqual(["NUMBER_OVERWRITTEN"]);
      expect(byId.get(people.D)).toEqual(["LEAVE_AFTER_EXIT"]);
      expect(byId.get(people.F)).toEqual(["NO_EXIT_DATE", "NUMBER_OVERWRITTEN"]);
    });
  });

  describe("idempotence", () => {
    it("a second --confirm plans and writes nothing for the corrected persons", async () => {
      expect(again.code).toBe(EXIT_OK);
      for (const id of [people.A, people.B, people.C, people.E, people.F]) {
        expect(lineOf(again, id), id).toContain("result=unchanged");
      }
      // D keeps only its reported skip, no write.
      expect(lineOf(again, people.D)).toContain("exitDate=keep:2026-08-05 number=none");
      expect(await auditRowsFor(app, "Employee", people.A, "UPDATE")).toHaveLength(1);
      expect(await auditRowsFor(app, "LeaveRequest", ids.later, "CANCEL")).toHaveLength(1);
      expect(await snapshotsOf(people.D)).toBe(dSnapshotsBefore);
    });
  });

  describe("scope and isolation", () => {
    it("a tenant filter that matches nobody plans nothing; another tenant is never touched", async () => {
      const none = await capture(() => main(["--tenant", other.tenant.id], app));
      expect(none.code).toBe(EXIT_OK);
      expect(none.lines.filter((l) => l.startsWith("tenant="))).toHaveLength(0);
      const unknown = await capture(() => main(["--tenant", randomUUID()], app));
      expect(unknown.lines.filter((l) => l.startsWith("tenant="))).toHaveLength(0);
    });

    it("a failure for one person is reported, rolls that person back and does not stop the others", async () => {
      const tenantId = other.tenant.id;
      const n1 = `G666${randomUUID().slice(0, 8)}`;
      const n2 = `H666${randomUUID().slice(0, 8)}`;
      const failing = await legacyAnonymizedIn(other, "g", n1);
      const passing = await legacyAnonymizedIn(other, "h", n2);
      const real = app.absenceExit.apply;
      const spy = vi.spyOn(app.absenceExit, "apply").mockImplementation(async (tx, plan, audit) => {
        const result = await real(tx, plan, audit);
        if (plan.input.employeeId === failing.employeeId) throw new Error("boom");
        return result;
      });
      try {
        const run = await capture(() => main(["--tenant", tenantId, "--confirm"], app));
        expect(run.code).toBe(EXIT_ERROR);
        expect(lineOf(run, failing.employeeId)).toContain("result=failed:Error");
        expect(lineOf(run, passing.employeeId)).toContain("result=written");
      } finally {
        spy.mockRestore();
      }
      // The failing person's whole transaction rolled back.
      expect(
        (await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id: failing.leaveId } }))
          .status,
      ).toBe("APPROVED");
      const failedRow = await employeeRow(failing.employeeId);
      expect(failedRow.exitDate).toBeNull();
      expect(failedRow.employeeNumber).toBe(`GELÖSCHT-${n1}`);
      // The other person was corrected.
      expect((await employeeRow(passing.employeeId)).employeeNumber).toBe(n2);
      expect(
        (await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id: passing.leaveId } }))
          .status,
      ).toBe("CANCELLED");
    });

    it("rejects an unknown flag with exit 1 and prints the usage with --help", async () => {
      expect((await capture(() => main(["--apply"], app))).code).toBe(EXIT_ERROR);
      const help = await capture(() => main(["--help"], app));
      expect(help.code).toBe(EXIT_OK);
      expect(help.lines.join("\n")).toContain("--confirm");
    });
  });

  it("source: reuses the one exit rule through app.absenceExit, writes no absence row itself", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../backfill-666-anonymized-employment.ts", import.meta.url)),
      "utf8",
    );
    expect(source.length).toBeGreaterThan(1000); // anti-vacuity: the scan read a real file
    const code = codeOnly(source);
    expect(code).toContain("app.absenceExit.plan(");
    expect(code).toContain("app.absenceExit.apply(");
    expect(code).toContain("app.absenceExit.afterCommit(");
    expect(code).not.toMatch(
      /\b(leaveRequest|absence|leaveEntitlement|saldoSnapshot|section9Credit)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/,
    );
    expect(code).not.toMatch(/\$executeRaw|\$queryRaw/);
    expect(code).not.toMatch(/\bfirstName\s*:\s*true|\blastName\s*:\s*true|\bemail\s*:\s*true/);
  });

  /** A legacy person of the OTHER tenant with one vacation after the audit day. */
  async function legacyAnonymizedIn(
    data: Awaited<ReturnType<typeof seedTestData>>,
    label: string,
    number: string,
  ): Promise<{ employeeId: string; leaveId: string }> {
    const user = await app.prisma.user.create({
      data: {
        email: `${label}${Math.random().toString(36).slice(2, 8)}@example.invalid`,
        passwordHash: "x",
        role: "EMPLOYEE",
        isActive: false,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `GELÖSCHT-${number}`,
        firstName: "Gelöscht",
        lastName: `GELÖSCHT-${number}`,
        hireDate: day("2025-01-01"),
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
        validFrom: day("2025-01-01"),
      },
    });
    await app.prisma.overtimeAccount.create({ data: { employeeId: employee.id, balanceHours: 0 } });
    await seedEntitlementYears(app, {
      employeeId: employee.id,
      leaveTypeId: data.vacationType.id,
      years: [2026],
    });
    await app.prisma.auditLog.create({
      data: {
        action: "ANONYMIZE",
        entity: "Employee",
        entityId: employee.id,
        oldValue: { employeeNumber: number },
        createdAt: new Date("2026-09-09T10:00:00Z"),
      },
    });
    const leave = await app.prisma.leaveRequest.create({
      data: {
        employeeId: employee.id,
        leaveTypeId: data.vacationType.id,
        startDate: day("2026-09-14"),
        endDate: day("2026-09-15"),
        days: 2,
        status: "APPROVED",
      },
    });
    return { employeeId: employee.id, leaveId: leave.id };
  }
});
