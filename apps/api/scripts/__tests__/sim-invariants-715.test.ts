/**
 * Issue #715 - proof that every database invariant of the simulation checker (apps/sim) turns red on
 * a deliberately injected violation and stays green on clean data, and that the checker's
 * connection cannot write.
 *
 * Violations are injected inside a `$transaction` that always ends by throwing a module-private
 * sentinel, so nothing lands in the worker database. The guard objects the product relies on
 * (exclusion constraint, partial unique index) are dropped inside that same transaction, because the
 * database would otherwise refuse the very rows the check exists to catch. DDL holds an ACCESS
 * EXCLUSIVE lock until the transaction ends, so no other connection reads meanwhile. Assertions run
 * AFTER the rollback, on values captured outside the callback.
 *
 * The findings are filtered to this test's own ids: the worker database may hold rows of earlier test
 * files, and the invariants scan the whole database like they do in the simulation.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Prisma } from "@clokr/db";
import {
  cleanupTestData,
  createTestSalon,
  getTestApp,
  seedTestData,
} from "../../src/__tests__/setup";
import { connectReadOnly } from "../../../sim/src/checker/db";
import {
  DB_INVARIANTS,
  auditCoverage,
  closedMonthsUnchanged,
  noOverlap,
  singleOpenPerDay,
  tenantReferences,
} from "../../../sim/src/checker/invariants-db";
import { arbzgOnlyWhereIntended } from "../../../sim/src/checker/invariants-rules";
import type {
  CheckContext,
  Finding,
  Invariant,
  InvariantResult,
  Queryable,
} from "../../../sim/src/checker/types";

class RollbackSentinel extends Error {}

const TODAY = "2026-04-10";

function queryable(db: {
  $queryRawUnsafe: (sql: string, ...values: unknown[]) => Promise<unknown>;
}): Queryable {
  return {
    query: async <R>(sql: string, params: unknown[] = []) => ({
      rows: (await db.$queryRawUnsafe(sql, ...params)) as R[],
    }),
  };
}

describe("sim invariants (#715) - database checks prove themselves", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let other: Awaited<ReturnType<typeof seedTestData>>;
  let emp: string;
  let ctxBase: Omit<CheckContext, "db">;

  const only = (findings: Finding[], ...ids: string[]) =>
    findings.filter((f) => ids.some((id) => f.key.includes(id) || f.message.includes(id)));

  async function runIn(
    invariant: Invariant,
    inject: (tx: Prisma.TransactionClient) => Promise<void>,
    overrides: Partial<CheckContext> = {},
  ): Promise<InvariantResult> {
    let outcome: InvariantResult | undefined;
    await expect(
      app.prisma.$transaction(async (tx) => {
        await inject(tx);
        outcome = await invariant.run({ ...ctxBase, ...overrides, db: queryable(tx) });
        throw new RollbackSentinel();
      }),
    ).rejects.toBeInstanceOf(RollbackSentinel);
    return outcome!;
  }

  async function entry(
    tx: Prisma.TransactionClient,
    day: string,
    start: string,
    end: string | null,
    extra: {
      employeeId?: string;
      salonId?: string;
      breakMinutes?: number;
      isLocked?: boolean;
    } = {},
  ): Promise<string> {
    const row = await tx.timeEntry.create({
      data: {
        employeeId: extra.employeeId ?? emp,
        salonId: extra.salonId ?? data.salonId,
        date: new Date(day),
        startTime: new Date(`${day}T${start}Z`),
        endTime: end ? new Date(`${day}T${end}Z`) : null,
        breakMinutes: extra.breakMinutes ?? 0,
        isLocked: extra.isLocked ?? false,
        source: "MANUAL",
      },
    });
    return row.id;
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "sim715");
    other = await seedTestData(app, "sim715b");
    emp = data.employee.id;
    ctxBase = {
      api: undefined as never,
      adminToken: "",
      state: {
        plan: { seed: "t", epoch: TODAY, tenants: [] },
        provisionedAt: "",
        tenants: {
          chain: {
            tenantId: data.tenant.id,
            adminEmail: "",
            adminPassword: "",
            salonIds: [data.salonId],
            terminalKey: null,
            presenceKey: null,
            persons: {
              p1: { employeeId: emp, userId: "", created: true, exited: false, anonymized: false },
            },
          },
        },
      },
      progress: {
        shiftsPlannedThrough: {},
        shifts: {},
        leave: {},
        closedMonths: {},
        weeklyHours: {},
        holidayMonths: [],
        intents: [],
        sampleEntryIds: [],
        daysSimulated: ["2026-04-08", "2026-04-09"],
      },
      dayLogs: [],
      seed: "t",
      today: TODAY,
      since: new Date(Date.now() - 3600_000),
      checksums: { entries: {}, snapshots: {} },
    };
  });

  afterAll(async () => {
    for (const t of [data, other]) {
      try {
        await cleanupTestData(app, t.tenant.id);
      } catch (err) {
        console.error("Test cleanup failed:", err);
      }
    }
  });

  it("registers every database invariant (a removed check cannot go unnoticed)", () => {
    expect(DB_INVARIANTS.map((i) => i.id)).toEqual([
      "entries.no-overlap",
      "entries.single-open-per-day",
      "months.closed-unchanged",
      "audit.coverage",
      "tenant.references",
    ]);
  });

  it("entries.no-overlap: green on back-to-back entries, red on a real overlap", async () => {
    const clean = await runIn(noOverlap, async (tx) => {
      await entry(tx, "2026-03-02", "08:00:00", "12:00:00");
      await entry(tx, "2026-03-02", "12:00:00", "16:00:00");
    });
    expect(clean.examined).toBeGreaterThanOrEqual(2);
    expect(only(clean.findings, emp)).toEqual([]);

    const ids: string[] = [];
    const dirty = await runIn(noOverlap, async (tx) => {
      await tx.$executeRawUnsafe(
        `ALTER TABLE "TimeEntry" DROP CONSTRAINT "TimeEntry_no_overlap_closed"`,
      );
      ids.push(await entry(tx, "2026-03-10", "08:00:00", "12:00:00"));
      ids.push(await entry(tx, "2026-03-10", "11:00:00", "13:00:00"));
    });
    const hits = dirty.findings.filter((f) => ids.every((id) => f.key.includes(id)));
    expect(hits).toHaveLength(1);
    expect(hits[0].invariant).toBe("entries.no-overlap");
  });

  it("entries.single-open-per-day: green on one open entry, red on two", async () => {
    const clean = await runIn(singleOpenPerDay, async (tx) => {
      await entry(tx, "2026-03-05", "08:00:00", null);
    });
    expect(clean.examined).toBeGreaterThanOrEqual(1);
    expect(only(clean.findings, emp)).toEqual([]);

    const dirty = await runIn(singleOpenPerDay, async (tx) => {
      await tx.$executeRawUnsafe(`DROP INDEX "TimeEntry_employeeId_date_open_unique"`);
      await entry(tx, "2026-03-16", "08:00:00", null);
      await entry(tx, "2026-03-16", "09:00:00", null);
    });
    const hits = only(dirty.findings, emp);
    expect(hits).toHaveLength(1);
    expect(hits[0].key).toBe(`multi-open:${emp}:2026-03-16`);
  });

  it("months.closed-unchanged: green when nothing moved, red when a closed month's rows change or vanish", async () => {
    let baseline: CheckContext["nextChecksums"];
    const first = await runIn(
      closedMonthsUnchanged,
      async (tx) => {
        await entry(tx, "2026-02-03", "08:00:00", "16:00:00", { isLocked: true, breakMinutes: 30 });
        await tx.saldoSnapshot.create({
          data: {
            employeeId: emp,
            periodType: "MONTHLY",
            periodStart: new Date("2026-02-01"),
            periodEnd: new Date("2026-02-28"),
            workedMinutes: 450,
            expectedMinutes: 480,
            balanceMinutes: -30,
            carryOver: -30,
            closedAt: new Date("2026-03-02T08:00:00Z"),
          },
        });
      },
      {},
    );
    expect(first.examined).toBeGreaterThanOrEqual(2);
    expect(only(first.findings, emp)).toEqual([]);

    // Second pass: take the baseline, then change both a locked entry and the snapshot.
    const second = await (async () => {
      let out: InvariantResult | undefined;
      await expect(
        app.prisma.$transaction(async (tx) => {
          const id = await entry(tx, "2026-02-03", "08:00:00", "16:00:00", {
            isLocked: true,
            breakMinutes: 30,
          });
          const snap = await tx.saldoSnapshot.create({
            data: {
              employeeId: emp,
              periodType: "MONTHLY",
              periodStart: new Date("2026-02-01"),
              periodEnd: new Date("2026-02-28"),
              workedMinutes: 450,
              expectedMinutes: 480,
              balanceMinutes: -30,
              carryOver: -30,
              closedAt: new Date("2026-03-02T08:00:00Z"),
            },
          });
          const ctx: CheckContext = { ...ctxBase, db: queryable(tx) };
          await closedMonthsUnchanged.run(ctx);
          baseline = ctx.nextChecksums;
          // Unchanged: green against its own baseline.
          const same: CheckContext = { ...ctxBase, db: queryable(tx), checksums: baseline! };
          const green = await closedMonthsUnchanged.run(same);
          expect(only(green.findings, emp)).toEqual([]);
          // Now tamper: a closed month's entry and its snapshot.
          await tx.timeEntry.update({
            where: { id },
            data: { endTime: new Date("2026-02-03T17:00:00Z") },
          });
          await tx.saldoSnapshot.delete({ where: { id: snap.id } });
          out = await closedMonthsUnchanged.run({
            ...ctxBase,
            db: queryable(tx),
            checksums: baseline!,
          });
          throw new RollbackSentinel();
        }),
      ).rejects.toBeInstanceOf(RollbackSentinel);
      return out!;
    })();
    const hits = only(second.findings, emp);
    expect(hits.map((f) => f.key.split(":").slice(0, 2).join(":")).sort()).toEqual([
      "closed-changed:entries",
      "closed-gone:snapshots",
    ]);
  });

  it("audit.coverage: red for an entry without audit entry, green once the audit entry exists", async () => {
    let entryId = "";
    const red = await runIn(auditCoverage, async (tx) => {
      entryId = await entry(tx, "2026-04-01", "08:00:00", "16:00:00");
    });
    expect(red.examined).toBeGreaterThanOrEqual(1);
    expect(red.findings.map((f) => f.key)).toContain(`audit-missing-create:TimeEntry:${entryId}`);

    const green = await runIn(auditCoverage, async (tx) => {
      entryId = await entry(tx, "2026-04-01", "08:00:00", "16:00:00");
      await tx.auditLog.create({
        data: { action: "CREATE", entity: "TimeEntry", entityId: entryId },
      });
    });
    expect(only(green.findings, entryId)).toEqual([]);

    // A later change without a matching audit entry is red as well.
    const changed = await runIn(auditCoverage, async (tx) => {
      entryId = await entry(tx, "2026-04-02", "08:00:00", "16:00:00");
      await tx.auditLog.create({
        data: { action: "CREATE", entity: "TimeEntry", entityId: entryId },
      });
      await tx.$executeRawUnsafe(
        `UPDATE "TimeEntry" SET "updatedAt" = "createdAt" + interval '5 minutes' WHERE "id" = $1`,
        entryId,
      );
    });
    expect(changed.findings.map((f) => f.key)).toContain(
      `audit-missing-change:TimeEntry:${entryId}`,
    );
  });

  it("tenant.references: red when an entry points at another tenant's salon", async () => {
    const clean = await runIn(tenantReferences, async (tx) => {
      await entry(tx, "2026-03-20", "08:00:00", "12:00:00");
    });
    expect(clean.examined).toBeGreaterThanOrEqual(1);
    expect(only(clean.findings, emp)).toEqual([]);

    let entryId = "";
    const dirty = await runIn(tenantReferences, async (tx) => {
      const foreign = await createTestSalon(tx, other.tenant.id);
      entryId = await entry(tx, "2026-03-20", "08:00:00", "12:00:00", { salonId: foreign.id });
    });
    expect(dirty.findings.map((f) => f.key)).toContain(`tenant-ref:TimeEntry:${entryId}`);
  });

  it("arbzg.only-intended: red for an unplanned 11 h day without break, green when a bot caused it", async () => {
    const inject = async (tx: Prisma.TransactionClient) => {
      await entry(tx, "2026-04-03", "06:00:00", "17:00:00");
    };
    const red = await runIn(arbzgOnlyWhereIntended, inject);
    expect(red.examined).toBeGreaterThanOrEqual(1);
    expect(
      only(red.findings, emp)
        .map((f) => f.key)
        .sort(),
    ).toEqual([`arbzg:missing-break:${emp}:2026-04-03`, `arbzg:over-10h-day:${emp}:2026-04-03`]);

    const green = await runIn(arbzgOnlyWhereIntended, inject, {
      progress: {
        ...ctxBase.progress,
        intents: [{ date: "2026-04-03", tenant: "chain", person: "p1", kind: "LONG_DAY" }],
      },
    });
    expect(only(green.findings, emp)).toEqual([]);

    // A short day with a break never produces a finding.
    const ok = await runIn(arbzgOnlyWhereIntended, async (tx) => {
      await entry(tx, "2026-04-06", "08:00:00", "16:30:00", { breakMinutes: 30 });
    });
    expect(only(ok.findings, emp)).toEqual([]);
  });

  it("the checker's connection cannot write", async () => {
    const url = process.env.DATABASE_URL;
    expect(url).toBeTruthy();
    const conn = await connectReadOnly(url!);
    try {
      const read = await conn.query<{ n: string }>(`SELECT count(*) AS n FROM "Tenant"`);
      expect(Number(read.rows[0].n)).toBeGreaterThanOrEqual(2);
      await expect(
        conn.query(
          `INSERT INTO "AuditLog" ("id", "action", "entity") VALUES (gen_random_uuid()::text, 'X', 'Y')`,
        ),
      ).rejects.toThrow(/read-only transaction/);
    } finally {
      await conn.close();
    }
  });
});
