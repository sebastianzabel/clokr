/**
 * Issue #70 (Phase 70b) — fixture test for audit-70-entry-overlaps.ts.
 *
 * The script is a read-only pre-deploy check: it lists the TimeEntry rows the no-overlap guarantee of
 * the 70b migration would refuse. The test database already carries that guarantee, so the violating
 * rows cannot be committed. They are inserted inside a `$transaction` that first removes the guard for
 * THAT transaction only (DROP CONSTRAINT / DROP INDEX are transactional in PostgreSQL) and always ends by
 * throwing a module-private sentinel, so nothing the test does lands in the shared test database.
 * Assertions run AFTER the rejection, on values captured outside the callback (an assertion failure
 * inside the callback would be masked by the rollback). The DDL holds an ACCESS EXCLUSIVE lock on
 * "TimeEntry" until the transaction ends — no `app.inject` and no read on another connection meanwhile.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, seedTestData, cleanupTestData } from "../../src/__tests__/setup";
import {
  main,
  parseCli,
  findEntryOverlapFindings,
  formatFindingLines,
  formatTotals,
  exitCodeFor,
  EXIT_OK,
  EXIT_FINDINGS,
  type EntryOverlapFindings,
} from "../audit-70-entry-overlaps";

/** Thrown at the end of the transaction so the removed guard and the violating rows always roll back. */
class OverlapAuditRollback extends Error {}

async function capture(fn: () => Promise<number>): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  try {
    const code = await fn();
    return { code, lines };
  } finally {
    spy.mockRestore();
  }
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function pairKey(a: string, b: string): string {
  return [a, b].sort(compareIds).join("|");
}

describe("audit-70-entry-overlaps — CLI and formatting (pure)", () => {
  it("rejects every write flag: the script has no mode that changes data", () => {
    expect(() => parseCli(["--confirm"])).toThrow();
    expect(() => parseCli(["--apply"])).toThrow();
    expect(() => parseCli(["--fix"])).toThrow();
  });

  it("accepts a UUID tenant selection and rejects anything else", () => {
    const uuid = "11111111-1111-4111-8111-111111111111";
    expect(parseCli(["--tenant-id", uuid])).toMatchObject({ tenantId: uuid, help: false });
    expect(parseCli([])).toMatchObject({ tenantId: null });
    expect(() => parseCli(["--tenant-id", "not-a-uuid"])).toThrow(/must be a UUID/);
  });

  it("maps findings to the repo exit-code convention and prints ids only", () => {
    const none: EntryOverlapFindings = { overlaps: [], inverted: [], multipleOpen: [] };
    expect(exitCodeFor(none)).toBe(EXIT_OK);
    expect(formatTotals(none)).toBe("Totals: overlap=0 inverted=0 multipleOpen=0");
    expect(formatFindingLines(none)).toEqual([]);

    const some: EntryOverlapFindings = {
      overlaps: [{ tenantId: "t", employeeId: "e", entryIdA: "a", entryIdB: "b" }],
      inverted: [{ tenantId: "t", employeeId: "e", entryId: "c" }],
      multipleOpen: [{ tenantId: "t", employeeId: "e", date: "2026-03-16", entryIds: ["d", "f"] }],
    };
    expect(exitCodeFor(some)).toBe(EXIT_FINDINGS);
    expect(formatFindingLines(some)).toEqual([
      "overlap tenantId=t employeeId=e entryA=a entryB=b",
      "inverted tenantId=t employeeId=e entryId=c",
      "multipleOpen tenantId=t employeeId=e date=2026-03-16 entryIds=d,f",
    ]);
    expect(formatTotals(some)).toBe("Totals: overlap=1 inverted=1 multipleOpen=1");
  });

  it("contains no statement that writes: the source has no SQL write keyword and no Prisma write call", () => {
    const source = readFileSync(join(__dirname, "..", "audit-70-entry-overlaps.ts"), "utf8");
    expect(source.length).toBeGreaterThan(1000);
    // Strip block comments and line comments, so the docblock may say "READ-ONLY" in prose.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(code).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE)\b/);
    expect(code).not.toMatch(
      /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/,
    );
    expect(code).not.toMatch(/\$executeRaw/);
  });
});

