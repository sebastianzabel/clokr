// Phase 85 Plan 03 (SS-01/SS-02/SS-05) — route-level tests for the Phorest admin API surface.
// Mirrors the fetch-mock harness of sync-shifts.test.ts, but drives the real HTTP routes via
// app.inject with an ADMIN token. Covers:
//   - POST /phorest/test classification: success (staffCount/branchName), auth-invalid (401/403),
//     unreachable (network/timeout) — never leaking the raw upstream body.
//   - Mapping CRUD round-trip (POST → GET → DELETE) + cross-tenant employee rejection.
//   - Staff preview surfaces an UNMAPPED Phorest staff (savedEmployeeId null) without erroring.
//   - Sync-run history read (latest + history).
// Run via `pnpm --filter @clokr/api test -- integrations-phorest` (pretest db-push) — NOT bare vitest.

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, seedTestData, cleanupTestData } from "../../../__tests__/setup";

const originalFetch = global.fetch;
const PREFIX = "/api/v1/integrations";

// Mock the Phorest upstream with a 200 JSON body (the /staff response).
function mockStaffOk(body: unknown): void {
  global.fetch = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  ) as unknown as typeof fetch;
}

// Mock a non-ok HTTP status (e.g. 401/403) → phorestFetch throws PhorestApiError(status).
function mockStatus(status: number): void {
  global.fetch = vi.fn(
    async () => new Response("upstream error body", { status }),
  ) as unknown as typeof fetch;
}

// Mock a generic network failure → phorestFetch throws PhorestApiError("NETWORK").
function mockNetworkError(): void {
  global.fetch = vi.fn(async () => {
    throw new TypeError("fetch failed: ECONNREFUSED");
  }) as unknown as typeof fetch;
}

