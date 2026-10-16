/**
 * Issue #70 (Phase 70b-05, AC-70-2, D-10) — the overlap rule holds for EVERY writer, at the
 * database level, and under concurrency.
 *
 * Block A writes raw Prisma rows (no route, no application check) so only the database can refuse:
 *  - two closed, non-deleted entries of one employee never overlap — also across dates (a night
 *    entry against the next day), valid or invalid, in any salon;
 *  - the interval is half-open: back-to-back entries and a zero-length row inside another's span are
 *    allowed; an inverted row is refused by the range constructor (SQLSTATE 22000) and is NOT
 *    recognised as an overlap (`isEntryOverlapViolation` false — it stays a visible server error);
 *  - soft-deleted rows do not block, and restoring one onto an occupied interval is refused;
 *  - other employees may overlap freely;
 *  - at most one OPEN live entry per employee and day (P2002 naming the partial unique index); a
 *    stale open entry of yesterday does not block today, but closing it later over today's entry is
 *    refused (the documented residual: ENTRY_OVERLAP at clock-out, correctable by a PUT).
 *
 * Block B proves concurrency: two parallel overlapping POSTs give exactly one 201 and one 409; the
 * database-level race (an uncommitted overlapping insert BLOCKS the second writer, observed through
 * `pg_blocking_pids`, and it is refused once the first commits); and a clock START racing a held
 * manual write is observed blocked on the Employee lock and then answers ENTRY_OVERLAP with nothing
 * written.
 *
 * Block C is the mutation proof: inside a transaction that always rolls back the guard is removed
 * and the overlapping insert goes through; after the rollback the guard is back and refuses again.
 * DDL holds an ACCESS EXCLUSIVE lock until the transaction ends — no `app.inject` and no read on
 * another connection while it is open (see `time-entry-activity-migration-81.test.ts`).
 *
 * No person names in fixtures.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Prisma } from "@clokr/db";
import { fromZonedTime } from "date-fns-tz";
import { getTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";
import { addDaysStr, nextWeekdayStr, pastDateStr, TEST_TZ } from "./test-dates";
import { holdEmployeeLockThen } from "./entry-lock-race-helpers";
import {
  isEntryOverlapViolation,
  isOpenEntryPerDayViolation,
} from "../contexts/time-tracking/entry-overlap-error";

/** Thrown at the end of the mutation transaction so the removed guard always rolls back. */
class OverlapGuardMutationRollback extends Error {}

/** Tenant-local instant for `HH:MM` on `dayStr`. */
function at(dayStr: string, hhmm: string): Date {
  return fromZonedTime(`${dayStr}T${hhmm}:00`, TEST_TZ);
}

/** UTC instant for `HH:MM` on `dayStr` (raw rows: the time zone is irrelevant to the constraint). */
function utc(dayStr: string, hhmm: string): Date {
  return new Date(`${dayStr}T${hhmm}:00Z`);
}

/** The error a promise rejected with; fails when it resolved (a refused write must be refused). */
async function refusal(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected the write to be refused, but it succeeded");
}

