/**
 * Issue #799 - audit-799-clock-entries-without-auto-break.ts is a read-only listing: it lists
 * exactly the closed NFC/WIFI entries of an open month, over 6 h, without a break, in a tenant with
 * the automatic break on - and changes no row.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../src/__tests__/setup";
import {
  main,
  parseCli,
  EXIT_OK,
  EXIT_FINDINGS,
} from "../audit-799-clock-entries-without-auto-break";

async function capture(fn: () => Promise<number>): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  try {
    return { code: await fn(), lines };
  } finally {
    spy.mockRestore();
  }
}

describe("audit-799-clock-entries-without-auto-break (Issue #799)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  const ids: Record<string, string> = {};

  async function entry(
    key: string,
    day: number,
    hours: number,
    extra: Record<string, unknown> = {},
  ) {
    const start = new Date(Date.UTC(2026, 6, day, 6, 0, 0));
    const row = await app.prisma.timeEntry.create({
      data: {
        employeeId: data.employee.id,
        date: new Date(Date.UTC(2026, 6, day)),
        startTime: start,
        endTime: new Date(start.getTime() + hours * 3_600_000),
        source: "NFC",
        salonId: data.salonId,
        ...extra,
      },
    });
    ids[key] = row.id;
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "a799");
    await app.prisma.tenantConfig.update({
      where: { tenantId: data.tenant.id },
      data: { autoBreakEnabled: true },
    });
    await entry("hit", 1, 8);
    await entry("wifiHit", 2, 7, { source: "WIFI" });
    await entry("short", 3, 5);
    await entry("web", 6, 8, { source: "MANUAL" });
    await entry("locked", 7, 8, { isLocked: true });
    await entry("deleted", 8, 8, { deletedAt: new Date("2026-07-20T00:00:00Z") });
    await entry("withBreak", 9, 8, { breakMinutes: 30 });
  });

  afterAll(async () => {
    try {
      await app.prisma.timeEntry.deleteMany({ where: { employeeId: data.employee.id } });
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("a799 cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("rejects write flags", () => {
    expect(() => parseCli(["--all-tenants", "--confirm"])).toThrow();
    expect(() => parseCli(["--all-tenants", "--apply"])).toThrow();
  });

  it("lists exactly the NFC/WIFI entries without break in an open month, writes nothing", async () => {
    const before = await app.prisma.timeEntry.findMany({
      where: { employeeId: data.employee.id },
      orderBy: { id: "asc" },
    });
    const { code, lines } = await capture(() =>
      main(["--tenant-id", data.tenant.id], app.prisma as never),
    );
    expect(code).toBe(EXIT_FINDINGS);
    const listed = lines.filter((l) => l.startsWith("entry ")).join("\n");
    expect(listed).toContain(ids.hit);
    expect(listed).toContain(ids.wifiHit);
    for (const k of ["short", "web", "locked", "deleted", "withBreak"]) {
      expect(listed).not.toContain(ids[k]);
    }
    expect(lines.join("\n")).toContain("2 entries listed");
    const after = await app.prisma.timeEntry.findMany({
      where: { employeeId: data.employee.id },
      orderBy: { id: "asc" },
    });
    expect(after).toEqual(before);
  });

  it("lists nothing for a tenant with the automatic break off", async () => {
    await app.prisma.tenantConfig.update({
      where: { tenantId: data.tenant.id },
      data: { autoBreakEnabled: false },
    });
    const { code } = await capture(() =>
      main(["--tenant-id", data.tenant.id], app.prisma as never),
    );
    expect(code).toBe(EXIT_OK);
  });
});