describe("integrations phorest routes", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;

  const auth = () => ({ authorization: `Bearer ${seed.adminToken}` });

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "intph");
    // Configure Phorest creds so POST /phorest/test + GET /phorest/staff reach the fetch path.
    // decryptSafe tolerates plaintext (see helpers.ts seed).
    await app.prisma.tenantConfig.update({
      where: { tenantId: seed.tenant.id },
      data: {
        phorestBusinessId: "biz-1",
        phorestBranchId: "branch-1",
        phorestUsername: "user@salon.de",
        phorestPassword: "secret-pw",
      },
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    try {
      // cleanupTestData does not know about the Phase-85 tables — clear them first (onDelete: Restrict).
      await app.prisma.phorestStaffMapping.deleteMany({ where: { tenantId: seed.tenant.id } });
      await app.prisma.phorestSyncRun.deleteMany({ where: { tenantId: seed.tenant.id } });
      await cleanupTestData(app, seed.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
  });

  // ── POST /phorest/test classification (SS-02) ─────────────────────────

  it("POST /phorest/test success surfaces staffCount + branchName", async () => {
    mockStaffOk({
      branchName: "Hauptfiliale",
      _embedded: { staffs: [{ staffId: "a" }, { staffId: "b" }] },
    });
    const res = await app.inject({
      method: "POST",
      url: `${PREFIX}/phorest/test`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.staffCount).toBe(2);
    expect(body.branchName).toBe("Hauptfiliale");
  });

  it("POST /phorest/test with 401 upstream → credentials-invalid reason, no raw body leak", async () => {
    mockStatus(401);
    const res = await app.inject({
      method: "POST",
      url: `${PREFIX}/phorest/test`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("auth-invalid");
    // The raw upstream body must never be echoed to the client.
    expect(JSON.stringify(body)).not.toContain("upstream error body");
  });

  it("POST /phorest/test with 403 upstream → credentials-invalid reason", async () => {
    mockStatus(403);
    const res = await app.inject({
      method: "POST",
      url: `${PREFIX}/phorest/test`,
      headers: auth(),
    });
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("auth-invalid");
  });

  it("POST /phorest/test with a network error → unreachable reason", async () => {
    mockNetworkError();
    const res = await app.inject({
      method: "POST",
      url: `${PREFIX}/phorest/test`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("unreachable");
  });

  // ── Mapping CRUD (SS-01) ──────────────────────────────────────────────

  it("mapping POST → GET round-trips and DELETE removes it", async () => {
    const empId = seed.employee.id;

    const post = await app.inject({
      method: "POST",
      url: `${PREFIX}/phorest/mappings`,
      headers: auth(),
      payload: { phorestStaffId: "ph-rt-1", employeeId: empId },
    });
    expect(post.statusCode).toBe(200);

    const get1 = await app.inject({
      method: "GET",
      url: `${PREFIX}/phorest/mappings`,
      headers: auth(),
    });
    const list1 = JSON.parse(get1.body).mappings as Array<{
      phorestStaffId: string;
      employeeId: string;
    }>;
    expect(list1.some((m) => m.phorestStaffId === "ph-rt-1" && m.employeeId === empId)).toBe(true);

    // The create is audited (Revisionssicherheit).
    const createAudits = await app.prisma.auditLog.count({
      where: { entity: "PhorestStaffMapping", action: { in: ["CREATE", "UPDATE"] } },
    });
    expect(createAudits).toBeGreaterThanOrEqual(1);

    const del = await app.inject({
      method: "DELETE",
      url: `${PREFIX}/phorest/mappings/ph-rt-1`,
      headers: auth(),
    });
    expect(del.statusCode).toBe(200);

    const get2 = await app.inject({
      method: "GET",
      url: `${PREFIX}/phorest/mappings`,
      headers: auth(),
    });
    const list2 = JSON.parse(get2.body).mappings as Array<{ phorestStaffId: string }>;
    expect(list2.some((m) => m.phorestStaffId === "ph-rt-1")).toBe(false);
  });

  it("POST /phorest/mappings rejects a cross-tenant employee (400)", async () => {
    const other = await seedTestData(app, "intph-other");
    try {
      const res = await app.inject({
        method: "POST",
        url: `${PREFIX}/phorest/mappings`,
        headers: auth(),
        payload: { phorestStaffId: "ph-cross", employeeId: other.employee.id },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.prisma.phorestStaffMapping.deleteMany({ where: { tenantId: other.tenant.id } });
      await app.prisma.phorestSyncRun.deleteMany({ where: { tenantId: other.tenant.id } });
      await cleanupTestData(app, other.tenant.id);
    }
  });

  // ── Staff preview: unmapped surfaced, never blocking (SS-01) ──────────

  it("GET /phorest/staff surfaces an unmapped staff member with savedEmployeeId null, never erroring", async () => {
    mockStaffOk({
      _embedded: {
        staffs: [{ staffId: "ph-unmapped-1", firstName: "Nn", lastName: "Xx", email: "nn@x.de" }],
      },
    });
    const res = await app.inject({
      method: "GET",
      url: `${PREFIX}/phorest/staff`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const entry = (
      body.staff as Array<{ phorestStaffId: string; savedEmployeeId: string | null }>
    ).find((s) => s.phorestStaffId === "ph-unmapped-1");
    expect(entry).toBeDefined();
    expect(entry?.savedEmployeeId).toBeNull();
  });

  it("GET /phorest/staff skips archived Phorest staff (consistent with the sync path)", async () => {
    mockStaffOk({
      _embedded: {
        staffs: [
          { staffId: "ph-active-1", firstName: "Aa", lastName: "Yy", email: "aa@x.de" },
          {
            staffId: "ph-archived-1",
            firstName: "Zz",
            lastName: "Qq",
            email: "zz@x.de",
            archived: true,
          },
        ],
      },
    });
    const res = await app.inject({
      method: "GET",
      url: `${PREFIX}/phorest/staff`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const staff = JSON.parse(res.body).staff as Array<{ phorestStaffId: string }>;
    expect(staff.some((s) => s.phorestStaffId === "ph-active-1")).toBe(true);
    expect(staff.some((s) => s.phorestStaffId === "ph-archived-1")).toBe(false);
  });

  // ── Sync-run history (SS-05) ──────────────────────────────────────────

  it("GET /phorest/sync-runs returns latest + history", async () => {
    await app.prisma.phorestSyncRun.create({
      data: { tenantId: seed.tenant.id, status: "SUCCESS", created: 1, finishedAt: new Date() },
    });
    const res = await app.inject({
      method: "GET",
      url: `${PREFIX}/phorest/sync-runs`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.latest).not.toBeNull();
    expect(Array.isArray(body.history)).toBe(true);
    expect(body.total).toBeGreaterThanOrEqual(1);
  });
});
