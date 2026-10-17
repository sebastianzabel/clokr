/**
 * Issue #663 - audit-663-backfilled-snapshots.ts is a read-only listing.
 *
 * Pure cases pin `affectedReasons` (which leave rows the old backfill read differently from the
 * regular close) and `parseBackfillAudit` (the recognition marker); one integration case runs
 * `main` against a seeded tenant and proves (a) exactly the right months are listed, (b) no row of
 * any table the script could touch changes.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  grantSystemRole,
} from "../../src/__tests__/setup";
import { saldoSnapshotPeriodBounds } from "../../src/__tests__/test-dates";
import { leaveTypeFields } from "../../src/contexts/absence/leave-type";
import { affectedReasons, parseBackfillAudit, main } from "../audit-663-backfilled-snapshots";

describe("affectedReasons", () => {
  const lr = (id: string, code: string | null, status = "APPROVED") => ({
    id,
    status,
    leaveType: code === null ? null : { code },
  });

  it("flags an Ueberstundenausgleich, a roster-credit type and a cancellation request", () => {
    const reasons = affectedReasons([
      lr("comp", "OVERTIME_COMP"),
      lr("sick", "SICK"),
      lr("child", "SICK_CHILD"),
      lr("special", "SPECIAL"),
      lr("cancel", "VACATION", "CANCELLATION_REQUESTED"),
    ]);
    expect(reasons.get("OVERTIME_COMP")).toEqual(["comp"]);
    expect(reasons.get("ROSTER_CREDIT")).toEqual(["sick", "child", "special"]);
    expect(reasons.get("CANCELLATION_REQUESTED")).toEqual(["cancel"]);
  });

  it("plain vacation, an unknown type and no leave at all are not affected", () => {
    expect(affectedReasons([lr("v", "VACATION"), lr("n", null)]).size).toBe(0);
    expect(affectedReasons([]).size).toBe(0);
  });
});

describe("parseBackfillAudit", () => {
  const ok = {
    origin: "BACKFILL",
    year: 2026,
    month: 6,
    workedMinutes: 1,
    expectedMinutes: 2,
    balanceMinutes: -1,
  };

  it("reads the month and the stored figures of a BACKFILL row", () => {
    expect(parseBackfillAudit(ok)).toEqual({
      year: 2026,
      month: 6,
      workedMinutes: 1,
      expectedMinutes: 2,
      balanceMinutes: -1,
    });
  });

  it("refuses another origin and malformed values", () => {
    expect(parseBackfillAudit({ ...ok, origin: "SYSTEM" })).toBeNull();
    expect(parseBackfillAudit({ ...ok, month: "6" })).toBeNull();
    expect(parseBackfillAudit(null)).toBeNull();
    expect(parseBackfillAudit("BACKFILL")).toBeNull();
  });
});

describe("main (read-only)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let compTypeId: string;
  let sickTypeId: string;
  let vacationTypeId: string;
  const emp: Record<"comp" | "sick" | "cancel" | "vacation" | "system" | "gone", string> = {
    comp: "",
    sick: "",
    cancel: "",
    vacation: "",
    system: "",
    gone: "",
  };

  const FIGURES = { workedMinutes: 9600, expectedMinutes: 9600, balanceMinutes: -480 };
  const JUNE = new Date("2026-06-01T00:00:00Z");

  async function createEmployee(key: keyof typeof emp): Promise<string> {
    const prisma = app.prisma;
    const user = await prisma.user.create({
      data: {
        email: `a663-${key}-${Date.now().toString(36)}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const e = await prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `A663-${key}-${Date.now().toString(36)}`,
        firstName: "X.",
        lastName: key.toUpperCase(),
        hireDate: new Date("2026-06-01T00:00:00Z"),
      },
    });
    await grantSystemRole(prisma, {
      tenantId: data.tenant.id,
      userId: user.id,
      role: "EMPLOYEE",
    });
    return e.id;
  }

  async function snapshot(employeeId: string) {
    const b = saldoSnapshotPeriodBounds(JUNE);
    return app.prisma.saldoSnapshot.create({
      data: {
        employeeId,
        periodType: "MONTHLY",
        periodStart: b.start,
        periodEnd: b.end,
        ...FIGURES,
        carryOver: -480,
        closedAt: new Date(),
      },
    });
  }

  async function audit(employeeId: string, origin: string, figures = FIGURES) {
    return app.prisma.auditLog.create({
      data: {
        userId: null,
        action: "CREATE",
        entity: "SaldoSnapshot",
        entityId: employeeId,
        newValue: { origin, employeeId, year: 2026, month: 6, ...figures },
      },
    });
  }

  async function leave(employeeId: string, leaveTypeId: string, status = "APPROVED") {
    return app.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId,
        startDate: new Date("2026-06-10T00:00:00Z"),
        endDate: new Date("2026-06-10T00:00:00Z"),
        days: 1,
        status: status as "APPROVED" | "CANCELLATION_REQUESTED",
      },
    });
  }

  const snapIds: Record<string, string> = {};
  const leaveIds: Record<string, string> = {};

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "a663");
    const tenantId = data.tenant.id;
    // seedTestData already seeds some of the types; take what exists, create what is missing.
    const type = async (code: "OVERTIME_COMP" | "SICK" | "VACATION", color: string) => {
      const existing = await app.prisma.leaveType.findFirst({ where: { tenantId, code } });
      if (existing) return existing.id;
      return (
        await app.prisma.leaveType.create({
          data: { tenantId, ...leaveTypeFields(code), color },
        })
      ).id;
    };
    compTypeId = await type("OVERTIME_COMP", "#8B5CF6");
    sickTypeId = await type("SICK", "#EF4444");
    vacationTypeId = await type("VACATION", "#22C55E");

    for (const key of Object.keys(emp) as (keyof typeof emp)[])
      emp[key] = await createEmployee(key);

    // comp / sick / cancel: backfilled months holding affected leave -> listed.
    for (const key of ["comp", "sick", "cancel"] as const) {
      snapIds[key] = (await snapshot(emp[key])).id;
      await audit(emp[key], "BACKFILL");
    }
    leaveIds.comp = (await leave(emp.comp, compTypeId)).id;
    leaveIds.sick = (await leave(emp.sick, sickTypeId)).id;
    leaveIds.cancel = (await leave(emp.cancel, vacationTypeId, "CANCELLATION_REQUESTED")).id;

    // vacation: backfilled, but only plain vacation -> not listed.
    await snapshot(emp.vacation);
    await audit(emp.vacation, "BACKFILL");
    await leave(emp.vacation, vacationTypeId);

    // system: affected leave but closed by the cron (origin SYSTEM) -> not listed.
    await snapshot(emp.system);
    await audit(emp.system, "SYSTEM");
    await leave(emp.system, compTypeId);

    // gone: backfill row whose snapshot figures changed since -> listed with snapshotId=none.
    await snapshot(emp.gone).then((s) =>
      app.prisma.saldoSnapshot.update({ where: { id: s.id }, data: { balanceMinutes: 0 } }),
    );
    await audit(emp.gone, "BACKFILL");
    await leave(emp.gone, compTypeId);
  }, 120_000);

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } finally {
      await closeTestApp();
    }
  });

  async function fingerprint() {
    const ids = Object.values(emp);
    return {
      snapshots: await app.prisma.saldoSnapshot.findMany({
        where: { employeeId: { in: ids } },
        orderBy: { id: "asc" },
      }),
      audits: await app.prisma.auditLog.findMany({
        where: { entityId: { in: ids } },
        orderBy: { id: "asc" },
      }),
      leave: await app.prisma.leaveRequest.findMany({
        where: { employeeId: { in: ids } },
        orderBy: { id: "asc" },
      }),
      entries: await app.prisma.timeEntry.count({ where: { employeeId: { in: ids } } }),
    };
  }

  it("lists exactly the backfilled months with affected leave and changes no row", async () => {
    const before = await fingerprint();
    const lines: string[] = [];
    const findings = await main(app.prisma, {
      tenantId: data.tenant.id,
      out: (l) => lines.push(l),
    });
    expect(await fingerprint()).toEqual(before);

    const byEmp = new Map(findings.map((f) => [f.employeeId, f]));
    expect([...byEmp.keys()].sort()).toEqual([emp.comp, emp.sick, emp.cancel, emp.gone].sort());

    expect(byEmp.get(emp.comp)).toMatchObject({ month: "2026-06", snapshotId: snapIds.comp });
    expect([...byEmp.get(emp.comp)!.reasons.keys()]).toEqual(["OVERTIME_COMP"]);
    expect(byEmp.get(emp.sick)!.reasons.get("ROSTER_CREDIT")).toEqual([leaveIds.sick]);
    expect(byEmp.get(emp.cancel)!.reasons.get("CANCELLATION_REQUESTED")).toEqual([leaveIds.cancel]);
    expect(byEmp.get(emp.gone)!.snapshotId).toBeNull();

    const text = lines.join("\n");
    expect(text).toContain(`tenant ${data.tenant.id}`);
    expect(text).toContain("affected months=4");
    expect(text).toContain(`snapshotId=${snapIds.comp}`);
    expect(text).toContain("snapshotId=none");
    // Ids only: no fixture name ever appears.
    expect(text).not.toMatch(/A663-|X\./);
  });
});

describe("source (read-only)", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../audit-663-backfilled-snapshots.ts", import.meta.url)),
    "utf8",
  );
  // Strip comments so the header prose cannot trigger or hide a hit.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("contains no Prisma write call and no write flag", () => {
    expect(source.length).toBeGreaterThan(1000);
    expect(code).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/);
    expect(code).not.toMatch(/\$executeRaw|\$transaction/);
    expect(code).not.toMatch(/["'](apply|confirm)["']/);
  });
});
