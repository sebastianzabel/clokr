/**
 * Issue #820 - fixture test for audit-820-anonymized-audit-macs.ts: lists anonymized persons whose
 * audit rows still hold a MAC (ids and counts only), skips persons that are clean or not
 * anonymized, exits 0 / 2 / 1, and writes nothing.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { getTestApp, seedTestData, cleanupTestData } from "../../src/__tests__/setup";
import { anonymizeEmployeeData } from "../../src/contexts/platform/anonymize";
import { main, EXIT_OK, EXIT_ERROR, EXIT_FINDINGS } from "../audit-820-anonymized-audit-macs";

const MAC = "aa:bb:cc:dd:82:01";

async function capture(fn: () => Promise<number>): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "info").mockImplementation((...a: unknown[]) => {
    lines.push(a.map(String).join(" "));
  });
  const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    return { code: await fn(), lines };
  } finally {
    spy.mockRestore();
    errSpy.mockRestore();
  }
}

describe("audit-820-anonymized-audit-macs (Issue #820)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let dirty: { employeeId: string; userId: string };
  let clean: { employeeId: string; userId: string };
  let live: { employeeId: string; userId: string };

  async function person(label: string) {
    const suffix = randomUUID().slice(0, 8);
    const user = await app.prisma.user.create({
      data: {
        email: `${label}-${suffix}@test.local`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        firstName: "Max",
        lastName: label,
        employeeNumber: `${label}-${suffix}`,
        hireDate: new Date("2024-01-01"),
      },
    });
    return { employeeId: employee.id, userId: user.id };
  }
  const anonymize = (p: { employeeId: string }) =>
    app.prisma.$transaction((tx) =>
      anonymizeEmployeeData({
        tx,
        employeeId: p.employeeId,
        exitDayIfUnset: new Date("2026-03-10T00:00:00Z"),
      }),
    );

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "audit-820");
    dirty = await person("dirty820");
    clean = await person("clean820");
    live = await person("live820");
    await anonymize(dirty);
    await anonymize(clean);
    // Pre-#820 state: the MAC rows exist AFTER the person was anonymized (as for Bestand persons).
    await app.prisma.auditLog.create({
      data: {
        action: "WIFI_OPT_OUT",
        entity: "PresenceEvent",
        entityId: dirty.employeeId,
        newValue: { mac: MAC },
        purgeable: true,
      },
    });
    await app.prisma.auditLog.create({
      data: {
        action: "WIFI_OPT_OUT",
        entity: "PresenceEvent",
        entityId: live.employeeId,
        newValue: { mac: MAC },
        purgeable: true,
      },
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("audit-820 cleanup failed:", err);
    }
  });

  it("lists only the anonymized person with a MAC row, ids and counts only, exit 2", async () => {
    const before = await app.prisma.auditLog.count();
    const run = await capture(() => main(["--tenant", data.tenant.id], app.prisma));
    expect(run.code).toBe(EXIT_FINDINGS);
    expect(run.lines).toContain(
      `tenant=${data.tenant.id} employee=${dirty.employeeId} auditRows=1 entities=PresenceEvent:1`,
    );
    const text = run.lines.join("\n");
    expect(text).not.toContain(clean.employeeId);
    expect(text).not.toContain(live.employeeId);
    expect(text).not.toContain(MAC);
    expect(text).toContain("Totals: employees=1 auditRows=1");
    expect(await app.prisma.auditLog.count()).toBe(before);
  });

  it("exits 0 when the tenant has no finding (rows redacted)", async () => {
    await app.prisma.auditLog.updateMany({
      where: { entity: "PresenceEvent", entityId: dirty.employeeId },
      data: { newValue: { mac: "[ausgeblendet]" } },
    });
    const run = await capture(() => main(["--tenant", data.tenant.id], app.prisma));
    expect(run.code).toBe(EXIT_OK);
  });

  it("rejects write flags", async () => {
    expect((await capture(() => main(["--confirm"], app.prisma))).code).toBe(EXIT_ERROR);
    expect((await capture(() => main(["--apply"], app.prisma))).code).toBe(EXIT_ERROR);
  });

  it("the source contains no write call", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../audit-820-anonymized-audit-macs.ts", import.meta.url)),
      "utf8",
    )
      .split("\n")
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join("\n");
    expect(src).not.toMatch(/\.(create|update|updateMany|delete|deleteMany|upsert|\$executeRaw)\(/);
  });
});