describe("Issue #70 — the overlap rule at the database level", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: { id: string };
  let salonB: { id: string };
  let empId: string;
  let otherEmpId: string;

  // Raw cases live on distinct fixed days (the constraint is calendar-independent); each case owns
  // one day (three days apart, so the "next day" of the night-entry case is nobody else's day).
  const BASE = "2026-06-01";
  const dayOf = (n: number): string => addDaysStr(BASE, n * 3);

  type RowOpts = {
    employeeId?: string;
    salonId?: string;
    date?: string;
    extra?: Record<string, unknown>;
  };

  /** Create a raw row: `start`/`end` are instants; `date` defaults to the start's UTC day. */
  function row(start: Date, end: Date | null, opts: RowOpts = {}) {
    return app.prisma.timeEntry.create({
      data: {
        employeeId: opts.employeeId ?? empId,
        salonId: opts.salonId ?? salonA.id,
        date: new Date(`${opts.date ?? start.toISOString().slice(0, 10)}T00:00:00Z`),
        startTime: start,
        endTime: end,
        source: "MANUAL",
        breakMinutes: 0,
        ...opts.extra,
      },
    });
  }

  const liveCount = (employeeId: string, date: string) =>
    app.prisma.timeEntry.count({
      where: { employeeId, date: new Date(`${date}T00:00:00Z`), deletedAt: null },
    });

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "ovl70c");
    salonA = await createTestSalon(app.prisma, seed.tenant.id, { name: "Salon A" });
    salonB = await createTestSalon(app.prisma, seed.tenant.id, { name: "Salon B" });
    empId = seed.employee.id;
    otherEmpId = seed.adminEmployee.id;
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, seed.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
  });

  it("refuses an overlapping closed entry on the same date, in another salon too", async () => {
    const d = dayOf(0);
    await row(utc(d, "08:00"), utc(d, "12:00"));
    const err = await refusal(row(utc(d, "10:00"), utc(d, "14:00"), { salonId: salonB.id }));
    expect(isEntryOverlapViolation(err)).toBe(true);
    expect(isOpenEntryPerDayViolation(err)).toBe(false);
    expect(await liveCount(empId, d)).toBe(1);
  });

  it("refuses an overlap ACROSS dates: a night entry against the next day's entry", async () => {
    const d = dayOf(1);
    const next = addDaysStr(d, 1);
    await row(utc(d, "22:00"), utc(next, "02:00"), { date: d });
    const err = await refusal(row(utc(next, "01:00"), utc(next, "03:00"), { date: next }));
    expect(isEntryOverlapViolation(err)).toBe(true);
    expect(await liveCount(empId, next)).toBe(0);
    // Control: the same next-day entry AFTER the night entry ends is fine.
    await row(utc(next, "02:00"), utc(next, "04:00"), { date: next });
    expect(await liveCount(empId, next)).toBe(1);
  });

  it("allows back-to-back entries (half-open interval)", async () => {
    const d = dayOf(2);
    await row(utc(d, "08:00"), utc(d, "12:00"));
    await row(utc(d, "12:00"), utc(d, "16:00"), { salonId: salonB.id });
    expect(await liveCount(empId, d)).toBe(2);
  });

  it("allows a zero-length row inside another entry's span", async () => {
    const d = dayOf(3);
    await row(utc(d, "08:00"), utc(d, "12:00"));
    await row(utc(d, "10:00"), utc(d, "10:00"));
    expect(await liveCount(empId, d)).toBe(2);
  });

  it("refuses an inverted row (end before start), and does NOT recognise it as an overlap", async () => {
    const d = dayOf(4);
    const err = (await refusal(row(utc(d, "12:00"), utc(d, "10:00")))) as {
      code?: string;
      meta?: {
        driverAdapterError?: { cause?: { originalCode?: string; originalMessage?: string } };
      };
    };
    expect(err.code).toBe("P2039");
    const cause = err.meta?.driverAdapterError?.cause;
    expect(cause?.originalCode).toBe("22000");
    expect(cause?.originalMessage).toContain("range lower bound must be less than or equal");
    expect(isEntryOverlapViolation(err), "an inverted row stays a visible server error").toBe(
      false,
    );
    expect(await liveCount(empId, d)).toBe(0);
  });

  it("does not let a soft-deleted entry block, and refuses restoring it onto an occupied interval", async () => {
    const d = dayOf(5);
    await row(utc(d, "08:00"), utc(d, "12:00"));
    const deleted = await row(utc(d, "09:00"), utc(d, "11:00"), {
      extra: { deletedAt: new Date("2026-06-10T00:00:00Z") },
    });
    // The live entry written over a soft-deleted one's interval is accepted as well.
    await row(utc(d, "09:00"), utc(d, "10:00"), { employeeId: otherEmpId });
    expect(await liveCount(empId, d)).toBe(1);

    const err = await refusal(
      app.prisma.timeEntry.update({ where: { id: deleted.id }, data: { deletedAt: null } }),
    );
    expect(isEntryOverlapViolation(err)).toBe(true);
    const still = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: deleted.id } });
    expect(still.deletedAt).not.toBeNull();
  });

  it("counts an invalid closed entry: it still occupies its interval", async () => {
    const d = dayOf(6);
    await row(utc(d, "08:00"), utc(d, "12:00"), {
      extra: { isInvalid: true, invalidReason: "ovl70" },
    });
    const err = await refusal(row(utc(d, "11:00"), utc(d, "13:00")));
    expect(isEntryOverlapViolation(err)).toBe(true);
  });

  it("refuses moving a closed entry onto another (UPDATE path)", async () => {
    const d = dayOf(7);
    await row(utc(d, "08:00"), utc(d, "12:00"));
    const movable = await row(utc(d, "13:00"), utc(d, "15:00"));
    const err = await refusal(
      app.prisma.timeEntry.update({
        where: { id: movable.id },
        data: { startTime: utc(d, "11:00") },
      }),
    );
    expect(isEntryOverlapViolation(err)).toBe(true);
    const unchanged = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: movable.id } });
    expect(unchanged.startTime.getTime()).toBe(utc(d, "13:00").getTime());
  });

  it("lets other employees overlap freely", async () => {
    const d = dayOf(8);
    await row(utc(d, "08:00"), utc(d, "12:00"));
    await row(utc(d, "08:00"), utc(d, "12:00"), { employeeId: otherEmpId });
    expect(await liveCount(empId, d)).toBe(1);
    expect(await liveCount(otherEmpId, d)).toBe(1);
  });

  it("refuses a second OPEN entry of one employee and day, naming the partial unique index", async () => {
    const d = dayOf(9);
    await row(utc(d, "08:00"), null);
    const err = await refusal(row(utc(d, "09:00"), null, { salonId: salonB.id }));
    expect((err as { code?: string }).code).toBe("P2002");
    expect(isOpenEntryPerDayViolation(err)).toBe(true);
    expect(isEntryOverlapViolation(err)).toBe(false);
    // Controls: another employee's open row, and a soft-deleted open row, do not count.
    await row(utc(d, "08:00"), null, { employeeId: otherEmpId });
    await row(utc(d, "07:00"), null, { extra: { deletedAt: new Date("2026-06-10T00:00:00Z") } });
    expect(await liveCount(empId, d)).toBe(1);
  });

  it("lets a stale open entry of yesterday coexist with a closed entry of today", async () => {
    const yesterday = dayOf(10);
    const today = dayOf(11);
    await row(utc(yesterday, "20:00"), null);
    await row(utc(today, "08:00"), utc(today, "12:00"));
    expect(await liveCount(empId, yesterday)).toBe(1);
    expect(await liveCount(empId, today)).toBe(1);
  });

  it("refuses closing that stale open entry over today's entry (documented residual: ENTRY_OVERLAP at clock-out)", async () => {
    const yesterday = dayOf(12);
    const today = dayOf(13);
    const stale = await row(utc(yesterday, "20:00"), null);
    await row(utc(today, "08:00"), utc(today, "12:00"));
    const err = await refusal(
      app.prisma.timeEntry.update({
        where: { id: stale.id },
        data: { endTime: utc(today, "10:00") },
      }),
    );
    expect(isEntryOverlapViolation(err)).toBe(true);
    // Correctable: an end time that stays clear of today's entry is accepted.
    await app.prisma.timeEntry.update({
      where: { id: stale.id },
      data: { endTime: utc(today, "07:00") },
    });
    const closed = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: stale.id } });
    expect(closed.endTime?.getTime()).toBe(utc(today, "07:00").getTime());
  });
});

