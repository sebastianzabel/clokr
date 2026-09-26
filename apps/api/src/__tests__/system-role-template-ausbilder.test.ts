/**
 * Phase 76b Plan 05 (Issue #76), AK-76b-6 — proves the SHIPPED Ausbilder template bundle
 * (`SYSTEM_ROLE_IDS.TRAINER`, migrated in Plan 76b-01) against real routes, following the #91
 * PERSONS rules: the listed trainees ([T1, T2]) are visible salon-independently on every touched
 * resource (time entries, employee profile), and an unlisted colleague sharing T1's own salon is
 * indistinguishable from a nonexistent id.
 *
 * D-08/D-12 anti-pattern (mirrors 76b-04's own note): the role assignment below points at the
 * REAL `SYSTEM_ROLE_IDS.TRAINER` row, never an ad-hoc custom `AccessRole` — the point is proving
 * the shipped bundle, not a hand-picked permission set.
 *
 * No person names in fixtures (CLAUDE.md PII rule).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";
import { SYSTEM_ROLE_IDS, type SystemRoleSlot } from "../contexts/platform";

const PASSWORD = "test1234";

// Mutation-proof lever (Task 1/2 <action>): flipping this single constant to "SALON_MANAGER"
// must make the corresponding write-side 403 cases fail — that is the mutation proof itself, run
// and restored during execution, quoted in the SUMMARY, never left flipped in the committed file.
const TEMPLATE_SLOT: SystemRoleSlot = "TRAINER";

// Fixed fixture window, inside 2026, well away from month boundaries — so the 90-day default
// window used elsewhere in the suite never matters here (Task 1 <action>).
const WINDOW_FROM = "2026-06-01";
const WINDOW_TO = "2026-06-30";
const T1_ENTRY_A_DATE = "2026-06-10";
const T1_ENTRY_B_DATE = "2026-06-12";
const T2_ENTRY_DATE = "2026-06-11";
const KOLLEGE_ENTRY_DATE = "2026-06-10";

const NONEXISTENT_EMPLOYEE_ID = "00000000-0000-4000-8000-000000000001";

describe("Issue #76 (Phase 76b Plan 05), AK-76b-6 — Ausbilder behavioural matrix", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: { id: string };
  let salonB: { id: string };

  function uniqueSuffix(label: string): string {
    return `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  async function createEmployee(label: string) {
    const s = uniqueSuffix(label);
    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const user = await app.prisma.user.create({
      data: { email: `${s}@test.de`, passwordHash, role: "EMPLOYEE", isActive: true },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: s.toUpperCase().slice(0, 20),
        firstName: label,
        lastName: "AusbilderScopeTest",
        hireDate: new Date("2024-01-01"),
      },
    });
    return { user, employee };
  }

  function createHome(employeeId: string, salonId: string) {
    return app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: data.tenant.id,
        employeeId,
        salonId,
        kind: "HOME",
        validFrom: new Date("2020-01-01"),
        validUntil: null,
        weekdays: [],
      },
    });
  }

  function createEntry(employeeId: string, salonId: string, date: string) {
    return app.prisma.timeEntry.create({
      data: {
        employeeId,
        salonId,
        date: new Date(date),
        startTime: new Date(`${date}T08:00:00Z`),
        endTime: new Date(`${date}T16:00:00Z`),
        source: "MANUAL",
      },
    });
  }

  /**
   * Assigns a REAL system-role slot (never an ad-hoc AccessRole) to `userId`. Defaults to the
   * PERSONS scope this plan proves (D-08's own intended scope for Ausbilder).
   */
  function assignSystemRole(
    userId: string,
    slot: SystemRoleSlot,
    scope: {
      scopeType?: "TENANT" | "SALONS" | "PERSONS";
      salonIds?: string[];
      employeeIds?: string[];
    } = {},
  ) {
    return app.prisma.roleAssignment.create({
      data: {
        tenantId: data.tenant.id,
        userId,
        accessRoleId: SYSTEM_ROLE_IDS[slot],
        scopeType: scope.scopeType ?? "PERSONS",
        salonIds: scope.salonIds ?? [],
        employeeIds: scope.employeeIds ?? [],
      },
    });
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

  let t1: Awaited<ReturnType<typeof createEmployee>>;
  let t2: Awaited<ReturnType<typeof createEmployee>>;
  let kollege: Awaited<ReturnType<typeof createEmployee>>;
  let trainer: Awaited<ReturnType<typeof createEmployee>>;
  let trainerToken: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "sprta");
    salonA = await createTestSalon(app.prisma, data.tenant.id, { name: "SPRTA Salon A" });
    salonB = await createTestSalon(app.prisma, data.tenant.id, { name: "SPRTA Salon B" });

    // azubi-1 (T1): Stammsalon A, one entry in each salon.
    t1 = await createEmployee("azubi-1");
    await createHome(t1.employee.id, salonA.id);
    await createEntry(t1.employee.id, salonA.id, T1_ENTRY_A_DATE);
    await createEntry(t1.employee.id, salonB.id, T1_ENTRY_B_DATE);

    // azubi-2 (T2): Stammsalon B, one entry in B.
    t2 = await createEmployee("azubi-2");
    await createHome(t2.employee.id, salonB.id);
    await createEntry(t2.employee.id, salonB.id, T2_ENTRY_DATE);

    // kollege (U): unlisted, Stammsalon A — same salon as T1.
    kollege = await createEmployee("kollege");
    await createHome(kollege.employee.id, salonA.id);
    await createEntry(kollege.employee.id, salonA.id, KOLLEGE_ENTRY_DATE);

    // ausbilder (R): the trainer, PERSONS scope [T1, T2] on the real TRAINER template.
    trainer = await createEmployee("ausbilder");
    await assignSystemRole(trainer.user.id, TEMPLATE_SLOT, {
      scopeType: "PERSONS",
      employeeIds: [t1.employee.id, t2.employee.id],
    });
    trainerToken = await login(trainer.user.email);
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  describe("Task 1: GET /time-entries — trainees visible across salons, unlisted colleague excluded", () => {
    it("employeeId=<T1> → 200 with both of T1's entries (salon A and salon B)", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/time-entries?employeeId=${t1.employee.id}&from=${WINDOW_FROM}&to=${WINDOW_TO}`,
        headers: { authorization: `Bearer ${trainerToken}` },
      });
      expect(res.statusCode).toBe(200);
      const rows = JSON.parse(res.body) as Array<{ employeeId: string; salonId: string | null }>;
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.salonId).sort()).toEqual([salonA.id, salonB.id].sort());
    });

    it("employeeId=<T2> → 200 with T2's entry", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/time-entries?employeeId=${t2.employee.id}&from=${WINDOW_FROM}&to=${WINDOW_TO}`,
        headers: { authorization: `Bearer ${trainerToken}` },
      });
      expect(res.statusCode).toBe(200);
      const rows = JSON.parse(res.body) as Array<{ employeeId: string }>;
      expect(rows.map((r) => r.employeeId)).toEqual([t2.employee.id]);
    });

    // FINDING (recorded in 76b-05-SUMMARY.md, carried to Plan 76b-07's follow-up issue): the
    // plan's <behavior> expected the UNFILTERED list to already contain both trainees' entries.
    // Measured against the real route (`time-entries.ts:1017`), it does not — a manager who omits
    // `?employeeId` falls back to `employeeId: user.employeeId ?? undefined` (the CALLER's own
    // id), never the reach's PERSONS list. The trainer has no time entries of their own, so the
    // unfiltered response is empty regardless of scope. This is pre-existing route behavior (not
    // introduced by this plan, and not owned by this plan's `files_modified`) — every trainee-scoped
    // read in this suite therefore passes an explicit `employeeId`, matching every other
    // `*-salon-scope.test.ts` fixture (none of them exercises the unfiltered-list branch for a
    // ZUGEWIESEN caller either).
    it("FINDING: the unfiltered list ignores PERSONS scope and falls back to the caller's own employeeId (time-entries.ts:1017)", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/time-entries?from=${WINDOW_FROM}&to=${WINDOW_TO}`,
        headers: { authorization: `Bearer ${trainerToken}` },
      });
      expect(res.statusCode).toBe(200);
      // Observed reality: empty, not "both trainees' entries" as the plan's <behavior> expected.
      expect(JSON.parse(res.body)).toEqual([]);
    });

    it("employeeId=<unlisted colleague> → 200 with []", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/time-entries?employeeId=${kollege.employee.id}&from=${WINDOW_FROM}&to=${WINDOW_TO}`,
        headers: { authorization: `Bearer ${trainerToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual([]);
    });
  });

  describe("Task 1: GET /employees/:id — trainee visible, unlisted colleague 404-indistinguishable", () => {
    it("GET /employees/<T1> → 200", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/employees/${t1.employee.id}`,
        headers: { authorization: `Bearer ${trainerToken}` },
      });
      expect(res.statusCode).toBe(200);
    });

    it("GET /employees/<unlisted colleague, same salon as T1> is byte-identical to a nonexistent id (T-100-09)", async () => {
      const kollegeRes = await app.inject({
        method: "GET",
        url: `/api/v1/employees/${kollege.employee.id}`,
        headers: { authorization: `Bearer ${trainerToken}` },
      });
      const nonexistentRes = await app.inject({
        method: "GET",
        url: `/api/v1/employees/${NONEXISTENT_EMPLOYEE_ID}`,
        headers: { authorization: `Bearer ${trainerToken}` },
      });
      expect(kollegeRes.statusCode).toBe(nonexistentRes.statusCode);
      expect(kollegeRes.body).toBe(nonexistentRes.body);
      expect(kollegeRes.statusCode).toBe(404);
    });
  });
});
