/**
 * Issue #85 (Phase 85b-08, D-12) - the save responses stop leaking other salons' time through
 * ArbZG warnings. `checkArbZG` sums every entry of the person (week total, rest period, 24-week
 * average); when the writing caller's `time-entry:read` reach does not cover every entry a warning
 * rests on, the warning is returned in the neutral form of D-07 (one `FINDING_WITHHELD` item, no
 * figure, no category). The same leak class as the day check, on the write path.
 *
 * Fixture (June 2026, clock pinned to Sat 2026-06-20T13:00Z): a Springer S homed in salon B. Per
 * test a fresh copy of the week: B entries Mon 15.06 - Thu 18.06 08:00-17:30 and Fri 19.06
 * 12:00-21:30 (47.5 h), plus - per case - an A entry on Sat 20.06 starting 06:00 (all instants UTC;
 * the tenant zone only matters for the day keys). Editing/clocking out/posting the Saturday A
 * entry past six hours without a break puts more than 48 h into the ISO week and leaves 8.5 h
 * between Friday's end and Saturday's start. MA holds SALONS [A] (Einsatzsalon manager), MB holds
 * SALONS [B] (Stammsalon manager of S); the tenant admin and S itself are the unchanged controls.
 * The retro approval needs a person MA may decide for (Stammsalon rule), so that person R is homed
 * in A up to 16.06 and in B from 17.06 on: the entries after the move are outside MA's reach.
 * No person names in fixtures.
 *
 * Mutation proof (Phase 85b-08, 2026-10-13) - recorded here, not re-run by CI; each change was
 * reverted with `cp` from a backup (cmp clean) after the red names below were observed:
 * M1 warningsVisibleToCaller keeps every warning (`covered || true`) -> red on the four MA cases:
 *    "MA (Einsatzsalon manager): the visible day warning is kept, ...", "MA records an A entry
 *    for the Springer: ...", "MA clocks the Springer out of an open A entry: ..." and "MA
 *    approves with a corrected time: ...".
 * M2 a scoped reach is treated like the whole tenant (early return) -> the same four MA cases red.
 * M3 every warning is withheld for a scoped caller (`false && covered`) -> red on "MA (Einsatzsalon
 *    manager): the visible day warning is kept, ...", "MB (Stammsalon manager of the Springer):
 *    the full warnings, no neutral item", "MA: a day that holds only in-scope entries keeps its
 *    day warning ..." and "MA approves with a corrected time: ..." (the day warning is gone).
 * Per call site (the caller replaced by the person, i.e. the site unwrapped): POST, clock-out and
 * the retro approval each turn exactly their own MA case red.
 *
 * Harness: `vi.useFakeTimers({ toFake: ["Date"] })` like the other frozen-date suites - timers stay
 * real, so the database connection is unaffected.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  createTestSalon,
  grantSystemRole,
} from "./setup";
import { SYSTEM_ROLE_IDS } from "../contexts/platform";

const PASSWORD = "test1234";
const FAKE_NOW = new Date("2026-06-20T13:00:00.000Z");

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

  // grant: false for a person whose stored assignment is the one the caller adds (no system-role grant).
  async function createEmployee(label: string, grant = true) {
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
    if (grant) {
      await grantSystemRole(app.prisma, {
        tenantId: data.tenant.id,
        userId: user.id,
        role: "EMPLOYEE",
      });
    }
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
    const m = await createEmployee(label, false);
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

  /** A fresh Springer homed in B with the 47.5 h week in B; optionally the short Saturday entry in A. */
  async function springerWeek(label: string, saturday: "closed" | "open" | "none" = "closed") {
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
    for (const day of ["2026-06-15", "2026-06-16", "2026-06-17", "2026-06-18"]) {
      await entry(s.employee.id, salonB, day, "08:00", "17:30");
    }
    await entry(s.employee.id, salonB, "2026-06-19", "12:00", "21:30");
    const saturdayEntry =
      saturday === "none"
        ? null
        : await entry(
            s.employee.id,
            salonA,
            "2026-06-20",
            "06:00",
            saturday === "closed" ? "09:00" : null,
          );
    return { ...s, saturday: saturdayEntry! };
  }

  function putSaturday(token: string, entryId: string, extra: Record<string, unknown> = {}) {
    return app.inject({
      method: "PUT",
      url: `/api/v1/time-entries/${entryId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        startTime: "2026-06-20T06:00:00.000Z",
        endTime: "2026-06-20T12:30:00.000Z",
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
    // The app boots on the real clock (its object-storage bootstrap signs requests with it).
    app = await getTestApp();
    vi.useFakeTimers({ now: FAKE_NOW, toFake: ["Date"] });
    data = await seedTestData(app, "wv85");
    salonA = data.salonId;
    salonB = (await createTestSalon(app.prisma, data.tenant.id, { name: "WV85 B" })).id;
    tokenMA = await salonManager("MgrA", [salonA]);
    tokenMB = await salonManager("MgrB", [salonB]);
  });

  afterAll(async () => {
    vi.useRealTimers();
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
      const e = await entry(s.employee.id, salonA, "2026-06-20", "06:00", "09:00");
      const res = await putSaturday(tokenMA, e.id);
      expect(res.statusCode, res.body).toBe(200);
      const codes = warningsOf(res).map((x) => x.code);
      expect(codes).toContain("BREAK_TOO_SHORT");
      expect(codes).not.toContain("FINDING_WITHHELD");
    });
  });
  // ── Task 2: POST, clock-out and the retro approval ───────────────────────────────────────

  describe("POST /time-entries", () => {
    function postSaturday(token: string, employeeId: string) {
      return app.inject({
        method: "POST",
        url: "/api/v1/time-entries",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          employeeId,
          date: "2026-06-20",
          startTime: "2026-06-20T06:00:00.000Z",
          endTime: "2026-06-20T10:00:00.000Z",
          breakMinutes: 0,
          salonId: salonA,
          reason: "Nachtrag im Einsatzsalon",
        },
      });
    }

    it("MA records an A entry for the Springer: the weekly and rest figures become one neutral item", async () => {
      const w = await springerWeek("PostMA", "none");
      const res = await postSaturday(tokenMA, w.employee.id);
      expect(res.statusCode, res.body).toBe(201);
      const warnings = warningsOf(res);
      const codes = warnings.map((x) => x.code);
      expect(codes).not.toContain("MAX_WEEKLY_EXCEEDED");
      expect(codes).not.toContain("MIN_REST_VIOLATED");
      expect(codes.filter((c) => c === "FINDING_WITHHELD")).toHaveLength(1);
      const body = JSON.stringify(warnings);
      expect(body).not.toContain("Diese Woche");
      expect(body).not.toContain("Ruhezeit");
    });

    it("the tenant admin: the full warnings", async () => {
      const w = await springerWeek("PostAdm", "none");
      const res = await postSaturday(data.adminToken, w.employee.id);
      expect(res.statusCode, res.body).toBe(201);
      const codes = warningsOf(res).map((x) => x.code);
      expect(codes).toContain("MAX_WEEKLY_EXCEEDED");
      expect(codes).toContain("MIN_REST_VIOLATED");
      expect(codes).not.toContain("FINDING_WITHHELD");
    });
  });

  describe("POST /time-entries/:id/clock-out", () => {
    function clockOut(token: string, entryId: string) {
      return app.inject({
        method: "POST",
        url: `/api/v1/time-entries/${entryId}/clock-out`,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
    }

    it("MA clocks the Springer out of an open A entry: no weekly or rest figure, one neutral item", async () => {
      const w = await springerWeek("OutMA", "open");
      const res = await clockOut(tokenMA, w.saturday.id);
      expect(res.statusCode, res.body).toBe(200);
      const warnings = warningsOf(res);
      const codes = warnings.map((x) => x.code);
      expect(codes).not.toContain("MAX_WEEKLY_EXCEEDED");
      expect(codes).not.toContain("MIN_REST_VIOLATED");
      expect(codes.filter((c) => c === "FINDING_WITHHELD")).toHaveLength(1);
      expect(JSON.stringify(warnings)).not.toContain("Diese Woche");
    });

    it("the person clocking out their own entry: the full warnings", async () => {
      const w = await springerWeek("OutSelf", "open");
      const token = await login(w.user.email);
      const res = await clockOut(token, w.saturday.id);
      expect(res.statusCode, res.body).toBe(200);
      const codes = warningsOf(res).map((x) => x.code);
      expect(codes).toContain("MAX_WEEKLY_EXCEEDED");
      expect(codes).toContain("MIN_REST_VIOLATED");
      expect(codes).not.toContain("FINDING_WITHHELD");
    });
  });

  describe("PATCH /retro-entry-requests/:id/review with a manager correction", () => {
    /**
     * R is homed in A up to 16.06 and in B from 17.06 on. The pending Monday entry (A) and Tuesday
     * (A) are in MA's reach; Wednesday to Friday (B, homed in B) are not. MA may decide for R
     * (Stammsalon at the request date is A), but the week's total rests on entries MA cannot see.
     */
    async function retroWeek(label: string) {
      const r = await createEmployee(label);
      const home = (salonId: string, from: string, until: string | null) =>
        app.prisma.employeeSalonAssignment.create({
          data: {
            tenantId: data.tenant.id,
            employeeId: r.employee.id,
            salonId,
            kind: "HOME",
            validFrom: new Date(`${from}T00:00:00Z`),
            validUntil: until === null ? null : new Date(`${until}T00:00:00Z`),
          },
        });
      await home(salonA, "2024-01-01", "2026-06-16");
      await home(salonB, "2026-06-17", null);
      await entry(r.employee.id, salonA, "2026-06-16", "06:00", "17:00");
      for (const day of ["2026-06-17", "2026-06-18", "2026-06-19"]) {
        await entry(r.employee.id, salonB, day, "06:00", "17:00");
      }
      const request = await app.prisma.retroEntryRequest.create({
        data: {
          employeeId: r.employee.id,
          targetDate: new Date("2026-06-15T00:00:00Z"),
          reason: "Fixture fuer die Sichtbarkeit der Warnungen",
          startTime: "08:00",
          endTime: "16:00",
          breakMinutes: 30,
          status: "PENDING",
        },
      });
      await app.prisma.timeEntry.create({
        data: {
          employeeId: r.employee.id,
          salonId: salonA,
          date: new Date("2026-06-15T00:00:00Z"),
          startTime: new Date("2026-06-15T08:00:00Z"),
          endTime: new Date("2026-06-15T16:00:00Z"),
          breakMinutes: 30,
          type: "WORK",
          source: "MANUAL",
          createdBy: r.employee.id,
          isInvalid: true,
          invalidReason: "Zeitnachtrag wartet auf Genehmigung",
          retroRequestId: request.id,
        },
      });
      return request;
    }

    function approve(token: string, requestId: string) {
      return app.inject({
        method: "PATCH",
        url: `/api/v1/retro-entry-requests/${requestId}/review`,
        headers: { authorization: `Bearer ${token}` },
        payload: { status: "APPROVED", startTime: "06:00", endTime: "17:00", breakMinutes: 0 },
      });
    }

    it("MA approves with a corrected time: the day warning stays, the weekly total becomes one neutral item", async () => {
      const request = await retroWeek("RetroMA");
      const res = await approve(tokenMA, request.id);
      expect(res.statusCode, res.body).toBe(200);
      const warnings = warningsOf(res);
      const codes = warnings.map((x) => x.code);
      expect(codes).toContain("MAX_DAILY_EXCEEDED");
      expect(codes).not.toContain("MAX_WEEKLY_EXCEEDED");
      expect(codes.filter((c) => c === "FINDING_WITHHELD")).toHaveLength(1);
      expect(JSON.stringify(warnings)).not.toContain("Diese Woche");
    });

    it("the tenant admin approves the same week: the full warnings", async () => {
      const request = await retroWeek("RetroAdm");
      const res = await approve(data.adminToken, request.id);
      expect(res.statusCode, res.body).toBe(200);
      const codes = warningsOf(res).map((x) => x.code);
      expect(codes).toContain("MAX_WEEKLY_EXCEEDED");
      expect(codes).not.toContain("FINDING_WITHHELD");
    });
  });
});
