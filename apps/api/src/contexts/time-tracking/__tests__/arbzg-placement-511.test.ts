// Issue #511 (D-10, D-15, D-06a) — the vertical tracer: Break rows are loaded once through the
// store, checkArbZG appends the Satz-2/3 findings, and POST /time-entries returns them in its
// `warnings`. Real database; the tenant time zone is Europe/Berlin (schema default).

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { fromZonedTime } from "date-fns-tz";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../../__tests__/setup";
import { loadBreaksOfEntries } from "../day-break-store";
import { checkArbZG } from "../arbzg";
import type { ArbZGWarning } from "../arbzg";

const TZ = "Europe/Berlin";

function at(day: string, hhmm: string): Date {
  return fromZonedTime(`${day}T${hhmm}:00`, TZ);
}

describe("checkArbZG reports Satz-2/3 findings from the day's Break rows (Issue #511)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let other: Awaited<ReturnType<typeof seedTestData>>;

  async function post(day: string, start: string, end: string, breaks: [string, string][]) {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/time-entries",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        employeeId: data.employee.id,
        date: day,
        startTime: at(day, start).toISOString(),
        endTime: at(day, end).toISOString(),
        breakMinutes: 0,
        breaks: breaks.map(([s, e]) => ({
          startTime: at(day, s).toISOString(),
          endTime: at(day, e).toISOString(),
        })),
      },
    });
    return res;
  }

  /** Inserts a closed entry directly (no Break rows unless given). */
  async function insertEntry(
    day: string,
    start: string,
    end: string,
    breakMinutes: number,
    breaks: [string, string][] = [],
  ) {
    return app.prisma.timeEntry.create({
      data: {
        employeeId: data.employee.id,
        date: new Date(`${day}T00:00:00.000Z`),
        startTime: at(day, start),
        endTime: at(day, end),
        breakMinutes,
        breakStatus: "CONFIRMED",
        source: "MANUAL",
        salonId: data.salonId,
        breaks: {
          create: breaks.map(([s, e]) => ({ startTime: at(day, s), endTime: at(day, e) })),
        },
      },
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "arbzg-place-511");
    other = await seedTestData(app, "arbzg-place-511-foreign");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
      await cleanupTestData(app, other.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  beforeEach(async () => {
    await app.prisma.break.deleteMany({ where: { timeEntry: { employeeId: data.employee.id } } });
    await app.prisma.timeEntry.deleteMany({ where: { employeeId: data.employee.id } });
  });

  it("tracer: POST of 08:00-15:00 with a break at 14:01 answers BREAK_TOO_LATE (D-10)", async () => {
    const res = await post("2026-03-23", "08:00", "15:00", [["14:01", "14:31"]]);
    expect(res.statusCode).toBe(201);
    const warnings = JSON.parse(res.body).warnings as ArbZGWarning[];
    const late = warnings.filter((w) => w.code === "BREAK_TOO_LATE");
    expect(late).toHaveLength(1);
    expect(late[0]).toMatchObject({
      severity: "warning",
      certainty: "VIOLATION",
      legalBasis: "§ 4 S. 3 ArbZG",
    });
    expect(late[0].message).toContain("6:01");
    expect(late[0].message).toContain("08:00–14:01");
    // The message is pronoun-free German prose.
    expect(late[0].message).not.toMatch(/\b(Sie|Ihr|Ihre|Du|Dein|Deine)\b/);
  });

  it("tracer control: the break at 14:00 leaves no BREAK_TOO_LATE", async () => {
    const res = await post("2026-03-24", "08:00", "15:00", [["14:00", "14:30"]]);
    expect(res.statusCode).toBe(201);
    const warnings = JSON.parse(res.body).warnings as ArbZGWarning[];
    expect(warnings.some((w) => w.code === "BREAK_TOO_LATE")).toBe(false);
  });

  it("AK-1: three 10-minute breaks surface the not-counted text through checkArbZG", async () => {
    await insertEntry("2026-03-25", "08:00", "15:00", 30, [
      ["10:00", "10:10"],
      ["11:30", "11:40"],
      ["13:00", "13:10"],
    ]);
    const warnings = await checkArbZG(app.prisma, data.employee.id, new Date("2026-03-25"));
    const short = warnings.filter((w) => w.code === "BREAK_SEGMENT_TOO_SHORT");
    expect(short).toHaveLength(1);
    expect(short[0].message).toContain("3 Pausen unter 15 Min nicht angerechnet");
  });

  it("AK-3: stored breakMinutes without Break rows give only the position hint", async () => {
    await insertEntry("2026-03-26", "08:00", "15:00", 30);
    const warnings = await checkArbZG(app.prisma, data.employee.id, new Date("2026-03-26"));
    const hint = warnings.filter((w) => w.code === "BREAK_POSITION_UNKNOWN");
    expect(hint).toHaveLength(1);
    expect(hint[0].hint).toBe(true);
    expect(warnings.some((w) => w.code === "BREAK_TOO_LATE")).toBe(false);
    expect(warnings.some((w) => w.code === "BREAK_TOO_SHORT")).toBe(false);
  });

  it("D-06a: 8 h without any break keeps BREAK_TOO_SHORT and adds exactly one BREAK_TOO_LATE", async () => {
    await insertEntry("2026-03-27", "08:00", "16:00", 0);
    const warnings = await checkArbZG(app.prisma, data.employee.id, new Date("2026-03-27"));
    const short = warnings.filter((w) => w.code === "BREAK_TOO_SHORT");
    expect(short).toHaveLength(1);
    expect(short[0].message).toBe(
      "§ 4 ArbZG: Bei über 6 Stunden Arbeitszeit sind mindestens 30 Minuten Pause vorgeschrieben. Erfasst: 0 Min.",
    );
    const late = warnings.filter((w) => w.code === "BREAK_TOO_LATE");
    expect(late).toHaveLength(1);
    expect(late[0].certainty).toBe("VIOLATION");
  });

  it("D-06a: 8 h with breakMinutes 20 and no Break rows is BREAK_TOO_SHORT and no placement finding", async () => {
    await insertEntry("2026-03-30", "08:00", "16:00", 20);
    const warnings = await checkArbZG(app.prisma, data.employee.id, new Date("2026-03-30"));
    expect(warnings.filter((w) => w.code === "BREAK_TOO_SHORT")).toHaveLength(1);
    for (const code of [
      "BREAK_TOO_LATE",
      "BREAK_SEGMENT_TOO_SHORT",
      "BREAK_OUTSIDE_WINDOW",
      "BREAK_POSITION_UNKNOWN",
    ]) {
      expect(warnings.some((w) => w.code === code)).toBe(false);
    }
  });

  describe("loadBreaksOfEntries (D-15, T-511-06)", () => {
    it("an empty id list issues no query", async () => {
      const findMany = vi.fn();
      const db = { break: { findMany } } as unknown as Parameters<typeof loadBreaksOfEntries>[0];
      const out = await loadBreaksOfEntries(db, { tenantId: data.tenant.id, entryIds: [] });
      expect(out.size).toBe(0);
      expect(findMany).not.toHaveBeenCalled();
    });

    it("returns the rows grouped by entry in start order, one query", async () => {
      const e1 = await insertEntry("2026-04-01", "08:00", "15:00", 45, [
        ["13:00", "13:15"],
        ["10:00", "10:30"],
      ]);
      const e2 = await insertEntry("2026-04-02", "08:00", "12:00", 15, [["10:00", "10:15"]]);
      const spy = vi.spyOn(app.prisma.break, "findMany");
      const out = await loadBreaksOfEntries(app.prisma, {
        tenantId: data.tenant.id,
        entryIds: [e1.id, e2.id],
      });
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
      expect(out.get(e1.id)?.map((b) => b.startTime.getTime())).toEqual([
        at("2026-04-01", "10:00").getTime(),
        at("2026-04-01", "13:00").getTime(),
      ]);
      expect(out.get(e2.id)).toHaveLength(1);
    });

    it("an entry id of another tenant returns nothing", async () => {
      const foreignEntry = await app.prisma.timeEntry.create({
        data: {
          employeeId: other.employee.id,
          date: new Date("2026-04-03T00:00:00.000Z"),
          startTime: at("2026-04-03", "08:00"),
          endTime: at("2026-04-03", "12:00"),
          breakMinutes: 15,
          source: "MANUAL",
          salonId: other.salonId,
          breaks: {
            create: [{ startTime: at("2026-04-03", "10:00"), endTime: at("2026-04-03", "10:15") }],
          },
        },
      });
      const out = await loadBreaksOfEntries(app.prisma, {
        tenantId: data.tenant.id,
        entryIds: [foreignEntry.id, randomUUID()],
      });
      expect(out.size).toBe(0);
      // anti-vacuity: the owning tenant does see the row
      const own = await loadBreaksOfEntries(app.prisma, {
        tenantId: other.tenant.id,
        entryIds: [foreignEntry.id],
      });
      expect(own.get(foreignEntry.id)).toHaveLength(1);
    });
  });
});
