/**
 * Issue #85 (Phase 85b-08, D-12) - the save responses stop leaking other salons' time through
 * ArbZG warnings. `checkArbZG` sums every entry of the person (week total, rest period, 24-week
 * average); when the writing caller's `time-entry:read` reach does not cover every entry a warning
 * rests on, the warning is returned in the neutral form of D-07 (one `FINDING_WITHHELD` item, no
 * figure, no category). The same leak class as the day check, on the write path.
 *
 * Fixture (June 2026): a Springer S homed in salon B. Per test a fresh copy of the week: B entries
 * Mon 08.06 - Thu 11.06 08:00-17:30 and Fri 12.06 12:00-21:30 (47.5 h), one A entry on Sat 13.06
 * 06:00-09:00 (all instants UTC; the tenant zone only matters for the day keys). Editing the
 * Saturday A entry to 06:00-12:30 without a break puts 54 h into the ISO week and leaves 8.5 h
 * between Friday's end and Saturday's start. MA holds SALONS [A] (Einsatzsalon manager), MB holds
 * SALONS [B] (Stammsalon manager of S); the tenant admin and S itself are the unchanged controls.
 * No person names in fixtures.
 *
 * Mutation proofs: see the Phase 85b-08 SUMMARY (cp backup/restore of warning-visibility.ts).
 *
 * Harness: no fake clock - every date is explicit and in the past; the retro window does not apply
 * to a manager correction, and the self case widens the tenant's retro window instead.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";
import { SYSTEM_ROLE_IDS } from "../contexts/platform";

const PASSWORD = "test1234";

interface Warning {
  code: string;
  severity: string;
  message: string;
  hint?: boolean;
}

describe("Issue #85 (Phase 85b-08) - ArbZG warnings of a save response, D-12", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: string;
  let salonB: string;
  let tokenMA: string;
  let tokenMB: string;

  function uniqueSuffix(label: string): string {
    return `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  async function createEmployee(label: string) {
    const s = uniqueSuffix(label);
    const passwordHash = await bcrypt.hash(PASSWORD, 4);
    const user = await app.prisma.user.create({
      data: { email: `${s}@test.de`, passwordHash, role: "EMPLOYEE", isActive: true },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: s.toUpperCase().slice(0, 20),
        firstName: label,
        lastName: "Wv85",
        hireDate: new Date("2024-01-01T00:00:00Z"),
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
    expect(res.statusCode, res.body).toBe(200);
    return (JSON.parse(res.body) as { accessToken: string }).accessToken;
  }

  async function salonManager(label: string, salonIds: string[]): Promise<string> {
    const m = await createEmployee(label);
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: data.tenant.id,
        userId: m.user.id,
        accessRoleId: SYSTEM_ROLE_IDS.SALON_MANAGER,
        scopeType: "SALONS",
        salonIds,
        employeeIds: [],
      },
    });
    return login(m.user.email);
  }

  function entry(
    employeeId: string,
    salonId: string,
    date: string,
    start: string,
    end: string | null,
  ) {
    return app.prisma.timeEntry.create({
      data: {
        employeeId,
        salonId,
        date: new Date(`${date}T00:00:00Z`),
        startTime: new Date(`${date}T${start}:00Z`),
        endTime: end === null ? null : new Date(`${date}T${end}:00Z`),
        breakMinutes: 0,
        type: "WORK",
        source: "MANUAL",
      },
    });
  }

  /** A fresh Springer homed in B with the 47.5 h week in B and a short Saturday entry in A. */
  async function springerWeek(label: string) {
    const s = await createEmployee(label);
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: data.tenant.id,
        employeeId: s.employee.id,
        salonId: salonB,
        kind: "HOME",
        validFrom: new Date("2024-01-01T00:00:00Z"),
        validUntil: null,
      },
    });
    for (const day of ["2026-06-08", "2026-06-09", "2026-06-10", "2026-06-11"]) {
      await entry(s.employee.id, salonB, day, "08:00", "17:30");
    }
    await entry(s.employee.id, salonB, "2026-06-12", "12:00", "21:30");
    const saturday = await entry(s.employee.id, salonA, "2026-06-13", "06:00", "09:00");
    return { ...s, saturday };
  }

  function putSaturday(token: string, entryId: string, extra: Record<string, unknown> = {}) {
    return app.inject({
      method: "PUT",
      url: `/api/v1/time-entries/${entryId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        startTime: "2026-06-13T06:00:00.000Z",
        endTime: "2026-06-13T12:30:00.000Z",
        breakMinutes: 0,
        reason: "Korrektur der Endzeit",
        ...extra,
      },
    });
  }

  function warningsOf(res: { body: string }): Warning[] {
    return (JSON.parse(res.body) as { warnings: Warning[] }).warnings;
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "wv85");
    salonA = data.salonId;
    salonB = (await createTestSalon(app.prisma, data.tenant.id, { name: "WV85 B" })).id;
    tokenMA = await salonManager("MgrA", [salonA]);
    tokenMB = await salonManager("MgrB", [salonB]);
    // The self case edits a June entry: widen the retro window so the own-edit guard stays out of it.
    await app.prisma.tenantConfig.update({
      where: { tenantId: data.tenant.id },
      data: { retroEntryWindowDays: 3650 },
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("write-warnings-scope-85 cleanup failed:", err);
    }
    await closeTestApp();
  });

  // ── Task 1: PUT /time-entries/:id (the tracer) ───────────────────────────────────────────

  describe("PUT /time-entries/:id", () => {
    it("MA (Einsatzsalon manager): the visible day warning is kept, the weekly and rest figures become one neutral item", async () => {
      const w = await springerWeek("PutMA");
      const res = await putSaturday(tokenMA, w.saturday.id);
      expect(res.statusCode, res.body).toBe(200);
      const warnings = warningsOf(res);

      const codes = warnings.map((x) => x.code);
      expect(codes).toContain("BREAK_TOO_SHORT");
      expect(codes).not.toContain("MAX_WEEKLY_EXCEEDED");
      expect(codes).not.toContain("MIN_REST_VIOLATED");
      expect(codes.filter((c) => c === "FINDING_WITHHELD")).toHaveLength(1);
      // The neutral item is appended after the kept ones.
      expect(codes[codes.length - 1]).toBe("FINDING_WITHHELD");

      const body = JSON.stringify(warnings);
      expect(body).not.toContain("Diese Woche");
      expect(body).not.toContain("Ruhezeit");
      expect(body).not.toContain("48 Stunden");
      expect(body).not.toMatch(/\d h\b/);
      // The neutral item itself names no number.
      const neutral = warnings.find((x) => x.code === "FINDING_WITHHELD")!;
      expect(neutral.hint).toBe(true);
      expect(neutral.message).not.toMatch(/\d/);
    });

    it("MB (Stammsalon manager of the Springer): the full warnings, no neutral item", async () => {
      const w = await springerWeek("PutMB");
      const res = await putSaturday(tokenMB, w.saturday.id);
      expect(res.statusCode, res.body).toBe(200);
      const warnings = warningsOf(res);
      const codes = warnings.map((x) => x.code);
      expect(codes).toContain("MAX_WEEKLY_EXCEEDED");
      expect(codes).toContain("MIN_REST_VIOLATED");
      expect(codes).toContain("BREAK_TOO_SHORT");
      expect(codes).not.toContain("FINDING_WITHHELD");
      expect(warnings.find((x) => x.code === "MAX_WEEKLY_EXCEEDED")!.message).toContain(
        "Diese Woche:",
      );
    });

    it("the tenant admin (whole-tenant reach): the full warnings", async () => {
      const w = await springerWeek("PutAdm");
      const res = await putSaturday(data.adminToken, w.saturday.id);
      expect(res.statusCode, res.body).toBe(200);
      const codes = warningsOf(res).map((x) => x.code);
      expect(codes).toContain("MAX_WEEKLY_EXCEEDED");
      expect(codes).toContain("MIN_REST_VIOLATED");
      expect(codes).not.toContain("FINDING_WITHHELD");
    });

    it("the person editing their own entry: the full warnings", async () => {
      const w = await springerWeek("PutSelf");
      const token = await login(w.user.email);
      const res = await putSaturday(token, w.saturday.id, { reason: undefined });
      expect(res.statusCode, res.body).toBe(200);
      const codes = warningsOf(res).map((x) => x.code);
      expect(codes).toContain("MAX_WEEKLY_EXCEEDED");
      expect(codes).toContain("MIN_REST_VIOLATED");
      expect(codes).not.toContain("FINDING_WITHHELD");
    });

    it("MA: a day that holds only in-scope entries keeps its day warning and gets no neutral item", async () => {
      // A Springer homed in A with a single week-long-free A entry: nothing outside A to withhold.
      const s = await createEmployee("PutMAOnly");
      await app.prisma.employeeSalonAssignment.create({
        data: {
          tenantId: data.tenant.id,
          employeeId: s.employee.id,
          salonId: salonA,
          kind: "HOME",
          validFrom: new Date("2024-01-01T00:00:00Z"),
          validUntil: null,
        },
      });
      const e = await entry(s.employee.id, salonA, "2026-06-13", "06:00", "09:00");
      const res = await putSaturday(tokenMA, e.id);
      expect(res.statusCode, res.body).toBe(200);
      const codes = warningsOf(res).map((x) => x.code);
      expect(codes).toContain("BREAK_TOO_SHORT");
      expect(codes).not.toContain("FINDING_WITHHELD");
    });
  });
});
