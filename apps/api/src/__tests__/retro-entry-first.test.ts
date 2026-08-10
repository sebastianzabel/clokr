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
  // Phase 96-05 (RETRO-16 withdraw) — a second, wholly separate tenant so the
  // cross-tenant withdraw case exercises a genuine tenant mismatch.
  let crossTenantId: string;
  let crossEmployeeId: string;

  beforeAll(async () => {
    app = await getTestApp();
    const seed = await seedEntryFirstTenant(app, "main");
    tenantId = seed.tenantId;
    empToken = seed.employee.token;
    employeeId = seed.employee.emp.id;
    manager2Token = seed.manager2.token;
    azubiId = seed.azubi.emp.id;
    azubiToken = seed.azubi.token;

    const crossSeed = await seedEntryFirstTenant(app, "cross");
    crossTenantId = crossSeed.tenantId;
    crossEmployeeId = crossSeed.employee.emp.id;
  });

  afterAll(async () => {
    try {
      // Local cleanup first: TimeEntry (frees the retroRequestId FK), then
      // RetroEntryRequest — BEFORE the shared cleanupTestData() deletes employees.
      // RetroEntryRequest.employee is onDelete:Restrict, and cleanupTestData()
      // does not delete RetroEntryRequest rows itself (pre-existing gap shared
      // with retro-approval-flow.test.ts) — scoped here so this file's tenant
      // doesn't leave residue.
      await app.prisma.timeEntry.deleteMany({
        where: { employee: { tenantId: { in: [tenantId, crossTenantId] } } },
      });
      await app.prisma.retroEntryRequest.deleteMany({
        where: { employee: { tenantId: { in: [tenantId, crossTenantId] } } },
      });
      await cleanupTestData(app, tenantId);
      await cleanupTestData(app, crossTenantId);
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

  // ── RETRO-12 reject-soft-delete ─────────────────────────────────────────────

  describe("RETRO-12 reject: coupled entry soft-deleted via PATCH /:id/review", () => {
    it("DIFFERENT manager rejects -> coupled entry deletedAt set (not hard-deleted), request REJECTED, both audited, day free for a fresh submission", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(FROZEN_NOW);
      try {
        const targetDate = daysAgoInTz(new Date(), WINDOW_DAYS + 11);
        const { request, entry } = await seedCoupledPending(app, employeeId, targetDate);

        const res = await app.inject({
          method: "PATCH",
          url: `/api/v1/retro-entry-requests/${request.id}/review`,
          headers: { authorization: `Bearer ${manager2Token}` },
          payload: { status: "REJECTED", reviewNote: "Nicht plausibel" },
        });
        expect(res.statusCode, "reject-soft-delete must return 200").toBe(200);
        const body = JSON.parse(res.body);
        expect(body.status).toBe("REJECTED");

        const rejectedEntry = await app.prisma.timeEntry.findUnique({ where: { id: entry.id } });
        expect(
          rejectedEntry,
          "row must be preserved (soft-delete, never prisma.delete())",
        ).not.toBeNull();
        expect(rejectedEntry?.deletedAt, "coupled entry must be soft-deleted").not.toBeNull();

        const requestAfter = await app.prisma.retroEntryRequest.findUnique({
          where: { id: request.id },
        });
        expect(requestAfter?.status, "request must be REJECTED").toBe("REJECTED");

        const entryAudit = await app.prisma.auditLog.findFirst({
          where: { entity: "TimeEntry", entityId: entry.id, action: "DELETE" },
          orderBy: { createdAt: "desc" },
        });
        expect(entryAudit, "TimeEntry DELETE (soft-delete) audit row must exist").not.toBeNull();

        const requestAudit = await app.prisma.auditLog.findFirst({
          where: {
            entity: "RetroEntryRequest",
            entityId: request.id,
            action: "RETRO_ENTRY_REJECTED",
          },
          orderBy: { createdAt: "desc" },
        });
        expect(
          requestAudit,
          "RetroEntryRequest RETRO_ENTRY_REJECTED audit row must exist",
        ).not.toBeNull();

        // deletedAt frees the (employeeId, date) partial unique slot — checkOneEntryPerDay
        // and the DB index both filter deletedAt:null only — so the day must be open for
        // a corrected resubmission via the same entry-first out-of-window path.
        const retryRes = await app.inject({
          method: "POST",
          url: "/api/v1/time-entries",
          headers: { authorization: `Bearer ${empToken}` },
          payload: {
            employeeId,
            date: targetDate,
            startTime: `${targetDate}T09:00:00.000Z`,
            endTime: `${targetDate}T17:00:00.000Z`,
            breakMinutes: 30,
            reason: "Korrigierter Nachtrag nach Ablehnung",
          },
        });
        expect(
          retryRes.statusCode,
          "day must be free for a fresh out-of-window submission after rejection",
        ).toBe(201);
      } finally {
        vi.useRealTimers();
      }
    });

    it("without reviewNote -> 400, nothing mutated (existing Zod refine, unchanged for the coupled path too)", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(FROZEN_NOW);
      try {
        const targetDate = daysAgoInTz(new Date(), WINDOW_DAYS + 12);
        const { request, entry } = await seedCoupledPending(app, employeeId, targetDate);

        const res = await app.inject({
          method: "PATCH",
          url: `/api/v1/retro-entry-requests/${request.id}/review`,
          headers: { authorization: `Bearer ${manager2Token}` },
          payload: { status: "REJECTED" }, // reviewNote omitted
        });
        expect(res.statusCode, "reject without note must stay 400").toBe(400);

        const unchangedEntry = await app.prisma.timeEntry.findUnique({ where: { id: entry.id } });
        expect(unchangedEntry?.deletedAt, "entry must stay untouched").toBeNull();
        const unchangedRequest = await app.prisma.retroEntryRequest.findUnique({
          where: { id: request.id },
        });
        expect(unchangedRequest?.status, "request must stay PENDING").toBe("PENDING");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ── RETRO-18 reject-into-locked-month ───────────────────────────────────────

  describe("RETRO-18 reject-into-locked-month: coupled entry inside a locked month", () => {
    it("reject attempt on a locked coupled entry -> 403, nothing mutated", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(FROZEN_NOW);
      try {
        const targetDate = daysAgoInTz(new Date(), WINDOW_DAYS + 13);
        const { request, entry } = await seedCoupledPending(app, employeeId, targetDate, {
          isLocked: true,
        });

        const res = await app.inject({
          method: "PATCH",
          url: `/api/v1/retro-entry-requests/${request.id}/review`,
          headers: { authorization: `Bearer ${manager2Token}` },
          payload: { status: "REJECTED", reviewNote: "Abgelehnt" },
        });
        expect(res.statusCode, "reject into a locked month must be rejected").toBe(403);

        const unchangedEntry = await app.prisma.timeEntry.findUnique({ where: { id: entry.id } });
        expect(unchangedEntry?.deletedAt, "entry must stay non-deleted").toBeNull();
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

  // ── RETRO-16 edit: PUT own still-pending coupled entry stays pending (D-10) ──

  describe("RETRO-16 edit: employee PUTs own still-pending coupled entry", () => {
    it("own pending edit -> 200, isInvalid stays true, retroRequestId unchanged, no RETRO_WINDOW_EXCEEDED, re-notifies managers", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(FROZEN_NOW);
      try {
        const targetDate = daysAgoInTz(new Date(), WINDOW_DAYS + 14);
        const { request, entry } = await seedCoupledPending(app, employeeId, targetDate);

        const res = await app.inject({
          method: "PUT",
          url: `/api/v1/time-entries/${entry.id}`,
          headers: { authorization: `Bearer ${empToken}` },
          payload: {
            startTime: `${targetDate}T09:00:00.000Z`,
            endTime: `${targetDate}T17:00:00.000Z`,
            breakMinutes: 45,
          },
        });
        expect(res.statusCode, "own pending edit must succeed, not RETRO_WINDOW_EXCEEDED").toBe(
          200,
        );
        const body = JSON.parse(res.body);
        expect(body.entry?.isInvalid, "must stay pending").toBe(true);
        expect(body.entry?.retroRequestId, "coupling FK unchanged").toBe(request.id);
        expect(body.entry?.breakMinutes, "edited fields are applied").toBe(45);

        const reloaded = await app.prisma.timeEntry.findUnique({ where: { id: entry.id } });
        expect(reloaded?.isInvalid).toBe(true);
        expect(reloaded?.invalidReason).toBe("Nachtrag – Genehmigung ausstehend");
        expect(reloaded?.retroRequestId).toBe(request.id);

        const requestStillPending = await app.prisma.retroEntryRequest.findUnique({
          where: { id: request.id },
        });
        expect(requestStillPending?.status, "coupled request untouched by employee edit").toBe(
          "PENDING",
        );

        // Re-notify: the edit must fire a fresh in-app notification (net-new call site).
        const notif = await app.prisma.notification.findFirst({
          where: {
            relatedType: "RetroEntryRequest",
            relatedId: request.id,
            type: "RETRO_ENTRY_UPDATED",
          },
          orderBy: { createdAt: "desc" },
        });
        expect(notif, "edit must re-notify the approver(s)").not.toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("locked pending coupled entry PUT still 403 (immutability preserved)", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(FROZEN_NOW);
      try {
        const targetDate = daysAgoInTz(new Date(), WINDOW_DAYS + 15);
        const { entry } = await seedCoupledPending(app, employeeId, targetDate, {
          isLocked: true,
        });

        const res = await app.inject({
          method: "PUT",
          url: `/api/v1/time-entries/${entry.id}`,
          headers: { authorization: `Bearer ${empToken}` },
          payload: { breakMinutes: 45 },
        });
        expect(res.statusCode, "locked pending entry PUT must stay 403").toBe(403);

        const unchanged = await app.prisma.timeEntry.findUnique({ where: { id: entry.id } });
        expect(unchanged?.breakMinutes, "nothing mutated on a locked entry").toBe(30);
      } finally {
        vi.useRealTimers();
      }
    });

    it("regression: editing a normal (non-pending, uncoupled) out-of-window entry still 403 RETRO_WINDOW_EXCEEDED", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(FROZEN_NOW);
      try {
        const targetDate = daysAgoInTz(new Date(), WINDOW_DAYS + 16);
        const plain = await app.prisma.timeEntry.create({
          data: {
            employeeId,
            date: new Date(targetDate),
            startTime: new Date(`${targetDate}T08:00:00.000Z`),
            endTime: new Date(`${targetDate}T16:00:00.000Z`),
            breakMinutes: 30,
            source: "MANUAL",
            createdBy: employeeId,
          },
        });

        const res = await app.inject({
          method: "PUT",
          url: `/api/v1/time-entries/${plain.id}`,
          headers: { authorization: `Bearer ${empToken}` },
          payload: { breakMinutes: 45 },
        });
        expect(res.statusCode, "normal out-of-window self-edit must stay blocked").toBe(403);
        const body = JSON.parse(res.body);
        expect(body.error).toBe("RETRO_WINDOW_EXCEEDED");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ── RETRO-16 withdraw: DELETE /retro-entry-requests/:id (D-11) ───────────────

  describe("RETRO-16 withdraw: DELETE /retro-entry-requests/:id", () => {
    it("owner withdraws own PENDING request -> 200, both rows soft-deleted, both audited, day free for a fresh submission", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(FROZEN_NOW);
      try {
        const targetDate = daysAgoInTz(new Date(), WINDOW_DAYS + 17);
        const { request, entry } = await seedCoupledPending(app, employeeId, targetDate);

        const res = await app.inject({
          method: "DELETE",
          url: `/api/v1/retro-entry-requests/${request.id}`,
          headers: { authorization: `Bearer ${empToken}` },
        });
        expect(res.statusCode, "owner withdraw of own PENDING must succeed").toBe(200);

        const reqAfter = await app.prisma.retroEntryRequest.findUnique({
          where: { id: request.id },
        });
        expect(reqAfter?.deletedAt, "request must be soft-deleted").not.toBeNull();
        expect(
          reqAfter?.status,
          "no new enum value — status left as PENDING, deletedAt is the signal",
        ).toBe("PENDING");

        const entryAfter = await app.prisma.timeEntry.findUnique({ where: { id: entry.id } });
        expect(
          entryAfter,
          "row must be preserved (soft-delete, never prisma.delete())",
        ).not.toBeNull();
        expect(entryAfter?.deletedAt, "coupled entry must be soft-deleted").not.toBeNull();

        const reqAudit = await app.prisma.auditLog.findFirst({
          where: {
            entity: "RetroEntryRequest",
            entityId: request.id,
            action: "RETRO_ENTRY_WITHDRAWN",
          },
          orderBy: { createdAt: "desc" },
        });
        expect(reqAudit, "RETRO_ENTRY_WITHDRAWN audit must exist").not.toBeNull();

        const entryAudit = await app.prisma.auditLog.findFirst({
          where: { entity: "TimeEntry", entityId: entry.id, action: "DELETE" },
          orderBy: { createdAt: "desc" },
        });
        expect(entryAudit, "TimeEntry DELETE (soft-delete) audit must exist").not.toBeNull();

        // deletedAt frees the (employeeId, date) partial unique slot — a fresh
        // out-of-window submission for the same day must succeed afterward.
        const retryRes = await app.inject({
          method: "POST",
          url: "/api/v1/time-entries",
          headers: { authorization: `Bearer ${empToken}` },
          payload: {
            employeeId,
            date: targetDate,
            startTime: `${targetDate}T09:00:00.000Z`,
            endTime: `${targetDate}T17:00:00.000Z`,
            breakMinutes: 30,
            reason: "Erneuter Versuch nach Rückzug",
          },
        });
        expect(retryRes.statusCode, "day must be free for a fresh submission after withdraw").toBe(
          201,
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("non-owner withdraw -> 403, no mutation", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(FROZEN_NOW);
      try {
        const targetDate = daysAgoInTz(new Date(), WINDOW_DAYS + 18);
        const { request, entry } = await seedCoupledPending(app, employeeId, targetDate);

        const res = await app.inject({
          method: "DELETE",
          url: `/api/v1/retro-entry-requests/${request.id}`,
          headers: { authorization: `Bearer ${azubiToken}` }, // different employee, same tenant
        });
        expect(res.statusCode, "non-owner withdraw must be rejected").toBe(403);

        const unchangedReq = await app.prisma.retroEntryRequest.findUnique({
          where: { id: request.id },
        });
        expect(unchangedReq?.deletedAt).toBeNull();
        const unchangedEntry = await app.prisma.timeEntry.findUnique({ where: { id: entry.id } });
        expect(unchangedEntry?.deletedAt).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("non-PENDING request (already APPROVED) -> 409, no mutation", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(FROZEN_NOW);
      try {
        const targetDate = daysAgoInTz(new Date(), WINDOW_DAYS + 19);
        const { request, entry } = await seedCoupledPending(app, employeeId, targetDate);
        await app.prisma.retroEntryRequest.update({
          where: { id: request.id },
          data: { status: "APPROVED" },
        });

        const res = await app.inject({
          method: "DELETE",
          url: `/api/v1/retro-entry-requests/${request.id}`,
          headers: { authorization: `Bearer ${empToken}` },
        });
        expect(res.statusCode, "non-PENDING withdraw must be rejected").toBe(409);

        const unchangedEntry = await app.prisma.timeEntry.findUnique({ where: { id: entry.id } });
        expect(unchangedEntry?.deletedAt).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("locked-month coupled entry -> 403, no mutation (D-09)", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(FROZEN_NOW);
      try {
        const targetDate = daysAgoInTz(new Date(), WINDOW_DAYS + 20);
        const { request, entry } = await seedCoupledPending(app, employeeId, targetDate, {
          isLocked: true,
        });

        const res = await app.inject({
          method: "DELETE",
          url: `/api/v1/retro-entry-requests/${request.id}`,
          headers: { authorization: `Bearer ${empToken}` },
        });
        expect(res.statusCode, "withdraw into a locked month must be rejected").toBe(403);

        const unchangedReq = await app.prisma.retroEntryRequest.findUnique({
          where: { id: request.id },
        });
        expect(unchangedReq?.status).toBe("PENDING");
        expect(unchangedReq?.deletedAt).toBeNull();
        const unchangedEntry = await app.prisma.timeEntry.findUnique({ where: { id: entry.id } });
        expect(unchangedEntry?.deletedAt).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("cross-tenant withdraw -> 404 + CROSS_TENANT_ACCESS_DENIED audit", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(FROZEN_NOW);
      try {
        const targetDate = daysAgoInTz(new Date(), WINDOW_DAYS + 1);
        const { request } = await seedCoupledPending(app, crossEmployeeId, targetDate);

        const res = await app.inject({
          method: "DELETE",
          url: `/api/v1/retro-entry-requests/${request.id}`,
          headers: { authorization: `Bearer ${empToken}` }, // main tenant's employee
        });
        expect(res.statusCode, "cross-tenant withdraw must 404").toBe(404);

        const audit = await app.prisma.auditLog.findFirst({
          where: {
            action: "CROSS_TENANT_ACCESS_DENIED",
            entity: "RetroEntryRequest",
            entityId: request.id,
          },
        });
        expect(audit, "CROSS_TENANT_ACCESS_DENIED audit must exist").not.toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
