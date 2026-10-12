/**
 * Issue #84 (D-13) — `homeSalonsForDays`, the BATCHED form of `homeSalonAt`.
 *
 * Why a batched form exists: the dashboard attributes absence days to the Stammsalon per calendar
 * day (a mid-month Stammsalon change must not move a whole month of sick days). Calling
 * `homeSalonAt` per person and day over a six-month window is an N+1 explosion, so the Unterbau
 * answers "Stammsalon of person P on day D" for many persons and days with ONE assignment query.
 *
 * The contract is parity: for every employee and every day the batched answer must equal
 * `homeSalonAt`'s. The rule is not re-derived in the batched function (it picks with the rules
 * module's `isEffectiveOn`), so this file is what keeps the two from drifting apart.
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
import { homeSalonAt, homeSalonsForDays } from "../facade/salon-assignments";
import { addDays, type CalendarDay } from "../salon-assignment-rules";

type Seed = Awaited<ReturnType<typeof seedTestData>>;

const FROM: CalendarDay = "2026-04-01";
const TO: CalendarDay = "2026-04-30";

function daysOf(from: CalendarDay, to: CalendarDay): CalendarDay[] {
  const days: CalendarDay[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) days.push(day);
  return days;
}

/** Counts every Prisma delegate method call on the wrapped client. */
function countingClient(db: FastifyInstance["prisma"]) {
  const calls: string[] = [];
  const proxy = new Proxy(db, {
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
  });
  return { db: proxy as FastifyInstance["prisma"], calls };
}

