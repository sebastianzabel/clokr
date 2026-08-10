/**
 * Phase 96 Plan 02 — [TRACER] entry-first Zeitnachtrag flow.
 *
 * RED-first per the plan's Task 0/1/2 ordering. Locks the contract for:
 *   - RETRO-10: an out-of-window POST /time-entries on an EMPTY day + a Nachtrag
 *     reason creates, in ONE transaction, a pending TimeEntry (isInvalid=true)
 *     coupled to a new PENDING RetroEntryRequest, and returns 201 — including the
 *     JArbSchG minor-protection hard-block and the ArbZG early-warning-in-201
 *     safety guards (the branch must fall THROUGH the shared create path, not
 *     around it).
 *   - RETRO-14: a second out-of-window POST for the same pending day is rejected
 *     with 409 (no second row).
 *   - RETRO-11: approving the coupled request releases the entry (isInvalid=false)
 *     with full audit, and is blocked with 403 when the entry's month is locked.
 *
 * RETRO-11 cases seed the coupled TimeEntry + RetroEntryRequest DIRECTLY via
 * Prisma (bypassing POST /time-entries) so they exercise ONLY the PATCH
 * /:id/review release logic (Task 2) — independent of the create branch (Task 1).
 * This gives each RED case a precise, independent failure reason.
 *
 * A RED failure (wrong status code / unchanged isInvalid / missing audit row) is
 * the SUCCESS criteria here, until Task 1 + Task 2 land. Do NOT skip, stub, or
 * .only these tests.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import bcrypt from "bcryptjs";
import { getTestApp, closeTestApp, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";
import { dateStrInTz } from "../utils/timezone";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TZ = "Europe/Berlin";

// Frozen "now" so all date arithmetic is deterministic (mirrors retro-approval-flow.test.ts).
const FROZEN_NOW = new Date("2024-04-14T22:00:00.000Z"); // Berlin: 2024-04-15 00:00

// TenantConfig.retroEntryWindowDays default (retro-config.ts DEFAULT_WINDOW_DAYS).
const WINDOW_DAYS = 10;

function daysAgoInTz(now: Date, n: number): string {
  return dateStrInTz(new Date(now.getTime() - n * 24 * 60 * 60 * 1000), TZ);
}

/** Birthdate that makes an employee exactly `age` years old ON `dateStr` (UTC Y-M-D,
 * birthday-exactly-on-date = full age, mirrors jarbschg.ts's ageAtDate semantics). */
function birthDateForAge(dateStr: string, age: number): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y - age, m - 1, d));
}

// ── Seed helpers (mirrors retro-approval-flow.test.ts's seedApprovalTenant) ────

async function mkUser(
  app: FastifyInstance,
  tenantId: string,
  s: string,
  role: "ADMIN" | "MANAGER" | "EMPLOYEE",
  idx: string,
  opts: { classification?: "VOLLZEIT" | "AZUBI" } = {},
) {
  const prisma = app.prisma;
  const email = `${role.toLowerCase()}-${idx}-${s}@refirst.test`;
  const user = await prisma.user.create({
    data: { email, passwordHash: await bcrypt.hash("pwTest123", 4), role, isActive: true },
  });
  const emp = await prisma.employee.create({
    data: {
      tenantId,
      userId: user.id,
      employeeNumber: `${role[0]}-${idx}-${s}`,
      firstName: role,
      lastName: "EntryFirst",
      hireDate: new Date("2020-01-01"),
      classification: opts.classification ?? "VOLLZEIT",
    },
  });
  await prisma.workSchedule.create({
    data: {
      employeeId: emp.id,
      weeklyHours: 40,
      mondayHours: 8,
      tuesdayHours: 8,
      wednesdayHours: 8,
      thursdayHours: 8,
      fridayHours: 8,
      saturdayHours: 0,
      sundayHours: 0,
      validFrom: new Date("2020-01-01"),
    },
  });
  await prisma.overtimeAccount.create({ data: { employeeId: emp.id, balanceHours: 0 } });

  const loginRes = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email, password: "pwTest123" },
  });
  const { accessToken } = JSON.parse(loginRes.body);
  return { user, emp, token: accessToken as string };
}

