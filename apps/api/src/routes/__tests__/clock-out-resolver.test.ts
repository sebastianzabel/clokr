import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../__tests__/setup";
import type { FastifyInstance } from "fastify";

// Phase 76.2 (ARCH-V19-01) — Plan 3 regression test for POST /:id/clock-out via the resolver.
//
// Block A: happy path → unified D-03 response shape `{ resolution: { kind: 'CLOCKED_OUT' | 'CONSOLIDATED', entry, audit }, warnings }`.
// Block B: 5 concurrent on same :id → 1× 200 + 4× 409, exactly 1 entry with endTime != null, exactly 1 CLOCK_OUT audit.
// Block D: already-closed entry → 409 'Bereits ausgestempelt' (pre-guard preserved verbatim).
//
// Block C (CLOCK_OUT_REMINDER dismissal) intentionally omitted per the plan's WARNING #5:
// the dismissByRelated call site is preserved verbatim from pre-76.2 (verified by `git diff`).
// Fixture cost for that integration assertion is high; deferred to Plan 4's full-suite green run
// + dev spot-check. The preservation IS the verification surface for Plan 3.
//
// Pre-Task-2 baseline: Block A FAILS (legacy response shape `{ success, entry, warnings }`).
// Block B may pass on the pre-Plan-3 path because findUnique({ where: { id } }) returns the same
// row for all 5 callers — but exposes the race-prone window between the pre-guard read and the
// UPDATE write. Post-Task-2: ALL blocks pass — Block A flips to D-03, Block B is hard-serialized
// by the resolver's FOR UPDATE lock.

describe("POST /:id/clock-out — Phase 76.2 resolver migration", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let jwt: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "clockout-resolver");
    jwt = app.jwt.sign({
      sub: data.empUser.id,
      tenantId: data.tenant.id,
      role: data.empUser.role,
      employeeId: data.employee.id,
    });
  });

  afterAll(async () => {
    const entries = await app.prisma.timeEntry.findMany({
      where: { employeeId: data.employee.id },
      select: { id: true },
    });
    await app.prisma.break.deleteMany({
      where: { timeEntryId: { in: entries.map((e) => e.id) } },
    });
    await app.prisma.auditLog.deleteMany({
      where: { entityId: { in: entries.map((e) => e.id) } },
    });
    await app.prisma.timeEntry.deleteMany({
      where: { employeeId: data.employee.id },
    });
    await cleanupTestData(app, data.tenant.id);
    await closeTestApp();
  });

  beforeEach(async () => {
    const entries = await app.prisma.timeEntry.findMany({
      where: { employeeId: data.employee.id },
      select: { id: true },
    });
    await app.prisma.break.deleteMany({
      where: { timeEntryId: { in: entries.map((e) => e.id) } },
    });
    await app.prisma.auditLog.deleteMany({
      where: { entityId: { in: entries.map((e) => e.id) } },
    });
    await app.prisma.timeEntry.deleteMany({
      where: { employeeId: data.employee.id },
    });
  });

  async function createOpenEntry(hoursAgo = 2): Promise<{ id: string; startTime: Date }> {
    const now = new Date();
    const startTime = new Date(now.getTime() - hoursAgo * 3600 * 1000);
    // Use date-only midnight for the row's `date` field (matches production semantics).
    const dateStr = startTime.toISOString().slice(0, 10);
    const date = new Date(`${dateStr}T00:00:00.000Z`);
    const entry = await app.prisma.timeEntry.create({
      data: {
        employeeId: data.employee.id,
        date,
        startTime,
        source: "MOBILE",
      },
    });
    return { id: entry.id, startTime };
  }

  // ── Block A — Happy path (D-03 response shape + AuditLog actor) ────────────
  it("happy path — single /:id/clock-out → 200 + { resolution: { kind: 'CLOCKED_OUT', entry, audit }, warnings }", async () => {
    const { id } = await createOpenEntry(2);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/time-entries/${id}/clock-out`,
      headers: { authorization: `Bearer ${jwt}` },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      resolution: { kind: string; entry: { id: string; endTime: string | null } };
      warnings?: unknown[];
      audit?: { id: string };
    };
    expect(["CLOCKED_OUT", "CONSOLIDATED"]).toContain(body.resolution.kind);
    expect(body.resolution.entry.endTime).toBeDefined();
    expect(body.resolution.entry.endTime).not.toBeNull();
    expect(body.resolution.entry.id).toBe(id);
    expect(Array.isArray(body.warnings)).toBe(true);

    // Exactly 1 closed entry exists for the employee (today's row)
    const closed = await app.prisma.timeEntry.findMany({
      where: { employeeId: data.employee.id, deletedAt: null, endTime: { not: null } },
    });
    expect(closed).toHaveLength(1);

    // Exactly 1 AuditLog row with action: 'CLOCK_OUT' for THIS entryId referencing the JWT actor.
    // Filter by entityId to avoid picking up stale CLOCK_OUT rows from other test files in the
    // shared test database.
    const audits = await app.prisma.auditLog.findMany({
      where: { entity: "TimeEntry", entityId: id, action: "CLOCK_OUT" },
      orderBy: { createdAt: "desc" },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0].userId).toBe(data.empUser.id); // sub-req A — JWT-path actor preserved
  });

  // ── Block B — Race (5 concurrent on same :id) ──────────────────────────────
  it("race — 5 concurrent /:id/clock-out on same id → 1× 200 + 4× 409, exactly 1 endTime != null, exactly 1 CLOCK_OUT audit", async () => {
    const { id } = await createOpenEntry(1);

    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        app.inject({
          method: "POST",
          url: `/api/v1/time-entries/${id}/clock-out`,
          headers: { authorization: `Bearer ${jwt}` },
          payload: {},
        }),
      ),
    );

    const statusCounts = responses.reduce<Record<number, number>>((acc, r) => {
      acc[r.statusCode] = (acc[r.statusCode] ?? 0) + 1;
      return acc;
    }, {});
    expect(statusCounts[200]).toBe(1);
    expect(statusCounts[409]).toBe(4);

    // Every 409 carries a string error (German UI string preserved — either the adapter pre-guard
    // 'Bereits ausgestempelt' or the resolver-CONFLICT-NOT_CLOCKED_IN mapping).
    for (const conflict of responses.filter((r) => r.statusCode === 409)) {
      const body = JSON.parse(conflict.body) as { error: string; resolution?: { kind: string } };
      expect(typeof body.error).toBe("string");
      expect(body.error.length).toBeGreaterThan(0);
    }

    // Exactly 1 closed entry for the :id
    const closedForId = await app.prisma.timeEntry.findMany({
      where: { id, deletedAt: null, endTime: { not: null } },
    });
    expect(closedForId).toHaveLength(1);

    // Exactly 1 CLOCK_OUT audit row for the :id (4 conflicts produced 0 audits)
    const audits = await app.prisma.auditLog.findMany({
      where: { entity: "TimeEntry", entityId: id, action: "CLOCK_OUT" },
    });
    expect(audits).toHaveLength(1);
  });

  // ── Block D — Already-closed entry shortcuts to 409 'Bereits ausgestempelt' ─
  it("already-closed entry → 409 'Bereits ausgestempelt'", async () => {
    const { id } = await createOpenEntry(2);
    // Pre-close the entry
    await app.prisma.timeEntry.update({
      where: { id },
      data: { endTime: new Date() },
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/time-entries/${id}/clock-out`,
      headers: { authorization: `Bearer ${jwt}` },
      payload: {},
    });

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe("Bereits ausgestempelt");
  });
});