describe("Issue #84 (D-13) — homeSalonsForDays agrees with homeSalonAt", () => {
  let app: FastifyInstance;
  let data: Seed;
  let foreign: Seed;
  let salonA: { id: string };
  let salonB: { id: string };
  let salonGone: { id: string };

  async function person(tenantId: string, label: string, hireDate = "2024-01-01") {
    const s = `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const user = await app.prisma.user.create({
      data: { email: `${s}@test.de`, passwordHash: "x", role: "EMPLOYEE", isActive: true },
    });
    return app.prisma.employee.create({
      data: {
        tenantId,
        userId: user.id,
        employeeNumber: s.toUpperCase().slice(0, 20),
        firstName: label,
        lastName: "HomeDays84",
        hireDate: new Date(`${hireDate}T00:00:00Z`),
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
    weekdays: number[] = [],
  ) {
    return app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId,
        employeeId,
        salonId,
        kind,
        validFrom: new Date(`${validFrom}T00:00:00Z`),
        validUntil: validUntil ? new Date(`${validUntil}T00:00:00Z`) : null,
        weekdays,
      },
    });
  }

  async function expectParity(employeeIds: string[]) {
    const batched = await homeSalonsForDays(app.prisma, data.tenant.id, employeeIds, FROM, TO);
    for (const id of employeeIds) {
      const dayMap = batched.get(id);
      expect(dayMap, `day map for ${id}`).toBeDefined();
      for (const day of daysOf(FROM, TO)) {
        const single = await homeSalonAt(
          app.prisma,
          data.tenant.id,
          id,
          new Date(`${day}T12:00:00Z`),
        );
        expect(dayMap?.get(day), `${id} on ${day}`).toBe(single?.salonId ?? null);
      }
    }
    return batched;
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "hsd84a");
    foreign = await seedTestData(app, "hsd84b");
    salonA = { id: data.salonId };
    salonB = await createTestSalon(app.prisma, data.tenant.id, { name: "HomeDays84 B" });
    salonGone = await createTestSalon(app.prisma, data.tenant.id, { name: "HomeDays84 Gone" });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
      await cleanupTestData(app, foreign.tenant.id);
    } catch (err) {
      console.error("home-salons-for-days-84 cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("follows a Stammsalon change on 2026-04-11 day by day, equal to homeSalonAt", async () => {
    const x = await person(data.tenant.id, "change");
    await row(data.tenant.id, x.id, salonA.id, "HOME", "2024-01-01", "2026-04-10");
    await row(data.tenant.id, x.id, salonB.id, "HOME", "2026-04-11", null);

    const batched = await expectParity([x.id]);
    const days = batched.get(x.id)!;
    expect(days.get("2026-04-10")).toBe(salonA.id);
    expect(days.get("2026-04-11")).toBe(salonB.id);
    expect(days.get("2026-04-01")).toBe(salonA.id);
    expect(days.get("2026-04-30")).toBe(salonB.id);
  });

  it("never lets a voided HOME row answer", async () => {
    const y = await person(data.tenant.id, "voided");
    await row(data.tenant.id, y.id, salonA.id, "HOME", "2024-01-01", null);
    // validUntil = validFrom - 1 day: effective on no day.
    await row(data.tenant.id, y.id, salonB.id, "HOME", "2026-04-15", "2026-04-14");

    const batched = await expectParity([y.id]);
    for (const day of daysOf(FROM, TO)) {
      expect(batched.get(y.id)?.get(day), day).toBe(salonA.id);
    }
  });

  it("ignores a DEPLOYMENT row covering the range (HOME only, unlike salonForDay)", async () => {
    const z = await person(data.tenant.id, "deployed");
    await row(data.tenant.id, z.id, salonA.id, "HOME", "2024-01-01", null);
    await row(
      data.tenant.id,
      z.id,
      salonB.id,
      "DEPLOYMENT",
      "2026-03-01",
      null,
      [0, 1, 2, 3, 4, 5, 6],
    );

    const batched = await expectParity([z.id]);
    for (const day of daysOf(FROM, TO)) {
      expect(batched.get(z.id)?.get(day), day).toBe(salonA.id);
    }
  });

  it("maps every day to null for a person without a HOME row and for a foreign tenant's person", async () => {
    const none = await person(data.tenant.id, "nohome");
    const foreignPerson = await person(foreign.tenant.id, "foreign");
    await row(foreign.tenant.id, foreignPerson.id, foreign.salonId, "HOME", "2024-01-01", null);

    const batched = await expectParity([none.id, foreignPerson.id]);
    for (const id of [none.id, foreignPerson.id]) {
      for (const day of daysOf(FROM, TO)) {
        expect(batched.get(id)?.get(day), `${id} ${day}`).toBeNull();
      }
    }
    // Indistinguishable (T-100-09): both are present with an all-null map, neither is absent.
    expect([...batched.get(none.id)!.values()]).toEqual([
      ...batched.get(foreignPerson.id)!.values(),
    ]);
  });

  it("answers a day before the hire date when a HOME row covers it (no hire floor)", async () => {
    const early = await person(data.tenant.id, "early", "2026-04-10");
    await row(data.tenant.id, early.id, salonB.id, "HOME", "2026-04-01", null);

    const batched = await expectParity([early.id]);
    expect(batched.get(early.id)?.get("2026-04-01")).toBe(salonB.id);
    expect(batched.get(early.id)?.get("2026-04-09")).toBe(salonB.id);
  });

  it("still answers with a since-deactivated salon (history, no isActive filter)", async () => {
    const hist = await person(data.tenant.id, "history");
    await row(data.tenant.id, hist.id, salonGone.id, "HOME", "2024-01-01", null);
    await app.prisma.salon.update({ where: { id: salonGone.id }, data: { isActive: false } });

    const batched = await expectParity([hist.id]);
    expect(batched.get(hist.id)?.get("2026-04-15")).toBe(salonGone.id);
  });

  it("picks like homeSalonAt when two HOME rows overlap (validFrom ascending, then id)", async () => {
    const o = await person(data.tenant.id, "overlap");
    await row(data.tenant.id, o.id, salonB.id, "HOME", "2026-04-10", null);
    await row(data.tenant.id, o.id, salonA.id, "HOME", "2024-01-01", null);

    const batched = await expectParity([o.id]);
    // The earlier validFrom wins on every overlapping day.
    expect(batched.get(o.id)?.get("2026-04-20")).toBe(salonA.id);
  });

  it("answers many persons in one call and agrees with homeSalonAt for all of them", async () => {
    const a = await person(data.tenant.id, "bulk-a");
    const b = await person(data.tenant.id, "bulk-b");
    await row(data.tenant.id, a.id, salonA.id, "HOME", "2024-01-01", "2026-04-20");
    await row(data.tenant.id, a.id, salonB.id, "HOME", "2026-04-21", null);
    await row(data.tenant.id, b.id, salonB.id, "HOME", "2024-01-01", null);

    const batched = await expectParity([a.id, b.id]);
    expect(batched.size).toBe(2);
  });

  it("does not query for an empty person list or an inverted range", async () => {
    const guard = countingClient(app.prisma);
    const empty = await homeSalonsForDays(guard.db, data.tenant.id, [], FROM, TO);
    const inverted = await homeSalonsForDays(guard.db, data.tenant.id, ["x"], TO, FROM);
    expect(empty.size).toBe(0);
    expect(inverted.size).toBe(0);
    expect(guard.calls).toEqual([]);
  });

  it("issues exactly one employeeSalonAssignment.findMany for any number of persons and days", async () => {
    const a = await person(data.tenant.id, "one-a");
    const b = await person(data.tenant.id, "one-b");
    await row(data.tenant.id, a.id, salonA.id, "HOME", "2024-01-01", null);
    await row(data.tenant.id, b.id, salonB.id, "HOME", "2024-01-01", null);

    const guard = countingClient(app.prisma);
    const result = await homeSalonsForDays(guard.db, data.tenant.id, [a.id, b.id], FROM, TO);
    expect(result.get(a.id)?.size).toBe(30);
    expect(guard.calls).toEqual(["employeeSalonAssignment.findMany"]);
  });
});
