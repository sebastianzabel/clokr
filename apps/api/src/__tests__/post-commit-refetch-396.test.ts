/**
 * Issue #396 - a write that is already committed never answers 500 because the response re-read
 * failed. The re-read is stubbed to fail (only the call that includes the breaks, i.e. the
 * post-commit one); the route must answer from the written entry, keep the audit row and leave a
 * retry to meet the overlap 409 instead of a duplicate.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData, soleAuditRow } from "./setup";

describe("Issue #396 - post-commit re-fetch failure", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "pcr396");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  /** Fails only the response re-read (the one asking for the breaks), not the handler's other reads. */
  function failRefetch() {
    const original = app.prisma.timeEntry.findUnique.bind(app.prisma.timeEntry);
    return vi.spyOn(app.prisma.timeEntry, "findUnique").mockImplementation(((args: {
      include?: { breaks?: unknown };
    }) => {
      if (args?.include?.breaks) return Promise.reject(new Error("getaddrinfo EAI_AGAIN"));
      return original(args as never);
    }) as never);
  }

  it("POST answers 201 with the created entry + breaks, writes the audit row, retry is a 409", async () => {
    const spy = failRefetch();
    const payload = {
      employeeId: data.employee.id,
      date: "2026-04-14",
      startTime: "2026-04-14T08:00:00.000Z",
      endTime: "2026-04-14T16:30:00.000Z",
      breaks: [{ startTime: "2026-04-14T12:00:00.000Z", endTime: "2026-04-14T12:30:00.000Z" }],
      activityShares: [{ kind: "SETUP_CLEANING", minutes: 20 }],
    };
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/time-entries",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload,
    });
    expect(spy).toHaveBeenCalled();
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.entry.employeeId).toBe(data.employee.id);
    expect(body.entry.breaks).toHaveLength(1);
    expect(body.entry.breaks[0].id).toBeTruthy();
    expect(body.entry.activityShares).toEqual([{ kind: "SETUP_CLEANING", minutes: 20 }]);

    spy.mockRestore();
    // Same shape as the normal read.
    const stored = await app.prisma.timeEntry.findUniqueOrThrow({
      where: { id: body.entry.id },
      include: { breaks: true, activityShares: { select: { kind: true, minutes: true } } },
    });
    expect(Object.keys(body.entry).sort()).toEqual(
      Object.keys(JSON.parse(JSON.stringify(stored))).sort(),
    );

    const audit = await soleAuditRow(app.prisma, {
      where: { entity: "TimeEntry", entityId: body.entry.id, action: "CREATE" },
    });
    expect(audit.newValue).toMatchObject({ id: body.entry.id });

    const retry = await app.inject({
      method: "POST",
      url: "/api/v1/time-entries",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload,
    });
    expect(retry.statusCode).toBe(409);
    const count = await app.prisma.timeEntry.count({
      where: { employeeId: data.employee.id, date: new Date("2026-04-14"), deletedAt: null },
    });
    expect(count).toBe(1);
  });

  it("clock-out answers 200 with the closed entry when the re-read fails", async () => {
    const open = await app.prisma.timeEntry.create({
      data: {
        employeeId: data.employee.id,
        date: new Date("2026-04-15"),
        startTime: new Date("2026-04-15T08:00:00Z"),
        endTime: null,
        source: "MANUAL",
        type: "WORK",
        salonId: data.salonId,
      },
    });
    const spy = failRefetch();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/time-entries/${open.id}/clock-out`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {},
    });
    expect(spy).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.entry.id).toBe(open.id);
    expect(body.entry.endTime).not.toBeNull();
    expect(Array.isArray(body.entry.breaks)).toBe(true);
    spy.mockRestore();
    const stored = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: open.id } });
    expect(stored.endTime).not.toBeNull();
  });

  it("#397: PUT /vocational-school-pattern answers 200 when the first-pattern tenant read fails", async () => {
    const spy = vi
      .spyOn(app.prisma.tenant, "findUniqueOrThrow")
      .mockRejectedValue(new Error("getaddrinfo EAI_AGAIN") as never);
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/employees/${data.employee.id}/vocational-school-pattern`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { patterns: [{ daysOfWeek: [2], validFrom: "2026-04-01" }] },
    });
    expect(spy).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    spy.mockRestore();
    await app.waitForPendingBSGenerations?.();
    const stored = await app.prisma.employeeVocationalSchoolPattern.count({
      where: { employeeId: data.employee.id, isActive: true },
    });
    expect(stored).toBe(1);
  });
});
