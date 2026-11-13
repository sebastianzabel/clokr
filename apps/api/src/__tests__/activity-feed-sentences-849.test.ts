/**
 * Issue #849 (4) — GET /api/v1/activity for an employee: entries an admin recorded name the admin
 * as the subject, a clocked day keeps its clock-in next to its clock-out, and no line is the old
 * infinitive fragment.
 */
import type { FastifyInstance } from "fastify";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";

describe("Issue #849 (4) — activity feed sentences", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "afs849");
    const day = (offset: number) => {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - offset);
      return d.toISOString().slice(0, 10);
    };
    // Three manual entries the admin recorded, all ending 17:15 UTC, on three past days.
    for (const offset of [2, 3, 4]) {
      await app.prisma.timeEntry.create({
        data: {
          employeeId: data.employee.id,
          date: new Date(`${day(offset)}T00:00:00Z`),
          startTime: new Date(`${day(offset)}T08:00:00Z`),
          endTime: new Date(`${day(offset)}T17:15:00Z`),
          source: "MANUAL",
          createdBy: data.adminUser.id,
          salonId: data.salonId,
        },
      });
    }
    // One clocked day of the employee themself.
    await app.prisma.timeEntry.create({
      data: {
        employeeId: data.employee.id,
        date: new Date(`${day(1)}T00:00:00Z`),
        startTime: new Date(`${day(1)}T07:00:00Z`),
        endTime: new Date(`${day(1)}T15:30:00Z`),
        source: "MOBILE",
        createdBy: data.empUser.id,
        salonId: data.salonId,
      },
    });
  });

  afterAll(async () => {
    await cleanupTestData(app, data.tenant.id);
    await closeTestApp();
  });

  it("names the author, keeps the clock-in and never repeats a sentence", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/activity?limit=20",
      headers: { authorization: `Bearer ${data.empToken}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    const items = (
      JSON.parse(res.body) as { items: Array<{ who: string; what: string; category: string }> }
    ).items.filter((i) => i.category === "time");
    const sentences = items.map((i) => `${i.who} ${i.what}`);

    expect(sentences.some((s) => /Ausstempeln um|Einstempeln um/.test(s))).toBe(false);
    expect(sentences.filter((s) => s.startsWith("Admin hat für dich "))).toHaveLength(3);
    expect(sentences.some((s) => /^Du hast um \d\d:\d\d eingestempelt\.$/.test(s))).toBe(true);
    expect(sentences.some((s) => /^Du hast um \d\d:\d\d ausgestempelt\.$/.test(s))).toBe(true);
    expect(new Set(sentences).size).toBe(sentences.length);
  });
});