/** A fixed raw-case day for the race block (the constraint is calendar-independent). */
function dayOf0(n: number): string {
  return addDaysStr("2026-07-01", n);
}

describe("Issue #70 — the overlap rule under concurrency", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: { id: string };
  let salonB: { id: string };

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "ovl70r");
    salonA = await createTestSalon(app.prisma, seed.tenant.id, { name: "Salon A" });
    salonB = await createTestSalon(app.prisma, seed.tenant.id, { name: "Salon B" });
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await cleanupTestData(app, seed.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
  });

  const live = (day: string) =>
    app.prisma.timeEntry.findMany({
      where: {
        employeeId: seed.employee.id,
        date: new Date(`${day}T00:00:00Z`),
        deletedAt: null,
      },
      orderBy: [{ startTime: "asc" }, { id: "asc" }],
    });

  it("two parallel overlapping POSTs: exactly one 201 and one 409, one row", async () => {
    const day = nextWeekdayStr(pastDateStr(9));
    const post = (from: string, to: string, salonId: string) =>
      app.inject({
        method: "POST",
        url: "/api/v1/time-entries",
        headers: { authorization: `Bearer ${seed.empToken}` },
        payload: {
          date: day,
          startTime: at(day, from).toISOString(),
          endTime: at(day, to).toISOString(),
          salonId,
        },
      });
    const [one, two] = await Promise.all([
      post("08:00", "12:00", salonA.id),
      post("10:00", "14:00", salonB.id),
    ]);
    expect([one.statusCode, two.statusCode].sort(), `${one.body} | ${two.body}`).toEqual([
      201, 409,
    ]);
    expect(await live(day)).toHaveLength(1);
  });

  /**
   * The database race: the first transaction inserts a closed entry and keeps it uncommitted, the
   * second writes an overlapping one. The exclusion constraint makes the second writer WAIT for the
   * first's outcome — observed as `pg_blocking_pids` — and refuses it once the first commits.
   */
  async function raceTwoTransactions(
    firstWork: (tx: Prisma.TransactionClient) => Promise<unknown>,
    secondWork: (tx: Prisma.TransactionClient) => Promise<unknown>,
    firstEnds: "commit" | "rollback",
  ) {
    let releaseFirst: (() => void) | undefined;
    const holdGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let signalFirst: ((pid: number) => void) | undefined;
    const firstReady = new Promise<number>((resolve) => {
      signalFirst = resolve;
    });
    class FirstRolledBack extends Error {}
    const firstPromise = app.prisma.$transaction(
      async (tx) => {
        const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        await firstWork(tx);
        signalFirst?.(pid);
        await holdGate;
        if (firstEnds === "rollback") throw new FirstRolledBack();
      },
      { timeout: 20000, maxWait: 20000 },
    );
    const firstPid = await Promise.race([
      firstReady,
      firstPromise.then(
        () => Promise.reject(new Error("first transaction ended before it signalled")),
        (err: unknown) => Promise.reject(err),
      ),
    ]);

    let signalSecondPid: ((pid: number) => void) | undefined;
    const secondPidKnown = new Promise<number>((resolve) => {
      signalSecondPid = resolve;
    });
    let secondSettled = false;
    const secondPromise = app.prisma
      .$transaction(
        async (tx) => {
          const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
          signalSecondPid?.(pid);
          return secondWork(tx);
        },
        { timeout: 20000, maxWait: 20000 },
      )
      .finally(() => {
        secondSettled = true;
      });
    const secondPid = await secondPidKnown;

    const deadline = Date.now() + 10000;
    let blocked = false;
    while (!secondSettled && Date.now() < deadline) {
      const [{ blockers }] = await app.prisma.$queryRaw<{ blockers: number[] }[]>`
        SELECT pg_blocking_pids(${secondPid}::int) AS blockers`;
      if (blockers.includes(firstPid)) {
        blocked = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    releaseFirst?.();
    const [first, second] = await Promise.allSettled([firstPromise, secondPromise]);
    return { first, second, blocked };
  }

  const rawInsert = (tx: Prisma.TransactionClient, day: string, from: string, to: string) =>
    tx.timeEntry.create({
      data: {
        employeeId: seed.employee.id,
        salonId: salonA.id,
        date: new Date(`${day}T00:00:00Z`),
        startTime: utc(day, from),
        endTime: utc(day, to),
        source: "MANUAL",
        breakMinutes: 0,
      },
    });

  it("an uncommitted overlapping insert blocks the second writer, which is refused once the first commits", async () => {
    const day = dayOf0(20);
    const { first, second, blocked } = await raceTwoTransactions(
      (tx) => rawInsert(tx, day, "08:00", "12:00"),
      (tx) => rawInsert(tx, day, "10:00", "14:00"),
      "commit",
    );
    expect(blocked, "PostgreSQL reports the second writer blocked by the first").toBe(true);
    expect(first.status).toBe("fulfilled");
    expect(second.status).toBe("rejected");
    expect(isEntryOverlapViolation((second as PromiseRejectedResult).reason)).toBe(true);
    expect(await live(day)).toHaveLength(1);
  });

  it("control: when the first writer rolls back, the blocked second writer succeeds", async () => {
    const day = dayOf0(21);
    const { first, second, blocked } = await raceTwoTransactions(
      (tx) => rawInsert(tx, day, "08:00", "12:00"),
      (tx) => rawInsert(tx, day, "10:00", "14:00"),
      "rollback",
    );
    expect(blocked).toBe(true);
    expect(first.status).toBe("rejected");
    expect(second.status).toBe("fulfilled");
    const rows = await live(day);
    expect(rows).toHaveLength(1);
    expect(rows[0].startTime.getTime()).toBe(utc(day, "10:00").getTime());
  });

  it("a clock START racing a held manual write queues on the Employee lock, then answers ENTRY_OVERLAP and writes nothing", async () => {
    const day = nextWeekdayStr(pastDateStr(14));
    const clockIn = async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(at(day, "13:30"));
      try {
        return await app.inject({
          method: "POST",
          url: "/api/v1/time-entries/clock-in",
          headers: { authorization: `Bearer ${seed.empToken}` },
          payload: { salonId: salonB.id },
        });
      } finally {
        vi.useRealTimers();
      }
    };

    const { result, blocked } = await holdEmployeeLockThen(app, {
      tenantId: seed.tenant.id,
      employeeId: seed.employee.id,
      start: clockIn,
      holderWork: async (tx) => {
        await tx.timeEntry.create({
          data: {
            employeeId: seed.employee.id,
            salonId: salonA.id,
            date: new Date(`${day}T00:00:00Z`),
            startTime: at(day, "13:00"),
            endTime: at(day, "14:00"),
            source: "MANUAL",
            breakMinutes: 0,
          },
        });
      },
    });

    expect(blocked, "the clock START must queue on the employee lock").toBe(true);
    expect(result.statusCode, result.body).toBe(409);
    expect(JSON.parse(result.body).code).toBe("ENTRY_OVERLAP");
    const rows = await live(day);
    expect(rows).toHaveLength(1);
    expect(rows[0].salonId).toBe(salonA.id);
    expect(rows[0].endTime?.getTime()).toBe(at(day, "14:00").getTime());
    const audits = await app.prisma.auditLog.count({
      where: { entity: "TimeEntry", entityId: { in: rows.map((r) => r.id) }, action: "CLOCK_IN" },
    });
    expect(audits, "the refused START wrote no CLOCK_IN row").toBe(0);
  });
});

