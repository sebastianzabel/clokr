/**
 * Issue #493 (R6, D-06, D-08, D-11) — RED-then-GREEN + zero-mutation proof for
 * audit-493-month-boundary-leak.ts.
 *
 * Fixture, tenant A (Europe/Berlin, fixed 2025 dates so the test is no time bomb), employee E1 on an
 * untracked MONTHLY_HOURS contract (monthlyHours null):
 *   - WORK      2025-09-30 19:44-20:42Z -> category A, month 2025-10, 58 min, reportIst
 *   - OVERTIME  2025-05-31 08:00-09:00Z -> category A, month 2025-06, not on the entry list, no reportIst
 *   - WORK      2025-10-01 / 2025-10-15 -> not a leak (inside both windows)
 *   - WORK      2025-08-31 soft-deleted, 2025-07-31 open (no endTime), 2025-06-30 invalid -> not findings
 *   - WORK      2099-09-30 -> would leak into 2099-10, a month after the tenant's current one -> skipped
 * Tenant B: one WORK entry on 2025-09-30 — a finding only in --all-tenants mode.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../src/__tests__/setup";
import {
  main,
  parseCli,
  legacyMonthDays,
  currentMonthDays,
  EXIT_OK,
  EXIT_FINDINGS,
} from "../audit-493-month-boundary-leak";
import type { FastifyInstance } from "fastify";

const day = (s: string) => new Date(`${s}T00:00:00Z`);

async function capture(argv: string[], prisma: FastifyInstance["prisma"]) {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
    lines.push(String(args[0]));
  });
  let code: number;
  try {
    code = await main(argv, prisma);
  } finally {
    spy.mockRestore();
  }
  return { code, lines };
}

const ids = (lines: string[], key: string) =>
  lines
    .filter((l) => l.startsWith("category=A "))
    .map((l) => l.match(new RegExp(`${key}=([0-9a-f-]+)`))?.[1])
    .filter((v): v is string => Boolean(v));

describe("legacyMonthDays / currentMonthDays (pure, tz-generic)", () => {
  it("Europe/Berlin: the old window starts on the previous month's last day", () => {
    expect(legacyMonthDays(2026, 10, "Europe/Berlin")).toEqual({
      first: "2026-09-30",
      last: "2026-10-31",
    });
    expect(currentMonthDays(2026, 10, "Europe/Berlin")).toEqual({
      first: "2026-10-01",
      last: "2026-10-31",
    });
    expect(legacyMonthDays(2026, 2, "Europe/Berlin").first).toBe("2026-01-31");
  });

  it("America/New_York: the old window ends on the next month's first day", () => {
    expect(legacyMonthDays(2026, 10, "America/New_York")).toEqual({
      first: "2026-10-01",
      last: "2026-11-01",
    });
    expect(currentMonthDays(2026, 10, "America/New_York")).toEqual({
      first: "2026-10-01",
      last: "2026-10-31",
    });
  });
});

describe("audit-493-month-boundary-leak — category A (Issue #493)", () => {
  let app: FastifyInstance;
  let dataA: Awaited<ReturnType<typeof seedTestData>>;
  let dataB: Awaited<ReturnType<typeof seedTestData>>;
  let e1Id: string;
  let e1UserId: string;
  const entry: Record<string, string> = {};

  beforeAll(async () => {
    app = await getTestApp();
    dataA = await seedTestData(app, "audit493a");
    dataB = await seedTestData(app, "audit493b");

    const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const user = await app.prisma.user.create({
      data: {
        email: `audit493-e1-${suffix}@test.de`,
        passwordHash: "x",
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    e1UserId = user.id;
    const e1 = await app.prisma.employee.create({
      data: {
        tenantId: dataA.tenant.id,
        userId: user.id,
        employeeNumber: `E1-${suffix}`,
        firstName: "Zebulon",
        lastName: "Quarkmann",
        hireDate: day("2024-01-01"),
      },
    });
    e1Id = e1.id;
    await app.prisma.workSchedule.create({
      data: {
        employeeId: e1.id,
        type: "MONTHLY_HOURS",
        monthlyHours: null,
        validFrom: day("2024-01-01"),
      },
    });

    const mk = async (
      key: string,
      employeeId: string,
      date: string,
      start: string,
      end: string | null,
      opts: { type?: "WORK" | "OVERTIME"; deletedAt?: Date; isInvalid?: boolean } = {},
    ) => {
      const row = await app.prisma.timeEntry.create({
        data: {
          employeeId,
          date: day(date),
          startTime: new Date(`${date}T${start}:00Z`),
          endTime: end ? new Date(`${date}T${end}:00Z`) : null,
          breakMinutes: 0,
          type: opts.type ?? "WORK",
          source: "MANUAL",
          salonId: dataA.salonId,
          deletedAt: opts.deletedAt ?? null,
          isInvalid: opts.isInvalid ?? false,
        },
      });
      entry[key] = row.id;
    };

    await mk("work0930", e1.id, "2025-09-30", "19:44", "20:42");
    await mk("overtime0531", e1.id, "2025-05-31", "08:00", "09:00", { type: "OVERTIME" });
    await mk("first1001", e1.id, "2025-10-01", "08:00", "09:00");
    await mk("mid1015", e1.id, "2025-10-15", "08:00", "09:00");
    await mk("deleted0831", e1.id, "2025-08-31", "08:00", "09:00", { deletedAt: new Date() });
    await mk("open0731", e1.id, "2025-07-31", "08:00", null);
    await mk("invalid0630", e1.id, "2025-06-30", "08:00", "09:00", { isInvalid: true });
    await mk("future", e1.id, "2099-09-30", "08:00", "09:00");

    // tenant B's own employee (FIXED schedule from the seed)
    const salonB = dataB.salonId;
    const rowB = await app.prisma.timeEntry.create({
      data: {
        employeeId: dataB.employee.id,
        date: day("2025-09-30"),
        startTime: new Date("2025-09-30T08:00:00Z"),
        endTime: new Date("2025-09-30T09:00:00Z"),
        breakMinutes: 0,
        type: "WORK",
        source: "MANUAL",
        salonId: salonB,
      },
    });
    entry.tenantB = rowB.id;
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, dataA.tenant.id);
      await app.prisma.user.deleteMany({ where: { id: e1UserId } });
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    try {
      await cleanupTestData(app, dataB.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("--tenant-id A lists exactly the two leaked entries (exit 2)", async () => {
    const { code, lines } = await capture(["--tenant-id", dataA.tenant.id], app.prisma);
    expect(code).toBe(EXIT_FINDINGS);
    expect(ids(lines, "entryId").sort()).toEqual([entry.work0930, entry.overtime0531].sort());
    for (const k of ["first1001", "mid1015", "deleted0831", "open0731", "invalid0630", "future"]) {
      expect(ids(lines, "entryId")).not.toContain(entry[k]);
    }
  });

  it("the WORK finding carries month, working minutes and all three output flags", async () => {
    const { lines } = await capture(["--tenant-id", dataA.tenant.id], app.prisma);
    const work = lines.find((l) => l.includes(`entryId=${entry.work0930}`))!;
    expect(work).toContain(`tenantId=${dataA.tenant.id}`);
    expect(work).toContain(`employeeId=${e1Id}`);
    expect(work).toContain("month=2025-10");
    expect(work).toContain("date=2025-09-30");
    expect(work).toContain("type=WORK");
    expect(work).toContain("workingMinutes=58");
    expect(work).toContain("reportEntryList=true");
    expect(work).toContain("datevHours=true");
    expect(work).toContain("reportIst=true");
  });

  it("the OVERTIME finding is DATEV-only (no entry list, no Ist) — D-11", async () => {
    const { lines } = await capture(["--tenant-id", dataA.tenant.id], app.prisma);
    const ot = lines.find((l) => l.includes(`entryId=${entry.overtime0531}`))!;
    expect(ot).toContain("month=2025-06");
    expect(ot).toContain("type=OVERTIME");
    expect(ot).toContain("workingMinutes=60");
    expect(ot).toContain("reportEntryList=false");
    expect(ot).toContain("datevHours=true");
    expect(ot).toContain("reportIst=false");
  });

  it("--all-tenants also lists tenant B's entry (contains, not equal — shared worker DB)", async () => {
    const { code, lines } = await capture(["--all-tenants"], app.prisma);
    expect(code).toBe(EXIT_FINDINGS);
    expect(ids(lines, "entryId")).toEqual(
      expect.arrayContaining([entry.work0930, entry.overtime0531, entry.tenantB]),
    );
  });

  it("a tenant without findings returns EXIT_OK", async () => {
    const other = await app.prisma.tenant.create({
      data: {
        name: `audit493-empty-${Date.now().toString(36)}`,
        slug: `audit493-empty-${Date.now().toString(36)}`,
        federalState: "NIEDERSACHSEN",
      },
    });
    try {
      const code = await main(["--tenant-id", other.id], app.prisma);
      expect(code).toBe(EXIT_OK);
    } finally {
      await app.prisma.tenant.delete({ where: { id: other.id } });
    }
  });

  it("main([]) throws the German tenant-selection error", async () => {
    await expect(main([], app.prisma)).rejects.toThrow(/Tenant-Auswahl erforderlich/);
  });

  it("parseCli throws on an unknown write flag (--confirm, --apply)", () => {
    expect(() => parseCli(["--confirm"])).toThrow();
    expect(() => parseCli(["--apply"])).toThrow();
  });
});
