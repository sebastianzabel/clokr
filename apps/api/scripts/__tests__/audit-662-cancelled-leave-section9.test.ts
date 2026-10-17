/**
 * Issue #662 - fixture test for audit-662-cancelled-leave-section9.ts.
 *
 * The script lists § 9 credits that are not SUPERSEDED although one of their two requests is
 * CANCELLED (the pre-#662 state). Covered: what is listed and what must NOT be, the ids-only
 * output, the exit codes 0 / 2 / 1 and the read-only guarantee (a database fingerprint before and
 * after a run, plus a source scan for write calls).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { getTestApp, seedTestData, cleanupTestData } from "../../src/__tests__/setup";
import { leaveTypeFields } from "../../src/contexts/absence/leave-type";
import {
  main,
  EXIT_OK,
  EXIT_ERROR,
  EXIT_FINDINGS,
  computeCancelledSection9,
} from "../audit-662-cancelled-leave-section9";

async function capture(fn: () => Promise<number>): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const code = await fn();
    return { code, lines };
  } finally {
    spy.mockRestore();
    errSpy.mockRestore();
  }
}

/** Strips block, JSDoc and line comments so a docblock explaining the read-only rule cannot trip a scan. */
function codeOnly(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join("\n");
}

const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

describe("audit-662-cancelled-leave-section9 (Issue #662)", () => {
  let app: FastifyInstance;
  let fixture: Awaited<ReturnType<typeof seedTestData>>;
  let clean: Awaited<ReturnType<typeof seedTestData>>;
  let run: { code: number; lines: string[] };
  const credits = {
    cancelledVacation: "",
    cancelledSick: "",
    supersededOnCancelled: "",
    onLiveRequests: "",
  };

  async function request(
    leaveTypeId: string,
    status: "APPROVED" | "CANCELLED",
    start: string,
    end: string,
  ) {
    return app.prisma.leaveRequest.create({
      data: {
        employeeId: fixture.employee.id,
        leaveTypeId,
        startDate: day(start),
        endDate: day(end),
        days: 2,
        status,
      },
    });
  }

  async function credit(
    vacationRequestId: string,
    sickRequestId: string,
    status: "AU_PENDING" | "CONFIRMED" | "SUPERSEDED",
    start: string,
  ) {
    const row = await app.prisma.section9Credit.create({
      data: {
        employeeId: fixture.employee.id,
        vacationRequestId,
        sickRequestId,
        overlapStart: day(start),
        overlapEnd: day(start),
        status,
      },
    });
    return row.id;
  }

  async function fingerprint(): Promise<string> {
    const [credit, leave, audit] = await Promise.all([
      app.prisma.section9Credit.aggregate({ _count: true, _max: { updatedAt: true } }),
      app.prisma.leaveRequest.aggregate({ _count: true, _max: { updatedAt: true } }),
      app.prisma.auditLog.aggregate({ _count: true, _max: { createdAt: true } }),
    ]);
    return JSON.stringify([credit, leave, audit]);
  }

  beforeAll(async () => {
    app = await getTestApp();
    fixture = await seedTestData(app, "audit662");
    clean = await seedTestData(app, "audit662clean");
    const sickType = await app.prisma.leaveType.create({
      data: { tenantId: fixture.tenant.id, ...leaveTypeFields("SICK"), color: "#8B5CF6" },
    });
    const vac = fixture.vacationType.id;

    // (1) Listed: the vacation is CANCELLED, the credit still stands.
    const cancelledVac = await request(vac, "CANCELLED", "2027-03-01", "2027-03-02");
    const liveSick1 = await request(sickType.id, "APPROVED", "2027-03-01", "2027-03-02");
    credits.cancelledVacation = await credit(
      cancelledVac.id,
      liveSick1.id,
      "CONFIRMED",
      "2027-03-01",
    );

    // (2) Listed: the SICK side is CANCELLED, the credit still stands.
    const liveVac2 = await request(vac, "APPROVED", "2027-04-05", "2027-04-06");
    const cancelledSick = await request(sickType.id, "CANCELLED", "2027-04-05", "2027-04-06");
    credits.cancelledSick = await credit(liveVac2.id, cancelledSick.id, "AU_PENDING", "2027-04-05");

    // (3) NOT listed: cancelled vacation, but the credit is already SUPERSEDED (the post-#662 state).
    const cancelledVac3 = await request(vac, "CANCELLED", "2027-05-03", "2027-05-04");
    const liveSick3 = await request(sickType.id, "APPROVED", "2027-05-03", "2027-05-04");
    credits.supersededOnCancelled = await credit(
      cancelledVac3.id,
      liveSick3.id,
      "SUPERSEDED",
      "2027-05-03",
    );

    // (4) NOT listed: both requests are live.
    const liveVac4 = await request(vac, "APPROVED", "2027-06-07", "2027-06-08");
    const liveSick4 = await request(sickType.id, "APPROVED", "2027-06-07", "2027-06-08");
    credits.onLiveRequests = await credit(liveVac4.id, liveSick4.id, "CONFIRMED", "2027-06-07");

    run = await capture(() => main(["--tenant", fixture.tenant.id], app.prisma));
  });

  afterAll(async () => {
    try {
      await app.prisma.section9Credit.deleteMany({ where: { employeeId: fixture.employee.id } });
      await cleanupTestData(app, fixture.tenant.id);
      await cleanupTestData(app, clean.tenant.id);
    } catch (err) {
      console.error("audit-662 test cleanup failed:", err);
    }
  });

  it("lists exactly the non-superseded credits with a cancelled request on either side, exits 2", async () => {
    expect(run.code).toBe(EXIT_FINDINGS);
    const rows = await computeCancelledSection9(app.prisma, { tenantId: fixture.tenant.id });
    expect(rows.map((r) => r.creditId).sort()).toEqual(
      [credits.cancelledVacation, credits.cancelledSick].sort(),
    );
    expect(
      rows.find((r) => r.creditId === credits.cancelledVacation)?.cancelledRequests[0].side,
    ).toBe("vacation");
    expect(rows.find((r) => r.creditId === credits.cancelledSick)?.cancelledRequests[0].side).toBe(
      "sick",
    );
    const text = run.lines.join("\n");
    expect(text).not.toContain(credits.supersededOnCancelled);
    expect(text).not.toContain(credits.onLiveRequests);
  });

  it("prints ids and status names only, a Totals line, and sorts by tenant then credit id", async () => {
    const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
    const rowLine = new RegExp(
      `^tenant=${UUID} credit=${UUID} employee=${UUID} creditStatus=[A-Z_]+ ` +
        `cancelled=(vacation|sick):${UUID}(,(vacation|sick):${UUID})?$`,
    );
    const rowLines = run.lines.filter((l) => l.startsWith("tenant="));
    expect(rowLines).toHaveLength(2); // anti-vacuity: the regex ran on real lines
    for (const line of rowLines) expect(line).toMatch(rowLine);
    expect(run.lines).toContain("Totals: credits=2 confirmed=1 auPending=1 rejected=0 tenants=1");

    const rows = await computeCancelledSection9(app.prisma, { tenantId: fixture.tenant.id });
    const keys = rows.map((r) => `${r.tenantId}/${r.creditId}`);
    expect(keys).toEqual([...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });

  it("without a --tenant filter it still prints the fixture lines and exits 2", async () => {
    const all = await capture(() => main([], app.prisma));
    expect(all.code).toBe(EXIT_FINDINGS);
    expect(all.lines.some((l) => l.includes(`credit=${credits.cancelledVacation} `))).toBe(true);
  });

  it("exits 0 for a tenant without findings and for a tenant id that does not exist", async () => {
    const cleanRun = await capture(() => main(["--tenant", clean.tenant.id], app.prisma));
    expect(cleanRun.code).toBe(EXIT_OK);
    expect(cleanRun.lines.filter((l) => l.startsWith("tenant="))).toHaveLength(0);
    const unknown = await capture(() => main(["--tenant", randomUUID()], app.prisma));
    expect(unknown.code).toBe(EXIT_OK);
  });

  it("writes nothing: the database fingerprint is identical before and after a run", async () => {
    const before = await fingerprint();
    const again = await capture(() => main([], app.prisma));
    expect(again.code).toBe(EXIT_FINDINGS);
    expect(await fingerprint()).toBe(before);
  });

  it("is read-only in source: no write call, no raw execute, no name/e-mail selected", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../audit-662-cancelled-leave-section9.ts", import.meta.url)),
      "utf8",
    );
    expect(source.length).toBeGreaterThan(1000); // anti-vacuity: the scan read a real file
    const code = codeOnly(source);
    expect(code).toContain("section9Credit.findMany"); // anti-vacuity: the scan sees real code
    expect(code).not.toMatch(
      /\b(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/,
    );
    expect(code).not.toMatch(/\$executeRaw/);
    expect(code).not.toMatch(/\$queryRaw/);
    expect(code).not.toMatch(/select:\s*\{[^}]*(employeeNumber|firstName|lastName|email)/);
    expect(code).toMatch(/help: \{ type: "boolean", default: false \}/);
    expect(code).toMatch(/tenant: \{ type: "string" \}/);
    expect(code).not.toMatch(/\b(apply|confirm)\s*:\s*\{/);
  });

  it("rejects a write flag with exit 1 and --help exits 0", async () => {
    const before = await fingerprint();
    expect((await capture(() => main(["--apply"], app.prisma))).code).toBe(EXIT_ERROR);
    expect((await capture(() => main(["--confirm"], app.prisma))).code).toBe(EXIT_ERROR);
    expect(await fingerprint()).toBe(before);
    const help = await capture(() => main(["--help"], app.prisma));
    expect(help.code).toBe(EXIT_OK);
    expect(help.lines.join("\n")).toContain("READ-ONLY");
  });

  it("without DATABASE_URL and without an injected client it exits 1 and connects to nothing", async () => {
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      expect((await capture(() => main([]))).code).toBe(EXIT_ERROR);
    } finally {
      if (saved !== undefined) process.env.DATABASE_URL = saved;
    }
  });

  it("importing the module is side-effect-free (the entrypoint guard keeps it from running)", () => {
    expect(process.exitCode ?? 0).toBe(0);
  });
});
