import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../__tests__/setup";
import type { FastifyInstance } from "fastify";

// Phase 76.2 (ARCH-V19-01) — Plan 2 regression test for /clock-in via the resolver.
//
// Block A: happy path → unified D-03 response shape `{ resolution: { kind: 'CLOCKED_IN', entry }, audit: { id } }`.
// Block B: 5 concurrent → 1×200 + 4×409 'Bereits eingestempelt', single TimeEntry row, single AuditLog row.
// Block C (within Block A): AuditLog row references JWT actor (sub-req A's preserved JWT-path).
//
// Pre-Task-2 baseline: Block A FAILS (response shape is `{ success, entry }`, not `{ resolution, audit }`).
// Block B PASSES (76.1's per-route lock still produces 1×200 + 4×409).
// Post-Task-2: BOTH blocks pass — Block A because the adapter now emits D-03; Block B
// because the resolver's own FOR UPDATE replaces the per-route lock with identical semantics.

describe("POST /clock-in — Phase 76.2 resolver migration", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let jwt: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "clockin-resolver");
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
    await app.prisma.auditLog.deleteMany({
      where: { entityId: { in: entries.map((e) => e.id) } },
    });
    await app.prisma.break.deleteMany({
      where: { timeEntry: { employeeId: data.employee.id } },
    });
    await app.prisma.timeEntry.deleteMany({
      where: { employeeId: data.employee.id },
    });
    await cleanupTestData(app, data.tenant.id);
    await closeTestApp();
  });

  beforeEach(async () => {
    await app.prisma.break.deleteMany({
      where: { timeEntry: { employeeId: data.employee.id } },
    });
    const entries = await app.prisma.timeEntry.findMany({
      where: { employeeId: data.employee.id },
      select: { id: true },
    });
    await app.prisma.auditLog.deleteMany({
      where: { entityId: { in: entries.map((e) => e.id) } },
    });
    await app.prisma.timeEntry.deleteMany({
      where: { employeeId: data.employee.id },
    });
  });

  // ── Block A — Happy path (response shape per D-03 + JWT audit actor) ───────
  it("happy path — single /clock-in → 200 + { resolution: { kind: 'CLOCKED_IN' }, audit: { id } } + AuditLog references JWT actor", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/time-entries/clock-in",
      headers: { authorization: `Bearer ${jwt}` },
      payload: { source: "MOBILE" },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      resolution: {
        kind: string;
        entry: { id: string; employeeId: string; source: string; startTime: string };
      };
      audit: { id: string };
    };
    expect(body.resolution.kind).toBe("CLOCKED_IN");
    expect(body.resolution.entry.employeeId).toBe(data.employee.id);
    expect(body.resolution.entry.source).toBe("MOBILE");
    expect(body.audit).toBeDefined();
    expect(typeof body.audit.id).toBe("string");

    // Exactly 1 non-deleted TimeEntry exists for today
    const rows = await app.prisma.timeEntry.findMany({
      where: { employeeId: data.employee.id, deletedAt: null },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(body.resolution.entry.id);

    // Exactly 1 AuditLog row with action: 'CLOCK_IN' referencing the JWT actor
    const audits = await app.prisma.auditLog.findMany({
      where: { entity: "TimeEntry", entityId: rows[0].id, action: "CLOCK_IN" },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0].userId).toBe(data.empUser.id); // sub-req A — JWT-path actor preserved
  });

  // ── Block B — Race (5 concurrent → 1×200 + 4×409 + 1 row + 1 audit) ─────────
  it("race — 5 concurrent /clock-in requests → 1× HTTP 200 + 4× HTTP 409 'Bereits eingestempelt' + 1 row + 1 audit", async () => {
    const headers = { authorization: `Bearer ${jwt}` };
    const payload = { source: "MOBILE" };

    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        app.inject({
          method: "POST",
          url: "/api/v1/time-entries/clock-in",
          headers,
          payload,
        }),
      ),
    );

    const statusCounts = responses.reduce<Record<number, number>>((acc, r) => {
      acc[r.statusCode] = (acc[r.statusCode] ?? 0) + 1;
      return acc;
    }, {});
    expect(statusCounts[200]).toBe(1);
    expect(statusCounts[409]).toBe(4);

    // Each 409 carries the verbatim German UI string (UI contract preserved)
    for (const conflict of responses.filter((r) => r.statusCode === 409)) {
      const body = JSON.parse(conflict.body) as { error: string };
      expect(body.error).toBe("Bereits eingestempelt");
    }

    // Exactly 1 TimeEntry row in DB (race contract)
    const rows = await app.prisma.timeEntry.findMany({
      where: { employeeId: data.employee.id, deletedAt: null },
    });
    expect(rows).toHaveLength(1);

    // Exactly 1 AuditLog row — the 4 conflicts produced zero audits
    const audits = await app.prisma.auditLog.findMany({
      where: { entity: "TimeEntry", entityId: rows[0].id, action: "CLOCK_IN" },
    });
    expect(audits).toHaveLength(1);
  });
});
