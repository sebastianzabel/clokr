/**
 * Issue #92 (Phase 92b-02, Task 3) — neighbour integrity (T6) on the two writers that are not the
 * time-entry routes: the Zeitnachtrag approval and the CSV import — and the race between a delete
 * of the arrival entry and a travel entry anchored on it.
 *
 * Fixture day (tenant time): A 08:00-12:00 salon A, T 12:00-12:30 travel A -> B, B 13:00-15:00
 * salon B, and a third active salon C. Written straight through Prisma. Every case owns a day.
 * No person names in fixtures.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { fromZonedTime } from "date-fns-tz";
import { getTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";
import { nextWeekdayStr, pastDateStr, TEST_TZ, utcMidnight } from "./test-dates";
import { invalidReasonFields } from "../contexts/time-tracking/invalid-reason";
import { travelRowsOrphanedBy } from "../contexts/time-tracking/travel-entry";

function at(dayStr: string, hhmm: string): Date {
  return fromZonedTime(`${dayStr}T${hhmm}:00`, TEST_TZ);
}

/** The n-th distinct weekday, three calendar days apart, starting 100 days ago (no retro window). */
function dayN(n: number): string {
  return nextWeekdayStr(pastDateStr(100 + 3 * n));
}

/** The import format's `DD.MM.YYYY`. */
function germanDate(dayStr: string): string {
  const [y, m, d] = dayStr.split("-");
  return `${d}.${m}.${y}`;
}

