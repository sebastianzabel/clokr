/**
 * Phase 79 Plan 01 (Issue #79), R1/R2/R3, D-06/D-14 — `GET /api/v1/time-entries` items carry the
 * per-entry `presenceMinutes` and `workingMinutes` (integers, Math.round at the API edge only);
 * an open entry carries null for both; every pre-existing key of an item is unchanged.
 *
 * All instants are fixed February-2026 instants — nothing is relative to "now".
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";

type Item = {
  id: string;
  date: string;
  presenceMinutes?: number | null;
  workingMinutes?: number | null;
  [k: string]: unknown;
};

describe("Issue #79 — per-entry presence and working time on GET /time-entries", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  const ids: Record<"a" | "b" | "c" | "d" | "e", string> = {
    a: "",
    b: "",
    c: "",
    d: "",
    e: "",
  };

  async function seedEntry(
    key: keyof typeof ids,
    date: string,
    start: string,
    end: string | null,
    extra: Record<string, unknown> = {},
  ) {
    const row = await app.prisma.timeEntry.create({
      data: {
        employeeId: data.employee.id,
        salonId: data.salonId,
        date: new Date(date),
        startTime: new Date(`${date}T${start}Z`),
        endTime: end ? new Date(`${date}T${end}Z`) : null,
        source: "MANUAL",
        breakMinutes: 0,
        ...extra,
      },
    });
    ids[key] = row.id;
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "ted79");
    await seedEntry("a", "2026-02-02", "08:00:00.000", "16:00:00.000", { breakMinutes: 30 });
    await seedEntry("b", "2026-02-03", "08:00:00.000", null);
    await seedEntry("c", "2026-02-04", "08:00:00.000", "12:00:00.000", { isInvalid: true });
    await seedEntry("d", "2026-02-05", "08:00:00.000", "16:00:40.000", { breakMinutes: 30 });
    await seedEntry("e", "2026-02-06", "08:00:00.000", "16:00:00.000", { type: "OVERTIME" });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch {
      // best-effort cleanup
    }
    await closeTestApp();
  });

  async function list(token: string, withEmployeeId: boolean): Promise<Item[]> {
    const qs = new URLSearchParams({ from: "2026-02-01", to: "2026-02-28" });
    if (withEmployeeId) qs.set("employeeId", data.employee.id);
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/time-entries?${qs.toString()}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body) as Item[];
  }

  const byId = (items: Item[], id: string) => items.find((i) => i.id === id);

  it("admin: the issue's example reads presence 480 / working 450; open is null; invalid and OVERTIME computed uniformly; seconds rounded", async () => {
    const items = await list(data.adminToken, true);
    expect(items).toHaveLength(5);

    const a = byId(items, ids.a)!;
    expect(a.presenceMinutes).toBe(480);
    expect(a.workingMinutes).toBe(450);

    const b = byId(items, ids.b)!;
    expect(b.presenceMinutes).toBeNull();
    expect(b.workingMinutes).toBeNull();

    const c = byId(items, ids.c)!;
    expect(c.presenceMinutes).toBe(240);
    expect(c.workingMinutes).toBe(240);

    const d = byId(items, ids.d)!;
    expect(d.presenceMinutes).toBe(481); // 480.666...
    expect(d.workingMinutes).toBe(451); // 450.666...

    const e = byId(items, ids.e)!;
    expect(e.presenceMinutes).toBe(480);
    expect(e.workingMinutes).toBe(480);
  });

  it("employee (EIGENE): own items carry the same two fields with the same values", async () => {
    const items = await list(data.empToken, false);
    expect(items).toHaveLength(5);
    const a = byId(items, ids.a)!;
    expect(a.presenceMinutes).toBe(480);
    expect(a.workingMinutes).toBe(450);
    expect(byId(items, ids.b)!.presenceMinutes).toBeNull();
    expect(byId(items, ids.d)!.workingMinutes).toBe(451);
  });

  it("every pre-existing key of an item is unchanged", async () => {
    const items = await list(data.adminToken, true);
    const a = byId(items, ids.a)!;
    const { presenceMinutes: _p, workingMinutes: _w, ...rest } = a;
    void _p;
    void _w;
    const row = await app.prisma.timeEntry.findUnique({
      where: { id: ids.a },
      include: {
        employee: { select: { firstName: true, lastName: true } },
        breaks: { orderBy: { startTime: "asc" } },
      },
    });
    expect(rest).toEqual(JSON.parse(JSON.stringify(row)));
  });
});
