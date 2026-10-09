/**
 * Issue #511 (D-14, AK-5) — fixture matrix for audit-511-break-placement.ts.
 *
 * The script is a read-only dry run: it lists the days the Satz-2/3 / § 11 JArbSchG break rules
 * flag, per code, month and month state. Fixtures are written directly (the script reads, it never
 * saves an entry); all days lie in March 2026 (CET, UTC+1) unless a test says otherwise.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../src/__tests__/setup";
import {
  main,
  parseCli,
  formatFindingLine,
  EXIT_OK,
  EXIT_FINDINGS,
} from "../audit-511-break-placement";
import type { FastifyInstance } from "fastify";

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
});

describe("audit-511-break-placement — tracer on the worker database", () => {
  let app: FastifyInstance;
  let dataA: Awaited<ReturnType<typeof seedTestData>>;
  let dataB: Awaited<ReturnType<typeof seedTestData>>;
  let empFinding: string;
  let empClean: string;

  async function createEmp(
    data: Awaited<ReturnType<typeof seedTestData>>,
    key: string,
    extra: { birthDate?: Date } = {},
  ): Promise<string> {
    const s = `${key}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
    const user = await app.prisma.user.create({
      data: { email: `${s}@a511.test`, passwordHash: "x", role: "EMPLOYEE", isActive: true },
    });
    const emp = await app.prisma.employee.create({
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
    return emp.id;
  }

  /** One WORK entry (UTC instants; Berlin is UTC+1 on these dates) with optional Break rows. */
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

  beforeAll(async () => {
    app = await getTestApp();
    dataA = await seedTestData(app, "audit511a");
    dataB = await seedTestData(app, "audit511b");
    empFinding = await createEmp(dataA, "F1");
    empClean = await createEmp(dataB, "C1");
    // 08:00-16:00 Berlin, one 30 min break from 14:30: the work before it runs 6.5 h (Satz 3).
    await entry(empFinding, dataA.salonId, "2026-03-10", "07:00", "15:00", {
      breaks: [["13:30", "14:00"]],
      breakMinutes: 30,
    });
    // A short morning only: no finding can exist.
    await entry(empClean, dataB.salonId, "2026-03-10", "07:00", "11:00");
  });

  afterAll(async () => {
    await cleanupTestData(app, dataA.tenant.id);
    await cleanupTestData(app, dataB.tenant.id);
    await closeTestApp();
  });

  it("prints the finding line of a Satz-3 day and exits 2", async () => {
    const run = await capture(() =>
      main(
        ["--tenant-id", dataA.tenant.id, "--from", "2026-03-01", "--to", "2026-03-31"],
        app.prisma,
      ),
    );
    expect(run.code).toBe(EXIT_FINDINGS);
    expect(run.lines).toContain(
      `finding tenantId=${dataA.tenant.id} employeeId=${empFinding} date=2026-03-10 ` +
        `code=BREAK_TOO_LATE certainty=VIOLATION month=2026-03 closed=false wouldBlock=true`,
    );
  });

  it("exits 0 for a tenant without a finding", async () => {
    const run = await capture(() =>
      main(
        ["--tenant-id", dataB.tenant.id, "--from", "2026-03-01", "--to", "2026-03-31"],
        app.prisma,
      ),
    );
    expect(run.code).toBe(EXIT_OK);
    expect(run.lines.filter((l) => l.startsWith("finding "))).toEqual([]);
  });
});