describe("Issue #92 — the approval and the import keep every trip anchored", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: { id: string };
  let salonB: { id: string };
  let salonC: { id: string };
  let dayCounter = 0;

  async function dayWithTrip(): Promise<{
    day: string;
    a: { id: string };
    t: { id: string };
    b: { id: string };
  }> {
    const day = dayN(dayCounter++);
    const base = {
      employeeId: seed.employee.id,
      date: utcMidnight(day),
      source: "MANUAL" as const,
    };
    const a = await app.prisma.timeEntry.create({
      data: {
        ...base,
        startTime: at(day, "08:00"),
        endTime: at(day, "12:00"),
        salonId: salonA.id,
      },
    });
    const t = await app.prisma.timeEntry.create({
      data: {
        ...base,
        startTime: at(day, "12:00"),
        endTime: at(day, "12:30"),
        salonId: salonA.id,
        activityKind: "TRAVEL",
        travelToSalonId: salonB.id,
      },
    });
    const b = await app.prisma.timeEntry.create({
      data: {
        ...base,
        startTime: at(day, "13:00"),
        endTime: at(day, "15:00"),
        salonId: salonB.id,
      },
    });
    return { day, a, t, b };
  }

  /** A pending entry-first Nachtrag (RETRO_APPROVAL_PENDING) of `day` and its coupled invalid entry. */
  async function pendingNachtrag(day: string, salonId: string, from: string, to: string) {
    const request = await app.prisma.retroEntryRequest.create({
      data: {
        employeeId: seed.employee.id,
        targetDate: utcMidnight(day),
        reason: "Nachtrag fixture for the neighbour check",
        startTime: from,
        endTime: to,
        breakMinutes: 0,
        status: "PENDING",
      },
    });
    const entry = await app.prisma.timeEntry.create({
      data: {
        employeeId: seed.employee.id,
        date: utcMidnight(day),
        startTime: at(day, from),
        endTime: at(day, to),
        breakMinutes: 0,
        source: "MANUAL",
        createdBy: seed.employee.id,
        isInvalid: true,
        ...invalidReasonFields("RETRO_APPROVAL_PENDING"),
        retroRequestId: request.id,
        salonId,
      },
    });
    return { request, entry };
  }

  const review = (requestId: string, payload: Record<string, unknown>) =>
    app.inject({
      method: "PATCH",
      url: `/api/v1/retro-entry-requests/${requestId}/review`,
      headers: { authorization: `Bearer ${seed.adminToken}` },
      payload: { status: "APPROVED", ...payload },
    });

  const importCsv = async (csv: string) => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/imports/time-entries",
      headers: { authorization: `Bearer ${seed.adminToken}` },
      payload: { csv },
    });
    expect(res.statusCode, res.body).toBe(200);
    return JSON.parse(res.body) as {
      imported: number;
      errors: number;
      details: Array<{ row: number; status: "ok" | "error"; error?: string }>;
    };
  };

  const liveRows = (day: string) =>
    app.prisma.timeEntry.findMany({
      where: { employeeId: seed.employee.id, date: utcMidnight(day), deletedAt: null },
      orderBy: [{ startTime: "asc" }, { id: "asc" }],
    });

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "trv92w");
    salonA = await createTestSalon(app.prisma, seed.tenant.id, { name: "Salon A" });
    salonB = await createTestSalon(app.prisma, seed.tenant.id, { name: "Salon B" });
    salonC = await createTestSalon(app.prisma, seed.tenant.id, { name: "Salon C" });
  });

  afterAll(async () => {
    try {
      await app.prisma.timeEntry.deleteMany({ where: { employee: { tenantId: seed.tenant.id } } });
      await app.prisma.retroEntryRequest.deleteMany({
        where: { employee: { tenantId: seed.tenant.id } },
      });
      await cleanupTestData(app, seed.tenant.id);
    } catch {
      // best-effort cleanup
    }
  });

  describe("the Zeitnachtrag", () => {
    it("a pending Nachtrag row does not anchor: a travel entry whose only arrival-side neighbour is pending is refused", async () => {
      const day = dayN(dayCounter++);
      await app.prisma.timeEntry.create({
        data: {
          employeeId: seed.employee.id,
          date: utcMidnight(day),
          startTime: at(day, "08:00"),
          endTime: at(day, "12:00"),
          source: "MANUAL",
          salonId: salonA.id,
        },
      });
      await pendingNachtrag(day, salonB.id, "13:00", "15:00");
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries",
        headers: { authorization: `Bearer ${seed.adminToken}` },
        payload: {
          employeeId: seed.employee.id,
          date: day,
          startTime: at(day, "12:00").toISOString(),
          endTime: at(day, "12:30").toISOString(),
          salonId: salonA.id,
          travelToSalonId: salonB.id,
        },
      });
      expect(res.statusCode, res.body).toBe(409);
      expect(JSON.parse(res.body).code).toBe("TRAVEL_NOT_BETWEEN_SALON_ENTRIES");
    });

    it("approving a pending row whose corrected times put it between the trip and its arrival entry in another salon: 409, the request stays PENDING, the coupled row is unchanged", async () => {
      const { day } = await dayWithTrip();
      const { request, entry } = await pendingNachtrag(day, salonC.id, "16:00", "17:00");

      const refused = await review(request.id, { startTime: "12:30", endTime: "12:50" });
      expect(refused.statusCode, refused.body).toBe(409);
      expect(JSON.parse(refused.body).code).toBe("TRAVEL_NEEDS_NEIGHBOUR");

      const requestAfter = await app.prisma.retroEntryRequest.findUniqueOrThrow({
        where: { id: request.id },
      });
      expect(requestAfter.status).toBe("PENDING");
      const entryAfter = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: entry.id } });
      expect(entryAfter.isInvalid).toBe(true);
      expect(entryAfter.startTime.toISOString()).toBe(at(day, "16:00").toISOString());
      expect(
        await app.prisma.auditLog.count({
          where: {
            entity: "RetroEntryRequest",
            entityId: request.id,
            action: "RETRO_ENTRY_APPROVED",
          },
        }),
      ).toBe(0);
    });

    it("approving without such a conflict (corrected times after the arrival entry) succeeds", async () => {
      const { day } = await dayWithTrip();
      const { request, entry } = await pendingNachtrag(day, salonC.id, "16:00", "17:00");
      const approved = await review(request.id, { startTime: "15:30", endTime: "16:30" });
      expect(approved.statusCode, approved.body).toBe(200);
      const entryAfter = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: entry.id } });
      expect(entryAfter.isInvalid).toBe(false);
      expect(entryAfter.startTime.toISOString()).toBe(at(day, "15:30").toISOString());
    });

    it("approving a pending row without corrected times between the trip and its arrival is also refused", async () => {
      const { day } = await dayWithTrip();
      // Stored times 12:30-12:50 in salon C: a pending row never anchored nor orphaned anything, but
      // its release would sit between the trip and the arrival entry of salon B.
      const { request } = await pendingNachtrag(day, salonC.id, "12:30", "12:50");
      const refused = await review(request.id, {});
      expect(refused.statusCode, refused.body).toBe(409);
      expect(JSON.parse(refused.body).code).toBe("TRAVEL_NEEDS_NEIGHBOUR");
    });
  });

  describe("the CSV import", () => {
    it("a row in salon C between the trip and its arrival entry is a per-row error; the other rows import", async () => {
      const { day } = await dayWithTrip();
      const nr = seed.employee.employeeNumber;
      const csv = `nr;datum;von;bis;pause;salon-id
${nr};${germanDate(day)};12:30;12:50;0;${salonC.id}
${nr};${germanDate(day)};16:00;17:00;0;${salonC.id}`;
      const body = await importCsv(csv);
      expect(body.details).toHaveLength(2);
      expect(body.details[0].status).toBe("error");
      expect(body.details[0].error).toBe(
        "Dieser Eintrag ist Abfahrts- oder Ankunftseintrag einer Fahrzeit. Bitte ändern oder löschen Sie zuerst die Fahrzeit.",
      );
      expect(body.details[1].status).toBe("ok");
      expect(await liveRows(day)).toHaveLength(4);
    });
  });

  describe("the race", () => {
    it("DELETE of the arrival entry against a travel POST anchored on it: exactly one succeeds, the end state has no orphan", async () => {
      // Day with the two anchors only (no trip yet): the trip needs B, the delete removes B.
      const day = dayN(dayCounter++);
      const base = {
        employeeId: seed.employee.id,
        date: utcMidnight(day),
        source: "MANUAL" as const,
      };
      await app.prisma.timeEntry.create({
        data: {
          ...base,
          startTime: at(day, "08:00"),
          endTime: at(day, "12:00"),
          salonId: salonA.id,
        },
      });
      const arrival = await app.prisma.timeEntry.create({
        data: {
          ...base,
          startTime: at(day, "12:30"),
          endTime: at(day, "14:30"),
          salonId: salonB.id,
        },
      });
      const [del, post] = await Promise.all([
        app.inject({
          method: "DELETE",
          url: `/api/v1/time-entries/${arrival.id}`,
          headers: { authorization: `Bearer ${seed.adminToken}` },
          payload: { reason: "Doppelt erfasst" },
        }),
        app.inject({
          method: "POST",
          url: "/api/v1/time-entries",
          headers: { authorization: `Bearer ${seed.adminToken}` },
          payload: {
            employeeId: seed.employee.id,
            date: day,
            startTime: at(day, "12:00").toISOString(),
            endTime: at(day, "12:30").toISOString(),
            salonId: salonA.id,
            travelToSalonId: salonB.id,
          },
        }),
      ]);
      const statuses = `delete ${del.statusCode} ${del.body} / post ${post.statusCode} ${post.body}`;
      const deleteWon = del.statusCode === 204;
      const postWon = post.statusCode === 201;
      expect(deleteWon !== postWon, `exactly one of the two wins: ${statuses}`).toBe(true);
      if (deleteWon) {
        expect(post.statusCode, statuses).toBe(409);
        expect(JSON.parse(post.body).code).toBe("TRAVEL_NOT_BETWEEN_SALON_ENTRIES");
      } else {
        expect(del.statusCode, statuses).toBe(409);
        expect(JSON.parse(del.body).code).toBe("TRAVEL_NEEDS_NEIGHBOUR");
      }
      expect(travelRowsOrphanedBy(await liveRows(day)), statuses).toEqual([]);
    });

    it("DELETE of the arrival entry against the DELETE of its only trip: the end state has no orphan", async () => {
      const { day, t, b } = await dayWithTrip();
      const results = await Promise.all([
        app.inject({
          method: "DELETE",
          url: `/api/v1/time-entries/${b.id}`,
          headers: { authorization: `Bearer ${seed.adminToken}` },
          payload: { reason: "Doppelt erfasst" },
        }),
        app.inject({
          method: "DELETE",
          url: `/api/v1/time-entries/${t.id}`,
          headers: { authorization: `Bearer ${seed.adminToken}` },
          payload: { reason: "Doppelt erfasst" },
        }),
      ]);
      for (const res of results) expect([204, 409]).toContain(res.statusCode);
      expect(results[1].statusCode, "the trip itself can always be deleted").toBe(204);
      expect(travelRowsOrphanedBy(await liveRows(day))).toEqual([]);
    });
  });
});
