/**
 * Issue #835 (D-835-05, D-835-22) — `employeeIdsHomedInSalonDuring`, the membership of a salon's
 * leave plan: the persons whose Stammsalon is the salon on at least one calendar day of a window.
 *
 * Cases: a person homed for only part of the window counts; a DEPLOYMENT row never does; a HOME row
 * ending the day before the window and one starting the day after it do not (both bounds are
 * inclusive); a voided row is effective on no day; another tenant's rows never leak; an id appears
 * once however many rows it has; the answer is sorted; `fromDay > toDay` answers `[]` without a
 * query.
 *
 * Deep imports of the facade file are allowed here: this test lives inside the platform context.
 * No person names in fixtures.
 */
import type { FastifyInstance } from "fastify";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  createTestSalon,
} from "../../../__tests__/setup";
import { employeeIdsHomedInSalonDuring } from "../facade/salon-assignments";

type Seed = Awaited<ReturnType<typeof seedTestData>>;

const FROM = "2027-01-01";
const TO = "2027-12-31";

describe("Issue #835 — employeeIdsHomedInSalonDuring", () => {
  let app: FastifyInstance;
  let data: Seed;
  let foreign: Seed;
  let salonS: { id: string };
  let salonOther: { id: string };

  async function person(tenantId: string, label: string) {
    const s = `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const user = await app.prisma.user.create({
      data: { email: `${s}@test.de`, passwordHash: "x", isActive: true },
    });
    return app.prisma.employee.create({
      data: {
        tenantId,
        userId: user.id,
        employeeNumber: s.toUpperCase().slice(0, 20),
        firstName: label,
        lastName: "Homed835",
        hireDate: new Date("2020-01-01T00:00:00Z"),
      },
    });
  }

  function row(
    tenantId: string,
    employeeId: string,
    salonId: string,
    kind: "HOME" | "DEPLOYMENT",
    validFrom: string,
    validUntil: string | null,
  ) {
    return app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId,
        employeeId,
        salonId,
        kind,
        validFrom: new Date(`${validFrom}T00:00:00Z`),
        validUntil: validUntil ? new Date(`${validUntil}T00:00:00Z`) : null,
        weekdays: [],
      },
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "ehs835a");
    foreign = await seedTestData(app, "ehs835b");
    salonS = { id: data.salonId };
    salonOther = await createTestSalon(app.prisma, data.tenant.id, { name: "Homed835 other" });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
      await cleanupTestData(app, foreign.tenant.id);
    } catch (err) {
      console.error("employee-ids-homed-in-salon-835 cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("returns each homed person once, sorted, with partial homing, open ends and several rows", async () => {
    const wholeYear = await person(data.tenant.id, "whole");
    await row(data.tenant.id, wholeYear.id, salonS.id, "HOME", "2020-01-01", null);
    const fromJuly = await person(data.tenant.id, "july");
    await row(data.tenant.id, fromJuly.id, salonOther.id, "HOME", "2020-01-01", "2027-06-30");
    await row(data.tenant.id, fromJuly.id, salonS.id, "HOME", "2027-07-01", null);
    const twoRows = await person(data.tenant.id, "tworows");
    await row(data.tenant.id, twoRows.id, salonS.id, "HOME", "2020-01-01", "2027-03-31");
    await row(data.tenant.id, twoRows.id, salonOther.id, "HOME", "2027-04-01", "2027-05-31");
    await row(data.tenant.id, twoRows.id, salonS.id, "HOME", "2027-06-01", null);

    const ids = await employeeIdsHomedInSalonDuring(
      app.prisma,
      data.tenant.id,
      salonS.id,
      FROM,
      TO,
    );
    expect(ids).toEqual([wholeYear.id, fromJuly.id, twoRows.id].sort());
    expect(new Set(ids).size, "every id once").toBe(ids.length);
  });

  it("ignores a DEPLOYMENT row, another salon and a window miss on either side", async () => {
    const deployed = await person(data.tenant.id, "deployed");
    await row(data.tenant.id, deployed.id, salonOther.id, "HOME", "2020-01-01", null);
    await row(data.tenant.id, deployed.id, salonS.id, "DEPLOYMENT", "2027-01-01", null);
    const endedBefore = await person(data.tenant.id, "endedbefore");
    await row(data.tenant.id, endedBefore.id, salonS.id, "HOME", "2020-01-01", "2026-12-31");
    await row(data.tenant.id, endedBefore.id, salonOther.id, "HOME", "2027-01-01", null);
    const startsAfter = await person(data.tenant.id, "startsafter");
    await row(data.tenant.id, startsAfter.id, salonOther.id, "HOME", "2020-01-01", "2027-12-31");
    await row(data.tenant.id, startsAfter.id, salonS.id, "HOME", "2028-01-01", null);

    const ids = await employeeIdsHomedInSalonDuring(
      app.prisma,
      data.tenant.id,
      salonS.id,
      FROM,
      TO,
    );
    for (const excluded of [deployed, endedBefore, startsAfter]) {
      expect(ids, excluded.firstName).not.toContain(excluded.id);
    }
  });

  it("both window bounds are inclusive: a row ending on the first day or starting on the last day counts", async () => {
    const endsOnFirst = await person(data.tenant.id, "endsfirst");
    await row(data.tenant.id, endsOnFirst.id, salonS.id, "HOME", "2020-01-01", "2027-01-01");
    await row(data.tenant.id, endsOnFirst.id, salonOther.id, "HOME", "2027-01-02", null);
    const startsOnLast = await person(data.tenant.id, "startslast");
    await row(data.tenant.id, startsOnLast.id, salonOther.id, "HOME", "2020-01-01", "2027-12-30");
    await row(data.tenant.id, startsOnLast.id, salonS.id, "HOME", "2027-12-31", null);

    const ids = await employeeIdsHomedInSalonDuring(
      app.prisma,
      data.tenant.id,
      salonS.id,
      FROM,
      TO,
    );
    expect(ids).toContain(endsOnFirst.id);
    expect(ids).toContain(startsOnLast.id);
  });

  it("never counts a voided row (validUntil before its own validFrom)", async () => {
    const voided = await person(data.tenant.id, "voided");
    await row(data.tenant.id, voided.id, salonOther.id, "HOME", "2020-01-01", null);
    // Effective on no day, although its dates straddle the window start.
    await row(data.tenant.id, voided.id, salonS.id, "HOME", "2027-03-01", "2027-02-28");

    const ids = await employeeIdsHomedInSalonDuring(
      app.prisma,
      data.tenant.id,
      salonS.id,
      FROM,
      TO,
    );
    expect(ids).not.toContain(voided.id);
  });

  it("never leaks another tenant's rows, and answers [] for a foreign salon id", async () => {
    const theirs = await person(foreign.tenant.id, "foreign");
    await row(foreign.tenant.id, theirs.id, foreign.salonId, "HOME", "2020-01-01", null);

    const own = await employeeIdsHomedInSalonDuring(
      app.prisma,
      data.tenant.id,
      salonS.id,
      FROM,
      TO,
    );
    expect(own).not.toContain(theirs.id);
    // Asked with the wrong tenant, the foreign salon yields nothing (the tenant is an inline filter).
    expect(
      await employeeIdsHomedInSalonDuring(app.prisma, data.tenant.id, foreign.salonId, FROM, TO),
    ).toEqual([]);
    expect(
      await employeeIdsHomedInSalonDuring(app.prisma, foreign.tenant.id, foreign.salonId, FROM, TO),
    ).toEqual([theirs.id]);
  });

  it("answers [] for an inverted window without a query", async () => {
    const calls: string[] = [];
    const counting = new Proxy(app.prisma, {
      get(target, model) {
        const delegate = Reflect.get(target, model) as unknown;
        if (typeof model !== "string" || delegate === null || typeof delegate !== "object") {
          return delegate;
        }
        return new Proxy(delegate as object, {
          get(inner, method) {
            const member = Reflect.get(inner, method) as unknown;
            if (typeof member !== "function") return member;
            return (...args: unknown[]) => {
              calls.push(`${model}.${String(method)}`);
              return (member as (...a: unknown[]) => unknown).apply(inner, args);
            };
          },
        });
      },
    }) as FastifyInstance["prisma"];

    expect(
      await employeeIdsHomedInSalonDuring(counting, data.tenant.id, salonS.id, TO, FROM),
    ).toEqual([]);
    expect(calls).toEqual([]);
    // Control: the proxy does record a real query.
    await employeeIdsHomedInSalonDuring(counting, data.tenant.id, salonS.id, FROM, TO);
    expect(calls).toEqual(["employeeSalonAssignment.findMany"]);
  });
});
