/**
 * Issue #81 (Phase 81 Plan 02) — the write surface of the activity kind: `activityKind` and
 * `activityShares` on POST / PUT /api/v1/time-entries, the share check (D-05) on every writer that
 * can shrink working time, the predicted automatic break on create (D-18) and the activity-only PUT
 * that is not a time correction (D-20).
 *
 * Fake clock 2026-06-15T10:00:00Z, installed BEFORE the app boots so every token's iat/exp and the
 * retro window agree. No person names in fixtures (CLAUDE.md PII rule).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { ActivityKind } from "@clokr/db";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import { AUDIT_REASON_REQUIRED } from "../contexts/platform";

const SUM_MESSAGE = "Die zugeordnete Tätigkeitszeit übersteigt die Arbeitszeit des Eintrags.";
const OPEN_MESSAGE = "Tätigkeitsanteile sind nur an einem abgeschlossenen Eintrag möglich.";
const REASON = "Korrektur nach Rückfrage";

describe("Issue #81 (Phase 81 Plan 02) — activity kind and shares on the entry write surface", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let dayCounter = 0;

  /** A fresh calendar day per call (one entry per employee and day). March 2026, far in the past. */
  function nextDate(): string {
    dayCounter += 1;
    return new Date(Date.UTC(2026, 2, 1 + dayCounter)).toISOString().slice(0, 10);
  }

  async function createEntry(
    date: string,
    opts: {
      employeeId?: string;
      start?: string;
      end?: string | null;
      breakMinutes?: number;
      breaks?: { start: string; end: string }[];
      kind?: ActivityKind;
      shares?: { kind: ActivityKind; minutes: number }[];
      isLocked?: boolean;
    } = {},
  ) {
    const end = opts.end === undefined ? "17:00:00Z" : opts.end;
    return app.prisma.timeEntry.create({
      data: {
        employeeId: opts.employeeId ?? data.employee.id,
        salonId: data.salonId,
        date: new Date(`${date}T00:00:00Z`),
        startTime: new Date(`${date}T${opts.start ?? "08:00:00Z"}`),
        endTime: end === null ? null : new Date(`${date}T${end}`),
        breakMinutes: opts.breakMinutes ?? 45,
        type: "WORK",
        source: "MANUAL",
        isLocked: opts.isLocked ?? false,
        activityKind: opts.kind ?? "UNSPECIFIED",
        ...(opts.breaks
          ? {
              breaks: {
                create: opts.breaks.map((b) => ({
                  startTime: new Date(`${date}T${b.start}`),
                  endTime: new Date(`${date}T${b.end}`),
                })),
              },
            }
          : {}),
        ...(opts.shares ? { activityShares: { create: opts.shares } } : {}),
      },
    });
  }

  function put(token: string, id: string, payload: Record<string, unknown>) {
    return app.inject({
      method: "PUT",
      url: `/api/v1/time-entries/${id}`,
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
  }

  async function stored(id: string) {
    return app.prisma.timeEntry.findUniqueOrThrow({
      where: { id },
      include: {
        activityShares: { select: { kind: true, minutes: true }, orderBy: { kind: "asc" } },
        breaks: { orderBy: { startTime: "asc" } },
      },
    });
  }

  async function newestAudit(entityId: string) {
    return app.prisma.auditLog.findFirstOrThrow({
      where: { entity: "TimeEntry", entityId },
      orderBy: { createdAt: "desc" },
    });
  }

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-15T10:00:00.000Z"));
    app = await getTestApp();
    data = await seedTestData(app, "act81w");
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("time-entries-activity-81 cleanup failed:", err);
    }
    await closeTestApp();
  });

  describe("PUT — tracer", () => {
    it("stores kind and shares atomically without a Begründung and keeps the source (AK-1, D-06, D-20)", async () => {
      const entry = await createEntry("2026-06-10");
      const res = await put(data.adminToken, entry.id, {
        activityKind: "PRODUCTIVE",
        activityShares: [{ kind: "SETUP_CLEANING", minutes: 60 }],
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        entry: { activityKind: string; activityShares: { kind: string; minutes: number }[] };
      };
      expect(body.entry.activityKind).toBe("PRODUCTIVE");
      expect(body.entry.activityShares).toEqual([{ kind: "SETUP_CLEANING", minutes: 60 }]);

      const row = await stored(entry.id);
      expect(row.activityShares).toEqual([{ kind: "SETUP_CLEANING", minutes: 60 }]);
      expect(row.source).toBe("MANUAL");

      const { activityMinutes } = await import("../contexts/time-tracking");
      expect(activityMinutes(row, row.activityShares)).toEqual({
        UNSPECIFIED: 0,
        PRODUCTIVE: 435,
        SETUP_CLEANING: 60,
      });

      const audit = await newestAudit(entry.id);
      expect(audit.action).toBe("UPDATE");
      const oldValue = audit.oldValue as { activityKind: string; activityShares: unknown[] };
      const newValue = audit.newValue as {
        activityKind: string;
        activityShares: unknown[];
        auditReason?: string;
      };
      expect(oldValue.activityKind).toBe("UNSPECIFIED");
      expect(oldValue.activityShares).toEqual([]);
      expect(newValue.activityKind).toBe("PRODUCTIVE");
      expect(newValue.activityShares).toEqual([{ kind: "SETUP_CLEANING", minutes: 60 }]);
      expect(newValue.auditReason).toBeUndefined();
    });

    it("an employee classifying their own entry gets 200 and an UPDATE audit", async () => {
      const entry = await createEntry("2026-06-11");
      const res = await put(data.empToken, entry.id, { activityKind: "SETUP_CLEANING" });
      expect(res.statusCode).toBe(200);
      expect((await stored(entry.id)).activityKind).toBe("SETUP_CLEANING");
      expect((await newestAudit(entry.id)).action).toBe("UPDATE");
    });
  });

  describe("PUT — D-05 share rules", () => {
    it("shares above the working minutes answer 409 with the exact message and change nothing", async () => {
      const entry = await createEntry(nextDate());
      const res = await put(data.adminToken, entry.id, {
        activityKind: "PRODUCTIVE",
        activityShares: [{ kind: "SETUP_CLEANING", minutes: 500 }],
      });
      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body) as { error: string; maxShareMinutes: number };
      expect(body.error).toBe(SUM_MESSAGE);
      expect(body.maxShareMinutes).toBe(495);
      const row = await stored(entry.id);
      expect(row.activityKind).toBe("UNSPECIFIED");
      expect(row.activityShares).toEqual([]);
    });

    it.each([
      [
        "own-kind share",
        { activityKind: "PRODUCTIVE", activityShares: [{ kind: "PRODUCTIVE", minutes: 10 }] },
      ],
      ["UNSPECIFIED share", { activityShares: [{ kind: "UNSPECIFIED", minutes: 10 }] }],
      [
        "duplicate kind",
        {
          activityKind: "PRODUCTIVE",
          activityShares: [
            { kind: "SETUP_CLEANING", minutes: 10 },
            { kind: "SETUP_CLEANING", minutes: 20 },
          ],
        },
      ],
    ])("%s answers 400 and changes nothing", async (_label, payload) => {
      const entry = await createEntry(nextDate());
      const res = await put(data.adminToken, entry.id, payload);
      expect(res.statusCode).toBe(400);
      const row = await stored(entry.id);
      expect(row.activityKind).toBe("UNSPECIFIED");
      expect(row.activityShares).toEqual([]);
    });

    it("changing the kind to the kind of a stored share answers 400 and keeps the share", async () => {
      const entry = await createEntry(nextDate(), {
        kind: "PRODUCTIVE",
        shares: [{ kind: "SETUP_CLEANING", minutes: 30 }],
      });
      const res = await put(data.adminToken, entry.id, { activityKind: "SETUP_CLEANING" });
      expect(res.statusCode).toBe(400);
      const row = await stored(entry.id);
      expect(row.activityKind).toBe("PRODUCTIVE");
      expect(row.activityShares).toEqual([{ kind: "SETUP_CLEANING", minutes: 30 }]);
    });

    it("an earlier end that would drop the working time below the shares answers 409", async () => {
      const date = nextDate();
      const entry = await createEntry(date, {
        kind: "PRODUCTIVE",
        shares: [{ kind: "SETUP_CLEANING", minutes: 400 }],
        breaks: [{ start: "12:00:00Z", end: "12:45:00Z" }],
      });
      const res = await put(data.adminToken, entry.id, {
        endTime: `${date}T14:00:00.000Z`,
        reason: REASON,
      });
      expect(res.statusCode).toBe(409);
      expect((JSON.parse(res.body) as { error: string }).error).toBe(SUM_MESSAGE);
      const row = await stored(entry.id);
      expect(row.endTime?.toISOString()).toBe(`${date}T17:00:00.000Z`);
      expect(row.activityShares).toEqual([{ kind: "SETUP_CLEANING", minutes: 400 }]);
    });

    it("longer breaks that would drop the working time below the shares answer 409 and keep the Break rows", async () => {
      const date = nextDate();
      const entry = await createEntry(date, {
        kind: "PRODUCTIVE",
        shares: [{ kind: "SETUP_CLEANING", minutes: 400 }],
        breaks: [{ start: "12:00:00Z", end: "12:45:00Z" }],
      });
      const before = await stored(entry.id);
      const res = await put(data.adminToken, entry.id, {
        breaks: [
          { startTime: `${date}T08:30:00.000Z`, endTime: `${date}T10:30:00.000Z` },
          { startTime: `${date}T12:00:00.000Z`, endTime: `${date}T13:00:00.000Z` },
        ],
        reason: REASON,
      });
      expect(res.statusCode).toBe(409);
      const after = await stored(entry.id);
      expect(after.breaks.map((b) => b.id)).toEqual(before.breaks.map((b) => b.id));
      expect(after.breakMinutes).toBe(before.breakMinutes);
    });

    it("a fitting break replacement together with shares stores both (breakMinutes comes from the new slots)", async () => {
      const date = nextDate();
      const entry = await createEntry(date, {
        breaks: [{ start: "12:00:00Z", end: "12:30:00Z" }],
        breakMinutes: 30,
      });
      const res = await put(data.adminToken, entry.id, {
        breaks: [{ startTime: `${date}T12:00:00.000Z`, endTime: `${date}T12:45:00.000Z` }],
        activityKind: "PRODUCTIVE",
        activityShares: [{ kind: "SETUP_CLEANING", minutes: 100 }],
        reason: REASON,
      });
      expect(res.statusCode).toBe(200);
      const row = await stored(entry.id);
      expect(row.breakMinutes).toBe(45);
      expect(row.breaks).toHaveLength(1);
      expect(row.activityShares).toEqual([{ kind: "SETUP_CLEANING", minutes: 100 }]);
    });

    it("reopening an entry that has shares answers 409", async () => {
      const date = nextDate();
      const entry = await createEntry(date, {
        kind: "PRODUCTIVE",
        shares: [{ kind: "SETUP_CLEANING", minutes: 30 }],
      });
      const res = await put(data.adminToken, entry.id, { endTime: null, reason: REASON });
      expect(res.statusCode).toBe(409);
      expect((await stored(entry.id)).endTime).not.toBeNull();
    });

    it("an empty list clears the shares and the audit says so", async () => {
      const entry = await createEntry(nextDate(), {
        kind: "PRODUCTIVE",
        shares: [{ kind: "SETUP_CLEANING", minutes: 30 }],
      });
      const res = await put(data.adminToken, entry.id, { activityShares: [] });
      expect(res.statusCode).toBe(200);
      expect((await stored(entry.id)).activityShares).toEqual([]);
      const audit = await newestAudit(entry.id);
      expect((audit.newValue as { activityShares: unknown[] }).activityShares).toEqual([]);
      expect((audit.oldValue as { activityShares: unknown[] }).activityShares).toEqual([
        { kind: "SETUP_CLEANING", minutes: 30 },
      ]);
    });

    it("omitted activity fields keep the stored kind and shares", async () => {
      const entry = await createEntry(nextDate(), {
        kind: "PRODUCTIVE",
        shares: [{ kind: "SETUP_CLEANING", minutes: 30 }],
      });
      const res = await put(data.adminToken, entry.id, { note: "nur Notiz", reason: REASON });
      expect(res.statusCode).toBe(200);
      const row = await stored(entry.id);
      expect(row.activityKind).toBe("PRODUCTIVE");
      expect(row.activityShares).toEqual([{ kind: "SETUP_CLEANING", minutes: 30 }]);
    });

    it("a kind on an open entry is allowed, a share on it is not", async () => {
      // Own entry of the admin employee, inside the retro window: an open entry overlaps every
      // later closed entry of its owner, so it gets an owner with no other entries.
      const open = await createEntry("2026-06-12", {
        employeeId: data.adminEmployee.id,
        end: null,
        breakMinutes: 0,
      });
      const ok = await put(data.adminToken, open.id, { activityKind: "PRODUCTIVE" });
      expect(ok.statusCode).toBe(200);
      const bad = await put(data.adminToken, open.id, {
        activityShares: [{ kind: "SETUP_CLEANING", minutes: 10 }],
      });
      expect(bad.statusCode).toBe(409);
      expect((JSON.parse(bad.body) as { error: string }).error).toBe(OPEN_MESSAGE);
      expect((await stored(open.id)).activityShares).toEqual([]);
    });

    it("a locked entry is refused with 403 and unchanged", async () => {
      const entry = await createEntry(nextDate(), { isLocked: true });
      const res = await put(data.adminToken, entry.id, { activityKind: "PRODUCTIVE" });
      expect(res.statusCode).toBe(403);
      expect((await stored(entry.id)).activityKind).toBe("UNSPECIFIED");
    });
  });

  describe("PUT — D-20 activity-only is not a time correction", () => {
    it("a manager changing the start together with activity fields still needs a Begründung", async () => {
      const date = nextDate();
      const entry = await createEntry(date);
      const without = await put(data.adminToken, entry.id, {
        startTime: `${date}T08:30:00.000Z`,
        activityKind: "PRODUCTIVE",
      });
      expect(without.statusCode).toBe(400);
      expect((JSON.parse(without.body) as { error: string }).error).toBe(AUDIT_REASON_REQUIRED);

      const withReason = await put(data.adminToken, entry.id, {
        startTime: `${date}T08:30:00.000Z`,
        activityKind: "PRODUCTIVE",
        reason: REASON,
      });
      expect(withReason.statusCode).toBe(200);
      expect((await newestAudit(entry.id)).action).toBe("MANAGER_CORRECTION");
      expect((await stored(entry.id)).source).toBe("CORRECTION");
    });

    it("re-sending the unchanged salon next to a kind is still activity-only", async () => {
      const entry = await createEntry(nextDate());
      const res = await put(data.adminToken, entry.id, {
        salonId: data.salonId,
        activityKind: "PRODUCTIVE",
      });
      expect(res.statusCode).toBe(200);
      expect((await newestAudit(entry.id)).action).toBe("UPDATE");
      expect((await stored(entry.id)).source).toBe("MANUAL");
    });

    it("the retro window binds an employee's activity-only PUT, an admin is exempt", async () => {
      const entry = await createEntry("2026-05-20");
      const denied = await put(data.empToken, entry.id, { activityKind: "PRODUCTIVE" });
      expect(denied.statusCode).toBe(403);
      expect((JSON.parse(denied.body) as { error: string }).error).toBe("RETRO_WINDOW_EXCEEDED");
      expect((await stored(entry.id)).activityKind).toBe("UNSPECIFIED");

      const allowed = await put(data.adminToken, entry.id, { activityKind: "PRODUCTIVE" });
      expect(allowed.statusCode).toBe(200);
    });

    it("AK-2: an activity-only PUT leaves the overtime view byte-identical", async () => {
      const entry = await createEntry(nextDate());
      const read = async () => {
        const res = await app.inject({
          method: "GET",
          url: `/api/v1/overtime/${data.employee.id}`,
          headers: { authorization: `Bearer ${data.adminToken}` },
        });
        expect(res.statusCode).toBe(200);
        return JSON.parse(res.body) as unknown;
      };
      const before = await read();
      const res = await put(data.adminToken, entry.id, {
        activityKind: "PRODUCTIVE",
        activityShares: [{ kind: "SETUP_CLEANING", minutes: 90 }],
      });
      expect(res.statusCode).toBe(200);
      expect(await read()).toEqual(before);
    });
  });
});
