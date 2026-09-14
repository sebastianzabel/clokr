/**
 * settings-vacation-type-resolution.test.ts
 *
 * Issue #196 — both `GET` and `PUT /api/v1/settings/vacation/:employeeId` resolved the
 * vacation `LeaveType` with
 *   `findFirst({ where: { tenantId, name: { contains: "Urlaub", mode: "insensitive" } } })`
 * (apps/api/src/routes/settings.ts, previously lines ~1138-1142 and ~1184-1188) — with NO
 * `orderBy`. Postgres guarantees no row order without `ORDER BY`, and four of the nine
 * `LEAVE_TYPE_DEFS` names in `leave.ts` match that `contains`: "Urlaub" (meant), "Sonderurlaub",
 * "Unbezahlter Urlaub", "Bildungsurlaub" (all not meant). Once a tenant has more than one of
 * those rows, GET and PUT could resolve DIFFERENT rows, and PUT could silently write the annual
 * leave entitlement onto the wrong one.
 *
 * The fix (`apps/api/src/utils/vacation-leave-type.ts`, `findVacationLeaveType()`) resolves the
 * canonical/legacy names first via exact (case-insensitive) match with a deterministic
 * `orderBy`, falling back to the old `contains` query only when it is unambiguous.
 *
 * Block A's fixture inserts the three decoy rows (Sonderurlaub / Unbezahlter Urlaub /
 * Bildungsurlaub) BEFORE the canonical "Urlaub" row. That physical insert order is
 * load-bearing: it is what gives block A the power to fail against the pre-fix code (a
 * sequential scan with no ORDER BY tends to return rows in something close to insertion
 * order), and the fixture-guard test right below it proves that for this run, rather than
 * assuming it.
 *
 * Every year in this file is derived from `new Date()` — no hardcoded calendar literal
 * (documented time-bomb hazard, see `.planning/STATE.md`).
 *
 * Refs: Issue #196 (this fix), Issue #97 (the eventual stable `code` column that replaces both
 * this file's and leave.ts's name lists).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, seedTestData, cleanupTestData, SEED_YEAR_OFFSET } from "./setup";
import type { FastifyInstance } from "fastify";

const YEAR = new Date().getFullYear() + SEED_YEAR_OFFSET;

describe("settings /vacation/:employeeId — deterministic vacation LeaveType resolution (Issue #196)", () => {
  let app: FastifyInstance;

  let tenantA: Awaited<ReturnType<typeof seedTestData>>;
  let tenantB: Awaited<ReturnType<typeof seedTestData>>;
  let tenantC: Awaited<ReturnType<typeof seedTestData>>;
  let tenantD: Awaited<ReturnType<typeof seedTestData>>;
  let tenantE: Awaited<ReturnType<typeof seedTestData>>;

  // Block A fixture state
  let urlaubTypeA: { id: string; name: string };
  let sonderurlaubA: { id: string; name: string };
  let unbezahlterUrlaubA: { id: string; name: string };
  let bildungsurlaubA: { id: string; name: string };

  // Block B/C/D fixture state
  let jahresurlaubB: { id: string; name: string };
  let erholungsurlaubC: { id: string; name: string };

  beforeAll(async () => {
    app = await getTestApp();

    tenantA = await seedTestData(app, "sv196-a");
    tenantB = await seedTestData(app, "sv196-b");
    tenantC = await seedTestData(app, "sv196-c");
    tenantD = await seedTestData(app, "sv196-d");
    tenantE = await seedTestData(app, "sv196-e");

    // ── Tenant A: decoys present, canonical row must win ──────────────────────────────────
    // Remove the seeded "Urlaub" row + its entitlement, then insert the three decoys BEFORE
    // recreating "Urlaub" — physical insert order is the whole point (see file header).
    await app.prisma.leaveEntitlement.deleteMany({ where: { employeeId: tenantA.employee.id } });
    await app.prisma.leaveType.delete({ where: { id: tenantA.vacationType.id } });

    sonderurlaubA = await app.prisma.leaveType.create({
      data: {
        tenantId: tenantA.tenant.id,
        name: "Sonderurlaub",
        isPaid: true,
        requiresApproval: true,
      },
      select: { id: true, name: true },
    });
    unbezahlterUrlaubA = await app.prisma.leaveType.create({
      data: {
        tenantId: tenantA.tenant.id,
        name: "Unbezahlter Urlaub",
        isPaid: false,
        requiresApproval: true,
      },
      select: { id: true, name: true },
    });
    bildungsurlaubA = await app.prisma.leaveType.create({
      data: {
        tenantId: tenantA.tenant.id,
        name: "Bildungsurlaub",
        isPaid: true,
        requiresApproval: true,
      },
      select: { id: true, name: true },
    });
    urlaubTypeA = await app.prisma.leaveType.create({
      data: { tenantId: tenantA.tenant.id, name: "Urlaub", isPaid: true, requiresApproval: true },
      select: { id: true, name: true },
    });

    // ── Tenant B: legacy "Jahresurlaub" only ───────────────────────────────────────────────
    await app.prisma.leaveEntitlement.deleteMany({ where: { employeeId: tenantB.employee.id } });
    await app.prisma.leaveType.delete({ where: { id: tenantB.vacationType.id } });
    jahresurlaubB = await app.prisma.leaveType.create({
      data: {
        tenantId: tenantB.tenant.id,
        name: "Jahresurlaub",
        isPaid: true,
        requiresApproval: true,
      },
      select: { id: true, name: true },
    });

    // ── Tenant C: single arbitrarily-named urlaub row ──────────────────────────────────────
    await app.prisma.leaveEntitlement.deleteMany({ where: { employeeId: tenantC.employee.id } });
    await app.prisma.leaveType.delete({ where: { id: tenantC.vacationType.id } });
    erholungsurlaubC = await app.prisma.leaveType.create({
      data: {
        tenantId: tenantC.tenant.id,
        name: "Erholungsurlaub",
        isPaid: true,
        requiresApproval: true,
      },
      select: { id: true, name: true },
    });

    // ── Tenant D: ambiguous non-canonical names, no canonical/legacy row ───────────────────
    await app.prisma.leaveEntitlement.deleteMany({ where: { employeeId: tenantD.employee.id } });
    await app.prisma.leaveType.delete({ where: { id: tenantD.vacationType.id } });
    await app.prisma.leaveType.create({
      data: {
        tenantId: tenantD.tenant.id,
        name: "Erholungsurlaub",
        isPaid: true,
        requiresApproval: true,
      },
    });
    await app.prisma.leaveType.create({
      data: {
        tenantId: tenantD.tenant.id,
        name: "Sonderurlaub",
        isPaid: true,
        requiresApproval: true,
      },
    });

    // ── Tenant E: no vacation type at all ──────────────────────────────────────────────────
    await app.prisma.leaveEntitlement.deleteMany({ where: { employeeId: tenantE.employee.id } });
    await app.prisma.leaveType.delete({ where: { id: tenantE.vacationType.id } });
  });

  afterAll(async () => {
    // Sequential cleanup, each in its own try/catch — never Promise.all (setup.ts Pitfall 3).
    try {
      await cleanupTestData(app, tenantA.tenant.id);
    } catch (err) {
      console.error("Cleanup tenantA failed:", err);
    }
    try {
      await cleanupTestData(app, tenantB.tenant.id);
    } catch (err) {
      console.error("Cleanup tenantB failed:", err);
    }
    try {
      await cleanupTestData(app, tenantC.tenant.id);
    } catch (err) {
      console.error("Cleanup tenantC failed:", err);
    }
    try {
      await cleanupTestData(app, tenantD.tenant.id);
    } catch (err) {
      console.error("Cleanup tenantD failed:", err);
    }
    try {
      await cleanupTestData(app, tenantE.tenant.id);
    } catch (err) {
      console.error("Cleanup tenantE failed:", err);
    }
  });

  describe("A) decoys present — canonical row wins", () => {
    it("fixture guard: the pre-fix contains-query does NOT already return the canonical row", async () => {
      // If this fails, the fixture stopped being adversarial (e.g. Postgres started returning
      // rows in a different physical order) — fix the fixture, never weaken this assertion
      // (CLAUDE.md: no test manipulation for green CI).
      const preFixResult = await app.prisma.leaveType.findFirst({
        where: { tenantId: tenantA.tenant.id, name: { contains: "Urlaub", mode: "insensitive" } },
      });
      expect(preFixResult).not.toBeNull();
      expect(preFixResult?.id).not.toBe(urlaubTypeA.id);
    });

    it("GET resolves the canonical 'Urlaub' row, not a decoy", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/settings/vacation/${tenantA.employee.id}?year=${YEAR}`,
        headers: { authorization: `Bearer ${tenantA.adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.leaveTypeId).toBe(urlaubTypeA.id);
    });

    it("PUT writes the entitlement onto the canonical row, not a decoy", async () => {
      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/settings/vacation/${tenantA.employee.id}`,
        headers: { authorization: `Bearer ${tenantA.adminToken}` },
        payload: { year: YEAR, totalDays: 24 },
      });
      expect(res.statusCode).toBe(200);

      const entitlement = await app.prisma.leaveEntitlement.findUnique({
        where: {
          employeeId_leaveTypeId_year: {
            employeeId: tenantA.employee.id,
            leaveTypeId: urlaubTypeA.id,
            year: YEAR,
          },
        },
      });
      expect(entitlement).not.toBeNull();
      expect(Number(entitlement?.totalDays)).toBe(24);

      const decoyCount = await app.prisma.leaveEntitlement.count({
        where: {
          employeeId: tenantA.employee.id,
          leaveTypeId: { in: [sonderurlaubA.id, unbezahlterUrlaubA.id, bildungsurlaubA.id] },
        },
      });
      expect(decoyCount).toBe(0);
    });

    it("GET after PUT returns the same row and the just-written value — GET and PUT touched ONE row", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/settings/vacation/${tenantA.employee.id}?year=${YEAR}`,
        headers: { authorization: `Bearer ${tenantA.adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.leaveTypeId).toBe(urlaubTypeA.id);
      expect(body.totalDays).toBe(24);
    });
  });

  describe("B) legacy name 'Jahresurlaub' keeps working — no new 404", () => {
    it("GET resolves the legacy row", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/settings/vacation/${tenantB.employee.id}?year=${YEAR}`,
        headers: { authorization: `Bearer ${tenantB.adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).leaveTypeId).toBe(jahresurlaubB.id);
    });

    it("PUT writes the entitlement onto the legacy row", async () => {
      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/settings/vacation/${tenantB.employee.id}`,
        headers: { authorization: `Bearer ${tenantB.adminToken}` },
        payload: { year: YEAR, totalDays: 20 },
      });
      expect(res.statusCode).toBe(200);

      const entitlement = await app.prisma.leaveEntitlement.findUnique({
        where: {
          employeeId_leaveTypeId_year: {
            employeeId: tenantB.employee.id,
            leaveTypeId: jahresurlaubB.id,
            year: YEAR,
          },
        },
      });
      expect(entitlement).not.toBeNull();
      expect(Number(entitlement?.totalDays)).toBe(20);
    });
  });

  describe("C) single arbitrarily-named urlaub row keeps working — no new 404", () => {
    it("GET resolves the single non-canonical row (old behaviour preserved)", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/settings/vacation/${tenantC.employee.id}?year=${YEAR}`,
        headers: { authorization: `Bearer ${tenantC.adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).leaveTypeId).toBe(erholungsurlaubC.id);
    });
  });

  describe("D) ambiguous non-canonical names — deterministic 404 (the one deliberate behaviour change)", () => {
    // Before this fix, a tenant with "Erholungsurlaub" AND "Sonderurlaub" and no canonical/legacy
    // row would have hit the old unordered `contains` query and gotten a nondeterministic WRONG
    // WRITE onto whichever row the scan happened to return first. This test pins the replacement:
    // a loud, reconstructible 404 instead of a coin-flip write (T-196-04, accepted risk, no
    // measured tenant is in this state).
    it("GET returns 404 'Urlaubstyp nicht konfiguriert' instead of guessing", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/settings/vacation/${tenantD.employee.id}?year=${YEAR}`,
        headers: { authorization: `Bearer ${tenantD.adminToken}` },
      });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body)).toEqual({ error: "Urlaubstyp nicht konfiguriert" });
    });
  });

  describe("E) no vacation type at all — unchanged 404 from BOTH handlers", () => {
    it("GET returns 404 'Urlaubstyp nicht konfiguriert'", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/settings/vacation/${tenantE.employee.id}?year=${YEAR}`,
        headers: { authorization: `Bearer ${tenantE.adminToken}` },
      });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body)).toEqual({ error: "Urlaubstyp nicht konfiguriert" });
    });

    it("PUT returns 404 'Urlaubstyp nicht konfiguriert'", async () => {
      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/settings/vacation/${tenantE.employee.id}`,
        headers: { authorization: `Bearer ${tenantE.adminToken}` },
        payload: { year: YEAR, totalDays: 10 },
      });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body)).toEqual({ error: "Urlaubstyp nicht konfiguriert" });
    });
  });
});
