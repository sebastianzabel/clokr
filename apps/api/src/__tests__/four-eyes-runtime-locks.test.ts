/**
 * Phase 78b (Issue #78), D-08 — the runtime self-approval locks hold even for a customer role
 * that confirmedly holds BOTH halves of the four-eyes combination (`contexts/platform/four-eyes.ts`).
 *
 * Plan 78b-01 wired a role-API WARNING (409 `FOUR_EYES_CONFIRMATION_REQUIRED`) for a save that
 * newly creates the combination. That warning is not a lock — a customer can legitimately confirm
 * it (e.g. mirroring the "Inhaber" system role, which deliberately holds it too, per
 * `system-roles.test.ts`'s D-03 exception list). The hard barrier against a single person both
 * recording and approving their own time correction is the RUNTIME identity lock in the owning
 * contexts (`retro-entry-requests.ts`, `leave.ts`) — deliberately NOT a permission
 * (`permission-catalog.ts`, `docs/permissions.md` § "Keine Permissions"). This file proves those
 * locks hold for the worst-case role composition, built the way a real customer would build it:
 * through `POST /api/v1/roles` with `confirm: true` (exercising 78b-01's own confirmation gate),
 * not a raw `accessRole.create`.
 *
 * The actor is deliberately given a linked `Employee` row (unlike
 * `customer-role-escalation.test.ts`'s bare-user fixture, Issue #354) — the self-approval checks
 * resolve "is this caller the requester" via `Employee.findFirst({ where: { userId } })`
 * (`retro-entry-requests.ts`) or the equivalent inline lookup (`leave.ts`); a bare user without an
 * Employee row can never match and would make every 403 below pass for the wrong reason. Every
 * 403 is therefore asserted on its EXACT German message, never on status code alone — a 403 for a
 * missing permission would otherwise pass the same status-only check without proving anything
 * about the lock itself. Each lock also gets a positive control: the same actor succeeds on a
 * FOREIGN request, proving the 403 comes from the self-approval identity check and not from some
 * missing permission the fixture role forgot to include.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import { FOUR_EYES_COMBINATION, holdsFourEyesCombination } from "../contexts/platform";
import type { JwtPayload } from "../middleware/auth";

describe("Runtime self-approval locks hold for a confirmed four-eyes combination holder (Issue #78, D-08)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  const retroRequestIds: string[] = [];
  const leaveRequestIds: string[] = [];
  let actor: { userId: string; employeeId: string; roleId: string; bearer: string };

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "78b04-locks");

    // The fixture role: created through POST /api/v1/roles with confirm: true — the exact path a
    // customer uses, exercising 78b-01's own confirmation gate. Its permission set is exactly what
    // the review routes below need, taken from FOUR_EYES_COMBINATION rather than restated as
    // literals (D-01) — plus the read/create counterparts so the actor can hold a plausible,
    // otherwise-unremarkable role, and the leave-review preHandler permission.
    const combinationPermissions = [
      ...FOUR_EYES_COMBINATION.changeOwnTimes,
      ...FOUR_EYES_COMBINATION.approveTimes,
      "time-entry:read:EIGENE",
      "retro-request:read:EIGENE",
      "retro-request:create:EIGENE",
      "leave-request:read:EIGENE",
      "leave-request:create:EIGENE",
      "leave-request:approve:ZUGEWIESEN",
      "leave-request:cancel:ZUGEWIESEN",
    ];

    const roleName =
      `Kombi-Rolle-78b04-${Date.now().toString(36)}` + Math.random().toString(36).slice(2, 6);
    const roleRes = await app.inject({
      method: "POST",
      url: "/api/v1/roles",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { name: roleName, permissions: combinationPermissions, confirm: true },
    });
    expect(roleRes.statusCode).toBe(201);
    const roleBody = JSON.parse(roleRes.body) as { id: string; permissions: string[] };
    expect(holdsFourEyesCombination(roleBody.permissions)).toBe(true);

    // The actor: a fresh active User + a linked Employee (Pitfall 3 — a bare user never matches
    // the self-approval checks' Employee lookup) + one TENANT-scope RoleAssignment to the role
    // above. JWT signed directly (mirrors customer-role-escalation.test.ts's fixture pattern) —
    // no login round-trip needed.
    const s = `78b04-${Date.now().toString(36)}` + Math.random().toString(36).slice(2, 6);
    const passwordHash = await bcrypt.hash("test1234", 10);
    const user = await app.prisma.user.create({
      data: { email: `${s}@test.de`, passwordHash, role: "EMPLOYEE", isActive: true },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `KOMBI-${s}`,
        firstName: "Kombi",
        lastName: "Halterin",
        hireDate: new Date("2024-01-01"),
      },
    });
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        accessRoleId: roleBody.id,
        scopeType: "TENANT",
        salonIds: [],
        employeeIds: [],
      },
    });
    const payload: JwtPayload = {
      sub: user.id,
      role: "EMPLOYEE",
      tenantId: data.tenant.id,
      employeeId: employee.id,
    };
    actor = {
      userId: user.id,
      employeeId: employee.id,
      roleId: roleBody.id,
      bearer: `Bearer ${app.jwt.sign(payload)}`,
    };
  });

  afterAll(async () => {
    // Deletion order per the module docblock above: the requests this file created, then the
    // RoleAssignment, then the AccessRole, then the shared tenant teardown — cleanupTestData()
    // deletes LeaveRequest itself but has NO RetroEntryRequest/RoleAssignment/AccessRole call at
    // all, and RetroEntryRequest.employee is onDelete: Restrict, so an un-deleted retro request
    // would make cleanupTestData's own employee.deleteMany fail and leak fixture rows.
    try {
      if (retroRequestIds.length > 0) {
        await app.prisma.retroEntryRequest.deleteMany({ where: { id: { in: retroRequestIds } } });
      }
    } catch (err) {
      console.error("RetroEntryRequest cleanup failed:", err);
    }
    try {
      if (leaveRequestIds.length > 0) {
        await app.prisma.leaveRequest.deleteMany({ where: { id: { in: leaveRequestIds } } });
      }
    } catch (err) {
      console.error("LeaveRequest cleanup failed:", err);
    }
    try {
      if (actor) {
        await app.prisma.roleAssignment.deleteMany({ where: { userId: actor.userId } });
      }
    } catch (err) {
      console.error("RoleAssignment cleanup failed:", err);
    }
    try {
      if (actor) {
        await app.prisma.accessRole.deleteMany({ where: { id: actor.roleId } });
      }
    } catch (err) {
      console.error("AccessRole cleanup failed:", err);
    }
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  describe("Zeitnachtrag — PATCH /api/v1/retro-entry-requests/:id/review (Task 1)", () => {
    it("a confirmed combination-holder cannot approve their own PENDING Zeitnachtrag", async () => {
      const request = await app.prisma.retroEntryRequest.create({
        data: {
          employeeId: actor.employeeId,
          targetDate: new Date("2024-02-01"),
          reason: "Eigener Zeitnachtrag für den Selbstgenehmigungstest (D-08)",
          startTime: "08:00",
          endTime: "16:00",
        },
      });
      retroRequestIds.push(request.id);

      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/retro-entry-requests/${request.id}/review`,
        headers: { authorization: actor.bearer },
        payload: { status: "APPROVED" },
      });

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error).toBe(
        "Eigene Anträge können nicht selbst genehmigt werden",
      );
      const stillPending = await app.prisma.retroEntryRequest.findUniqueOrThrow({
        where: { id: request.id },
      });
      expect(stillPending.status).toBe("PENDING");
    });

    it("(positive control) the same combination-holder CAN approve a colleague's Zeitnachtrag", async () => {
      const request = await app.prisma.retroEntryRequest.create({
        data: {
          employeeId: data.employee.id,
          targetDate: new Date("2024-02-02"),
          reason: "Fremder Zeitnachtrag für die Positivkontrolle (D-08)",
          startTime: "08:00",
          endTime: "16:00",
        },
      });
      retroRequestIds.push(request.id);

      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/retro-entry-requests/${request.id}/review`,
        headers: { authorization: actor.bearer },
        payload: { status: "APPROVED" },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).status).toBe("APPROVED");
    });
  });

  describe("Urlaubsantrag — PATCH /api/v1/leave/requests/:id/review (Task 2)", () => {
    it("a confirmed combination-holder cannot approve their own PENDING leave request", async () => {
      const request = await app.prisma.leaveRequest.create({
        data: {
          employeeId: actor.employeeId,
          leaveTypeId: data.vacationType.id,
          startDate: new Date("2030-06-10"),
          endDate: new Date("2030-06-10"),
          days: 1,
        },
      });
      leaveRequestIds.push(request.id);

      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/leave/requests/${request.id}/review`,
        headers: { authorization: actor.bearer },
        payload: { status: "APPROVED" },
      });

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error).toBe(
        "Eigene Anträge können nicht selbst genehmigt werden",
      );
      const stillPending = await app.prisma.leaveRequest.findUniqueOrThrow({
        where: { id: request.id },
      });
      expect(stillPending.status).toBe("PENDING");
    });

    it("cannot decide a cancellation the combination-holder itself requested", async () => {
      const request = await app.prisma.leaveRequest.create({
        data: {
          employeeId: data.employee.id,
          leaveTypeId: data.vacationType.id,
          startDate: new Date("2030-06-11"),
          endDate: new Date("2030-06-11"),
          days: 1,
          status: "CANCELLATION_REQUESTED",
          cancellationRequestedBy: actor.userId,
          reviewedBy: data.adminUser.id,
        },
      });
      leaveRequestIds.push(request.id);

      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/leave/requests/${request.id}/review`,
        headers: { authorization: actor.bearer },
        payload: { status: "APPROVED" },
      });

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error).toBe(
        "Stornierung kann nicht vom Antragsteller genehmigt werden",
      );
      const unchanged = await app.prisma.leaveRequest.findUniqueOrThrow({
        where: { id: request.id },
      });
      expect(unchanged.status).toBe("CANCELLATION_REQUESTED");
    });

    it("cannot decide a cancellation of a leave the combination-holder originally approved", async () => {
      const request = await app.prisma.leaveRequest.create({
        data: {
          employeeId: data.employee.id,
          leaveTypeId: data.vacationType.id,
          startDate: new Date("2030-06-12"),
          endDate: new Date("2030-06-12"),
          days: 1,
          status: "CANCELLATION_REQUESTED",
          cancellationRequestedBy: data.empUser.id,
          reviewedBy: actor.userId,
        },
      });
      leaveRequestIds.push(request.id);

      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/leave/requests/${request.id}/review`,
        headers: { authorization: actor.bearer },
        payload: { status: "APPROVED" },
      });

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error).toBe(
        "Stornierung kann nicht vom ursprünglichen Genehmiger genehmigt werden",
      );
      const unchanged = await app.prisma.leaveRequest.findUniqueOrThrow({
        where: { id: request.id },
      });
      expect(unchanged.status).toBe("CANCELLATION_REQUESTED");
    });

    it("(positive control) the same combination-holder CAN decide a colleague's PENDING leave request", async () => {
      const request = await app.prisma.leaveRequest.create({
        data: {
          employeeId: data.employee.id,
          leaveTypeId: data.vacationType.id,
          startDate: new Date("2030-06-13"),
          endDate: new Date("2030-06-13"),
          days: 1,
        },
      });
      leaveRequestIds.push(request.id);

      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/leave/requests/${request.id}/review`,
        headers: { authorization: actor.bearer },
        payload: { status: "REJECTED", reviewNote: "Positivkontrolle (D-08)" },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).status).toBe("REJECTED");
    });
  });
});