async function seedEntryFirstTenant(app: FastifyInstance, suffix: string) {
  const s = `refirst-${suffix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
  const prisma = app.prisma;

  const tenant = await prisma.tenant.create({
    data: { name: `EntryFirst ${s}`, slug: `refirst-${s}`, federalState: "NIEDERSACHSEN" },
  });
  await prisma.tenantConfig.create({
    data: { tenantId: tenant.id, defaultVacationDays: 30, timezone: TZ },
  });

  const admin = await mkUser(app, tenant.id, s, "ADMIN", "a");
  const manager1 = await mkUser(app, tenant.id, s, "MANAGER", "m1");
  const manager2 = await mkUser(app, tenant.id, s, "MANAGER", "m2"); // different manager for approvals
  const employee = await mkUser(app, tenant.id, s, "EMPLOYEE", "e");
  const azubi = await mkUser(app, tenant.id, s, "EMPLOYEE", "az", { classification: "AZUBI" });

  return { tenantId: tenant.id, admin, manager1, manager2, employee, azubi };
}

/** Directly seed a coupled pending TimeEntry + RetroEntryRequest pair (bypasses
 * POST /time-entries entirely) so RETRO-11 cases exercise ONLY the PATCH
 * /:id/review release logic (Task 2), decoupled from the create branch (Task 1). */
async function seedCoupledPending(
  app: FastifyInstance,
  employeeId: string,
  targetDate: string,
  opts: { isLocked?: boolean } = {},
) {
  const prisma = app.prisma;
  const request = await prisma.retroEntryRequest.create({
    data: {
      employeeId,
      targetDate: new Date(targetDate),
      reason: "RETRO-11 fixture: coupled pending entry",
      startTime: "08:00",
      endTime: "16:00",
      breakMinutes: 30,
      status: "PENDING",
    },
  });
  const entry = await prisma.timeEntry.create({
    data: {
      employeeId,
      date: new Date(targetDate),
      startTime: new Date(`${targetDate}T08:00:00.000Z`),
      endTime: new Date(`${targetDate}T16:00:00.000Z`),
      breakMinutes: 30,
      source: "MANUAL",
      createdBy: employeeId,
      isInvalid: true,
      invalidReason: "Nachtrag – Genehmigung ausstehend",
      retroRequestId: request.id,
      isLocked: opts.isLocked ?? false,
    },
  });
  return { request, entry };
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe("Entry-first Zeitnachtrag tracer (96-02): RETRO-10/11/14", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let empToken: string;
  let employeeId: string;
  let manager2Token: string;
  let azubiId: string;
  let azubiToken: string;

  beforeAll(async () => {
    app = await getTestApp();
    const seed = await seedEntryFirstTenant(app, "main");
    tenantId = seed.tenantId;
    empToken = seed.employee.token;
    employeeId = seed.employee.emp.id;
    manager2Token = seed.manager2.token;
    azubiId = seed.azubi.emp.id;
    azubiToken = seed.azubi.token;
  });

  afterAll(async () => {
    try {
      // Local cleanup first: TimeEntry (frees the retroRequestId FK), then
      // RetroEntryRequest — BEFORE the shared cleanupTestData() deletes employees.
      // RetroEntryRequest.employee is onDelete:Restrict, and cleanupTestData()
      // does not delete RetroEntryRequest rows itself (pre-existing gap shared
      // with retro-approval-flow.test.ts) — scoped here so this file's tenant
      // doesn't leave residue.
      await app.prisma.timeEntry.deleteMany({ where: { employee: { tenantId } } });
      await app.prisma.retroEntryRequest.deleteMany({ where: { employee: { tenantId } } });
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("retro-entry-first cleanup:", err);
    }
    await closeTestApp();
    vi.useRealTimers();
  });

  // ── RETRO-10 create ───────────────────────────────────────────────────────────

  describe("RETRO-10 create: entry-first atomic pending TimeEntry + RetroEntryRequest", () => {
    it("out-of-window POST on empty day + reason -> 201 pending coupled entry+request", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(FROZEN_NOW);
      try {
        const targetDate = daysAgoInTz(new Date(), WINDOW_DAYS + 3);
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/time-entries",
          headers: { authorization: `Bearer ${empToken}` },
          payload: {
            employeeId,
            date: targetDate,
            startTime: `${targetDate}T08:00:00.000Z`,
            endTime: `${targetDate}T16:00:00.000Z`,
            breakMinutes: 30,
            reason: "vergessen einzutragen",
          },
        });
        expect(res.statusCode, "entry-first create must return 201").toBe(201);
        const body = JSON.parse(res.body);
        expect(body.entry?.isInvalid, "pending entry must be isInvalid=true").toBe(true);
        expect(body.entry?.invalidReason, "exact D-01/D-06 reason string").toBe(
          "Nachtrag – Genehmigung ausstehend",
        );
        expect(body.entry?.source, "entry-first create is source MANUAL").toBe("MANUAL");
        expect(body.entry?.retroRequestId, "coupling FK must be set").toBeTruthy();

        const request = await app.prisma.retroEntryRequest.findFirst({
          where: { employeeId, targetDate: new Date(targetDate), deletedAt: null },
        });
        expect(request, "coupled RetroEntryRequest must exist").not.toBeNull();
        expect(request?.status).toBe("PENDING");
        expect(request?.targetDate.toISOString().split("T")[0]).toBe(targetDate);
        expect(request?.reason).toBe("vergessen einzutragen");
        expect(request?.id, "request.id must equal entry.retroRequestId (1:1 coupling)").toBe(
          body.entry.retroRequestId,
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("body.breaks persisted: entry-first create honors break slots from the shared path", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(FROZEN_NOW);
      try {
        const targetDate = daysAgoInTz(new Date(), WINDOW_DAYS + 4);
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/time-entries",
          headers: { authorization: `Bearer ${empToken}` },
          payload: {
            employeeId,
            date: targetDate,
            startTime: `${targetDate}T08:00:00.000Z`,
            endTime: `${targetDate}T17:00:00.000Z`,
            breakMinutes: 0,
            breaks: [
              { startTime: `${targetDate}T12:00:00.000Z`, endTime: `${targetDate}T12:30:00.000Z` },
            ],
            reason: "Pause vergessen mit einzutragen",
          },
        });
        expect(res.statusCode, "entry-first create with breaks must return 201").toBe(201);
        const body = JSON.parse(res.body);
        expect(body.entry?.breakMinutes, "breakMinutes computed from slots (D-05)").toBe(30);
        expect(body.entry?.breaks, "response carries the persisted break").toHaveLength(1);

        const breaks = await app.prisma.break.findMany({ where: { timeEntryId: body.entry.id } });
        expect(breaks, "Break rows persisted for the pending entry").toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("JArbSchG minor hard-block: AZUBI<18 over-limit Nachtrag stays 400-blocked, nothing created", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(FROZEN_NOW);
      try {
        const targetDate = daysAgoInTz(new Date(), WINDOW_DAYS + 5);
        await app.prisma.employee.update({
          where: { id: azubiId },
          data: { birthDate: birthDateForAge(targetDate, 16) },
        });
        await app.prisma.absence.create({
          data: {
            employeeId: azubiId,
            type: "VOCATIONAL_SCHOOL",
            source: "MANUAL",
            startDate: new Date(targetDate),
            endDate: new Date(targetDate),
            days: 1.0,
            createdBy: "retro-entry-first-test",
          },
        });

        const res = await app.inject({
          method: "POST",
          url: "/api/v1/time-entries",
          headers: { authorization: `Bearer ${azubiToken}` },
          payload: {
            employeeId: azubiId,
            date: targetDate,
            startTime: `${targetDate}T08:00:00.000Z`,
            endTime: `${targetDate}T14:00:00.000Z`, // 6h net > 225 min JArbSchG cap
            breakMinutes: 0,
            reason: "Nachtrag trotz Berufsschule",
          },
        });
        expect(res.statusCode, "AZUBI<18 over-limit entry-first Nachtrag must stay 400").toBe(400);
        const body = JSON.parse(res.body);
        expect(body.error).toBe("JARBSCHG_MINOR_LIMIT");

        const entry = await app.prisma.timeEntry.findFirst({
          where: { employeeId: azubiId, date: new Date(targetDate), deletedAt: null },
        });
        expect(entry, "no TimeEntry created on hard-block").toBeNull();
        const request = await app.prisma.retroEntryRequest.findFirst({
          where: { employeeId: azubiId, targetDate: new Date(targetDate), deletedAt: null },
        });
        expect(request, "no RetroEntryRequest created on hard-block").toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("ArbZG early-warning in 201 (D-03): >10h entry-first Nachtrag returns checkArbZG warnings", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(FROZEN_NOW);
      try {
        const targetDate = daysAgoInTz(new Date(), WINDOW_DAYS + 6);
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/time-entries",
          headers: { authorization: `Bearer ${empToken}` },
          payload: {
            employeeId,
            date: targetDate,
            startTime: `${targetDate}T07:00:00.000Z`,
            endTime: `${targetDate}T19:00:00.000Z`, // 12h net > 10h ArbZG §3 daily max
            breakMinutes: 0,
            reason: "Langer Nachtrag-Tag",
          },
        });
        expect(
          res.statusCode,
          "over-limit entry-first Nachtrag still creates (warn, not block)",
        ).toBe(201);
        const body = JSON.parse(res.body);
        expect(Array.isArray(body.warnings), "warnings must travel back in the 201").toBe(true);
        expect(
          body.warnings.some((w: { code: string }) => w.code === "MAX_DAILY_EXCEEDED"),
          "D-03: §3 daily-max warning must be present at submission (early warning)",
        ).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("regression: out-of-window POST WITHOUT reason still returns byte-identical 403", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(FROZEN_NOW);
      try {
        const targetDate = daysAgoInTz(new Date(), WINDOW_DAYS + 7);
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/time-entries",
          headers: { authorization: `Bearer ${empToken}` },
          payload: {
            employeeId,
            date: targetDate,
            startTime: `${targetDate}T08:00:00.000Z`,
            endTime: `${targetDate}T16:00:00.000Z`,
            breakMinutes: 30,
          },
        });
        expect(res.statusCode).toBe(403);
        const body = JSON.parse(res.body);
        expect(body.error).toBe("RETRO_WINDOW_EXCEEDED");
        expect(typeof body.windowDays).toBe("number");
        expect(typeof body.entryAgeInDays).toBe("number");

        const entry = await app.prisma.timeEntry.findFirst({
          where: { employeeId, date: new Date(targetDate), deletedAt: null },
        });
        expect(entry, "no TimeEntry created without a reason").toBeNull();
        const request = await app.prisma.retroEntryRequest.findFirst({
          where: { employeeId, targetDate: new Date(targetDate), deletedAt: null },
        });
        expect(request, "no RetroEntryRequest created without a reason").toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ── RETRO-14 duplicate ──────────────────────────────────────────────────────

  describe("RETRO-14 duplicate: second out-of-window POST for a pending day", () => {
    it("second create for the same day -> 409, exactly one row survives", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(FROZEN_NOW);
      try {
        const targetDate = daysAgoInTz(new Date(), WINDOW_DAYS + 8);
        const payload = {
          employeeId,
          date: targetDate,
          startTime: `${targetDate}T08:00:00.000Z`,
          endTime: `${targetDate}T16:00:00.000Z`,
          breakMinutes: 30,
          reason: "Erster Versuch",
        };
        const firstRes = await app.inject({
          method: "POST",
          url: "/api/v1/time-entries",
          headers: { authorization: `Bearer ${empToken}` },
          payload,
        });
        expect(firstRes.statusCode, "first entry-first create must succeed").toBe(201);

        const secondRes = await app.inject({
          method: "POST",
          url: "/api/v1/time-entries",
          headers: { authorization: `Bearer ${empToken}` },
          payload: { ...payload, reason: "Zweiter Versuch" },
        });
        expect(secondRes.statusCode, "duplicate day must be rejected with 409").toBe(409);
        const body = JSON.parse(secondRes.body);
        expect(body.error).toContain("Es existiert bereits ein Eintrag für diesen Tag.");

        const rows = await app.prisma.timeEntry.findMany({
          where: { employeeId, date: new Date(targetDate), deletedAt: null },
        });
        expect(rows, "exactly one row must exist for the day").toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ── RETRO-11 approve-release ─────────────────────────────────────────────────

  describe("RETRO-11 approve-release: coupled entry release via PATCH /:id/review", () => {
    it("DIFFERENT manager approves -> coupled entry isInvalid=false, both mutations audited", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(FROZEN_NOW);
      try {
        const targetDate = daysAgoInTz(new Date(), WINDOW_DAYS + 9);
        const { request, entry } = await seedCoupledPending(app, employeeId, targetDate);

        const res = await app.inject({
          method: "PATCH",
          url: `/api/v1/retro-entry-requests/${request.id}/review`,
          headers: { authorization: `Bearer ${manager2Token}` },
          payload: { status: "APPROVED", reviewNote: "Freigegeben" },
        });
        expect(res.statusCode, "approve-release must return 200").toBe(200);
        const body = JSON.parse(res.body);
        expect(["APPROVED", "USED"]).toContain(body.status);

        const releasedEntry = await app.prisma.timeEntry.findUnique({ where: { id: entry.id } });
        expect(releasedEntry?.isInvalid, "coupled entry must be released").toBe(false);
        expect(releasedEntry?.invalidReason).toBeNull();

        const entryAudit = await app.prisma.auditLog.findFirst({
          where: { entity: "TimeEntry", entityId: entry.id, action: "UPDATE" },
          orderBy: { createdAt: "desc" },
        });
        expect(entryAudit, "TimeEntry UPDATE audit row must exist").not.toBeNull();

        const requestAudit = await app.prisma.auditLog.findFirst({
          where: {
            entity: "RetroEntryRequest",
            entityId: request.id,
            action: "RETRO_ENTRY_APPROVED",
          },
          orderBy: { createdAt: "desc" },
        });
        expect(
          requestAudit,
          "RetroEntryRequest RETRO_ENTRY_APPROVED audit row must exist",
        ).not.toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("locked month -> 403, nothing mutated", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(FROZEN_NOW);
      try {
        const targetDate = daysAgoInTz(new Date(), WINDOW_DAYS + 10);
        const { request, entry } = await seedCoupledPending(app, employeeId, targetDate, {
          isLocked: true,
        });

        const res = await app.inject({
          method: "PATCH",
          url: `/api/v1/retro-entry-requests/${request.id}/review`,
          headers: { authorization: `Bearer ${manager2Token}` },
          payload: { status: "APPROVED", reviewNote: "Freigegeben" },
        });
        expect(res.statusCode, "release into a locked month must be rejected").toBe(403);

        const unchangedEntry = await app.prisma.timeEntry.findUnique({ where: { id: entry.id } });
        expect(unchangedEntry?.isInvalid, "entry stays pending, unmutated").toBe(true);
        expect(unchangedEntry?.invalidReason).toBe("Nachtrag – Genehmigung ausstehend");

        const unchangedRequest = await app.prisma.retroEntryRequest.findUnique({
          where: { id: request.id },
        });
        expect(unchangedRequest?.status, "request stays PENDING, unmutated").toBe("PENDING");
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
