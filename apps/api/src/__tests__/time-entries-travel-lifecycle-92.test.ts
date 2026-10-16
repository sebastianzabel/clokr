/**
 * Issue #92 (Phase 92b-02, Task 2) — the life of a travel entry on the time-entry routes: PUT with an
 * immutable kind and changed-salon-only validation, DELETE, the break routes, the month lock and
 * the neighbour integrity (T6) of POST, PUT and DELETE.
 *
 * Fixture day (tenant time): A 08:00-12:00 salon A, T 12:00-12:30 travel A -> B, B 12:30-14:30
 * salon B, written straight through Prisma. Every case owns a day of its own; a third active salon
 * C exists for the "wrong neighbour" cases. The W2 cases use salons of their own because they
 * deactivate them. No person names in fixtures.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { fromZonedTime } from "date-fns-tz";
import {
  getTestApp,
  seedTestData,
  cleanupTestData,
  createTestSalon,
  soleAuditRow,
  auditRowsFor,
} from "./setup";
import { dowOf, nextWeekdayStr, pastDateStr, TEST_TZ, utcMidnight } from "./test-dates";

function at(dayStr: string, hhmm: string): string {
  return fromZonedTime(`${dayStr}T${hhmm}:00`, TEST_TZ).toISOString();
}

/** The n-th distinct weekday, three calendar days apart, starting twelve days ago. */
function dayN(n: number): string {
  return nextWeekdayStr(pastDateStr(12 + 3 * n));
}