describe("audit-70-entry-overlaps — report on the worker database", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let cleanRun: { code: number; lines: string[] };
  let cleanFindings: EntryOverlapFindings;

  async function insertEntry(
    employeeId: string,
    day: string,
    start: string,
    end: string | null,
    extra: { deletedAt?: Date } = {},
  ): Promise<string> {
    const row = await app.prisma.timeEntry.create({
      data: {
        employeeId,
        salonId: data.salonId,
        date: new Date(day),
        startTime: new Date(`${day}T${start}Z`),
        endTime: end ? new Date(`${day}T${end}Z`) : null,
        source: "MANUAL",
        deletedAt: extra.deletedAt ?? null,
      },
    });
    return row.id;
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "a70");
    const emp = data.employee.id;
    const admin = data.adminEmployee.id;

    // Legal data only (the guard is still in place, so every row below is accepted by the database):
    // back-to-back, a zero-length row inside another entry, a soft-deleted overlap, one open entry per
    // day, and the same instants for a second employee.
    await insertEntry(emp, "2026-03-02", "08:00:00", "12:00:00");
    await insertEntry(emp, "2026-03-02", "12:00:00", "16:00:00");
    await insertEntry(emp, "2026-03-03", "08:00:00", "12:00:00");
    await insertEntry(emp, "2026-03-03", "09:00:00", "09:00:00");
    await insertEntry(emp, "2026-03-04", "08:00:00", "12:00:00");
    await insertEntry(emp, "2026-03-04", "09:00:00", "11:00:00", { deletedAt: new Date() });
    await insertEntry(emp, "2026-03-05", "08:00:00", null);
    await insertEntry(emp, "2026-03-06", "08:00:00", null);
    await insertEntry(admin, "2026-03-02", "08:00:00", "12:00:00");

    cleanRun = await capture(() => main(["--tenant-id", data.tenant.id], app.prisma));
    cleanFindings = await findEntryOverlapFindings(app.prisma, data.tenant.id);
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
  });

  it("exits 0 with an empty report on a tenant whose entries are all legal", () => {
    expect(cleanRun.code).toBe(EXIT_OK);
    expect(cleanRun.lines).toEqual(["Totals: overlap=0 inverted=0 multipleOpen=0"]);
    expect(cleanFindings).toEqual({ overlaps: [], inverted: [], multipleOpen: [] });
  });

  it("reports exactly the overlapping, inverted and multiply-open rows once the guard is removed (rolled back)", async () => {
    const emp = data.employee.id;
    const admin = data.adminEmployee.id;
    const ids: Record<string, string> = {};
    let findings: EntryOverlapFindings | undefined;
    let tenantRun: { code: number; lines: string[] } | undefined;
    let allTenantsFindings: EntryOverlapFindings | undefined;

    await expect(
      app.prisma.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(
            `ALTER TABLE "TimeEntry" DROP CONSTRAINT "TimeEntry_no_overlap_closed"`,
          );
          await tx.$executeRawUnsafe(`DROP INDEX "TimeEntry_employeeId_date_open_unique"`);

          const make = async (
            key: string,
            employeeId: string,
            day: string,
            start: string,
            end: string | null,
            endDay = day,
          ) => {
            const row = await tx.timeEntry.create({
              data: {
                employeeId,
                salonId: data.salonId,
                date: new Date(day),
                startTime: new Date(`${day}T${start}Z`),
                endTime: end ? new Date(`${endDay}T${end}Z`) : null,
                source: "MANUAL",
              },
            });
            ids[key] = row.id;
          };

          // Overlap on one date.
          await make("o1", emp, "2026-03-10", "08:00:00", "12:00:00");
          await make("o2", emp, "2026-03-10", "11:00:00", "13:00:00");
          // Overlap across midnight: the first entry ends on the next date.
          await make("m1", emp, "2026-03-12", "22:00:00", "02:00:00", "2026-03-13");
          await make("m2", emp, "2026-03-13", "01:00:00", "03:00:00");
          // Inverted closed entry.
          await make("inv", admin, "2026-03-14", "12:00:00", "08:00:00");
          // Two open entries of one employee and day.
          await make("open1", admin, "2026-03-16", "08:00:00", null);
          await make("open2", admin, "2026-03-16", "09:00:00", null);

          findings = await findEntryOverlapFindings(tx, data.tenant.id);
          allTenantsFindings = await findEntryOverlapFindings(tx, null);
          tenantRun = await capture(() => main(["--tenant-id", data.tenant.id], tx));
          throw new OverlapAuditRollback();
        },
        { timeout: 30_000 },
      ),
    ).rejects.toThrow(OverlapAuditRollback);

    expect(findings).toBeDefined();
    expect(Object.keys(ids)).toHaveLength(7);

    expect(findings!.overlaps.map((f) => pairKey(f.entryIdA, f.entryIdB)).sort(compareIds)).toEqual(
      [pairKey(ids.o1, ids.o2), pairKey(ids.m1, ids.m2)].sort(compareIds),
    );
    expect(findings!.overlaps.every((f) => f.employeeId === emp)).toBe(true);
    expect(findings!.inverted.map((f) => f.entryId)).toEqual([ids.inv]);
    expect(findings!.inverted[0].employeeId).toBe(admin);
    expect(findings!.multipleOpen).toEqual([
      {
        tenantId: data.tenant.id,
        employeeId: admin,
        date: "2026-03-16",
        entryIds: [ids.open1, ids.open2].sort(compareIds),
      },
    ]);
    // The survey over every tenant contains at least the same rows (never fewer).
    expect(allTenantsFindings!.overlaps.length).toBeGreaterThanOrEqual(2);

    // The CLI over the same data: exit 2, ids only, one totals line.
    expect(tenantRun!.code).toBe(EXIT_FINDINGS);
    expect(tenantRun!.lines).toHaveLength(5);
    expect(tenantRun!.lines.at(-1)).toBe("Totals: overlap=2 inverted=1 multipleOpen=1");
    expect(tenantRun!.lines.join("\n")).toContain(`entryId=${ids.inv}`);

    // Rollback proof: the guard objects exist again and none of the rows is left.
    const constraint = await app.prisma.$queryRaw<{ contype: string }[]>`
      SELECT contype::text AS contype FROM pg_constraint
      WHERE conname = 'TimeEntry_no_overlap_closed'`;
    expect(constraint).toEqual([{ contype: "x" }]);
    const index = await app.prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE indexname = 'TimeEntry_employeeId_date_open_unique'`;
    expect(index).toHaveLength(1);
    expect(index[0].indexdef).toContain("UNIQUE INDEX");
    expect(index[0].indexdef).toContain('"endTime" IS NULL');
    const left = await app.prisma.timeEntry.count({ where: { id: { in: Object.values(ids) } } });
    expect(left).toBe(0);
  });
});
