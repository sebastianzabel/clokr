/**
 * Issue #511, T-511-27 — the single-employee break-finding detector reads the employee's birth date
 * (it decides the § 11 JArbSchG regime) and must read it only inside the caller's tenant.
 *
 * `findUnacknowledgedBreakFindingDaysForEmployee` takes an employee id from its caller. Called with
 * the id of an employee of ANOTHER tenant it has to behave exactly like an unknown id: no days, and
 * — the part `lint:tenant-scoping` can only enforce by shape — no foreign birth date read. The
 * test records what the employee read returns instead of asserting the query's shape, so a
 * restructured query that is still tenant-bound stays green and one that is not turns red.
 *
 * Tenant B holds a 16 year old whose day is a § 11 JArbSchG finding (a 4 h 31 min block), tenant A
 * holds nothing. The positive control runs the same call inside tenant B and must list the day:
 * without it an always-empty answer would pass the cross-tenant assertions.
 *
 * Fixture names are neutral labels, never person names.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@clokr/db";
import { getTestApp, closeTestApp, cleanupTestData, createTestSalon } from "./setup";
import { findUnacknowledgedBreakFindingDaysForEmployee } from "../contexts/time-tracking";
import { isMinorAtDate } from "../contexts/absence";

const TZ = "Europe/Berlin";
// A fixed past winter day: the Berlin offset is +01:00, so 08:00 local is 07:00Z.
const DAY = "2026-02-10";
const MONTH_FIRST = new Date("2026-02-01T00:00:00.000Z");
const MONTH_LAST = new Date("2026-02-28T00:00:00.000Z");

describe("Issue #511 T-511-27 — the single-employee break-finding detector is tenant-bound", () => {
  let app: Awaited<ReturnType<typeof getTestApp>>;
  let tenantA = "";
  let tenantB = "";
  let employeeB = "";
  /** Every result of `employee.findFirst` observed through the recording client. */
  const employeeReads: { found: { birthDate: Date | null } | null }[] = [];

  /** The real client with `employee.findFirst` recorded; every other member is passed through. */
  function recordingClient(): PrismaClient {
    const real = app.prisma;
    return new Proxy(real, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop !== "employee") return typeof value === "function" ? value.bind(target) : value;
        return new Proxy(value as PrismaClient["employee"], {
          get(delegate, method, delegateReceiver) {
            const member = Reflect.get(delegate, method, delegateReceiver);
            if (method !== "findFirst") return member;
            return async (args: unknown) => {
              const found = await (member as PrismaClient["employee"]["findFirst"]).call(
                delegate,
                args as never,
              );
              employeeReads.push({ found: found as { birthDate: Date | null } | null });
              return found;
            };
          },
        });
      },
    });
  }

  function detect(tenantId: string, employeeId: string) {
    return findUnacknowledgedBreakFindingDaysForEmployee(recordingClient(), {
      tenantId,
      employeeId,
      monthFirstDay: MONTH_FIRST,
      monthLastDay: MONTH_LAST,
      tz: TZ,
      isMinorAt: isMinorAtDate,
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    const prisma = app.prisma;
    const s = `bfd-tb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
    const a = await prisma.tenant.create({
      data: { name: `BreakFindingTenantA ${s}`, slug: `${s}-a`, federalState: "NIEDERSACHSEN" },
    });
    const b = await prisma.tenant.create({
      data: { name: `BreakFindingTenantB ${s}`, slug: `${s}-b`, federalState: "NIEDERSACHSEN" },
    });
    tenantA = a.id;
    tenantB = b.id;
    for (const tenantId of [tenantA, tenantB]) {
      await prisma.tenantConfig.create({
        data: { tenantId, defaultVacationDays: 30, timezone: TZ },
      });
    }
    const salonB = await createTestSalon(prisma, tenantB, { name: "Salon Beta" });

    const user = await prisma.user.create({
      data: {
        email: `bfd-tb-${s}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 4),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await prisma.employee.create({
      data: {
        tenantId: tenantB,
        userId: user.id,
        employeeNumber: `BFDTB-${Date.now().toString(36)}`.slice(0, 30),
        firstName: "Fixture",
        lastName: "Minor",
        hireDate: new Date("2024-01-01T00:00:00Z"),
        birthDate: new Date("2010-05-01T00:00:00Z"), // 15 on DAY: a minor
      },
    });
    employeeB = employee.id;

    // 08:00-14:00 local with a 30 min break at 12:31: 4 h 31 min at a stretch before it. Under the
    // § 11 JArbSchG limit of 4 h 30 min that is a finding; an adult's 6 h limit would not flag it.
    const entry = await prisma.timeEntry.create({
      data: {
        employeeId: employeeB,
        date: new Date(`${DAY}T00:00:00.000Z`),
        startTime: new Date(`${DAY}T07:00:00.000Z`),
        endTime: new Date(`${DAY}T13:00:00.000Z`),
        breakMinutes: 30,
        breakStatus: "CONFIRMED",
        type: "WORK",
        salonId: salonB.id,
      },
    });
    await prisma.break.create({
      data: {
        timeEntryId: entry.id,
        startTime: new Date(`${DAY}T11:31:00.000Z`),
        endTime: new Date(`${DAY}T12:01:00.000Z`),
      },
    });
  }, 120_000);

  afterAll(async () => {
    for (const tenantId of [tenantA, tenantB]) {
      try {
        await cleanupTestData(app, tenantId);
      } catch (err) {
        console.error("break-finding-days-tenant-bound-511 cleanup:", err);
      }
    }
    await closeTestApp();
  });

  it("positive control: inside its own tenant the minor's day is listed (the birth date is read)", async () => {
    employeeReads.length = 0;

    const days = await detect(tenantB, employeeB);

    expect(days).toEqual([{ date: DAY, kind: "PLACEMENT" }]);
    expect(employeeReads).toHaveLength(1);
    expect(employeeReads[0].found?.birthDate).toBeInstanceOf(Date);
  });

  it("an employee id of another tenant yields no days and reads no foreign birth date", async () => {
    employeeReads.length = 0;

    const days = await detect(tenantA, employeeB);

    expect(days).toEqual([]);
    expect(
      employeeReads,
      "the employee read must have run, or the check below is vacuous",
    ).toHaveLength(1);
    // The birth date of a foreign employee never comes back to the caller's tenant context.
    expect(employeeReads.every((r) => r.found === null)).toBe(true);
  });

  it("answers a foreign id exactly like an unknown id", async () => {
    employeeReads.length = 0;
    const foreign = await detect(tenantA, employeeB);
    const foreignReads = employeeReads.map((r) => r.found);

    employeeReads.length = 0;
    const unknown = await detect(tenantA, randomUUID());
    const unknownReads = employeeReads.map((r) => r.found);

    expect(foreignReads).toHaveLength(1);
    expect(unknownReads).toHaveLength(1);
    expect(foreign).toEqual(unknown);
    expect(foreignReads).toEqual(unknownReads);
  });
});
