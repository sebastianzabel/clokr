/**
 * Issues #388/#508 - fixture test for audit-388-anonymized-leftovers.ts: it lists anonymized
 * employees that still carry MACs or a waiver text (ids and counts only), skips clean and live
 * persons, uses exit codes 0 / 2 / 1 and writes nothing.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { getTestApp, seedTestData, cleanupTestData } from "../../src/__tests__/setup";
import {
  main,
  EXIT_OK,
  EXIT_ERROR,
  EXIT_FINDINGS,
  computeAnonymizedLeftovers,
} from "../audit-388-anonymized-leftovers";

async function capture(fn: () => Promise<number>): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    return { code: await fn(), lines };
  } finally {
    spy.mockRestore();
    errSpy.mockRestore();
  }
}

describe("audit-388-anonymized-leftovers (Issues #388, #508)", () => {
  let app: FastifyInstance;
  let fixture: Awaited<ReturnType<typeof seedTestData>>;
  let clean: Awaited<ReturnType<typeof seedTestData>>;
  const MAC = "aa:bb:cc:00:03:88";
  const WAIVER = "Geheimer Freitext 508";
  const FREE = "Geheimer Freitext 718";
  let dirty = "";
  let tidy = "";
  let live = "";

  async function createEmployee(tenantId: string, label: string, anonymized: boolean, extra = {}) {
    const suffix = randomUUID().slice(0, 8);
    const user = await app.prisma.user.create({
      data: {
        email: `${label}-${suffix}@test.local`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: !anonymized,
      },
    });
    return app.prisma.employee.create({
      data: {
        tenantId,
        userId: user.id,
        firstName: anonymized ? "Gelöscht" : "Live",
        lastName: anonymized ? `GELÖSCHT-${suffix}` : "Person",
        employeeNumber: `${label}-${suffix}`,
        hireDate: new Date("2024-01-01"),
        ...extra,
      },
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    fixture = await seedTestData(app, "audit-388");
    clean = await seedTestData(app, "audit-388-clean");
    dirty = (
      await createEmployee(fixture.tenant.id, "dirty", true, {
        wifiMacs: [MAC, "aa:bb:cc:00:03:89"],
      })
    ).id;
    await app.prisma.presenceDevice.create({
      data: {
        tenantId: fixture.tenant.id,
        employeeId: dirty,
        mac: "aa:bb:cc:00:03:90",
        label: "X",
      },
    });
    await app.prisma.timeEntry.create({
      data: {
        employeeId: dirty,
        date: new Date("2025-06-15"),
        startTime: new Date("2025-06-15T08:00:00Z"),
        endTime: new Date("2025-06-15T16:00:00Z"),
        breakWaivedReason: WAIVER,
        deletedAt: new Date("2025-06-16T00:00:00Z"),
        salonId: fixture.salonId,
      },
    });
    // Issue #718: free-text leftovers of the same person (counts only, never the text).
    await app.prisma.retroEntryRequest.create({
      data: {
        employeeId: dirty,
        targetDate: new Date("2025-06-15"),
        reason: FREE,
        reviewNote: FREE,
        status: "APPROVED",
      },
    });
    await app.prisma.overtimePlan.create({
      data: {
        employeeId: dirty,
        hoursToReduce: 2,
        deadline: new Date("2026-12-31T00:00:00Z"),
        note: FREE,
        createdBy: dirty,
      },
    });
    tidy = (await createEmployee(fixture.tenant.id, "tidy", true)).id;
    live = (await createEmployee(fixture.tenant.id, "live", false, { wifiMacs: [MAC] })).id;
    await createEmployee(clean.tenant.id, "tidy2", true);
  });

  afterAll(async () => {
    await cleanupTestData(app, fixture.tenant.id);
    await cleanupTestData(app, clean.tenant.id);
  });

  it("lists only the anonymized employee with leftovers, with counts and no PII", async () => {
    const run = await capture(() => main(["--tenant", fixture.tenant.id], app.prisma));
    expect(run.code).toBe(EXIT_FINDINGS);
    const text = run.lines.join("\n");
    expect(text).toContain(`employee=${dirty}`);
    expect(text).toContain("findings=WIFI_MACS,PRESENCE_DEVICES,BREAK_WAIVED_REASON");
    expect(text).toContain("wifiMacs=2 presenceDevices=1 breakWaivedReasons=1");
    expect(text).toContain("Totals: employees=1 wifiMacs=2 presenceDevices=1 breakWaivedReasons=1");
    expect(text).toContain("RETRO_REASON,RETRO_REVIEW_NOTE,OVERTIME_PLAN_NOTE");
    expect(text).toContain("retroReasons=1 retroReviewNotes=1 overtimePlanNotes=1");
    expect(text).not.toContain(FREE);
    expect(text).not.toContain(tidy);
    expect(text).not.toContain(live);
    for (const secret of [MAC, WAIVER, "aa:bb:cc:00:03:90"]) expect(text).not.toContain(secret);
  });

  it("exits 0 for a tenant without leftovers and 1 for bad CLI", async () => {
    expect((await capture(() => main(["--tenant", clean.tenant.id], app.prisma))).code).toBe(
      EXIT_OK,
    );
    expect((await capture(() => main(["--confirm"], app.prisma))).code).toBe(EXIT_ERROR);
    expect(await computeAnonymizedLeftovers(app.prisma, { tenantId: clean.tenant.id })).toEqual([]);
  });

  it("writes nothing", async () => {
    const before = await app.prisma.employee.findUniqueOrThrow({ where: { id: dirty } });
    await capture(() => main(["--tenant", fixture.tenant.id], app.prisma));
    const after = await app.prisma.employee.findUniqueOrThrow({ where: { id: dirty } });
    expect(after).toEqual(before);
    const source = readFileSync(
      fileURLToPath(new URL("../audit-388-anonymized-leftovers.ts", import.meta.url)),
      "utf8",
    )
      .split("\n")
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join("\n");
    expect(source).not.toMatch(/\.(create|update|delete|upsert)(Many)?\(|\$executeRaw/);
  });
});
