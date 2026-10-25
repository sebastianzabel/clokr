/**
 * Issue #613 (D-03) - fixture test for audit-613-month-close-population.ts.
 *
 * The script is a read-only survey of the persons the auto-close cron (login state) and the report
 * population rule (employment) select differently. It prints ids, reason codes and counts only. The
 * worker test database may hold other tenants, so every assertion is scoped with `--tenant-id` and
 * looks for the fixture's own lines, never for global totals.
 *
 * Month under test: September 2026 (tenant time zone Europe/Berlin). Persons (hire 2025-01-01):
 *   L   login off, employed all September, TZ-converted September snapshot -> EMPLOYED_LOGIN_INACTIVE, closed
 *   L2  login off, employed all September, legacy September snapshot      -> EMPLOYED_LOGIN_INACTIVE, closed
 *   Q   left 2026-08-31, login on, no August snapshot                    -> NOT_EMPLOYED_LOGIN_ACTIVE, open
 *   R   hired 2026-10-01, login on                                       -> NOT_EMPLOYED_LOGIN_ACTIVE
 *   S   anonymised sentinel, login (inconsistently) on                   -> ANONYMIZED_LOGIN_ACTIVE
 *   B   login on, employed                                               -> no line
 *   X   exempt from time tracking                                        -> no line
 *   V   left 2026-08-31, login off, TZ-converted August snapshot         -> no line, exit month closed
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../src/__tests__/setup";
import {
  createPopulationPerson,
  type PopulationPerson,
} from "../../src/__tests__/population-fixtures-613";
import { main, EXIT_OK, EXIT_ERROR, EXIT_FINDINGS } from "../audit-613-month-close-population";

const FAKE_NOW = new Date("2026-11-18T10:00:00Z");
const HIRE = new Date("2025-01-01T00:00:00.000Z");
const day = (d: string) => new Date(`${d}T00:00:00.000Z`);

async function capture(fn: () => Promise<number>): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FAKE_NOW);
  try {
    const code = await fn();
    return { code, lines };
  } finally {
    vi.useRealTimers();
    spy.mockRestore();
  }
}

describe("audit-613-month-close-population (Issue #613, D-03)", () => {
  let app: FastifyInstance;
  let d: Awaited<ReturnType<typeof seedTestData>>;
  let clean: Awaited<ReturnType<typeof seedTestData>>;
  let p: Record<"L" | "L2" | "Q" | "R" | "S" | "B" | "X" | "V", PopulationPerson>;
  let run: { code: number; lines: string[] };
  let before: Record<string, number>;

  async function counts(tenantId: string): Promise<Record<string, number>> {
    return {
      employee: await app.prisma.employee.count({ where: { tenantId } }),
      user: await app.prisma.user.count(),
      saldoSnapshot: await app.prisma.saldoSnapshot.count({ where: { employee: { tenantId } } }),
      auditLog: await app.prisma.auditLog.count(),
    };
  }

  async function snapshot(employeeId: string, periodStart: string, periodEnd: string) {
    await app.prisma.saldoSnapshot.create({
      data: {
        employeeId,
        periodType: "MONTHLY",
        periodStart: day(periodStart),
        periodEnd: day(periodEnd),
        workedMinutes: 0,
        expectedMinutes: 0,
        balanceMinutes: 0,
        carryOver: 0,
        closedAt: new Date("2026-10-02T06:00:00Z"),
        superseded: false,
      },
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    d = await seedTestData(app, "a613");
    clean = await seedTestData(app, "a613c");
    const base = { tenantId: d.tenant.id, salonId: d.salonId, hireDate: HIRE };
    p = {
      L: await createPopulationPerson(app, { ...base, tag: "l", loginActive: false }),
      L2: await createPopulationPerson(app, { ...base, tag: "l2", loginActive: false }),
      Q: await createPopulationPerson(app, { ...base, tag: "q", exitDate: day("2026-08-31") }),
      R: await createPopulationPerson(app, { ...base, tag: "r", hireDate: day("2026-10-01") }),
      S: await createPopulationPerson(app, { ...base, tag: "s", anonymized: true }),
      B: await createPopulationPerson(app, { ...base, tag: "b" }),
      X: await createPopulationPerson(app, { ...base, tag: "x", loginActive: false }),
      V: await createPopulationPerson(app, {
        ...base,
        tag: "v",
        loginActive: false,
        exitDate: day("2026-08-31"),
      }),
    };
    // S: anonymised with an active login (a synthetic, inconsistent legacy state).
    await app.prisma.user.update({ where: { id: p.S.userId }, data: { isActive: true } });
    // X: exempt from time tracking AND login off - in neither selection.
    await app.prisma.employee.update({
      where: { id: p.X.employeeId },
      data: { isTimeTrackingExempt: true },
    });
    // TZ-converted convention (Berlin): the local month's instants stored as dates.
    await snapshot(p.L.employeeId, "2026-08-31", "2026-09-30");
    // Legacy convention: first and last day of the month.
    await snapshot(p.L2.employeeId, "2026-09-01", "2026-09-30");
    await snapshot(p.V.employeeId, "2026-07-31", "2026-08-31");

    before = await counts(d.tenant.id);
    run = await capture(() =>
      main(["--tenant-id", d.tenant.id, "--year", "2026", "--month", "9"], app.prisma),
    );
  }, 180_000);

  afterAll(async () => {
    try {
      await cleanupTestData(app, d.tenant.id);
      await cleanupTestData(app, clean.tenant.id);
    } catch (err) {
      console.error("audit-613 cleanup failed:", err);
    }
    await closeTestApp();
  });

  const line = (id: string, reason: string, closed: "yes" | "no") =>
    `tenant=${d.tenant.id} month=2026-09 employee=${id} reason=${reason} monthClosed=${closed}`;

  it("exits 2 and lists exactly the persons the two selections disagree on, with reason and closed flag", () => {
    expect(run.code).toBe(EXIT_FINDINGS);
    expect(run.lines).toContain(line(p.L.employeeId, "EMPLOYED_LOGIN_INACTIVE", "yes"));
    expect(run.lines).toContain(line(p.L2.employeeId, "EMPLOYED_LOGIN_INACTIVE", "yes"));
    expect(run.lines).toContain(line(p.Q.employeeId, "NOT_EMPLOYED_LOGIN_ACTIVE", "no"));
    expect(run.lines).toContain(line(p.R.employeeId, "NOT_EMPLOYED_LOGIN_ACTIVE", "no"));
    expect(run.lines).toContain(line(p.S.employeeId, "ANONYMIZED_LOGIN_ACTIVE", "no"));
  });

  it("prints no line for a person both selections contain, an exempt person or a leaver with a login off", () => {
    const mentions = (id: string) => run.lines.filter((l) => l.includes(`employee=${id} `));
    expect(mentions(p.B.employeeId)).toEqual([]);
    expect(mentions(p.X.employeeId)).toEqual([]);
    expect(mentions(p.V.employeeId)).toEqual([]);
  });

  it("prints a per-tenant count line and counts the open final saldo of exited persons with the overview's functions", () => {
    // The tenant's own seeded accounts agree between the selections; the fixture adds 5 differences.
    const countLine = run.lines.find((l) =>
      l.startsWith(`tenant=${d.tenant.id} month=2026-09 differences=`),
    );
    expect(countLine).toBe(`tenant=${d.tenant.id} month=2026-09 differences=5`);
    // Q left on 31.08. with no August snapshot (open); V's August is closed.
    expect(run.lines).toContain(`tenant=${d.tenant.id} exitedOpenFinalSaldo=1`);
  });

  it("prints ids, reason codes and counts only - no name, employee number or e-mail", () => {
    const all = run.lines.join("\n");
    for (const person of Object.values(p)) {
      expect(all).not.toContain(person.email);
      expect(all).not.toContain(person.employeeNumber);
    }
    expect(all).not.toContain("P613");
    expect(all).not.toContain("Gelöscht");
    expect(all).not.toContain("example.invalid");
  });

  it("is read-only: row counts are identical before and after the run", async () => {
    expect(await counts(d.tenant.id)).toEqual(before);
  });

  it("exits 0 for a tenant whose two selections agree", async () => {
    const result = await capture(() =>
      main(["--tenant-id", clean.tenant.id, "--year", "2026", "--month", "9"], app.prisma),
    );
    expect(result.code).toBe(EXIT_OK);
    expect(result.lines).toContain(`tenant=${clean.tenant.id} month=2026-09 differences=0`);
  });

  it("exits 1 for an invalid argument, an unknown flag and a missing database URL; --help exits 0", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      expect(await main(["--year", "2026"], app.prisma)).toBe(EXIT_ERROR);
      expect(await main(["--year", "2026", "--month", "13"], app.prisma)).toBe(EXIT_ERROR);
      expect(await main(["--tenant-id", "not-a-uuid"], app.prisma)).toBe(EXIT_ERROR);
      expect(await main(["--confirm"], app.prisma)).toBe(EXIT_ERROR);
      expect(await main([])).toBe(EXIT_ERROR);
    } finally {
      errSpy.mockRestore();
      if (saved !== undefined) process.env.DATABASE_URL = saved;
    }
    const help = await capture(() => main(["--help"]));
    expect(help.code).toBe(EXIT_OK);
  });

  it("has no write call in its source, and importing the module is side-effect-free", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../audit-613-month-close-population.ts", import.meta.url)),
      "utf8",
    );
    expect(source.length).toBeGreaterThan(1000); // anti-vacuity: the scan read a real file
    expect(source).not.toMatch(
      /\.(update|create|delete|updateMany|deleteMany|upsert|createMany)\(/,
    );
    expect(source).not.toMatch(/\$executeRaw|\$queryRaw/);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("source anchor (Issue #668): the cron and the deferred close select by employment, not by login state, and exclude exempt persons", () => {
    const read = (rel: string) =>
      readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
    const cron = read("../../src/contexts/working-time-account/plugins/auto-close-month.ts");
    const deferred = read("../../src/contexts/working-time-account/deferred-month-close.ts");
    for (const source of [cron, deferred]) {
      expect(source.length).toBeGreaterThan(1000);
      expect(source).toContain("monthClosePopulationWhere(");
      expect(source).not.toContain("user: { isActive: true },");
      expect(source).toContain("isTimeTrackingExempt: false");
    }
  });
});
