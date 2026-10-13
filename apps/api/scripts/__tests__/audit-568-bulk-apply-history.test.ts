/**
 * Issue #568 — fixture test for audit-568-bulk-apply-history.ts.
 *
 * The script is a read-only survey of the contract rows past bulk applies of the default working
 * time wrote. The worker test database may hold audit rows of other files, so every run is narrowed
 * with `--tenant-id` to the fixture tenant and the assertions look at the fixture's own lines only.
 *
 * The audit rows are written directly, with explicit `createdAt` instants (pure data, no clock
 * dependence): a historic pre-#568 apply (no BULK_APPLY row, paired through the time window) and a
 * post-#568 apply (paired exactly through its BULK_APPLY row), plus decoys that must not pair.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../src/__tests__/setup";
import { main, EXIT_OK, EXIT_ERROR, EXIT_FINDINGS } from "../audit-568-bulk-apply-history";

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

type Fixture = Awaited<ReturnType<typeof seedTestData>>;

/** A work-schedule audit snapshot: Decimal columns are strings, validFrom an ISO instant. */
function scheduleSnapshot(
  employeeId: string,
  validFrom: string,
  weekly: number,
  days: number[],
  type = "FIXED_SCHEDULE",
) {
  return {
    id: randomUUID(),
    employeeId,
    type,
    weeklyHours: weekly.toFixed(2),
    mondayHours: days[0].toFixed(2),
    tuesdayHours: days[1].toFixed(2),
    wednesdayHours: days[2].toFixed(2),
    thursdayHours: days[3].toFixed(2),
    fridayHours: days[4].toFixed(2),
    saturdayHours: days[5].toFixed(2),
    sundayHours: days[6].toFixed(2),
    validFrom: `${validFrom}T00:00:00.000Z`,
  };
}

const MIN = 60 * 1000;
// Historic (pre-#568) apply: a fixed mid-month instant, so a validFrom on the 1st is retroactive.
const T_HISTORIC = new Date("2026-09-15T10:00:00.000Z");
// Post-#568 apply at a later fixed instant; its effective date is the 1st of the next month.
const T_GUARDED = new Date("2026-09-20T10:00:00.000Z");
const OLD_16 = [4, 4, 4, 4, 0, 0, 0];
const NEW_40 = [8, 8, 8, 8, 8, 0, 0];

