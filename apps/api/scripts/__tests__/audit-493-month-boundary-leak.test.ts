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
 *
 * Categories B and C (tenant A, FIXED employees):
 *   - E2: APPROVED SICK Mon 2025-09-29 .. Sat 2025-10-04 -> B for 2025-09 (3 -> 2), C for 2025-10 (4 -> 3)
 *   - E3: APPROVED SICK 2025-09-29 .. 2025-10-01 + APPROVED VACATION + CONFIRMED § 9 credit over the
 *     same days -> B for 2025-09 twice (sick request and credit, 3 -> 2), NO C (one October key
 *     before and after — the documented same-count limitation); the VACATION request is no line
 *   - AuditLog: tenant A's admin recorded a DATEV export for 2025-10; tenant B's admin one for 2025-09
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../src/__tests__/setup";
import {
  main,
  parseCli,
  legacyMonthDays,
  currentMonthDays,
  legacyClippedDays,
  legacyWorkdayKeys,
  EXIT_OK,
  EXIT_FINDINGS,
} from "../audit-493-month-boundary-leak";
import { monthDateRange, monthRangeUtc } from "../../src/contexts/working-time-account";
import { leaveTypeFields } from "../../src/contexts/absence/leave-type";
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

const field = (line: string, key: string) => line.match(new RegExp(`(?:^| )${key}=(\\S+)`))?.[1];

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
  let e2Id: string;
  let e3Id: string;
  let sickE2Id: string;
  let sickE3Id: string;
  let vacE3Id: string;
  let creditE3Id: string;
  let exportLogIds: string[] = [];
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

    // ── categories B / C ────────────────────────────────────────────────────
    const makeEmployee = async (label: string) => {
      const sfx = `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const u = await app.prisma.user.create({
        data: {
          email: `audit493-${sfx}@test.de`,
          passwordHash: "x",
          role: "EMPLOYEE",
          isActive: true,
        },
      });
      const emp = await app.prisma.employee.create({
        data: {
          tenantId: dataA.tenant.id,
          userId: u.id,
          employeeNumber: `N-${sfx}`,
          firstName: "Quirin",
          lastName: "Zackenbarsch",
          hireDate: day("2024-01-01"),
        },
      });
      await app.prisma.workSchedule.create({
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
          validFrom: day("2024-01-01"),
        },
      });
      return emp.id;
    };
    e2Id = await makeEmployee("e2");
    e3Id = await makeEmployee("e3");

    const sickType = await app.prisma.leaveType.create({
      data: { tenantId: dataA.tenant.id, ...leaveTypeFields("SICK"), color: "#EF4444" },
    });
    const mkLeave = async (
      employeeId: string,
      leaveTypeId: string,
      start: string,
      end: string,
      status: "APPROVED" | "PENDING" = "APPROVED",
    ) =>
      (
        await app.prisma.leaveRequest.create({
          data: {
            employeeId,
            leaveTypeId,
            startDate: day(start),
            endDate: day(end),
            days: 1,
            halfDay: false,
            status,
            reviewedBy: "system",
            reviewedAt: new Date(),
          },
        })
      ).id;
    sickE2Id = await mkLeave(e2Id, sickType.id, "2025-09-29", "2025-10-04");
    sickE3Id = await mkLeave(e3Id, sickType.id, "2025-09-29", "2025-10-01");
    vacE3Id = await mkLeave(e3Id, dataA.vacationType.id, "2025-09-29", "2025-10-01");
    creditE3Id = (
      await app.prisma.section9Credit.create({
        data: {
          employeeId: e3Id,
          sickRequestId: sickE3Id,
          vacationRequestId: vacE3Id,
          overlapStart: day("2025-09-29"),
          overlapEnd: day("2025-10-01"),
          status: "CONFIRMED",
          creditedStart: day("2025-09-29"),
          creditedEnd: day("2025-10-01"),
          creditedDays: 3,
        },
      })
    ).id;

    // A PENDING sick request is not effective leave — must produce no B/C line.
    await mkLeave(e2Id, sickType.id, "2025-05-29", "2025-06-03", "PENDING");

    exportLogIds = [
      (
        await app.prisma.auditLog.create({
          data: {
            userId: dataA.adminUser.id,
            action: "EXPORT",
            entity: "Report",
            newValue: { type: "DATEV", year: "2025", month: "10" },
          },
        })
      ).id,
      (
        await app.prisma.auditLog.create({
          data: {
            userId: dataB.adminUser.id,
            action: "EXPORT",
            entity: "Report",
            newValue: { type: "MONTHLY_PDF", year: "2025", month: "9" },
          },
        })
      ).id,
    ];
  });

  afterAll(async () => {
    try {
      await app.prisma.auditLog.deleteMany({ where: { id: { in: exportLogIds } } });
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
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

  it("categories B and C list exactly the sick-day and DATEV-key shifts of tenant A", async () => {
    const { lines } = await capture(["--tenant-id", dataA.tenant.id], app.prisma);
    const b = lines
      .filter((l) => l.startsWith("category=B "))
      .map(
        (l) =>
          `${field(l, "month")}|${field(l, "employeeId")}|${field(l, "source")}|${field(l, "id")}|${field(l, "daysOld")}->${field(l, "daysNew")}`,
      )
      .sort();
    expect(b).toEqual(
      [
        `2025-09|${e2Id}|leaveRequest|${sickE2Id}|3->2`,
        `2025-09|${e3Id}|leaveRequest|${sickE3Id}|3->2`,
        `2025-09|${e3Id}|section9Credit|${creditE3Id}|3->2`,
      ].sort(),
    );
    const c = lines
      .filter((l) => l.startsWith("category=C "))
      .map(
        (l) =>
          `${field(l, "month")}|${field(l, "employeeId")}|${field(l, "leaveRequestId")}|${field(l, "keysOld")}->${field(l, "keysNew")}`,
      );
    expect(c).toEqual([`2025-10|${e2Id}|${sickE2Id}|4->3`]);
    // the VACATION request and the PENDING sick request produce no line at all
    expect(lines.join("\n")).not.toContain(vacE3Id);
    expect(lines.filter((l) => l.startsWith("category=A ")).length).toBe(2);
  });

  it("annotates each affected month with the exports recorded for it (D-07)", async () => {
    const { lines } = await capture(["--tenant-id", dataA.tenant.id], app.prisma);
    const monthLine = (m: string) =>
      lines.find((l) => l.startsWith("month ") && field(l, "month") === m)!;
    expect(monthLine("2025-10")).toContain("exports=DATEV");
    // tenant B's admin exported 2025-09 — it must not show up for tenant A
    expect(monthLine("2025-09")).toContain("exports=none");
    expect(monthLine("2025-06")).toContain("exports=none");
    expect(monthLine("2025-10")).toContain(`tenantId=${dataA.tenant.id}`);
  });

  it("prints one summary line per affected month and employee", async () => {
    const { lines } = await capture(["--tenant-id", dataA.tenant.id], app.prisma);
    const sum = (m: string, emp: string) =>
      lines.find(
        (l) =>
          l.startsWith("summary ") && field(l, "month") === m && field(l, "employeeId") === emp,
      )!;
    expect(sum("2025-10", e1Id)).toMatch(
      /entries=1 workingMinutes=58 dayCountRows=0 keyShiftRows=0/,
    );
    expect(sum("2025-09", e2Id)).toMatch(
      /entries=0 workingMinutes=0 dayCountRows=1 keyShiftRows=0/,
    );
    expect(sum("2025-10", e2Id)).toMatch(
      /entries=0 workingMinutes=0 dayCountRows=0 keyShiftRows=1/,
    );
    expect(sum("2025-09", e3Id)).toMatch(/dayCountRows=2 keyShiftRows=0/);
  });

  it("tenant B's rows never appear in tenant A's output", async () => {
    const { lines } = await capture(["--tenant-id", dataA.tenant.id], app.prisma);
    expect(lines.join("\n")).not.toContain(dataB.tenant.id);
    expect(lines.join("\n")).not.toContain(entry.tenantB);
  });

  it("prints no personal data (no names, employee numbers or emails of the fixture)", async () => {
    const { lines } = await capture(["--all-tenants"], app.prisma);
    const out = lines.join("\n");
    const emps = await app.prisma.employee.findMany({
      where: { tenantId: { in: [dataA.tenant.id, dataB.tenant.id] } },
      select: {
        employeeNumber: true,
        firstName: true,
        lastName: true,
        user: { select: { email: true } },
      },
    });
    expect(emps.length).toBeGreaterThanOrEqual(6);
    for (const e of emps) {
      expect(out).not.toContain(e.employeeNumber);
      expect(out).not.toContain(e.user.email);
    }
    for (const needle of ["Zebulon", "Quarkmann", "Quirin", "Zackenbarsch", "@test.de"]) {
      expect(out).not.toContain(needle);
    }
  });

  it("zero mutations: counts and max(updatedAt) of tenant A's rows and the AuditLog count are unchanged", async () => {
    const snapshot = async () => {
      const where = { employee: { tenantId: dataA.tenant.id } };
      const [te, lr, cr, logs] = await Promise.all([
        app.prisma.timeEntry.aggregate({ where, _count: true, _max: { updatedAt: true } }),
        app.prisma.leaveRequest.aggregate({ where, _count: true, _max: { updatedAt: true } }),
        app.prisma.section9Credit.aggregate({ where, _count: true, _max: { updatedAt: true } }),
        app.prisma.auditLog.count(),
      ]);
      return { te, lr, cr, logs };
    };
    const before = await snapshot();
    await capture(["--tenant-id", dataA.tenant.id], app.prisma);
    await capture(["--all-tenants"], app.prisma);
    expect(await snapshot()).toEqual(before);
  });

  it("the script source calls no Prisma write method and no raw execute", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(
      new URL("../audit-493-month-boundary-leak.ts", import.meta.url),
      "utf8",
    );
    expect(src).not.toMatch(/\.(update|updateMany|create|createMany|delete|deleteMany|upsert)\(/);
    expect(src).not.toMatch(/\$executeRaw|\$queryRawUnsafe|\$executeRawUnsafe/);
  });
});

describe("frozen pre-#493 arithmetic (RESEARCH probe values)", () => {
  const sepInstants = monthRangeUtc(2026, 9, "Europe/Berlin");
  const sepDays = monthDateRange(2026, 9, "Europe/Berlin");
  const octInstants = monthRangeUtc(2026, 10, "Europe/Berlin");
  const octDays = monthDateRange(2026, 10, "Europe/Berlin");

  it("legacyClippedDays counts the previous month's last day through the instants", () => {
    const from = day("2026-09-28");
    const to = day("2026-10-02");
    expect(legacyClippedDays(from, to, sepInstants.start, sepInstants.end)).toBe(4);
    expect(legacyClippedDays(from, to, sepDays.firstDay, sepDays.lastDay)).toBe(3);
  });

  it("legacyWorkdayKeys walks from the instant and shifts the weekday keys", () => {
    const from = day("2026-09-28");
    const to = day("2026-10-03");
    expect(legacyWorkdayKeys(from, to, octInstants.start, octInstants.end)).toEqual([
      "2026-09-30",
      "2026-10-01",
      "2026-10-02",
    ]);
    expect(legacyWorkdayKeys(from, to, octDays.firstDay, octDays.lastDay)).toEqual([
      "2026-10-01",
      "2026-10-02",
    ]);
  });
});
