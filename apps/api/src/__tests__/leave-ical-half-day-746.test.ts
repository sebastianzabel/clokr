/**
 * Issue #746 (class of #728) - the iCal feeds mark a half day in SUMMARY with the one wording of
 * `withHalfDayMarker()` (the absence context; reports use the same helper). The model has no
 * morning/afternoon, so the event stays an all-day DATE event (RFC 5545) - no invented times.
 * A full day is pinned byte-for-byte: the marker must not leak into unchanged output.
 */
import type { FastifyInstance } from "fastify";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, seedTestData, cleanupTestData, closeTestApp } from "./setup";

function vevents(body: string): string[] {
  return body
    .split("BEGIN:VEVENT")
    .slice(1)
    .map((b) => "BEGIN:VEVENT" + b.split("END:VEVENT")[0] + "END:VEVENT");
}

describe("Issue #746 - iCal half day marker", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let fullId: string;
  let halfId: string;
  let absFullId: string;
  let absHalfId: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "ical746");
    const mk = (start: string, halfDay: boolean) =>
      app.prisma.leaveRequest.create({
        data: {
          employeeId: data.employee.id,
          leaveTypeId: data.vacationType.id,
          startDate: new Date(`${start}T00:00:00Z`),
          endDate: new Date(`${start}T00:00:00Z`),
          days: halfDay ? 0.5 : 1,
          halfDay,
          status: "APPROVED",
        },
      });
    fullId = (await mk("2026-06-08", false)).id;
    halfId = (await mk("2026-06-09", true)).id;
    const ab = (start: string, halfDay: boolean) =>
      app.prisma.absence.create({
        data: {
          employeeId: data.employee.id,
          type: "EDUCATION",
          startDate: new Date(`${start}T00:00:00Z`),
          endDate: new Date(`${start}T00:00:00Z`),
          days: halfDay ? 0.5 : 1,
          halfDay,
          createdBy: data.employee.userId ?? data.employee.id,
        },
      });
    absFullId = (await ab("2026-06-10", false)).id;
    absHalfId = (await ab("2026-06-11", true)).id;
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  const feeds = [
    {
      name: "personal",
      url: "/api/v1/leave/ical/personal",
      token: () => data.empToken,
      prefix: "",
    },
    { name: "team", url: "/api/v1/leave/ical/team", token: () => data.adminToken, prefix: "NAME" },
  ];

  for (const f of feeds) {
    it(`${f.name} feed: half day is marked in SUMMARY, stays an all-day DATE event`, async () => {
      const res = await app.inject({
        method: "GET",
        url: f.url,
        headers: { authorization: `Bearer ${f.token()}` },
      });
      expect(res.statusCode).toBe(200);
      const events = vevents(res.body);
      const half = events.find((e) => e.includes(`UID:leave-${halfId}@clokr`))!;
      expect(half).toMatch(/SUMMARY:.*\(halber Tag\)/);
      expect(half).toContain("DTSTART;VALUE=DATE:20260609");
      expect(half).not.toMatch(/DTSTART:.*T/);
      const absHalf = events.find((e) => e.includes(`UID:absence-${absHalfId}@clokr`))!;
      expect(absHalf).toMatch(/SUMMARY:.*Fortbildung.*\(halber Tag\)|SUMMARY:.*\(halber Tag\)/);
      expect(absHalf).toContain("DTSTART;VALUE=DATE:20260611");
    });

    it(`${f.name} feed: full day output has no marker`, async () => {
      const res = await app.inject({
        method: "GET",
        url: f.url,
        headers: { authorization: `Bearer ${f.token()}` },
      });
      const events = vevents(res.body);
      for (const id of [`leave-${fullId}`, `absence-${absFullId}`]) {
        const ev = events.find((e) => e.includes(`UID:${id}@clokr`))!;
        expect(ev).not.toContain("halber Tag");
      }
    });
  }

  it("personal feed: a full-day VEVENT is pinned byte-for-byte", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/leave/ical/personal",
      headers: { authorization: `Bearer ${data.empToken}` },
    });
    const ev = vevents(res.body).find((e) => e.includes(`UID:leave-${fullId}@clokr`))!;
    const lines = ev.split(/\r?\n/).filter((l) => !l.startsWith("DTSTAMP"));
    expect(lines).toEqual([
      "BEGIN:VEVENT",
      `UID:leave-${fullId}@clokr`,
      "DTSTART;VALUE=DATE:20260608",
      "DTEND;VALUE=DATE:20260609",
      `SUMMARY:${data.vacationType.name}`,
      "STATUS:CONFIRMED",
      "CATEGORIES:VACATION",
      "END:VEVENT",
    ]);
  });
});