describe("audit-568-bulk-apply-history (Issue #568)", () => {
  let app: FastifyInstance;
  let data: Fixture;
  let foreign: Fixture;
  let empty: Fixture;
  let configId: string;
  const auditIds: string[] = [];
  const decoyWorkScheduleIds: string[] = [];
  const expected = { admin: "", employee: "", guarded: "" };
  let configAuditIds: { historic: string; guarded: string; decoyConfig: string };
  let run: { code: number; lines: string[] };

  async function writeAudit(row: {
    userId: string | null;
    action: string;
    entity: string;
    entityId: string;
    createdAt: Date;
    oldValue?: object;
    newValue?: object;
  }): Promise<string> {
    const created = await app.prisma.auditLog.create({
      data: {
        userId: row.userId,
        action: row.action,
        entity: row.entity,
        entityId: row.entityId,
        createdAt: row.createdAt,
        oldValue: row.oldValue,
        newValue: row.newValue,
      },
    });
    auditIds.push(created.id);
    return created.id;
  }

  async function createRow(opts: {
    userId: string | null;
    employeeId: string;
    at: Date;
    snapshot: ReturnType<typeof scheduleSnapshot>;
    old?: ReturnType<typeof scheduleSnapshot>;
    decoy?: boolean;
  }): Promise<string> {
    await writeAudit({
      userId: opts.userId,
      action: "CREATE",
      entity: "WorkSchedule",
      entityId: opts.snapshot.id,
      createdAt: opts.at,
      oldValue: opts.old,
      newValue: opts.snapshot,
    });
    if (opts.decoy) decoyWorkScheduleIds.push(opts.snapshot.id);
    return opts.snapshot.id;
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "audit568");
    foreign = await seedTestData(app, "audit568f");
    empty = await seedTestData(app, "audit568e");
    configId = (
      await app.prisma.tenantConfig.findUniqueOrThrow({ where: { tenantId: data.tenant.id } })
    ).id;
    const adminId = data.adminEmployee.id;
    const employeeId = data.employee.id;
    const actor = data.adminUser.id;

    // ── Historic apply: UPDATE TenantConfig (applyToExisting) at T, CREATE rows 2 min before ──
    const historicAt = new Date(T_HISTORIC.getTime() - 2 * MIN);
    expected.admin = await createRow({
      userId: actor,
      employeeId: adminId,
      at: historicAt,
      snapshot: scheduleSnapshot(adminId, "2026-09-01", 40, NEW_40),
      old: scheduleSnapshot(adminId, "2024-01-01", 16, OLD_16),
    });
    expected.employee = await createRow({
      userId: actor,
      employeeId,
      at: historicAt,
      snapshot: scheduleSnapshot(employeeId, "2026-09-01", 40, NEW_40),
    });
    // Decoys that must NOT pair:
    // 1. same user, 20 minutes before the config row (outside the window)
    await createRow({
      userId: actor,
      employeeId: adminId,
      at: new Date(T_HISTORIC.getTime() - 20 * MIN),
      snapshot: scheduleSnapshot(adminId, "2026-09-01", 39, NEW_40),
      decoy: true,
    });
    // 2. a validFrom in a different month than the config row's
    await createRow({
      userId: actor,
      employeeId: adminId,
      at: historicAt,
      snapshot: scheduleSnapshot(adminId, "2026-07-01", 38, NEW_40),
      decoy: true,
    });
    // 3. another user
    await createRow({
      userId: data.empUser.id,
      employeeId: adminId,
      at: historicAt,
      snapshot: scheduleSnapshot(adminId, "2026-09-01", 37, NEW_40),
      decoy: true,
    });
    // 4. a different schedule type (the old loop only ever wrote FIXED_SCHEDULE rows)
    await createRow({
      userId: actor,
      employeeId: adminId,
      at: historicAt,
      snapshot: scheduleSnapshot(adminId, "2026-09-01", 36, NEW_40, "SHIFT_BASED"),
      decoy: true,
    });
    // 5. an employee of another tenant
    await createRow({
      userId: actor,
      employeeId: foreign.adminEmployee.id,
      at: historicAt,
      snapshot: scheduleSnapshot(foreign.adminEmployee.id, "2026-09-01", 35, NEW_40),
      decoy: true,
    });
    const historicConfig = await writeAudit({
      userId: actor,
      action: "UPDATE",
      entity: "TenantConfig",
      entityId: configId,
      createdAt: T_HISTORIC,
      newValue: { applyToExisting: true, defaultWeeklyHours: 40, appliedCount: 2 },
    });
    // Same shape but applyToExisting false: not a bulk apply, its CREATE row is a decoy as well
    const decoyConfigAt = new Date("2026-08-10T10:00:00.000Z");
    await createRow({
      userId: actor,
      employeeId: adminId,
      at: new Date(decoyConfigAt.getTime() - 2 * MIN),
      snapshot: scheduleSnapshot(adminId, "2026-08-01", 34, NEW_40),
      decoy: true,
    });
    const decoyConfig = await writeAudit({
      userId: actor,
      action: "UPDATE",
      entity: "TenantConfig",
      entityId: configId,
      createdAt: decoyConfigAt,
      newValue: { applyToExisting: false, defaultWeeklyHours: 40 },
    });

    // ── Post-#568 apply: CREATE row, then BULK_APPLY row, then the UPDATE row ──
    const guardedBulkAt = new Date(T_GUARDED.getTime() - 1000);
    const guardedCreateAt = new Date(T_GUARDED.getTime() - 2000);
    expected.guarded = await createRow({
      userId: actor,
      employeeId: adminId,
      at: guardedCreateAt,
      snapshot: scheduleSnapshot(adminId, "2026-10-01", 40, NEW_40),
      old: scheduleSnapshot(adminId, "2026-09-01", 40, NEW_40),
    });
    // In the window but not among the applied ids: must not pair on the exact path
    await createRow({
      userId: actor,
      employeeId,
      at: guardedCreateAt,
      snapshot: scheduleSnapshot(employeeId, "2026-10-01", 33, NEW_40),
      decoy: true,
    });
    await writeAudit({
      userId: actor,
      action: "BULK_APPLY",
      entity: "TenantConfig",
      entityId: configId,
      createdAt: guardedBulkAt,
      newValue: {
        effectiveFrom: "2026-10-01",
        appliedEmployeeIds: [adminId],
        deselectedCandidateIds: [],
        previewFingerprint: "x",
      },
    });
    const guardedConfig = await writeAudit({
      userId: actor,
      action: "UPDATE",
      entity: "TenantConfig",
      entityId: configId,
      createdAt: T_GUARDED,
      newValue: { applyToExisting: true, defaultWeeklyHours: 40, appliedCount: 1 },
    });

    configAuditIds = { historic: historicConfig, guarded: guardedConfig, decoyConfig };
    run = await capture(() => main(["--tenant-id", data.tenant.id], app.prisma));
  });

  afterAll(async () => {
    try {
      await app.prisma.auditLog.deleteMany({ where: { id: { in: auditIds } } });
      await cleanupTestData(app, data.tenant.id);
      await cleanupTestData(app, foreign.tenant.id);
      await cleanupTestData(app, empty.tenant.id);
    } catch (err) {
      console.error("audit-568 cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("pairs the historic apply by window and lists both rows with old -> new hours and flags, exit 2", () => {
    expect(run.code).toBe(EXIT_FINDINGS);
    const windowLines = run.lines.filter((l) => l.includes("source=WINDOW"));
    expect(windowLines).toHaveLength(2);

    const admin = windowLines.find((l) => l.includes(`workScheduleId=${expected.admin}`))!;
    expect(admin).toBeDefined();
    expect(admin).toContain(`configAuditId=${configAuditIds.historic}`);
    expect(admin).toContain(`tenantId=${data.tenant.id}`);
    expect(admin).toContain(`employeeId=${data.adminEmployee.id}`);
    expect(admin).toContain("validFrom=2026-09-01");
    expect(admin).toContain("weekly=16->40");
    expect(admin).toContain("days=4/4/4/4/0/0/0->8/8/8/8/8/0/0");
    expect(admin).toMatch(/flags=\S*HOURS_CHANGED/);
    expect(admin).toMatch(/flags=\S*RETROACTIVE/);
    expect(admin).not.toContain("NO_PREVIOUS_CONTRACT");

    const noContract = windowLines.find((l) => l.includes(`workScheduleId=${expected.employee}`))!;
    expect(noContract).toBeDefined();
    expect(noContract).toContain(`employeeId=${data.employee.id}`);
    expect(noContract).toContain("weekly=none->40");
    expect(noContract).toMatch(/flags=\S*NO_PREVIOUS_CONTRACT/);
    expect(noContract).toMatch(/flags=\S*RETROACTIVE/);
    expect(noContract).not.toContain("HOURS_CHANGED");
  });

  it("pairs the post-#568 apply exactly through its BULK_APPLY row, with no flag for unchanged hours", () => {
    const exact = run.lines.filter((l) => l.includes("source=BULK_APPLY"));
    expect(exact).toHaveLength(1);
    expect(exact[0]).toContain(`configAuditId=${configAuditIds.guarded}`);
    expect(exact[0]).toContain(`workScheduleId=${expected.guarded}`);
    expect(exact[0]).toContain(`employeeId=${data.adminEmployee.id}`);
    expect(exact[0]).toContain("validFrom=2026-10-01");
    expect(exact[0]).toContain("weekly=40->40");
    expect(exact[0]).toContain("flags=NONE");
  });

  it("ignores every decoy and the config row without applyToExisting", () => {
    const output = run.lines.join("\n");
    expect(decoyWorkScheduleIds.length).toBeGreaterThanOrEqual(7);
    for (const id of decoyWorkScheduleIds) expect(output).not.toContain(id);
    expect(output).not.toContain(configAuditIds.decoyConfig);
    expect(output).not.toContain(foreign.adminEmployee.id);
    expect(run.lines.filter((l) => l.includes("workScheduleId="))).toHaveLength(3);
  });

  it("prints a totals line over the paired rows", () => {
    expect(run.lines).toContain(
      "Totals: configRows=2 pairedRows=3 hoursChanged=1 retroactive=2 noPreviousContract=1",
    );
  });

  it("prints ids and numbers only: no name, mail address or employee number appears", () => {
    const output = run.lines.join("\n");
    expect(output).not.toContain("@");
    for (const fixture of [data, foreign]) {
      expect(output).not.toContain(fixture.adminEmployee.employeeNumber);
      expect(output).not.toContain(fixture.employee.employeeNumber);
    }
    expect(output).not.toContain(data.adminEmployee.firstName);
    expect(output).not.toContain(data.adminEmployee.lastName);
  });

  it("a tenant without a bulk apply exits 0 with a totals line of zeros", async () => {
    const result = await capture(() => main(["--tenant-id", empty.tenant.id], app.prisma));
    expect(result.code).toBe(EXIT_OK);
    expect(result.lines).toContain(
      "Totals: configRows=0 pairedRows=0 hoursChanged=0 retroactive=0 noPreviousContract=0",
    );
  });

  it("rejects a write flag and a malformed tenant id with exit 1, and --help exits 0", async () => {
    expect((await capture(() => main(["--confirm"], app.prisma))).code).toBe(EXIT_ERROR);
    expect((await capture(() => main(["--apply"], app.prisma))).code).toBe(EXIT_ERROR);
    expect((await capture(() => main(["--tenant-id", "not-a-uuid"], app.prisma))).code).toBe(
      EXIT_ERROR,
    );
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

  it("is read-only: the fixture audit rows are unchanged and the source has no write call", async () => {
    const rows = await app.prisma.auditLog.count({ where: { id: { in: auditIds } } });
    expect(rows).toBe(auditIds.length);

    const source = readFileSync(
      fileURLToPath(new URL("../audit-568-bulk-apply-history.ts", import.meta.url)),
      "utf8",
    );
    expect(source.length).toBeGreaterThan(1000); // anti-vacuity: the scan read a real file
    expect(source).not.toMatch(
      /\.(update|create|delete|updateMany|deleteMany|upsert|createMany)\(/,
    );
    expect(source).not.toMatch(/\$executeRaw|\$queryRaw/);
    // The CLI accepts exactly --tenant-id and --help; no write flag is declared
    expect(source).toMatch(/options:\s*\{\s*"tenant-id": \{ type: "string" \},\s*help: /);
    // Names, e-mail and employee numbers are never selected
    expect(source).not.toMatch(/firstName|lastName|email|employeeNumber/);
  });

  it("importing the module is side-effect-free (the entrypoint guard keeps it from running)", () => {
    expect(process.exitCode ?? 0).toBe(0);
  });
});
