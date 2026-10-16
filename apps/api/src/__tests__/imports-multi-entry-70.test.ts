/**
 * Issue #70 (Phase 70b-04, I-21) — the CSV time-entry import with several entries per day.
 *
 * A day may now hold several entries, so a second row of a day imports when it does not overlap
 * the first; the refusal that remains is the overlap, reported per row with German text whose
 * wording follows the importer's reach (`overlapMessageForCaller`, D-13) — detailed for a
 * whole-tenant reader, the neutral text for a scoped importer whose reach does not contain the
 * conflicting entry. The write itself (lock, in-transaction re-check, create) runs in ONE
 * transaction inside the time-tracking facade; a conflict found there (a lost race) and a
 * database-level refusal are both worded neutrally, because the reach-worded text already came
 * from the pre-check.
 *
 * Cases:
 *  1. D 08:00-12:00 salon A + D 13:00-17:00 salon B import; a third row D 11:00-14:00 is a per-row
 *     overlap error; an identical re-import of row 1 is a per-row overlap error, never the former
 *     duplicate-day text (`OLD_DUPLICATE_TEXT` below)
 *  2. Reach: an importer whose `time-entry:read` reach does not contain the conflicting entry gets
 *     the neutral text; a whole-tenant importer gets date and times. (Amended 2026-10-16 for #654:
 *     the import reach now decides which persons a row may name, so the importer holds an import
 *     reach over the imported person and a read reach elsewhere; see `createScopedImporter`.)
 *  3. Race: an overlapping entry committed while the import waits for the employee lock is found by
 *     the in-transaction re-check (neutral text), the loop continues with the next row.
 *  4. Backstop: with the application check blinded, the database's exclusion constraint refuses the
 *     insert and the facade turns that into the neutral text (never a raw Prisma error).
 *
 * Mutation proof (recorded in the 70b-04 SUMMARY, restored by `cp`): removing the lock call from the
 * facade turns case 3 red; removing the violation mapping turns case 4 red.
 *
 * No person names in fixtures.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Prisma } from "@clokr/db";
import { fromZonedTime } from "date-fns-tz";
import { getTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";
import { TEST_TZ } from "./test-dates";
import { normalizeRolePermissions, roleNameKey } from "../contexts/platform";
import { createImportedTimeEntry } from "../contexts/time-tracking";
import { holdEmployeeLockThen } from "./entry-lock-race-helpers";

const PASSWORD = "test1234";
const NEUTRAL = "Überschneidung mit einem bestehenden Eintrag dieses Tages.";
const OLD_DUPLICATE_TEXT = "Es existiert bereits ein Eintrag für diesen Tag.";

function at(dayStr: string, hhmm: string): Date {
  return fromZonedTime(`${dayStr}T${hhmm}:00`, TEST_TZ);
}

type RowResult = { row: number; status: "ok" | "error"; error?: string };

describe("Issue #70 — CSV time-entry import with several entries per day", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: { id: string };
  let salonB: { id: string };
  let salonC: { id: string };
  let empNo: string;
  let scopedImporterToken: string;

  const importCsv = async (token: string, csv: string) => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/imports/time-entries",
      headers: { authorization: `Bearer ${token}` },
      payload: { csv },
    });
    expect(res.statusCode, res.body).toBe(200);
    return JSON.parse(res.body) as { imported: number; errors: number; details: RowResult[] };
  };
  const liveCount = (dayStr: string) =>
    app.prisma.timeEntry.count({
      where: {
        employeeId: seed.employee.id,
        date: new Date(`${dayStr}T00:00:00Z`),
        deletedAt: null,
      },
    });

  async function createScopedImporter(): Promise<string> {
    const s = `imp70-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const user = await app.prisma.user.create({
      data: {
        email: `${s}@test.de`,
        passwordHash: await bcrypt.hash(PASSWORD, 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    await app.prisma.employee.create({
      data: {
        tenantId: seed.tenant.id,
        userId: user.id,
        employeeNumber: s.toUpperCase().slice(0, 20),
        firstName: "Scoped",
        lastName: "ImporterTest",
        hireDate: new Date("2020-01-01"),
      },
    });
    // Amended 2026-10-16 for #654 (merged into #70): the importer reaches the imported person
    // through the IMPORT reach (salon A = the person's Stammsalon), while its READ reach lies on
    // another salon (C). The overlap wording follows the READ reach, so a conflicting entry in
    // salon B (person and entry both outside salon C) is still worded neutrally — the case keeps
    // testing exactly that branch, now that an import row of an out-of-reach person is refused
    // earlier as "not found".
    const grant = async (permission: string, salonId: string) => {
      const name = `Import70 ${crypto.randomBytes(3).toString("hex")}`;
      const role = await app.prisma.accessRole.create({
        data: {
          tenantId: seed.tenant.id,
          name,
          nameKey: roleNameKey(name),
          permissions: normalizeRolePermissions([permission]),
        },
      });
      await app.prisma.roleAssignment.create({
        data: {
          tenantId: seed.tenant.id,
          userId: user.id,
          accessRoleId: role.id,
          scopeType: "SALONS",
          salonIds: [salonId],
          employeeIds: [],
        },
      });
    };
    await grant("time-entry:import:ZUGEWIESEN", salonA.id);
    await grant("time-entry:read:ZUGEWIESEN", salonC.id);
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: user.email, password: PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    return (JSON.parse(login.body) as { accessToken: string }).accessToken;
  }

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "imm70");
    salonA = await createTestSalon(app.prisma, seed.tenant.id, { name: "Salon A" });
    salonB = await createTestSalon(app.prisma, seed.tenant.id, { name: "Salon B" });
    salonC = await createTestSalon(app.prisma, seed.tenant.id, { name: "Salon C" });
    empNo = seed.employee.employeeNumber;
    // Amended 2026-10-16 for #654 (merged into #70): a scoped importer only reaches rows of persons
    // whose Stammsalon lies in its reach. The imported person therefore belongs to salon A, so the
    // case below still isolates what it tests: the CONFLICTING ENTRY lies outside the importer's read reach.
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: seed.tenant.id,
        employeeId: seed.employee.id,
        salonId: salonA.id,
        kind: "HOME",
        validFrom: new Date("2020-01-01"),
        validUntil: null,
        weekdays: [],
      },
    });
    scopedImporterToken = await createScopedImporter();
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, seed.tenant.id);
    } catch {
      // best-effort cleanup
    }
  });

  it("two rows of one day in two salons import; an overlapping third row and an identical re-import are per-row overlap errors", async () => {
    const csv = `nr;datum;von;bis;pause;salon-id
${empNo};22.06.2026;08:00;12:00;0;${salonA.id}
${empNo};22.06.2026;13:00;17:00;0;${salonB.id}
${empNo};22.06.2026;11:00;14:00;0;${salonA.id}`;
    const body = await importCsv(seed.adminToken, csv);
    expect(body.details).toHaveLength(3);
    expect(body.details[0].status).toBe("ok");
    expect(body.details[1].status).toBe("ok");
    expect(body.details[2].status).toBe("error");
    expect(body.details[2].error).toBe(
      "Überschneidung mit bestehendem Eintrag vom 22.06.2026 (08:00 – 12:00)",
    );
    expect(await liveCount("2026-06-22")).toBe(2);
    const salons = await app.prisma.timeEntry.findMany({
      where: { employeeId: seed.employee.id, date: new Date("2026-06-22T00:00:00Z") },
      select: { salonId: true },
      orderBy: { startTime: "asc" },
    });
    expect(salons.map((r) => r.salonId)).toEqual([salonA.id, salonB.id]);

    const again = await importCsv(
      seed.adminToken,
      `nr;datum;von;bis;pause;salon-id\n${empNo};22.06.2026;08:00;12:00;0;${salonA.id}`,
    );
    expect(again.imported).toBe(0);
    expect(again.details[0].status).toBe("error");
    expect(again.details[0].error).not.toBe(OLD_DUPLICATE_TEXT);
    expect(again.details[0].error).toMatch(
      /^Überschneidung mit bestehendem Eintrag vom 22\.06\.2026/,
    );
    expect(await liveCount("2026-06-22")).toBe(2);
  });

  it("reach: a scoped importer whose conflicting entry lies in another salon gets the neutral text, a whole-tenant importer date and times", async () => {
    await app.prisma.timeEntry.create({
      data: {
        employeeId: seed.employee.id,
        date: new Date("2026-06-23T00:00:00Z"),
        startTime: at("2026-06-23", "09:00"),
        endTime: at("2026-06-23", "11:00"),
        source: "MANUAL",
        salonId: salonB.id,
      },
    });
    const csv = `nr;datum;von;bis;pause;salon-id\n${empNo};23.06.2026;10:00;12:00;0;${salonA.id}`;

    const scoped = await importCsv(scopedImporterToken, csv);
    expect(scoped.details[0].status).toBe("error");
    expect(scoped.details[0].error).toBe(NEUTRAL);

    const whole = await importCsv(seed.adminToken, csv);
    expect(whole.details[0].error).toBe(
      "Überschneidung mit bestehendem Eintrag vom 23.06.2026 (09:00 – 11:00)",
    );
    expect(await liveCount("2026-06-23")).toBe(1);
  });

  it("race: an overlapping entry committed while the import waits for the employee lock is found by the in-transaction re-check; the loop continues", async () => {
    const csv = `nr;datum;von;bis;pause;salon-id
${empNo};24.06.2026;08:00;12:00;0;${salonA.id}
${empNo};25.06.2026;08:00;12:00;0;${salonA.id}`;
    const { result, blocked } = await holdEmployeeLockThen(app, {
      tenantId: seed.tenant.id,
      employeeId: seed.employee.id,
      start: () => importCsv(seed.adminToken, csv),
      holderWork: async (tx) => {
        await tx.timeEntry.create({
          data: {
            employeeId: seed.employee.id,
            date: new Date("2026-06-24T00:00:00Z"),
            startTime: at("2026-06-24", "10:00"),
            endTime: at("2026-06-24", "11:00"),
            source: "MANUAL",
            salonId: salonA.id,
          },
        });
      },
    });
    expect(blocked, "the import write must queue on the employee lock").toBe(true);
    expect(result.details[0].status).toBe("error");
    expect(result.details[0].error).toBe(NEUTRAL);
    expect(result.details[1].status).toBe("ok");
    expect(await liveCount("2026-06-24")).toBe(1);
    expect(await liveCount("2026-06-25")).toBe(1);
  });

  it("backstop: with the application check blinded, the database exclusion constraint refuses the insert and the facade words it neutrally", async () => {
    await app.prisma.timeEntry.create({
      data: {
        employeeId: seed.employee.id,
        date: new Date("2026-06-26T00:00:00Z"),
        startTime: at("2026-06-26", "08:00"),
        endTime: at("2026-06-26", "12:00"),
        source: "MANUAL",
        salonId: salonA.id,
      },
    });
    const blind = (tx: Prisma.TransactionClient): Prisma.TransactionClient => {
      const bindIfFn = (target: object, prop: string | symbol) => {
        const value = Reflect.get(target, prop) as unknown;
        return typeof value === "function" ? (value as () => unknown).bind(target) : value;
      };
      return new Proxy(tx, {
        get(target, prop) {
          if (prop === "timeEntry") {
            return new Proxy(target.timeEntry, {
              get(delegate, method) {
                if (method === "findFirst") return async () => null;
                return bindIfFn(delegate, method);
              },
            });
          }
          return bindIfFn(target, prop);
        },
      });
    };

    await expect(
      app.prisma.$transaction((tx) =>
        createImportedTimeEntry(blind(tx), {
          tenantId: seed.tenant.id,
          employeeId: seed.employee.id,
          date: new Date("2026-06-26T00:00:00Z"),
          startTime: at("2026-06-26", "10:00"),
          endTime: at("2026-06-26", "11:00"),
          breakMinutes: 0,
          note: null,
          salonId: salonA.id,
        }),
      ),
    ).rejects.toThrow(NEUTRAL);
    expect(await liveCount("2026-06-26")).toBe(1);
  });
});
