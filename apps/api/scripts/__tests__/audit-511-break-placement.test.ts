/**
 * Issue #511 (D-14, AK-5) — fixture matrix for audit-511-break-placement.ts.
 *
 * The script is a read-only dry run: it lists the days the Satz-2/3 / § 11 JArbSchG break rules
 * flag, per code, month and month state. Fixtures are written directly (the script reads, it never
 * saves an entry). Berlin is UTC+1 on every fixture date (DST starts on 2026-03-29), so a UTC
 * clock time here is the Berlin clock time minus one hour.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../src/__tests__/setup";
import {
  main,
  parseCli,
  formatFindingLine,
  monthChunks,
  validateRange,
  EXIT_OK,
  EXIT_FINDINGS,
} from "../audit-511-break-placement";
import { evaluateDayBreaks } from "../../src/contexts/time-tracking/day-break-rule";
import type { FastifyInstance } from "fastify";
import type { Prisma } from "@clokr/db";

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

describe("audit-511-break-placement — CLI (pure)", () => {
  it("rejects every write flag: the script has no mode that changes data", () => {
    expect(() => parseCli(["--confirm"])).toThrow();
    expect(() => parseCli(["--apply"])).toThrow();
    expect(() => parseCli(["--fix"])).toThrow();
  });

  it("parses the tenant selection and the range", () => {
    expect(
      parseCli(["--tenant-id", "t1", "--from", "2026-03-01", "--to", "2026-03-31"]),
    ).toMatchObject({ tenantId: "t1", allTenants: false, from: "2026-03-01", to: "2026-03-31" });
    expect(parseCli(["--all-tenants", "--from", "2026-03-01", "--to", "2026-03-31"])).toMatchObject(
      { tenantId: null, allTenants: true },
    );
  });

  it("formats a finding line with full ids and no name", () => {
    expect(
      formatFindingLine({
        tenantId: "11111111-1111-1111-1111-111111111111",
        employeeId: "22222222-2222-2222-2222-222222222222",
        date: "2026-03-10",
        code: "BREAK_TOO_LATE",
        certainty: "VIOLATION",
        month: "2026-03",
        closed: false,
        wouldBlock: true,
      }),
    ).toBe(
      "finding tenantId=11111111-1111-1111-1111-111111111111 " +
        "employeeId=22222222-2222-2222-2222-222222222222 date=2026-03-10 code=BREAK_TOO_LATE " +
        "certainty=VIOLATION month=2026-03 closed=false wouldBlock=true",
    );
  });

  it("throws the German tenant-selection message when neither or both are given", async () => {
    const range = ["--from", "2026-03-01", "--to", "2026-03-31"];
    await expect(main(range)).rejects.toThrow(
      "Tenant-Auswahl erforderlich: bitte --tenant-id <uuid> ODER --all-tenants angeben.",
    );
    await expect(main(["--tenant-id", "x", "--all-tenants", ...range])).rejects.toThrow(
      "Tenant-Auswahl erforderlich",
    );
  });

  it("splits a range into calendar months, each clipped to the range", () => {
    expect(monthChunks("2026-02-15", "2026-04-10")).toEqual([
      { month: "2026-02", first: "2026-02-15", last: "2026-02-28" },
      { month: "2026-03", first: "2026-03-01", last: "2026-03-31" },
      { month: "2026-04", first: "2026-04-01", last: "2026-04-10" },
    ]);
    expect(monthChunks("2025-12-31", "2026-01-01")).toEqual([
      { month: "2025-12", first: "2025-12-31", last: "2025-12-31" },
      { month: "2026-01", first: "2026-01-01", last: "2026-01-01" },
    ]);
    expect(monthChunks("2026-03-10", "2026-03-10")).toEqual([
      { month: "2026-03", first: "2026-03-10", last: "2026-03-10" },
    ]);
  });

  it("rejects a range that is reversed, malformed or longer than 366 days (German message)", async () => {
    const t = ["--tenant-id", "x"];
    await expect(main([...t, "--from", "2026-04-02", "--to", "2026-04-01"])).rejects.toThrow(
      /nicht nach --to/,
    );
    await expect(main([...t, "--from", "2026-3-1", "--to", "2026-03-31"])).rejects.toThrow(
      /Ungültiges Datum für --from/,
    );
    // Round-trip check: the 30th of February is not a date.
    await expect(main([...t, "--from", "2026-03-01", "--to", "2026-02-30"])).rejects.toThrow(
      /Ungültiges Datum für --to/,
    );
    await expect(main([...t, "--from", "2025-03-01", "--to", "2026-03-02"])).rejects.toThrow(
      /höchstens 366 Tage/,
    );
    // 366 days inclusive is the largest accepted range, 367 is not.
    expect(() => validateRange("2025-03-01", "2026-03-01")).not.toThrow();
    expect(() => validateRange("2025-03-01", "2026-03-02")).toThrow(/höchstens 366 Tage/);
  });
});

describe("audit-511-break-placement — report on the worker database", () => {
  let app: FastifyInstance;
  let dataA: Awaited<ReturnType<typeof seedTestData>>;
  let dataB: Awaited<ReturnType<typeof seedTestData>>;
  let dataC: Awaited<ReturnType<typeof seedTestData>>;
  const emp: Record<string, string> = {};
  let runA: { code: number; lines: string[] };
  let runClipped: { code: number; lines: string[] };
  let runAll: { code: number; lines: string[] };
  let before: Record<string, number>;
  let after: Record<string, number>;

  async function createEmp(
    data: Awaited<ReturnType<typeof seedTestData>>,
    key: string,
    extra: { birthDate?: Date } = {},
  ): Promise<string> {
    const s = `${key}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
    const user = await app.prisma.user.create({
      data: { email: `${s}@a511.test`, passwordHash: "x", role: "EMPLOYEE", isActive: true },
    });
    const created = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `A511NUM-${s}`,
        firstName: `Vorname${key}Zq`,
        lastName: `Nachname${key}Zq`,
        hireDate: new Date("2024-01-01T00:00:00Z"),
        isTimeTrackingExempt: false,
        ...extra,
      },
    });
    return created.id;
  }

  /** One WORK entry (UTC instants) with optional Break rows. */
  async function entry(
    employeeId: string,
    salonId: string,
    day: string,
    start: string,
    end: string,
    opts: { breaks?: Array<[string, string]>; breakMinutes?: number; isLocked?: boolean } = {},
  ) {
    return app.prisma.timeEntry.create({
      data: {
        employeeId,
        date: new Date(`${day}T00:00:00Z`),
        startTime: new Date(`${day}T${start}:00Z`),
        endTime: new Date(`${day}T${end}:00Z`),
        breakMinutes: opts.breakMinutes ?? 0,
        type: "WORK",
        source: "MANUAL",
        salonId,
        isLocked: opts.isLocked ?? false,
        breaks: opts.breaks
          ? {
              create: opts.breaks.map(([s, e]) => ({
                startTime: new Date(`${day}T${s}:00Z`),
                endTime: new Date(`${day}T${e}:00Z`),
              })),
            }
          : undefined,
      },
    });
  }

  /** The Satz-3 day of the tracer (08:00-16:00 Berlin, 30 min break from 14:30) as a helper. */
  async function satz3Day(employeeId: string, day: string, opts: { isLocked?: boolean } = {}) {
    return entry(employeeId, dataA.salonId, day, "07:00", "15:00", {
      breaks: [["13:30", "14:00"]],
      breakMinutes: 30,
      ...opts,
    });
  }

  /** The snapshot an acknowledgement of this day would store today (production evaluation). */
  function currentSnapshot(e: Awaited<ReturnType<typeof entry>>) {
    return evaluateDayBreaks({
      rows: [
        {
          id: e.id,
          startTime: e.startTime,
          endTime: e.endTime!,
          breakMinutes: e.breakMinutes,
          salonId: e.salonId,
          breaks: [
            {
              startTime: new Date(e.startTime.getTime() + 390 * 60_000),
              endTime: new Date(e.startTime.getTime() + 420 * 60_000),
            },
          ],
        },
      ],
      dayBreaks: [],
      acks: [],
      regime: "ARBZG_4",
    }).snapshot;
  }

  async function closeMonth(employeeId: string, monthFirst: string, monthLast: string) {
    await app.prisma.saldoSnapshot.create({
      data: {
        employeeId,
        periodType: "MONTHLY",
        periodStart: new Date(`${monthFirst}T00:00:00Z`),
        periodEnd: new Date(`${monthLast}T00:00:00Z`),
        workedMinutes: 0,
        expectedMinutes: 0,
        balanceMinutes: 0,
        carryOver: 0,
        closedAt: new Date("2026-04-01T00:00:00Z"),
        closedBy: "a511-seed",
      },
    });
  }

  async function counts(): Promise<Record<string, number>> {
    const p = app.prisma;
    const [timeEntry, breakRows, dayBreak, dayBreakAck, auditLog, saldoSnapshot, notification] =
      await Promise.all([
        p.timeEntry.count(),
        p.break.count(),
        p.dayBreak.count(),
        p.dayBreakAck.count(),
        p.auditLog.count(),
        p.saldoSnapshot.count(),
        p.notification.count(),
      ]);
    return { timeEntry, breakRows, dayBreak, dayBreakAck, auditLog, saldoSnapshot, notification };
  }

  const tenantArgs = (id: string, from: string, to: string) => [
    "--tenant-id",
    id,
    "--from",
    from,
    "--to",
    to,
  ];

  beforeAll(async () => {
    app = await getTestApp();
    dataA = await seedTestData(app, "audit511a");
    dataB = await seedTestData(app, "audit511b");
    dataC = await seedTestData(app, "audit511c");

    // Satz 3: 08:00-16:00, one 30 min break from 14:30, so the work before it runs 6.5 h.
    emp.finding = await createEmp(dataA, "F1");
    await entry(emp.finding, dataA.salonId, "2026-03-10", "07:00", "15:00", {
      breaks: [["13:30", "14:00"]],
      breakMinutes: 30,
    });
    // Outside the clipped range of the second run (after its --to).
    await entry(emp.finding, dataA.salonId, "2026-04-20", "07:00", "15:00", {
      breaks: [["13:30", "14:00"]],
      breakMinutes: 30,
    });

    // The same shape in a month with a closed snapshot (February), one day before and one inside
    // the clipped range.
    emp.closedMonth = await createEmp(dataA, "CM");
    for (const day of ["2026-02-10", "2026-02-17"]) {
      await entry(emp.closedMonth, dataA.salonId, day, "07:00", "15:00", {
        breaks: [["13:30", "14:00"]],
        breakMinutes: 30,
      });
    }
    await closeMonth(emp.closedMonth, "2026-02-01", "2026-02-28");

    // A finding on a locked entry (April), the month itself has no snapshot.
    emp.locked = await createEmp(dataA, "LK");
    await entry(emp.locked, dataA.salonId, "2026-04-07", "07:00", "15:00", {
      breaks: [["13:30", "14:00"]],
      breakMinutes: 30,
      isLocked: true,
    });

    // Legacy sum-only entry: 8 h with a stored 30 min break and no Break row. The position of the
    // break is unknowable: a hint, not a finding.
    emp.hint = await createEmp(dataA, "HN");
    await entry(emp.hint, dataA.salonId, "2026-03-12", "07:00", "15:00", { breakMinutes: 30 });

    // Break rows (40 min) that exceed the stored breakMinutes (30): divergent. The break lies
    // early in the day, so there is no finding.
    emp.divergent = await createEmp(dataA, "DV");
    await entry(emp.divergent, dataA.salonId, "2026-03-13", "07:00", "15:00", {
      breaks: [["10:00", "10:40"]],
      breakMinutes: 30,
    });

    // A minor with a 4 h 31 min block before the break; the adult control has the same day.
    emp.minor = await createEmp(dataA, "MI", { birthDate: new Date("2010-06-01T00:00:00Z") });
    emp.adult = await createEmp(dataA, "AD", { birthDate: new Date("1990-06-01T00:00:00Z") });
    for (const id of [emp.minor, emp.adult]) {
      await entry(id, dataA.salonId, "2026-03-16", "07:00", "14:00", {
        breaks: [["11:31", "12:01"]],
        breakMinutes: 30,
      });
    }

    // Stale acknowledgements (Issue #511 A8): the day carries a Satz-3 finding today, the stored
    // snapshot predates the placement key. The unique index allows one entry per day, so the
    // fixture day is a single-entry day.
    emp.staleOpen = await createEmp(dataA, "SO");
    const staleOpenEntry = await satz3Day(emp.staleOpen, "2026-03-18");
    const legacyOf = (snap: ReturnType<typeof currentSnapshot>) => ({
      entryIds: snap.entryIds,
      salonIds: snap.salonIds,
      netWorkedMin: snap.netWorkedMin,
      totalBreakMin: snap.totalBreakMin,
    });
    const staleOpenSnap = currentSnapshot(staleOpenEntry);
    expect(staleOpenSnap.placementKey, "fixture must carry a placement finding").toBeTruthy();
    const ackBase = { acknowledgedBy: "a511-seed", reason: "seed" };
    await app.prisma.dayBreakAck.create({
      data: {
        employeeId: emp.staleOpen,
        date: new Date("2026-03-18T00:00:00Z"),
        snapshot: legacyOf(staleOpenSnap),
        ...ackBase,
      },
    });
    // A revoked stale acknowledgement never counts.
    await app.prisma.dayBreakAck.create({
      data: {
        employeeId: emp.staleOpen,
        date: new Date("2026-03-18T00:00:00Z"),
        snapshot: legacyOf(staleOpenSnap),
        deletedAt: new Date("2026-03-19T00:00:00Z"),
        deletedBy: "a511-seed",
        ...ackBase,
      },
    });

    // The same day in a closed month (locked entries).
    emp.staleClosed = await createEmp(dataA, "SC");
    const staleClosedEntry = await satz3Day(emp.staleClosed, "2026-02-18", { isLocked: true });
    await app.prisma.dayBreakAck.create({
      data: {
        employeeId: emp.staleClosed,
        date: new Date("2026-02-18T00:00:00Z"),
        snapshot: legacyOf(currentSnapshot(staleClosedEntry)),
        ...ackBase,
      },
    });

    // An acknowledgement that already carries the key: current, not stale, the day is waived.
    emp.keyCurrent = await createEmp(dataA, "KC");
    const keyCurrentEntry = await satz3Day(emp.keyCurrent, "2026-03-18");
    await app.prisma.dayBreakAck.create({
      data: {
        employeeId: emp.keyCurrent,
        date: new Date("2026-03-18T00:00:00Z"),
        snapshot: currentSnapshot(keyCurrentEntry) as unknown as Prisma.InputJsonValue,
        ...ackBase,
      },
    });

    // A stale acknowledgement the day's OTHER acknowledgement already covers does not re-open it.
    await app.prisma.dayBreakAck.create({
      data: {
        employeeId: emp.keyCurrent,
        date: new Date("2026-03-18T00:00:00Z"),
        snapshot: legacyOf(currentSnapshot(keyCurrentEntry)),
        ...ackBase,
      },
    });

    // Stale for a different reason (the day's break minutes changed since): not the new key.
    emp.moved = await createEmp(dataA, "MV");
    const movedEntry = await satz3Day(emp.moved, "2026-03-19");
    await app.prisma.dayBreakAck.create({
      data: {
        employeeId: emp.moved,
        date: new Date("2026-03-19T00:00:00Z"),
        snapshot: { ...legacyOf(currentSnapshot(movedEntry)), totalBreakMin: 45 },
        ...ackBase,
      },
    });

    // Tenant B: one finding of its own. Tenant C: nothing.
    emp.findingB = await createEmp(dataB, "FB");
    await entry(emp.findingB, dataB.salonId, "2026-03-11", "07:00", "15:00", {
      breaks: [["13:30", "14:00"]],
      breakMinutes: 30,
    });
    emp.clean = await createEmp(dataC, "C1");
    await entry(emp.clean, dataC.salonId, "2026-03-10", "07:00", "11:00");

    before = await counts();
    runA = await capture(() =>
      main(tenantArgs(dataA.tenant.id, "2026-02-01", "2026-04-30"), app.prisma),
    );
    runClipped = await capture(() =>
      main(tenantArgs(dataA.tenant.id, "2026-02-15", "2026-04-10"), app.prisma),
    );
    runAll = await capture(() =>
      main(["--all-tenants", "--from", "2026-02-01", "--to", "2026-04-30"], app.prisma),
    );
    after = await counts();
  });

  afterAll(async () => {
    for (const t of [dataA, dataB, dataC]) {
      const ids = (
        await app.prisma.employee.findMany({
          where: { tenantId: t.tenant.id },
          select: { id: true },
        })
      ).map((e) => e.id);
      await app.prisma.break.deleteMany({ where: { timeEntry: { employeeId: { in: ids } } } });
      await cleanupTestData(app, t.tenant.id);
    }
    await closeTestApp();
  });

  const findingLine = (lines: string[], employeeId: string, date: string) =>
    lines.find(
      (l) => l.startsWith("finding ") && l.includes(`employeeId=${employeeId} date=${date} `),
    );

  it("prints the finding line of a Satz-3 day and exits 2", () => {
    expect(runA.code).toBe(EXIT_FINDINGS);
    expect(runA.lines).toContain(
      `finding tenantId=${dataA.tenant.id} employeeId=${emp.finding} date=2026-03-10 ` +
        `code=BREAK_TOO_LATE certainty=VIOLATION month=2026-03 closed=false wouldBlock=true`,
    );
  });

  it("exits 0 for a tenant without a finding", async () => {
    const run = await capture(() =>
      main(tenantArgs(dataC.tenant.id, "2026-03-01", "2026-03-31"), app.prisma),
    );
    expect(run.code).toBe(EXIT_OK);
    expect(run.lines.filter((l) => l.startsWith("finding "))).toEqual([]);
    expect(run.lines).toContain(
      `staleAckTotal tenantId=${dataC.tenant.id} ackRows=0 days=0 openDays=0 closedDays=0`,
    );
  });

  it("reads a range across three months and clips the outer ones to the range", () => {
    // The full run sees 10 Feb and 20 Apr; the clipped run (15 Feb - 10 Apr) sees neither.
    expect(findingLine(runA.lines, emp.closedMonth, "2026-02-10")).toBeDefined();
    expect(findingLine(runA.lines, emp.finding, "2026-04-20")).toBeDefined();
    expect(findingLine(runClipped.lines, emp.closedMonth, "2026-02-10")).toBeUndefined();
    expect(findingLine(runClipped.lines, emp.finding, "2026-04-20")).toBeUndefined();
    expect(findingLine(runClipped.lines, emp.closedMonth, "2026-02-17")).toBeDefined();
    expect(findingLine(runClipped.lines, emp.locked, "2026-04-07")).toBeDefined();
  });

  it("marks a month with a closed snapshot and a locked entry as closed and not blocking", () => {
    expect(findingLine(runA.lines, emp.closedMonth, "2026-02-17")).toMatch(
      /closed=true wouldBlock=false$/,
    );
    expect(findingLine(runA.lines, emp.locked, "2026-04-07")).toMatch(
      /closed=true wouldBlock=false$/,
    );
    // The same finding in an open month blocks.
    expect(findingLine(runA.lines, emp.finding, "2026-04-20")).toMatch(
      /closed=false wouldBlock=true$/,
    );
  });

  it("counts a finding per code, month and month state in the summary", () => {
    const summary = runA.lines.filter((l) => l.startsWith("summary code="));
    expect(summary.length).toBeGreaterThan(0);
    // Closed February: two days of the closed-month employee and the locked cross-salon day.
    expect(summary).toContain("summary code=BREAK_TOO_LATE month=2026-02 open=0 closed=3");
    // The summary is derived from the printed lines: totals agree per code and state.
    const findingLines = runA.lines.filter((l) => l.startsWith("finding "));
    const closedLines = findingLines.filter((l) => l.includes("closed=true")).length;
    const closedSum = summary.reduce((n, l) => n + Number(/closed=(\d+)/.exec(l)![1]), 0);
    expect(closedSum).toBe(closedLines);
    const openSum = summary.reduce((n, l) => n + Number(/open=(\d+)/.exec(l)![1]), 0);
    expect(openSum).toBe(findingLines.length - closedLines);
  });

  it("counts a legacy sum-only day as a hint, never as a finding", () => {
    expect(findingLine(runA.lines, emp.hint, "2026-03-12")).toBeUndefined();
    expect(runA.lines).toContain("hint BREAK_POSITION_UNKNOWN month=2026-03 open=1 closed=0");
  });

  it("counts an entry whose Break rows exceed its stored break as divergent", () => {
    expect(runA.lines).toContain("summary divergent=1");
    expect(findingLine(runA.lines, emp.divergent, "2026-03-13")).toBeUndefined();
  });

  it("applies the § 11 JArbSchG regime: a minor's 4 h 31 min block is a finding, an adult's is not", () => {
    expect(findingLine(runA.lines, emp.minor, "2026-03-16")).toMatch(
      /code=BREAK_TOO_LATE certainty=VIOLATION month=2026-03 closed=false wouldBlock=true$/,
    );
    expect(findingLine(runA.lines, emp.adult, "2026-03-16")).toBeUndefined();
  });

  it("does not block a day whose current acknowledgement waives it", () => {
    expect(findingLine(runA.lines, emp.keyCurrent, "2026-03-18")).toMatch(
      /closed=false wouldBlock=false$/,
    );
    expect(findingLine(runA.lines, emp.staleOpen, "2026-03-18")).toMatch(
      /closed=false wouldBlock=true$/,
    );
  });

  it("counts the days that would block the month close", () => {
    const blocking = runA.lines.filter(
      (l) => l.startsWith("finding ") && l.endsWith("wouldBlock=true"),
    );
    const days = new Set(
      blocking.map((l) => /employeeId=(\S+) date=(\S+)/.exec(l)!.slice(1).join()),
    );
    expect(runA.lines).toContain(`summary wouldBlock=${days.size}`);
  });

  it("reports per tenant how many acknowledgements read as stale because of the new placement key (A8)", () => {
    // One live stale row on an open day, one on a closed day. The revoked row, the row that
    // already carries the key and the days without acknowledgement are not counted.
    expect(runA.lines).toContain(
      `staleAck tenantId=${dataA.tenant.id} month=2026-03 ackRows=1 days=1 openDays=1 closedDays=0`,
    );
    expect(runA.lines).toContain(
      `staleAck tenantId=${dataA.tenant.id} month=2026-02 ackRows=1 days=1 openDays=0 closedDays=1`,
    );
    expect(runA.lines).toContain(
      `staleAckTotal tenantId=${dataA.tenant.id} ackRows=2 days=2 openDays=1 closedDays=1`,
    );
  });

  it("covers every tenant with --all-tenants and prints no personal data", () => {
    expect(runAll.code).toBe(EXIT_FINDINGS);
    expect(findingLine(runAll.lines, emp.finding, "2026-03-10")).toBeDefined();
    expect(findingLine(runAll.lines, emp.findingB, "2026-03-11")).toContain(
      `tenantId=${dataB.tenant.id}`,
    );
    expect(runAll.lines).toContain(
      `staleAckTotal tenantId=${dataB.tenant.id} ackRows=0 days=0 openDays=0 closedDays=0`,
    );
    expect(runAll.lines).toContain(
      `staleAckTotal tenantId=${dataA.tenant.id} ackRows=2 days=2 openDays=1 closedDays=1`,
    );
    const output = [...runA.lines, ...runClipped.lines, ...runAll.lines].join("\n");
    expect(output).not.toMatch(/Vorname|Nachname|A511NUM|@a511\.test/);
  });

  it("changes no row: the counts of the seven touched tables are identical before and after", () => {
    expect(after).toEqual(before);
    expect(Object.keys(before).sort()).toEqual(
      [
        "auditLog",
        "breakRows",
        "dayBreak",
        "dayBreakAck",
        "notification",
        "saldoSnapshot",
        "timeEntry",
      ].sort(),
    );
  });
});
