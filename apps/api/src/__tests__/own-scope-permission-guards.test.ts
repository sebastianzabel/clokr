/**
 * Issues #346, #358, #359 — three related "eigene Reichweite" gaps found in the security review
 * of PR #354 (Phase 75b, permission neutrality matrix). Grouped in one file because they share the
 * same fixture shape (a colleague of the same tenant; a "Kundenrolle" person stripped of every
 * EIGENE permission this file exercises) and the same finding shape: a caller with LESS reach than
 * the code intended was let through.
 *
 * - #346: `POST /:id/clock-out` had no ownership check at all — any authenticated tenant member,
 *   an EMPLOYEE included, could clock out a colleague's open entry.
 * - #358: `POST /clock-in`'s "on behalf of" judgment looked only at `body.employeeId`, so a
 *   colleague's `nfcCardId` (physically readable) bypassed it entirely.
 * - #359: `POST /time-entries`, `POST /leave/requests`, `POST /retro-entry-requests` and
 *   `POST /:id/clock-out` never checked the EIGENE reach on the self-service path — a Kundenrolle
 *   without ANY reach of the relevant permission fell straight through to acting on itself.
 *
 * Every "still works" counterpart (ADMIN, ZUGEWIESEN) is asserted alongside the fix so a
 * regression that over-blocks shows up here too, not just in the neutrality matrix.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import { pastDateStr, futureDateStr } from "./test-dates";
import { normalizeRolePermissions, roleNameKey } from "../contexts/platform";

const PASSWORD = "test1234";
const NON_EXISTENT_ID = "00000000-0000-0000-0000-000000000000";

describe("Issues #346/#358/#359 — eigene-Reichweite guards", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "esr");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  /** A second EMPLOYEE-role person of the SAME tenant — no stored RoleAssignment, so they resolve
   * through the ordinary legacy-role fallback exactly like `data.employee` does. */
  async function createColleague(label: string, opts: { nfcCardId?: string } = {}) {
    const s = `${Date.now().toString(36)}${crypto.randomBytes(4).toString("hex")}`;
    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const user = await app.prisma.user.create({
      data: { email: `esr-${s}@test.de`, passwordHash, role: "EMPLOYEE", isActive: true },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `ESR-${s}`.slice(0, 20),
        firstName: label,
        lastName: "Test",
        hireDate: new Date("2024-01-01"),
        ...(opts.nfcCardId ? { nfcCardId: opts.nfcCardId } : {}),
      },
    });
    return { user, employee };
  }

  /** A person of a Kundenrolle carrying NEITHER reach of ANY permission this file tests — a
   * well-formed TENANT-scope assignment, so the legacy-role fallback (D-08, which fires only for a
   * user with no stored assignment at all) never kicks in and masks the missing checks. */
  async function createKundePerson(label: string) {
    const { user, employee } = await createColleague(label);
    const name = `Kundenrolle ${crypto.randomBytes(3).toString("hex")}`;
    const role = await app.prisma.accessRole.create({
      data: {
        tenantId: data.tenant.id,
        name,
        nameKey: roleNameKey(name),
        // Deliberately unrelated to time-entry:*, leave-request:create or retro-request:create,
        // in either reach.
        permissions: normalizeRolePermissions(["role:read:ZUGEWIESEN"]),
      },
    });
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        accessRoleId: role.id,
        scopeType: "TENANT",
        salonIds: [],
        employeeIds: [],
      },
    });
    return { user, employee };
  }

  async function login(email: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    return (JSON.parse(res.body) as { accessToken: string }).accessToken;
  }

  describe("#346 — POST /time-entries/:id/clock-out ownership", () => {
    it("an EMPLOYEE cannot clock out a colleague's open entry — 404, byte-identical to a non-existent id", async () => {
      const colleague = await createColleague("Kollegin346");
      const openEntry = await app.prisma.timeEntry.create({
        data: {
          employeeId: colleague.employee.id,
          date: new Date("2026-04-01"),
          startTime: new Date("2026-04-01T08:00:00Z"),
          source: "MANUAL",
          salonId: data.salonId,
        },
      });

      const foreignRes = await app.inject({
        method: "POST",
        url: `/api/v1/time-entries/${openEntry.id}/clock-out`,
        headers: { authorization: `Bearer ${data.empToken}` },
        payload: {},
      });
      const nonExistentRes = await app.inject({
        method: "POST",
        url: `/api/v1/time-entries/${NON_EXISTENT_ID}/clock-out`,
        headers: { authorization: `Bearer ${data.empToken}` },
        payload: {},
      });

      expect(foreignRes.statusCode).toBe(404);
      expect(nonExistentRes.statusCode).toBe(404);
      expect(JSON.parse(foreignRes.body)).toEqual({ error: "Eintrag nicht gefunden" });
      expect(JSON.parse(foreignRes.body)).toEqual(JSON.parse(nonExistentRes.body));

      // The colleague's entry must still be open — the rejected request had no side effect.
      const stillOpen = await app.prisma.timeEntry.findUnique({ where: { id: openEntry.id } });
      expect(stillOpen?.endTime).toBeNull();

      await app.prisma.timeEntry.delete({ where: { id: openEntry.id } });
    });

    it("an ADMIN (time-entry:update:ZUGEWIESEN) can still clock out a colleague's open entry — unchanged", async () => {
      const colleague = await createColleague("Kollegin346b");
      const openEntry = await app.prisma.timeEntry.create({
        data: {
          employeeId: colleague.employee.id,
          date: new Date("2026-04-02"),
          startTime: new Date("2026-04-02T08:00:00Z"),
          source: "MANUAL",
          salonId: data.salonId,
        },
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/v1/time-entries/${openEntry.id}/clock-out`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {},
      });

      expect(res.statusCode).toBe(200);
    });
  });

  describe("#358 — POST /time-entries/clock-in on behalf of a colleague via nfcCardId", () => {
    it("an EMPLOYEE cannot clock in a colleague via their nfcCardId — 403, same as a foreign employeeId", async () => {
      const nfcCardId = `NFC-358-${crypto.randomBytes(4).toString("hex")}`;
      const colleague = await createColleague("Kollegin358", { nfcCardId });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries/clock-in",
        headers: { authorization: `Bearer ${data.empToken}` },
        payload: { source: "MANUAL", nfcCardId },
      });

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body)).toEqual({ error: "Forbidden" });

      const entries = await app.prisma.timeEntry.findMany({
        where: { employeeId: colleague.employee.id },
      });
      expect(entries).toEqual([]);
    });

    it("an ADMIN (time-entry:create:ZUGEWIESEN) can clock in a colleague via their nfcCardId — unchanged", async () => {
      const nfcCardId = `NFC-358b-${crypto.randomBytes(4).toString("hex")}`;
      const colleague = await createColleague("Kollegin358b", { nfcCardId });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries/clock-in",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { source: "MANUAL", nfcCardId },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        resolution: { entry: { id: string; employeeId: string } };
      };
      expect(body.resolution.entry.employeeId).toBe(colleague.employee.id);

      await app.prisma.timeEntry.delete({ where: { id: body.resolution.entry.id } });
    });
  });

  describe("#359 — self-service paths without the EIGENE permission (Kundenrolle)", () => {
    it("POST /time-entries rejects a Kundenrolle without time-entry:create:EIGENE", async () => {
      const kunde = await createKundePerson("Kunde359a");
      const token = await login(kunde.user.email);
      const d = pastDateStr(2);

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          date: d,
          startTime: `${d}T08:00:00.000Z`,
          endTime: `${d}T16:00:00.000Z`,
          breakMinutes: 30,
        },
      });

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body)).toEqual({ error: "Forbidden" });
    });

    it("POST /leave/requests rejects a Kundenrolle without leave-request:create:EIGENE", async () => {
      const kunde = await createKundePerson("Kunde359b");
      const token = await login(kunde.user.email);

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/leave/requests",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          type: "VACATION",
          startDate: futureDateStr(30),
          endDate: futureDateStr(31),
        },
      });

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body)).toEqual({ error: "Forbidden" });
    });

    it("POST /retro-entry-requests rejects a Kundenrolle without retro-request:create:EIGENE", async () => {
      const kunde = await createKundePerson("Kunde359c");
      const token = await login(kunde.user.email);

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/retro-entry-requests",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          targetDate: pastDateStr(2),
          reason: "Vergessen zu stempeln",
          startTime: "08:00",
          endTime: "16:00",
        },
      });

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body)).toEqual({ error: "Forbidden" });
    });

    it("POST /time-entries/:id/clock-out rejects a Kundenrolle without time-entry:update, even on their own entry", async () => {
      const kunde = await createKundePerson("Kunde359d");
      const token = await login(kunde.user.email);
      const openEntry = await app.prisma.timeEntry.create({
        data: {
          employeeId: kunde.employee.id,
          date: new Date("2026-04-04"),
          startTime: new Date("2026-04-04T08:00:00Z"),
          source: "MANUAL",
          salonId: data.salonId,
        },
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/v1/time-entries/${openEntry.id}/clock-out`,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });

      // Own entry (not a foreign one) — 403 "Forbidden", not the 404 the ownership branch answers.
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body)).toEqual({ error: "Forbidden" });

      await app.prisma.timeEntry.delete({ where: { id: openEntry.id } });
    });
  });
});
