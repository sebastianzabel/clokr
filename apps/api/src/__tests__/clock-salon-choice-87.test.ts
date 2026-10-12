/**
 * Issue #87 (Phase 87b-03), D-02/D-03/D-04/D-11 — what the clock shows about the salon is decided
 * on the server, in ONE function (`clockSalonChoice`), and served by ONE read route,
 * `GET /api/v1/time-entries/clock-salon`. The web renders this answer and computes no rule.
 *
 * This file proves the route-level read answer: the pattern salon is preselected, whether a
 * choice is offered at all, the active salons (ids and names only) when it is, and the salon a
 * day's existing entry is fixed to.
 *
 * No person names in fixtures. Every fixture id is a UUID.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { fromZonedTime } from "date-fns-tz";
import { getTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";
import { addDaysStr, mondayOfWeekStr, TEST_TZ } from "./test-dates";

/** Tenant-local instant for `HH:MM` on `dayStr`. */
function instant(dayStr: string, hhmm: string): Date {
  return fromZonedTime(`${dayStr}T${hhmm}:00`, TEST_TZ);
}

type SalonItem = { id: string; name: string };
type ChoiceBody = {
  offerChoice: boolean;
  preselectedSalonId: string | null;
  salons: SalonItem[];
  fixedSalon: SalonItem | null;
};

describe("Issue #87 — GET /time-entries/clock-salon (read path)", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: { id: string; name: string };
  let salonB: { id: string; name: string };

  // A past Monday far enough back that no other file's fixtures matter; Thursday = Monday + 3.
  const baseMonday = addDaysStr(mondayOfWeekStr(), -10 * 7);
  const thursday = addDaysStr(baseMonday, 3);

  /** GET /clock-salon at `hhmm` of `dayStr` (tenant time) with the given token. */
  async function choice(dayStr: string, hhmm: string, token?: string) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(instant(dayStr, hhmm));
    try {
      return await app.inject({
        method: "GET",
        url: "/api/v1/time-entries/clock-salon",
        headers: { authorization: `Bearer ${token ?? seed.empToken}` },
      });
    } finally {
      vi.useRealTimers();
    }
  }

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "csc87");
    salonA = await createTestSalon(app.prisma, seed.tenant.id, { name: "Salon Nord" });
    salonB = await createTestSalon(app.prisma, seed.tenant.id, { name: "Salon Ost" });
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
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: seed.tenant.id,
        employeeId: seed.employee.id,
        salonId: salonB.id,
        kind: "DEPLOYMENT",
        validFrom: new Date("2020-01-01"),
        validUntil: null,
        weekdays: [3], // Thursday
      },
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, seed.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
  });

  /** The tenant's active salons as the route must list them: name (de), then id. */
  async function expectedActiveSalons(tenantId: string): Promise<SalonItem[]> {
    const rows = await app.prisma.salon.findMany({ where: { tenantId, isActive: true } });
    return rows
      .map((s) => ({ id: s.id, name: s.name }))
      .sort((a, b) => a.name.localeCompare(b.name, "de") || (a.id < b.id ? -1 : 1));
  }

  it("tracer: HOME A + Thursday DEPLOYMENT B -> B preselected, choice offered with all active salons", async () => {
    const res = await choice(thursday, "09:00");
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      offerChoice: true,
      preselectedSalonId: salonB.id,
      salons: await expectedActiveSalons(seed.tenant.id),
      fixedSalon: null,
    } satisfies ChoiceBody);
  });

  it("the Monday of the same week preselects the HOME salon A", async () => {
    const res = await choice(baseMonday, "09:00");
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as ChoiceBody;
    expect(body.preselectedSalonId).toBe(salonA.id);
    expect(body.offerChoice).toBe(true);
    expect(body.salons).toHaveLength(3);
  });
});