describe("Issue #92 — a travel entry keeps its kind and its neighbours", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: { id: string };
  let salonB: { id: string };
  let salonC: { id: string };
  let dayCounter = 0;

  type Fixture = {
    day: string;
    a: { id: string };
    t: { id: string };
    b: { id: string };
  };

  async function fixtureOn(
    day: string,
    salons: { from: string; to: string } = { from: salonA.id, to: salonB.id },
    extra: { locked?: boolean } = {},
  ): Promise<Fixture> {
    const base = {
      employeeId: seed.employee.id,
      date: utcMidnight(day),
      source: "MANUAL" as const,
    };
    const a = await app.prisma.timeEntry.create({
      data: {
        ...base,
        startTime: new Date(at(day, "08:00")),
        endTime: new Date(at(day, "12:00")),
        salonId: salons.from,
      },
    });
    const t = await app.prisma.timeEntry.create({
      data: {
        ...base,
        startTime: new Date(at(day, "12:00")),
        endTime: new Date(at(day, "12:30")),
        salonId: salons.from,
        activityKind: "TRAVEL",
        travelToSalonId: salons.to,
        isLocked: extra.locked ?? false,
      },
    });
    const b = await app.prisma.timeEntry.create({
      data: {
        ...base,
        startTime: new Date(at(day, "12:30")),
        endTime: new Date(at(day, "14:30")),
        salonId: salons.to,
      },
    });
    return { day, a, t, b };
  }

  const adminFixture = (salons?: { from: string; to: string }) =>
    fixtureOn(dayN(dayCounter++), salons);

  const put = (token: string, id: string, payload: Record<string, unknown>) =>
    app.inject({
      method: "PUT",
      url: `/api/v1/time-entries/${id}`,
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
  const adminPut = (id: string, payload: Record<string, unknown>) =>
    put(seed.adminToken, id, { reason: "Korrektur nach Rückfrage", ...payload });
  const del = (token: string, id: string) =>
    app.inject({
      method: "DELETE",
      url: `/api/v1/time-entries/${id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { reason: "Doppelt erfasst" },
    });
  const stored = (id: string) => app.prisma.timeEntry.findUniqueOrThrow({ where: { id } });
  const codeOf = (body: string) => (JSON.parse(body) as { code?: string }).code;

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "trv92l");
    salonA = await createTestSalon(app.prisma, seed.tenant.id, { name: "Salon A" });
    salonB = await createTestSalon(app.prisma, seed.tenant.id, { name: "Salon B" });
    salonC = await createTestSalon(app.prisma, seed.tenant.id, { name: "Salon C" });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, seed.tenant.id);
    } catch {
      // best-effort cleanup
    }
  });

  describe("PUT: times and note change, the kind never does", () => {
    let fx: Fixture;
    let recentDay = "";

    beforeAll(async () => {
      for (let back = 1; recentDay === "" && back <= 6; back++) {
        const candidate = pastDateStr(back);
        if (dowOf(candidate) >= 1 && dowOf(candidate) <= 5) recentDay = candidate;
      }
      expect(recentDay, "a weekday among the last six days").not.toBe("");
      fx = await fixtureOn(recentDay);
    });

    it("the person themself moves the start to 12:05: 200 and an UPDATE audit row with old and new times and both salons", async () => {
      const res = await put(seed.empToken, fx.t.id, { startTime: at(recentDay, "12:05") });
      expect(res.statusCode, res.body).toBe(200);
      const audit = await soleAuditRow(app.prisma, {
        where: { entity: "TimeEntry", entityId: fx.t.id, action: "UPDATE" },
      });
      expect(audit.oldValue).toMatchObject({
        startTime: at(recentDay, "12:00"),
        salonId: salonA.id,
        travelToSalonId: salonB.id,
        activityKind: "TRAVEL",
      });
      expect(audit.newValue).toMatchObject({
        startTime: at(recentDay, "12:05"),
        salonId: salonA.id,
        travelToSalonId: salonB.id,
        activityKind: "TRAVEL",
      });
    });

    it("a destination that is not followed by an entry of that salon: 409 TRAVEL_NOT_BETWEEN_SALON_ENTRIES, nothing changes", async () => {
      const before = await stored(fx.t.id);
      const res = await put(seed.empToken, fx.t.id, { travelToSalonId: salonC.id });
      expect(res.statusCode, res.body).toBe(409);
      expect(codeOf(res.body)).toBe("TRAVEL_NOT_BETWEEN_SALON_ENTRIES");
      expect((await stored(fx.t.id)).travelToSalonId).toBe(before.travelToSalonId);
    });

    it("the kind is immutable: a travel entry cannot become another kind", async () => {
      const res = await put(seed.empToken, fx.t.id, { activityKind: "UNSPECIFIED" });
      expect(res.statusCode, res.body).toBe(400);
      expect(codeOf(res.body)).toBe("TRAVEL_KIND_IMMUTABLE");
      expect((await stored(fx.t.id)).activityKind).toBe("TRAVEL");
    });

    it.each([
      ["activity shares", { activityShares: [{ kind: "PRODUCTIVE", minutes: 5 }] }],
      ["break minutes", { breakMinutes: 15 }],
      [
        "break slots",
        {
          breaks: [{ startTime: "2026-01-01T12:10:00.000Z", endTime: "2026-01-01T12:20:00.000Z" }],
        },
      ],
      ["no end time", { endTime: null }],
    ])("a travel entry takes no %s: 400 TRAVEL_SHAPE", async (_label, payload) => {
      const before = await stored(fx.t.id);
      const res = await put(seed.empToken, fx.t.id, payload);
      expect(res.statusCode, res.body).toBe(400);
      expect(codeOf(res.body)).toBe("TRAVEL_SHAPE");
      const after = await stored(fx.t.id);
      expect(after.breakMinutes).toBe(before.breakMinutes);
      expect(after.endTime?.toISOString()).toBe(before.endTime?.toISOString());
    });

    it("the departure salon as destination: 400 TRAVEL_SAME_SALON", async () => {
      const res = await put(seed.empToken, fx.t.id, { travelToSalonId: salonA.id });
      expect(res.statusCode, res.body).toBe(400);
      expect(codeOf(res.body)).toBe("TRAVEL_SAME_SALON");
    });

    it("an ordinary entry never turns into travel: 400 TRAVEL_KIND_IMMUTABLE for a destination, TRAVEL_KIND_DERIVED for the kind", async () => {
      const withDestination = await put(seed.empToken, fx.a.id, { travelToSalonId: salonB.id });
      expect(withDestination.statusCode, withDestination.body).toBe(400);
      expect(codeOf(withDestination.body)).toBe("TRAVEL_KIND_IMMUTABLE");
      const withKind = await put(seed.empToken, fx.a.id, { activityKind: "TRAVEL" });
      expect(withKind.statusCode, withKind.body).toBe(400);
      expect(codeOf(withKind.body)).toBe("TRAVEL_KIND_DERIVED");
      const after = await stored(fx.a.id);
      expect(after.activityKind).toBe("UNSPECIFIED");
      expect(after.travelToSalonId).toBeNull();
    });
  });

  describe("W2 — a salon deactivated after the trip never blocks a correction of the old trip", () => {
    it("only a CHANGED salon is validated", async () => {
      const salonA2 = await createTestSalon(app.prisma, seed.tenant.id, { name: "Salon A2" });
      const salonB2 = await createTestSalon(app.prisma, seed.tenant.id, { name: "Salon B2" });
      const salonD2 = await createTestSalon(app.prisma, seed.tenant.id, {
        name: "Salon D2",
        isActive: false,
      });
      const fx = await adminFixture({ from: salonA2.id, to: salonB2.id });
      await app.prisma.salon.update({
        where: { id: salonB2.id },
        data: { isActive: false, deactivatedAt: new Date() },
      });

      const noteOnly = await adminPut(fx.t.id, { note: "Fahrt mit der Bahn" });
      expect(noteOnly.statusCode, noteOnly.body).toBe(200);

      const shorter = await adminPut(fx.t.id, { endTime: at(fx.day, "12:25") });
      expect(shorter.statusCode, shorter.body).toBe(200);

      const resent = await adminPut(fx.t.id, { travelToSalonId: salonB2.id });
      expect(resent.statusCode, resent.body).toBe(200);

      const toDeactivated = await adminPut(fx.t.id, { travelToSalonId: salonD2.id });
      expect(toDeactivated.statusCode, toDeactivated.body).toBe(400);
      expect(codeOf(toDeactivated.body)).toBe("SALON_INACTIVE");
      expect((await stored(fx.t.id)).travelToSalonId).toBe(salonB2.id);

      // The departure salon deactivated as well: a note-only PUT and a re-sent unchanged salon pass.
      await app.prisma.salon.update({
        where: { id: salonA2.id },
        data: { isActive: false, deactivatedAt: new Date() },
      });
      const noteAgain = await adminPut(fx.t.id, { note: "Fahrt mit der Bahn, Gleis 4" });
      expect(noteAgain.statusCode, noteAgain.body).toBe(200);
      const resentFrom = await adminPut(fx.t.id, { salonId: salonA2.id });
      expect(resentFrom.statusCode, resentFrom.body).toBe(200);
    });
  });

  describe("a manager's change of a travel entry is a correction like any other", () => {
    it("without a Begründung 400, with one 200 and a MANAGER_CORRECTION audit row", async () => {
      const fx = await adminFixture();
      const without = await put(seed.adminToken, fx.t.id, { endTime: at(fx.day, "12:25") });
      expect(without.statusCode, without.body).toBe(400);
      expect((await stored(fx.t.id)).endTime?.toISOString()).toBe(at(fx.day, "12:30"));

      const withReason = await adminPut(fx.t.id, { endTime: at(fx.day, "12:25") });
      expect(withReason.statusCode, withReason.body).toBe(200);
      const audit = await soleAuditRow(app.prisma, {
        where: { entity: "TimeEntry", entityId: fx.t.id, action: "MANAGER_CORRECTION" },
      });
      expect(audit.newValue).toMatchObject({
        auditReason: "Korrektur nach Rückfrage",
        travelToSalonId: salonB.id,
        salonId: salonA.id,
      });
      expect((await stored(fx.t.id)).source).toBe("CORRECTION");
    });
  });

  describe("the break routes refuse a travel entry", () => {
    it("POST /:id/breaks and PATCH /:id/break-status answer 400 TRAVEL_SHAPE and change nothing", async () => {
      const fx = await adminFixture();
      const before = await stored(fx.t.id);
      const append = await app.inject({
        method: "POST",
        url: `/api/v1/time-entries/${fx.t.id}/breaks`,
        headers: { authorization: `Bearer ${seed.adminToken}` },
        payload: { startTime: at(fx.day, "12:10"), endTime: at(fx.day, "12:20") },
      });
      expect(append.statusCode, append.body).toBe(400);
      expect(codeOf(append.body)).toBe("TRAVEL_SHAPE");
      for (const action of ["confirm", "waive"]) {
        const res = await app.inject({
          method: "PATCH",
          url: `/api/v1/time-entries/${fx.t.id}/break-status`,
          headers: { authorization: `Bearer ${seed.adminToken}` },
          payload: { action },
        });
        expect(res.statusCode, res.body).toBe(400);
        expect(codeOf(res.body)).toBe("TRAVEL_SHAPE");
      }
      const after = await stored(fx.t.id);
      expect(after.breakMinutes).toBe(before.breakMinutes);
      expect(after.breakStatus).toBe(before.breakStatus);
      expect(await app.prisma.break.count({ where: { timeEntryId: fx.t.id } })).toBe(0);
    });
  });

  describe("T6 — no route leaves a trip without the two entries it lies between", () => {
    it("DELETE of the arrival or the departure entry: 409 TRAVEL_NEEDS_NEIGHBOUR, nothing deleted, no DELETE audit", async () => {
      const fx = await adminFixture();
      for (const entry of [fx.b, fx.a]) {
        const res = await del(seed.adminToken, entry.id);
        expect(res.statusCode, res.body).toBe(409);
        expect(codeOf(res.body)).toBe("TRAVEL_NEEDS_NEIGHBOUR");
        expect((await stored(entry.id)).deletedAt).toBeNull();
        expect(await auditRowsFor(app, "TimeEntry", entry.id, "DELETE")).toHaveLength(0);
      }
    });

    it("PUT of the arrival entry into another salon, to another date or in front of the departure entry: 409, nothing changes", async () => {
      const fx = await adminFixture();
      const before = await stored(fx.b.id);
      const otherSalon = await adminPut(fx.b.id, { salonId: salonC.id });
      expect(otherSalon.statusCode, otherSalon.body).toBe(409);
      expect(codeOf(otherSalon.body)).toBe("TRAVEL_NEEDS_NEIGHBOUR");

      const otherDay = dayN(dayCounter++);
      const otherDate = await adminPut(fx.b.id, {
        date: otherDay,
        startTime: at(otherDay, "12:30"),
        endTime: at(otherDay, "14:30"),
      });
      expect(otherDate.statusCode, otherDate.body).toBe(409);
      expect(codeOf(otherDate.body)).toBe("TRAVEL_NEEDS_NEIGHBOUR");

      // Same date, a move in front of the departure entry: a stale copy of the stored row must not
      // keep anchoring the trip (one evaluation with both the removed and the resulting row).
      const infront = await adminPut(fx.b.id, {
        startTime: at(fx.day, "06:00"),
        endTime: at(fx.day, "07:30"),
      });
      expect(infront.statusCode, infront.body).toBe(409);
      expect(codeOf(infront.body)).toBe("TRAVEL_NEEDS_NEIGHBOUR");

      const after = await stored(fx.b.id);
      expect(after.salonId).toBe(before.salonId);
      expect(after.date.toISOString()).toBe(before.date.toISOString());
      expect(after.startTime.toISOString()).toBe(before.startTime.toISOString());
    });

    it("a later start of the arrival entry keeps the trip anchored; an entry of another salon in between does not; delete the trip, then its neighbours go", async () => {
      const fx = await adminFixture();
      const later = await adminPut(fx.b.id, { startTime: at(fx.day, "13:00") });
      expect(later.statusCode, later.body).toBe(200);

      const between = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries",
        headers: { authorization: `Bearer ${seed.adminToken}` },
        payload: {
          employeeId: seed.employee.id,
          date: fx.day,
          startTime: at(fx.day, "12:30"),
          endTime: at(fx.day, "12:50"),
          salonId: salonC.id,
        },
      });
      expect(between.statusCode, between.body).toBe(409);
      expect(codeOf(between.body)).toBe("TRAVEL_NEEDS_NEIGHBOUR");
      expect(
        await app.prisma.timeEntry.count({
          where: { employeeId: seed.employee.id, date: utcMidnight(fx.day), deletedAt: null },
        }),
      ).toBe(3);

      // An entry of the ARRIVAL salon in between keeps the trip anchored.
      const inArrivalSalon = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries",
        headers: { authorization: `Bearer ${seed.adminToken}` },
        payload: {
          employeeId: seed.employee.id,
          date: fx.day,
          startTime: at(fx.day, "12:30"),
          endTime: at(fx.day, "12:50"),
          salonId: salonB.id,
        },
      });
      expect(inArrivalSalon.statusCode, inArrivalSalon.body).toBe(201);

      const deleted = await del(seed.adminToken, fx.t.id);
      expect(deleted.statusCode, deleted.body).toBe(204);
      const audit = await soleAuditRow(app.prisma, {
        where: { entity: "TimeEntry", entityId: fx.t.id, action: "DELETE" },
      });
      expect(audit.oldValue).toMatchObject({
        salonId: salonA.id,
        travelToSalonId: salonB.id,
        activityKind: "TRAVEL",
      });
      expect(audit.newValue).toMatchObject({ auditReason: "Doppelt erfasst" });
      expect((await stored(fx.t.id)).deletedAt).not.toBeNull();

      const arrivalNow = await del(seed.adminToken, fx.b.id);
      expect(arrivalNow.statusCode, arrivalNow.body).toBe(204);
    });
  });

  describe("the revalidate correction moves an interval too (T6)", () => {
    it("moving an invalid arrival entry away from its trip is refused; a harmless correction passes", async () => {
      const fx = await adminFixture();
      await app.prisma.timeEntry.update({
        where: { id: fx.b.id },
        data: { isInvalid: true, invalidReason: "Test", invalidReasonCode: "MISSING_CLOCK_OUT" },
      });
      const refused = await app.inject({
        method: "PATCH",
        url: `/api/v1/time-entries/${fx.b.id}/revalidate`,
        headers: { authorization: `Bearer ${seed.adminToken}` },
        payload: { startTime: at(fx.day, "06:00"), endTime: at(fx.day, "07:30") },
      });
      expect(refused.statusCode, refused.body).toBe(409);
      expect(codeOf(refused.body)).toBe("TRAVEL_NEEDS_NEIGHBOUR");
      const unchanged = await stored(fx.b.id);
      expect(unchanged.isInvalid).toBe(true);
      expect(unchanged.startTime.toISOString()).toBe(at(fx.day, "12:30"));

      const fine = await app.inject({
        method: "PATCH",
        url: `/api/v1/time-entries/${fx.b.id}/revalidate`,
        headers: { authorization: `Bearer ${seed.adminToken}` },
        payload: { startTime: at(fx.day, "12:45") },
      });
      expect(fine.statusCode, fine.body).toBe(200);
    });

    it("a travel entry cannot be revalidated into an open or break-carrying entry", async () => {
      const fx = await adminFixture();
      await app.prisma.timeEntry.update({
        where: { id: fx.t.id },
        data: {
          isInvalid: true,
          invalidReason: "Test",
          invalidReasonCode: "LEAVE_CANCELLATION_PENDING",
        },
      });
      for (const payload of [{ endTime: null }, { breakMinutes: 10 }]) {
        const res = await app.inject({
          method: "PATCH",
          url: `/api/v1/time-entries/${fx.t.id}/revalidate`,
          headers: { authorization: `Bearer ${seed.adminToken}` },
          payload,
        });
        expect(res.statusCode, res.body).toBe(400);
        expect(codeOf(res.body)).toBe("TRAVEL_SHAPE");
      }
    });
  });

  describe("the month lock", () => {
    it("a locked travel entry refuses PUT and DELETE like any entry", async () => {
      const fx = await fixtureOn(dayN(dayCounter++), undefined, { locked: true });
      const putRes = await adminPut(fx.t.id, { note: "gesperrt?" });
      expect(putRes.statusCode, putRes.body).toBe(403);
      const delRes = await del(seed.adminToken, fx.t.id);
      expect(delRes.statusCode, delRes.body).toBe(403);
      expect((await stored(fx.t.id)).deletedAt).toBeNull();
    });
  });
});
