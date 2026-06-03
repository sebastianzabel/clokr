import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";

// Mock the HTTP client BEFORE importing the sync module so the import wires up
// against the spy. We re-import inside tests after each vi.doMock to ensure
// freshness.
const fetchSpy = vi.fn();

vi.mock("../utils/school-holidays-client", async () => {
  const actual = await vi.importActual<typeof import("../utils/school-holidays-client")>(
    "../utils/school-holidays-client",
  );
  return {
    ...actual,
    fetchSchoolHolidays: (sub: string, from: number, to: number): Promise<unknown> =>
      fetchSpy(sub, from, to),
  };
});

// Import AFTER vi.mock — synchronous import order matters.
import { syncSchoolHolidaysForTenant, type SyncResult } from "../plugins/school-holidays-sync";
import { SchoolHolidaysApiError } from "../utils/school-holidays-client";
import { FederalState } from "@clokr/db";

const BASE = "/api/v1/admin/school-holidays";

describe("school-holidays-sync — syncSchoolHolidaysForTenant", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let adminToken: string;
  let empToken: string;
  let seed: Awaited<ReturnType<typeof seedTestData>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const log = { warn: vi.fn(), info: vi.fn() } as any;

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "sh-sync");
    tenantId = seed.tenant.id;
    adminToken = seed.adminToken;
    empToken = seed.empToken;
  });

  afterAll(async () => {
    try {
      await app.prisma.schoolHolidayPeriod.deleteMany({ where: { tenantId } });
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("cleanup failed", err);
    }
  });

  beforeEach(async () => {
    fetchSpy.mockReset();
    log.warn.mockReset?.();
    log.info.mockReset?.();
    await app.prisma.schoolHolidayPeriod.deleteMany({ where: { tenantId } });
  });

  it("upserts rows for a single federal state on success", async () => {
    fetchSpy.mockResolvedValueOnce([
      {
        externalId: "uuid-1",
        startDate: new Date("2026-02-16T00:00:00Z"),
        endDate: new Date("2026-02-20T00:00:00Z"),
        name: "Frühjahrsferien",
        subdivisionCode: "DE-NI",
      },
      {
        externalId: "uuid-2",
        startDate: new Date("2026-07-27T00:00:00Z"),
        endDate: new Date("2026-09-07T00:00:00Z"),
        name: "Sommerferien",
        subdivisionCode: "DE-NI",
      },
    ]);

    const result = await syncSchoolHolidaysForTenant(
      app.prisma,
      tenantId,
      ["NIEDERSACHSEN" as FederalState],
      { from: 2026, to: 2026 },
      log,
    );

    expect(result.perState).toHaveLength(1);
    expect(result.perState[0]).toMatchObject({
      federalState: "NIEDERSACHSEN",
      upserts: 2,
      status: "OK",
    });

    const rows = await app.prisma.schoolHolidayPeriod.findMany({ where: { tenantId } });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.source === "OPENHOLIDAYS_API")).toBe(true);
    expect(rows.every((r) => r.fetchedAt.getTime() === result.syncedAt.getTime())).toBe(true);
  });

  it("is idempotent — same DTOs twice = same row count", async () => {
    const dtos = [
      {
        externalId: "uuid-1",
        startDate: new Date("2026-02-16T00:00:00Z"),
        endDate: new Date("2026-02-20T00:00:00Z"),
        name: "Frühjahrsferien",
        subdivisionCode: "DE-NI",
      },
    ];
    fetchSpy.mockResolvedValue(dtos);

    await syncSchoolHolidaysForTenant(
      app.prisma,
      tenantId,
      ["NIEDERSACHSEN" as FederalState],
      { from: 2026, to: 2026 },
      log,
    );
    await syncSchoolHolidaysForTenant(
      app.prisma,
      tenantId,
      ["NIEDERSACHSEN" as FederalState],
      { from: 2026, to: 2026 },
      log,
    );

    const rows = await app.prisma.schoolHolidayPeriod.findMany({ where: { tenantId } });
    expect(rows).toHaveLength(1); // upsert, not insert
  });

  it("stale-cache fallback: API failure does NOT delete existing rows", async () => {
    // 1. Seed an existing row from a previous successful sync (mocked old fetchedAt).
    const oldFetchedAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000); // 5 days ago
    await app.prisma.schoolHolidayPeriod.create({
      data: {
        tenantId,
        federalState: "NIEDERSACHSEN" as FederalState,
        startDate: new Date("2026-02-16T00:00:00Z"),
        endDate: new Date("2026-02-20T00:00:00Z"),
        name: "Frühjahrsferien (cached)",
        source: "OPENHOLIDAYS_API",
        externalId: "uuid-old",
        fetchedAt: oldFetchedAt,
      },
    });

    // 2. New sync attempt fails (5xx).
    fetchSpy.mockRejectedValueOnce(new SchoolHolidaysApiError(503, "OpenHolidays 503"));

    const result: SyncResult = await syncSchoolHolidaysForTenant(
      app.prisma,
      tenantId,
      ["NIEDERSACHSEN" as FederalState],
      { from: 2026, to: 2026 },
      log,
    );

    // 3. Existing row MUST still exist (no destructive overwrite).
    const rows = await app.prisma.schoolHolidayPeriod.findMany({ where: { tenantId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Frühjahrsferien (cached)");
    expect(rows[0].fetchedAt.getTime()).toBe(oldFetchedAt.getTime());

    // 4. perState reports FAILED (cache is < 30d old, so not yet STALE).
    expect(result.perState[0].status).toBe("FAILED");
    expect(result.perState[0].upserts).toBe(0);
    expect(log.warn).toHaveBeenCalled();
  });

  it("stale-cache: cache > 30d old returns status STALE", async () => {
    const veryOld = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000); // 40 days ago
    await app.prisma.schoolHolidayPeriod.create({
      data: {
        tenantId,
        federalState: "BAYERN" as FederalState,
        startDate: new Date("2026-02-16T00:00:00Z"),
        endDate: new Date("2026-02-20T00:00:00Z"),
        name: "Stale",
        source: "OPENHOLIDAYS_API",
        externalId: "uuid-stale",
        fetchedAt: veryOld,
      },
    });

    fetchSpy.mockRejectedValueOnce(new SchoolHolidaysApiError("NETWORK", "ECONNREFUSED"));

    const result = await syncSchoolHolidaysForTenant(
      app.prisma,
      tenantId,
      ["BAYERN" as FederalState],
      { from: 2026, to: 2026 },
      log,
    );

    expect(result.perState[0].status).toBe("STALE");
  });

  it("stale-cache: empty cache + failure also returns STALE", async () => {
    fetchSpy.mockRejectedValueOnce(new SchoolHolidaysApiError("TIMEOUT", "timed out"));

    const result = await syncSchoolHolidaysForTenant(
      app.prisma,
      tenantId,
      ["BAYERN" as FederalState],
      { from: 2026, to: 2026 },
      log,
    );

    expect(result.perState[0].status).toBe("STALE");
  });

  it("handles multiple federal states independently", async () => {
    fetchSpy.mockResolvedValueOnce([
      {
        externalId: "uuid-ni-1",
        startDate: new Date("2026-02-16T00:00:00Z"),
        endDate: new Date("2026-02-20T00:00:00Z"),
        name: "Frühjahrsferien NI",
        subdivisionCode: "DE-NI",
      },
    ]);
    fetchSpy.mockRejectedValueOnce(new SchoolHolidaysApiError(503, "BAYERN api down"));

    const result = await syncSchoolHolidaysForTenant(
      app.prisma,
      tenantId,
      ["NIEDERSACHSEN" as FederalState, "BAYERN" as FederalState],
      { from: 2026, to: 2026 },
      log,
    );

    expect(result.perState).toHaveLength(2);
    expect(result.perState.find((p) => p.federalState === "NIEDERSACHSEN")?.status).toBe("OK");
    expect(result.perState.find((p) => p.federalState === "BAYERN")?.status).toBe("STALE");
  });

  it("uses correct ISO code for federal state (BAYERN → DE-BY)", async () => {
    fetchSpy.mockResolvedValueOnce([]);

    await syncSchoolHolidaysForTenant(
      app.prisma,
      tenantId,
      ["BAYERN" as FederalState],
      { from: 2026, to: 2027 },
      log,
    );

    expect(fetchSpy).toHaveBeenCalledWith("DE-BY", 2026, 2027);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Admin REST endpoints
// ──────────────────────────────────────────────────────────────────────────────

describe("admin school-holidays endpoints", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let adminToken: string;
  let empToken: string;
  let seed: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "sh-admin");
    tenantId = seed.tenant.id;
    adminToken = seed.adminToken;
    empToken = seed.empToken;
  });

  afterAll(async () => {
    try {
      await app.prisma.schoolHolidayPeriod.deleteMany({ where: { tenantId } });
      await app.prisma.employeeVocationalSchoolPattern.deleteMany({
        where: { employee: { tenantId } },
      });
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("cleanup failed", err);
    }
  });

  beforeEach(() => {
    fetchSpy.mockReset();
  });

  it("GET /admin/school-holidays as ADMIN returns rows scoped by tenant", async () => {
    // Pre-seed two rows.
    await app.prisma.schoolHolidayPeriod.createMany({
      data: [
        {
          tenantId,
          federalState: "NIEDERSACHSEN" as FederalState,
          startDate: new Date("2026-02-16T00:00:00Z"),
          endDate: new Date("2026-02-20T00:00:00Z"),
          name: "Frühjahrsferien",
          source: "OPENHOLIDAYS_API",
          externalId: "u1",
          fetchedAt: new Date(),
        },
      ],
    });

    const res = await app.inject({
      method: "GET",
      url: BASE,
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(1);
    // Date should be serialized as YYYY-MM-DD
    expect(body[0].startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body[0].endDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("GET /admin/school-holidays as EMPLOYEE returns 403", async () => {
    const res = await app.inject({
      method: "GET",
      url: BASE,
      headers: { authorization: `Bearer ${empToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("POST /refresh as ADMIN syncs and writes audit log", async () => {
    fetchSpy.mockResolvedValue([
      {
        externalId: "refresh-1",
        startDate: new Date("2026-04-06T00:00:00Z"),
        endDate: new Date("2026-04-17T00:00:00Z"),
        name: "Osterferien",
        subdivisionCode: "DE-NI",
      },
    ]);

    const before = await app.prisma.auditLog.count({
      where: { entity: "SchoolHolidayPeriod", action: "SCHOOL_HOLIDAYS_REFRESH" },
    });

    const res = await app.inject({
      method: "POST",
      url: `${BASE}/refresh`,
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.perState).toBeDefined();
    expect(Array.isArray(body.perState)).toBe(true);
    // The tenant's own federalState (NIEDERSACHSEN from seed) must be included.
    expect(
      body.perState.some((p: { federalState: string }) => p.federalState === "NIEDERSACHSEN"),
    ).toBe(true);

    const after = await app.prisma.auditLog.count({
      where: { entity: "SchoolHolidayPeriod", action: "SCHOOL_HOLIDAYS_REFRESH" },
    });
    expect(after).toBe(before + 1);
  });

  it("POST /refresh as EMPLOYEE returns 403", async () => {
    const res = await app.inject({
      method: "POST",
      url: `${BASE}/refresh`,
      headers: { authorization: `Bearer ${empToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("POST /refresh dedups Tenant.federalState + Pattern.federalStateOverride", async () => {
    fetchSpy.mockResolvedValue([]);

    // Add a pattern with a federalStateOverride.
    await app.prisma.employeeVocationalSchoolPattern.create({
      data: {
        employeeId: seed.employee.id,
        daysOfWeek: [0],
        blockWeeks: [],
        validFrom: new Date("2026-01-01"),
        isActive: true,
        respectSchoolHolidays: true,
        federalStateOverride: "BAYERN" as FederalState,
      },
    });

    const res = await app.inject({
      method: "POST",
      url: `${BASE}/refresh`,
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    // Should include BOTH NIEDERSACHSEN (tenant) and BAYERN (override).
    const states = body.perState.map((p: { federalState: string }) => p.federalState).sort();
    expect(states).toEqual(["BAYERN", "NIEDERSACHSEN"]);
  });
});
