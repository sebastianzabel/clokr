/**
 * Issue #657 — a Zeitnachtrag is per INTERVAL, not per day.
 *
 * Several requests of one employee and day are created as long as their intervals do not overlap
 * (half-open, a legacy request without times covers the whole day); an overlap answers 409
 * `RETRO_REQUEST_OVERLAP` and writes nothing. Both creation paths (`POST /retro-entry-requests`
 * and the entry-first Nachtrag of `POST /time-entries`) run check and write under the one
 * employee row lock.
 *
 * No person names in fixtures.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import type { FastifyInstance } from "fastify";
import { fromZonedTime } from "date-fns-tz";
import type { RetroEntryStatus } from "@clokr/db";
import {
  getTestApp,
  cleanupTestData,
  seedTestData,
  soleAuditRow,
  createTestSalon,
  grantSystemRole,
} from "./setup";
import { nextWeekdayStr, pastDateStr, TEST_TZ } from "./test-dates";
import { invalidReasonFields } from "../contexts/time-tracking/invalid-reason";
import { normalizeRolePermissions, roleNameKey } from "../contexts/platform";
import { holdEmployeeLockThen } from "./entry-lock-race-helpers";

function at(dayStr: string, hhmm: string): Date {
  return fromZonedTime(`${dayStr}T${hhmm}:00`, TEST_TZ);
}

function detailedText(dayStr: string, from: string, to: string): string {
  const [y, m, d] = dayStr.split("-");
  return `Überschneidung mit bestehendem Eintrag vom ${d}.${m}.${y} (${from} – ${to})`;
}

const OVERLAP_BODY = {
  error: "Der Zeitraum überschneidet sich mit einem anderen Zeitnachtrag dieses Tages.",
  code: "RETRO_REQUEST_OVERLAP",
};

describe("Issue #657 — Zeitnachtrag per interval", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;
  let tenantId: string;
  let employeeId: string;
  let dayCounter = 0;

  /** A distinct past weekday per call, far outside the retro window and after the hire date. */
  function nextDay(): string {
    dayCounter += 1;
    return nextWeekdayStr(pastDateStr(100 + 7 * dayCounter));
  }

  function propose(day: string, startTime: string, endTime: string, token = seed.empToken) {
    return app.inject({
      method: "POST",
      url: "/api/v1/retro-entry-requests",
      headers: { authorization: `Bearer ${token}` },
      payload: { targetDate: day, reason: "Nachtrag fixture", startTime, endTime },
    });
  }

  const liveRequests = (day: string) =>
    app.prisma.retroEntryRequest.findMany({
      where: { employeeId, targetDate: new Date(`${day}T00:00:00Z`), deletedAt: null },
      orderBy: { startTime: "asc" },
    });

  /** Entry-first Nachtrag through POST /time-entries (the day lies outside the retro window). */
  function entryFirst(day: string, from: string, to: string, token = seed.empToken) {
    return app.inject({
      method: "POST",
      url: "/api/v1/time-entries",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        employeeId,
        date: day,
        startTime: at(day, from).toISOString(),
        endTime: at(day, to).toISOString(),
        breakMinutes: 0,
        reason: "Nachtrag fixture",
      },
    });
  }

  /** Seeds a request row directly; `coupled` adds the entry it stands for. */
  async function seedRequest(
    day: string,
    opts: {
      status?: RetroEntryStatus;
      start?: string | null;
      end?: string | null;
      coupled?: { from: string; to: string };
      deletedAt?: Date;
      forEmployeeId?: string;
    } = {},
  ) {
    const owner = opts.forEmployeeId ?? employeeId;
    const status = opts.status ?? "PENDING";
    const request = await app.prisma.retroEntryRequest.create({
      data: {
        employeeId: owner,
        targetDate: new Date(`${day}T00:00:00Z`),
        reason: "Nachtrag fixture",
        startTime: opts.start === undefined ? "08:00" : opts.start,
        endTime: opts.end === undefined ? "12:00" : opts.end,
        status,
        deletedAt: opts.deletedAt ?? null,
      },
    });
    if (opts.coupled) {
      await app.prisma.timeEntry.create({
        data: {
          employeeId: owner,
          date: new Date(`${day}T00:00:00Z`),
          startTime: at(day, opts.coupled.from),
          endTime: at(day, opts.coupled.to),
          breakMinutes: 0,
          source: "MANUAL",
          createdBy: owner,
          salonId: seed.salonId,
          retroRequestId: request.id,
          ...(status === "PENDING"
            ? { isInvalid: true, ...invalidReasonFields("RETRO_APPROVAL_PENDING") }
            : {}),
        },
      });
    }
    return request;
  }

  const pendingRows = (day: string) =>
    app.prisma.timeEntry.count({
      where: { employeeId, date: new Date(`${day}T00:00:00Z`), deletedAt: null },
    });

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "rpi657");
    tenantId = seed.tenant.id;
    employeeId = seed.employee.id;
  });

  afterAll(async () => {
    try {
      await app.prisma.timeEntry.deleteMany({ where: { employee: { tenantId } } });
      await app.prisma.retroEntryRequest.deleteMany({ where: { employee: { tenantId } } });
      await cleanupTestData(app, tenantId);
    } catch {
      // best-effort cleanup
    }
  });

  describe("AC-657-1 via POST /retro-entry-requests", () => {
    it("creates non-overlapping requests of one day, refuses an overlap, accepts touching intervals", async () => {
      const day = nextDay();

      const a = await propose(day, "08:00", "12:00");
      expect(a.statusCode).toBe(201);
      const b = await propose(day, "13:00", "17:00");
      expect(b.statusCode).toBe(201);

      const c = await propose(day, "11:00", "14:00");
      expect(c.statusCode).toBe(409);
      expect(JSON.parse(c.body)).toEqual(OVERLAP_BODY);

      const d = await propose(day, "12:00", "13:00");
      expect(d.statusCode).toBe(201);

      const rows = await liveRequests(day);
      expect(rows.map((r) => `${r.startTime}-${r.endTime}`)).toEqual([
        "08:00-12:00",
        "12:00-13:00",
        "13:00-17:00",
      ]);
      for (const id of [a, b, d].map((r) => (JSON.parse(r.body) as { id: string }).id)) {
        const audit = await soleAuditRow(app.prisma, {
          where: { entity: "RetroEntryRequest", entityId: id, action: "RETRO_ENTRY_REQUESTED" },
        });
        expect(audit).toBeTruthy();
      }
    });
  });

  describe("AC-657-1 via the entry-first Nachtrag (POST /time-entries)", () => {
    it("creates two non-overlapping Nachträge of one day, refuses an overlap with the entry text", async () => {
      const day = nextDay();
      expect((await entryFirst(day, "08:00", "12:00")).statusCode).toBe(201);
      expect((await entryFirst(day, "13:00", "17:00")).statusCode).toBe(201);

      const clash = await entryFirst(day, "11:00", "14:00");
      expect(clash.statusCode).toBe(409);
      // The entry re-check runs first and words the overlap by the caller's reach (D-03/D-13).
      const body = JSON.parse(clash.body) as { error: string; code?: string };
      expect(body.code).toBeUndefined();
      expect(body.error).toBe(detailedText(day, "08:00", "12:00"));

      expect(await liveRequests(day)).toHaveLength(2);
      expect(await pendingRows(day)).toBe(2);
    });
  });

  describe("mixed paths and the interval a coupled request occupies", () => {
    it("judges a coupled pending request by its entry and an uncoupled one by its HH:MM", async () => {
      const day = nextDay();
      expect((await entryFirst(day, "08:00", "12:00")).statusCode).toBe(201);

      const inside = await propose(day, "10:00", "11:00");
      expect(inside.statusCode).toBe(409);
      expect(JSON.parse(inside.body)).toEqual(OVERLAP_BODY);
      expect((await propose(day, "13:00", "14:00")).statusCode).toBe(201);

      const clash = await entryFirst(day, "13:30", "15:00");
      expect(clash.statusCode).toBe(409);
      expect(JSON.parse(clash.body)).toEqual(OVERLAP_BODY);
      expect(await pendingRows(day)).toBe(1);
      expect(await liveRequests(day)).toHaveLength(2);
    });

    it("a coupled pending request whose entry was moved is judged by the entry, not by its HH:MM", async () => {
      const day = nextDay();
      const request = await seedRequest(day, { coupled: { from: "08:00", to: "12:00" } });
      await app.prisma.timeEntry.updateMany({
        where: { retroRequestId: request.id },
        data: { endTime: at(day, "09:00") },
      });
      // The request still says 08:00-12:00; the moved entry ends 09:00.
      expect((await propose(day, "10:00", "11:00")).statusCode).toBe(201);
    });
  });

  describe("legacy request without times covers the whole day (D-02)", () => {
    it("refuses both creation paths on that day and not on the next", async () => {
      const day = nextDay();
      await seedRequest(day, { start: null, end: null });
      const p = await propose(day, "18:00", "19:00");
      expect(p.statusCode).toBe(409);
      expect(JSON.parse(p.body)).toEqual(OVERLAP_BODY);
      const e = await entryFirst(day, "18:00", "19:00");
      expect(e.statusCode).toBe(409);
      expect(JSON.parse(e.body)).toEqual(OVERLAP_BODY);
      expect(await pendingRows(day)).toBe(0);

      const next = new Date(new Date(`${day}T00:00:00Z`).getTime() + 86400000)
        .toISOString()
        .split("T")[0];
      expect((await propose(next, "18:00", "19:00")).statusCode).toBe(201);
    });
  });

  describe("which requests are live (D-13): only PENDING ones", () => {
    const ignored: Array<[string, Parameters<typeof seedRequest>[1]]> = [
      ["REJECTED", { status: "REJECTED" }],
      ["USED", { status: "USED" }],
      ["withdrawn (deletedAt)", { deletedAt: new Date() }],
      [
        "APPROVED with a coupled entry",
        { status: "APPROVED", coupled: { from: "08:00", to: "12:00" } },
      ],
      // CR-01 scenario 1: an approved correction proposal writes no entry and nothing consumes it.
      ["APPROVED without a coupled entry (approved correction proposal)", { status: "APPROVED" }],
    ];
    for (const [label, opts] of ignored) {
      it(`${label} never refuses, on either creation path`, async () => {
        const day = nextDay();
        await seedRequest(day, opts);
        expect((await propose(day, "09:00", "10:00")).statusCode).toBe(201);
        expect((await entryFirst(day, "13:00", "14:00")).statusCode).toBe(201);
      });
    }

    it("an APPROVED Nachtrag whose coupled entry was deleted later does not block a re-filing (CR-01 scenario 2)", async () => {
      const day = nextDay();
      const request = await seedRequest(day, {
        status: "APPROVED",
        coupled: { from: "08:00", to: "12:00" },
      });
      await app.prisma.timeEntry.updateMany({
        where: { retroRequestId: request.id },
        data: { deletedAt: new Date() },
      });
      expect((await entryFirst(day, "08:00", "12:00")).statusCode).toBe(201);
      expect((await propose(day, "12:00", "13:00")).statusCode).toBe(201);
    });

    it("a PENDING request still refuses an overlapping one", async () => {
      const day = nextDay();
      await seedRequest(day, { status: "PENDING" });
      const res = await propose(day, "09:00", "10:00");
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body)).toEqual(OVERLAP_BODY);
    });
  });

  describe("correction proposals run no entry-overlap check (D-12)", () => {
    it("a proposal overlapping the recorded entry it corrects is created", async () => {
      const day = nextDay();
      await app.prisma.timeEntry.create({
        data: {
          employeeId,
          date: new Date(`${day}T00:00:00Z`),
          startTime: at(day, "07:00"),
          endTime: at(day, "15:00"),
          breakMinutes: 30,
          source: "MANUAL",
          createdBy: employeeId,
          salonId: seed.salonId,
        },
      });
      expect((await propose(day, "08:00", "17:00")).statusCode).toBe(201);
    });
  });

  describe("#658 order: the reach decision comes before any overlap read", () => {
    it("answers a scoped caller out of reach byte-identically to an unknown id", async () => {
      const salonA = await createTestSalon(app.prisma, tenantId, { name: "RPI657 Salon A" });
      const salonB = await createTestSalon(app.prisma, tenantId, { name: "RPI657 Salon B" });
      async function person(label: string, salonId: string) {
        const slug = `${label}-${crypto.randomBytes(3).toString("hex")}`;
        const user = await app.prisma.user.create({
          data: {
            email: `${slug}@test.de`,
            passwordHash: await bcrypt.hash("test1234", 10),
            isActive: true,
          },
        });
        const employee = await app.prisma.employee.create({
          data: {
            tenantId,
            userId: user.id,
            employeeNumber: slug.toUpperCase().slice(0, 20),
            firstName: label,
            lastName: "Rpi657",
            hireDate: new Date("2020-01-01"),
          },
        });
        await grantSystemRole(app.prisma, { tenantId, userId: user.id, role: "EMPLOYEE" });
        await app.prisma.employeeSalonAssignment.create({
          data: {
            tenantId,
            employeeId: employee.id,
            salonId,
            kind: "HOME",
            validFrom: new Date("2020-01-01"),
            validUntil: null,
            weekdays: [],
          },
        });
        return { id: employee.id, userId: user.id, email: `${slug}@test.de` };
      }
      const foreign = await person("fb", salonB.id);
      const mgr = await person("ma", salonA.id);
      const roleName = `Rpi657 ${crypto.randomBytes(3).toString("hex")}`;
      const role = await app.prisma.accessRole.create({
        data: {
          tenantId,
          name: roleName,
          nameKey: roleNameKey(roleName),
          permissions: normalizeRolePermissions(["retro-request:create:ZUGEWIESEN"]),
        },
      });
      await app.prisma.roleAssignment.create({
        data: {
          tenantId,
          userId: mgr.userId,
          accessRoleId: role.id,
          scopeType: "SALONS",
          salonIds: [salonA.id],
          employeeIds: [],
        },
      });
      const login = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: mgr.email, password: "test1234" },
      });
      expect(login.statusCode).toBe(200);
      const token = (JSON.parse(login.body) as { accessToken: string }).accessToken;

      const day = nextDay();
      await seedRequest(day, { forEmployeeId: foreign.id });
      const post = (targetEmployee: string) =>
        app.inject({
          method: "POST",
          url: "/api/v1/retro-entry-requests",
          headers: { authorization: `Bearer ${token}` },
          payload: {
            employeeId: targetEmployee,
            targetDate: day,
            reason: "Nachtrag fixture",
            startTime: "09:00",
            endTime: "10:00",
          },
        });
      const out = await post(foreign.id);
      const unknown = await post(crypto.randomUUID());
      expect(out.statusCode).toBe(404);
      expect(unknown.statusCode).toBe(404);
      expect(out.body).toBe(unknown.body);

      const rows = await app.prisma.retroEntryRequest.findMany({
        where: { employeeId: foreign.id },
        select: { id: true },
      });
      expect(rows).toHaveLength(1);
      expect(
        await app.prisma.auditLog.count({
          where: { entity: "RetroEntryRequest", entityId: { in: rows.map((r) => r.id) } },
        }),
      ).toBe(0);
    });
  });

  describe("an entry-first request cannot be redeemed as a grant (CR-02, four-eyes)", () => {
    it("POST with the own approved coupled request as grantId is refused like a missing grant", async () => {
      const day = nextDay();
      const approved = await seedRequest(day, {
        status: "APPROVED",
        coupled: { from: "08:00", to: "12:00" },
      });
      const send = (grantId: string) =>
        app.inject({
          method: "POST",
          url: "/api/v1/time-entries",
          headers: { authorization: `Bearer ${seed.empToken}` },
          payload: {
            employeeId,
            date: day,
            startTime: at(day, "13:00").toISOString(),
            endTime: at(day, "17:00").toISOString(),
            breakMinutes: 0,
            reason: "Nachtrag fixture",
            grantId,
          },
        });
      const missing = await send(crypto.randomUUID());
      const bypass = await send(approved.id);
      expect(missing.statusCode).toBe(403);
      expect(bypass.statusCode).toBe(403);
      expect(bypass.body).toBe(missing.body);
      expect(
        (await app.prisma.retroEntryRequest.findUniqueOrThrow({ where: { id: approved.id } }))
          .status,
      ).toBe("APPROVED");
      expect(await pendingRows(day)).toBe(1);
    });

    it("PUT with the own approved coupled request as grantId is refused like a missing grant", async () => {
      const day = nextDay();
      const approved = await seedRequest(day, {
        status: "APPROVED",
        coupled: { from: "08:00", to: "12:00" },
      });
      const entry = await app.prisma.timeEntry.findFirstOrThrow({
        where: { retroRequestId: approved.id },
      });
      const send = (grantId: string) =>
        app.inject({
          method: "PUT",
          url: `/api/v1/time-entries/${entry.id}`,
          headers: { authorization: `Bearer ${seed.empToken}` },
          payload: {
            startTime: at(day, "07:00").toISOString(),
            endTime: at(day, "19:00").toISOString(),
            breakMinutes: 0,
            reason: "Nachtrag fixture",
            grantId,
          },
        });
      const missing = await send(crypto.randomUUID());
      const bypass = await send(approved.id);
      expect(missing.statusCode).toBe(403);
      expect(bypass.statusCode).toBe(403);
      expect(bypass.body).toBe(missing.body);
      const after = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: entry.id } });
      expect(after.startTime.toISOString()).toBe(at(day, "08:00").toISOString());
      expect(after.endTime?.toISOString()).toBe(at(day, "12:00").toISOString());
      expect(
        (await app.prisma.retroEntryRequest.findUniqueOrThrow({ where: { id: approved.id } }))
          .status,
      ).toBe("APPROVED");
    });
  });

  describe("check and write run under the employee row lock (D-04)", () => {
    const holderRequest =
      (day: string) =>
      async (tx: Parameters<Parameters<typeof holdEmployeeLockThen>[1]["holderWork"]>[0]) => {
        await tx.retroEntryRequest.create({
          data: {
            employeeId,
            targetDate: new Date(`${day}T00:00:00Z`),
            reason: "Nachtrag fixture",
            startTime: "08:00",
            endTime: "12:00",
            status: "PENDING",
          },
        });
      };

    it("POST /retro-entry-requests waits for the holder and then sees its committed request", async () => {
      const day = nextDay();
      const { result, blocked } = await holdEmployeeLockThen(app, {
        tenantId,
        employeeId,
        start: () => propose(day, "09:00", "10:00"),
        holderWork: holderRequest(day),
      });
      expect(blocked).toBe(true);
      expect(result.statusCode).toBe(409);
      expect(JSON.parse(result.body)).toEqual(OVERLAP_BODY);
      expect(await liveRequests(day)).toHaveLength(1);
    });

    it("the entry-first Nachtrag waits for the holder, answers the request code and writes nothing", async () => {
      const day = nextDay();
      const { result, blocked } = await holdEmployeeLockThen(app, {
        tenantId,
        employeeId,
        start: () => entryFirst(day, "09:00", "10:00"),
        holderWork: holderRequest(day),
      });
      expect(blocked).toBe(true);
      expect(result.statusCode).toBe(409);
      expect(JSON.parse(result.body)).toEqual(OVERLAP_BODY);
      expect(await liveRequests(day)).toHaveLength(1);
      expect(await pendingRows(day)).toBe(0);
    });

    it("two concurrent overlapping creations end with exactly one live request", async () => {
      const day = nextDay();
      const [one, two] = await Promise.all([
        propose(day, "08:00", "12:00"),
        propose(day, "10:00", "14:00"),
      ]);
      expect([one.statusCode, two.statusCode].sort()).toEqual([201, 409]);
      expect(await liveRequests(day)).toHaveLength(1);
    });
  });

  describe("a day with a single request behaves as before (AC-657-4, AC-657-5)", () => {
    it("POST /retro-entry-requests answers with the same body keys and writes one audit row with the same keys", async () => {
      const day = nextDay();
      const res = await propose(day, "08:00", "12:00");
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body) as Record<string, unknown> & { id: string };
      expect(Object.keys(body).sort()).toEqual(
        [
          "id",
          "employeeId",
          "targetDate",
          "reason",
          "startTime",
          "endTime",
          "breakMinutes",
          "status",
          "reviewedBy",
          "reviewedAt",
          "reviewNote",
          "deletedAt",
          "createdAt",
          "updatedAt",
          "requesterId",
        ].sort(),
      );
      expect(body.targetDate).toBe(day);
      expect(body.status).toBe("PENDING");

      const audit = await soleAuditRow(app.prisma, {
        where: { entity: "RetroEntryRequest", entityId: body.id, action: "RETRO_ENTRY_REQUESTED" },
      });
      expect(Object.keys(audit.newValue as Record<string, unknown>).sort()).toEqual(
        [
          "employeeId",
          "targetDate",
          "ageInDays",
          "reason",
          "startTime",
          "endTime",
          "breakMinutes",
          "requesterId",
        ].sort(),
      );
    });

    it("an entry-first Nachtrag on an empty day creates one pending row and one PENDING request", async () => {
      const day = nextDay();
      const res = await entryFirst(day, "08:00", "12:00");
      expect(res.statusCode).toBe(201);
      expect(JSON.stringify(JSON.parse(res.body))).not.toContain("RETRO_REQUEST_OVERLAP");
      const requests = await liveRequests(day);
      expect(requests).toHaveLength(1);
      expect(requests[0].status).toBe("PENDING");
      expect(await pendingRows(day)).toBe(1);
    });
  });
});
