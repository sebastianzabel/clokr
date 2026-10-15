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
  // A second tenant with the automatic break switched on, so the first tenant's entries stay
  // untouched by it.
  let autoData: Awaited<ReturnType<typeof seedTestData>>;
  let dayCounter = 0;
  let postDayCounter = 0;

  /** A fresh April 2026 day for the POST cases (the PUT cases use March). */
  function nextPostDate(): string {
    postDayCounter += 1;
    return new Date(Date.UTC(2026, 3, 1 + postDayCounter)).toISOString().slice(0, 10);
  }

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
      isInvalid?: boolean;
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
        isInvalid: opts.isInvalid ?? false,
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
    autoData = await seedTestData(app, "act81a");
    await app.prisma.tenantConfig.update({
      where: { tenantId: autoData.tenant.id },
      data: { autoBreakEnabled: true, defaultBreakStart: "12:00" },
    });
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await cleanupTestData(app, data.tenant.id);
      await cleanupTestData(app, autoData.tenant.id);
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
  describe("POST — kind and shares on create (D-06, D-18)", () => {
    function post(token: string, payload: Record<string, unknown>) {
      return app.inject({
        method: "POST",
        url: "/api/v1/time-entries",
        headers: { authorization: `Bearer ${token}` },
        payload,
      });
    }

    async function rowsOn(employeeId: string, date: string) {
      return app.prisma.timeEntry.findMany({
        where: { employeeId, date: new Date(`${date}T00:00:00Z`) },
        include: { activityShares: { select: { kind: true, minutes: true } } },
      });
    }

    it("stores kind and shares with the entry; response and CREATE audit carry them", async () => {
      const date = nextPostDate();
      const res = await post(data.adminToken, {
        employeeId: data.employee.id,
        date,
        startTime: `${date}T08:00:00.000Z`,
        endTime: `${date}T17:00:00.000Z`,
        breaks: [{ startTime: `${date}T12:00:00.000Z`, endTime: `${date}T12:45:00.000Z` }],
        activityKind: "PRODUCTIVE",
        activityShares: [{ kind: "SETUP_CLEANING", minutes: 60 }],
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body) as {
        entry: { id: string; activityKind: string; activityShares: unknown[] };
      };
      expect(body.entry.activityKind).toBe("PRODUCTIVE");
      expect(body.entry.activityShares).toEqual([{ kind: "SETUP_CLEANING", minutes: 60 }]);
      const audit = await app.prisma.auditLog.findFirstOrThrow({
        where: { entity: "TimeEntry", entityId: body.entry.id, action: "CREATE" },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      expect((audit.newValue as { activityShares: unknown[] }).activityShares).toEqual([
        { kind: "SETUP_CLEANING", minutes: 60 },
      ]);
    });

    it("an entry written without activity input reads UNSPECIFIED with no shares (D-03)", async () => {
      const date = nextPostDate();
      const res = await post(data.adminToken, {
        employeeId: data.employee.id,
        date,
        startTime: `${date}T08:00:00.000Z`,
        endTime: `${date}T16:00:00.000Z`,
        breakMinutes: 30,
      });
      expect(res.statusCode).toBe(201);
      const rows = await rowsOn(data.employee.id, date);
      expect(rows).toHaveLength(1);
      expect(rows[0].activityKind).toBe("UNSPECIFIED");
      expect(rows[0].activityShares).toEqual([]);
    });

    it("shares on an entry without an end answer 409 and create no row; a kind alone is allowed", async () => {
      // An open entry overlaps every later entry of its owner, so it goes on the last allowed
      // day (the fake "today") of an employee whose other entries all lie earlier.
      const date = "2026-06-15";
      const payload = {
        employeeId: autoData.employee.id,
        date,
        startTime: `${date}T08:00:00.000Z`,
      };
      const withShare = await post(autoData.adminToken, {
        ...payload,
        activityShares: [{ kind: "SETUP_CLEANING", minutes: 10 }],
      });
      expect(withShare.statusCode).toBe(409);
      expect((JSON.parse(withShare.body) as { error: string }).error).toBe(OPEN_MESSAGE);
      expect(await rowsOn(autoData.employee.id, date)).toHaveLength(0);

      const kindOnly = await post(autoData.adminToken, { ...payload, activityKind: "PRODUCTIVE" });
      expect(kindOnly.statusCode).toBe(201);
      const [row] = await rowsOn(autoData.employee.id, date);
      expect(row.activityKind).toBe("PRODUCTIVE");
    });

    it("shares above the explicit working time answer 409 and create no row", async () => {
      const date = nextPostDate();
      const res = await post(data.adminToken, {
        employeeId: data.employee.id,
        date,
        startTime: `${date}T08:00:00.000Z`,
        endTime: `${date}T09:00:00.000Z`,
        activityKind: "PRODUCTIVE",
        activityShares: [{ kind: "SETUP_CLEANING", minutes: 90 }],
      });
      expect(res.statusCode).toBe(409);
      expect((JSON.parse(res.body) as { error: string }).error).toBe(SUM_MESSAGE);
      expect(await rowsOn(data.employee.id, date)).toHaveLength(0);
    });

    it("D-18: shares equal to the presence of an auto-break entry are rejected against the PREDICTED break", async () => {
      // 08:00-15:00 is 420 min of presence; the tenant default break for > 6 h is 30 min, so the
      // stored working time is 390. Judged against the presence (the break not yet written) the
      // 420 min would pass — only the predicted plan makes it a 409.
      const date = nextPostDate();
      const res = await post(autoData.adminToken, {
        employeeId: autoData.employee.id,
        date,
        startTime: `${date}T08:00:00.000Z`,
        endTime: `${date}T15:00:00.000Z`,
        activityKind: "PRODUCTIVE",
        activityShares: [{ kind: "SETUP_CLEANING", minutes: 420 }],
      });
      expect(res.statusCode).toBe(409);
      expect((JSON.parse(res.body) as { error: string }).error).toBe(SUM_MESSAGE);
      expect(await rowsOn(autoData.employee.id, date)).toHaveLength(0);
    });

    it("D-18: a share that fits the planned break is stored and the break equals the one written without shares", async () => {
      const withDate = nextPostDate();
      const withoutDate = nextPostDate();
      const input = (date: string) => ({
        employeeId: autoData.employee.id,
        date,
        startTime: `${date}T08:00:00.000Z`,
        endTime: `${date}T15:00:00.000Z`,
      });
      const withShares = await post(autoData.adminToken, {
        ...input(withDate),
        activityKind: "PRODUCTIVE",
        activityShares: [{ kind: "SETUP_CLEANING", minutes: 380 }],
      });
      expect(withShares.statusCode).toBe(201);
      const without = await post(autoData.adminToken, input(withoutDate));
      expect(without.statusCode).toBe(201);

      const [stored1] = await rowsOn(autoData.employee.id, withDate);
      const [stored2] = await rowsOn(autoData.employee.id, withoutDate);
      expect(stored1.breakMinutes).toBe(30);
      expect(stored1.breakMinutes).toBe(stored2.breakMinutes);
      const { entryDurations } = await import("../contexts/time-tracking");
      const working = entryDurations(stored1).workingMinutes;
      const sum = stored1.activityShares.reduce((acc, share) => acc + share.minutes, 0);
      expect(working).toBe(390);
      expect(sum).toBe(380);
      expect(sum).toBeLessThanOrEqual(working);
    });

    it("the pending Zeitnachtrag branch carries the share on the coupled invalid entry", async () => {
      const res = await post(data.empToken, {
        date: "2026-05-01",
        startTime: "2026-05-01T08:00:00.000Z",
        endTime: "2026-05-01T16:00:00.000Z",
        breakMinutes: 30,
        reason: "vergessen einzutragen",
        activityKind: "PRODUCTIVE",
        activityShares: [{ kind: "SETUP_CLEANING", minutes: 45 }],
      });
      expect(res.statusCode).toBe(201);
      const [row] = await rowsOn(data.employee.id, "2026-05-01");
      expect(row.isInvalid).toBe(true);
      expect(row.retroRequestId).not.toBeNull();
      expect(row.activityKind).toBe("PRODUCTIVE");
      expect(row.activityShares).toEqual([{ kind: "SETUP_CLEANING", minutes: 45 }]);
    });

    it("the grant branch carries kind and share on the CORRECTION entry", async () => {
      const grant = await app.prisma.retroEntryRequest.create({
        data: {
          employeeId: data.employee.id,
          targetDate: new Date("2026-05-04T00:00:00Z"),
          reason: "Freigabe fuer Nachtrag",
          startTime: "08:00",
          endTime: "16:00",
          breakMinutes: 30,
          status: "APPROVED",
        },
      });
      const res = await post(data.empToken, {
        date: "2026-05-04",
        startTime: "2026-05-04T08:00:00.000Z",
        endTime: "2026-05-04T16:00:00.000Z",
        breakMinutes: 30,
        grantId: grant.id,
        activityKind: "SETUP_CLEANING",
        activityShares: [{ kind: "PRODUCTIVE", minutes: 200 }],
      });
      expect(res.statusCode).toBe(201);
      const [row] = await rowsOn(data.employee.id, "2026-05-04");
      expect(row.source).toBe("CORRECTION");
      expect(row.activityKind).toBe("SETUP_CLEANING");
      expect(row.activityShares).toEqual([{ kind: "PRODUCTIVE", minutes: 200 }]);
    });
  });
  describe("remaining shrink sites and the soft delete (D-05, D-07)", () => {
    function appendBreak(token: string, id: string, date: string, from: string, to: string) {
      return app.inject({
        method: "POST",
        url: `/api/v1/time-entries/${id}/breaks`,
        headers: { authorization: `Bearer ${token}` },
        payload: { startTime: `${date}T${from}:00.000Z`, endTime: `${date}T${to}:00.000Z` },
      });
    }

    function revalidate(id: string, payload: Record<string, unknown>) {
      return app.inject({
        method: "PATCH",
        url: `/api/v1/time-entries/${id}/revalidate`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload,
      });
    }

    async function classified(
      date: string,
      minutes: number,
      extra: { isInvalid?: boolean; isLocked?: boolean } = {},
    ) {
      return createEntry(date, {
        kind: "PRODUCTIVE",
        shares: [{ kind: "SETUP_CLEANING", minutes }],
        breaks: [{ start: "12:00:00Z", end: "12:30:00Z" }],
        breakMinutes: 30,
        ...extra,
      });
    }

    it("an appended break that pushes the working time below the shares answers 409 and writes nothing", async () => {
      const date = nextDate();
      const entry = await classified(date, 500);
      const res = await appendBreak(data.adminToken, entry.id, date, "15:00", "15:30");
      expect(res.statusCode).toBe(409);
      expect((JSON.parse(res.body) as { error: string }).error).toBe(SUM_MESSAGE);
      const row = await stored(entry.id);
      expect(row.breaks).toHaveLength(1);
      expect(row.breakMinutes).toBe(30);
    });

    it("an appended break that still fits is stored", async () => {
      const date = nextDate();
      const entry = await classified(date, 400);
      const res = await appendBreak(data.adminToken, entry.id, date, "15:00", "15:30");
      expect(res.statusCode).toBe(200);
      const row = await stored(entry.id);
      expect(row.breaks).toHaveLength(2);
      expect(row.breakMinutes).toBe(60);
    });

    it("a locked entry still answers the existing 409 before the share check", async () => {
      const date = nextDate();
      const entry = await classified(date, 500, { isLocked: true });
      const res = await appendBreak(data.adminToken, entry.id, date, "15:00", "15:30");
      expect(res.statusCode).toBe(409);
      expect((JSON.parse(res.body) as { error: string }).error).not.toBe(SUM_MESSAGE);
      expect((await stored(entry.id)).breaks).toHaveLength(1);
    });

    it("a revalidation correction below the shares answers 409 and leaves the entry invalid", async () => {
      const date = nextDate();
      const entry = await classified(date, 400, { isInvalid: true });
      const shorter = await revalidate(entry.id, { endTime: `${date}T14:00:00.000Z` });
      expect(shorter.statusCode).toBe(409);
      const reopen = await revalidate(entry.id, { endTime: null });
      expect(reopen.statusCode).toBe(409);
      const row = await stored(entry.id);
      expect(row.isInvalid).toBe(true);
      expect(row.endTime?.toISOString()).toBe(`${date}T17:00:00.000Z`);
    });

    it("a fitting revalidation correction keeps the shares; a plain revalidation is not checked", async () => {
      const date = nextDate();
      const entry = await classified(date, 400, { isInvalid: true });
      const fitting = await revalidate(entry.id, { endTime: `${date}T16:00:00.000Z` });
      expect(fitting.statusCode).toBe(200);
      const row = await stored(entry.id);
      expect(row.isInvalid).toBe(false);
      expect(row.activityShares).toEqual([{ kind: "SETUP_CLEANING", minutes: 400 }]);

      const plainEntry = await classified(nextDate(), 400, { isInvalid: true });
      const plain = await revalidate(plainEntry.id, {});
      expect(plain.statusCode).toBe(200);
    });

    it("DELETE keeps the share rows and the audit oldValue carries them", async () => {
      const entry = await classified(nextDate(), 100);
      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/time-entries/${entry.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { reason: "Storno wegen Fehleingabe" },
      });
      expect(res.statusCode).toBe(204);
      const row = await stored(entry.id);
      expect(row.deletedAt).not.toBeNull();
      expect(row.activityShares).toEqual([{ kind: "SETUP_CLEANING", minutes: 100 }]);
      const audit = await newestAudit(entry.id);
      expect(audit.action).toBe("DELETE");
      expect((audit.oldValue as { activityShares: unknown[] }).activityShares).toEqual([
        { kind: "SETUP_CLEANING", minutes: 100 },
      ]);
    });
  });
});