describe("Issue #70 — mutation proof: without the guard the overlap goes through", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: { id: string };

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "ovl70m");
    salonA = await createTestSalon(app.prisma, seed.tenant.id, { name: "Salon A" });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, seed.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
  });

  it("the overlapping insert succeeds with the exclusion constraint dropped (rolled back), and is refused again afterwards", async () => {
    const day = "2026-08-03";
    const insert = (
      db: Prisma.TransactionClient | FastifyInstance["prisma"],
      from: string,
      to: string,
    ) =>
      db.timeEntry.create({
        data: {
          employeeId: seed.employee.id,
          salonId: salonA.id,
          date: new Date(`${day}T00:00:00Z`),
          startTime: utc(day, from),
          endTime: utc(day, to),
          source: "MANUAL",
          breakMinutes: 0,
        },
      });

    // With the guard: the overlap is refused.
    await insert(app.prisma, "08:00", "12:00");
    const guarded = await refusal(insert(app.prisma, "10:00", "14:00"));
    expect(isEntryOverlapViolation(guarded)).toBe(true);

    let rowsWithoutGuard = -1;
    await expect(
      app.prisma.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(
            `ALTER TABLE "TimeEntry" DROP CONSTRAINT "TimeEntry_no_overlap_closed"`,
          );
          await insert(tx, "10:00", "14:00");
          rowsWithoutGuard = await tx.timeEntry.count({
            where: { employeeId: seed.employee.id, deletedAt: null },
          });
          throw new OverlapGuardMutationRollback();
        },
        { timeout: 30_000 },
      ),
    ).rejects.toThrow(OverlapGuardMutationRollback);

    expect(rowsWithoutGuard, "without the guard both overlapping rows exist").toBe(2);

    // Rollback proof: the guard is back, the overlap row never landed, the overlap is refused again.
    const constraint = await app.prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM pg_constraint
      WHERE conrelid = '"TimeEntry"'::regclass AND conname = 'TimeEntry_no_overlap_closed'`;
    expect(Number(constraint[0].n)).toBe(1);
    expect(await app.prisma.timeEntry.count({ where: { employeeId: seed.employee.id } })).toBe(1);
    const again = await refusal(insert(app.prisma, "10:00", "14:00"));
    expect(isEntryOverlapViolation(again)).toBe(true);
  });
});
