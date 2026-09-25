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
import {
  getTestApp,
  seedTestData,
  cleanupTestData,
  createTestSalon,
} from "../../../__tests__/setup";
import { encrypt, decryptSafe } from "../../../utils/crypto";
import { mockPhorestByBranch } from "./helpers";

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
        phorestUsername: "user@salon.de",
        phorestPassword: "secret-pw",
      },
    });
    // Phase 65b (issue #65, D-19): the branch lives on the seed salon's coupling, not on
    // TenantConfig.phorestBranchId (deprecated).
    await app.prisma.salonCoupling.create({
      data: {
        tenantId: seed.tenant.id,
        salonId: seed.salonId,
        provider: "PHOREST",
        externalBranchId: "branch-1",
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

  // ── PUT /phorest/config password preservation (BUG-2 regression) ──────
  //
  // GET /phorest/config never returns the password (masked). So an admin editing any OTHER field
  // must be able to re-save WITHOUT re-typing it. The old schema made phorestPassword required →
  // a save without it 400'd and nothing persisted. These pin: omit-preserves, new-value-overwrites.

  it("PUT /phorest/config without a password preserves the stored password", async () => {
    // Seed a known, ENCRYPTED password so we can assert it survives untouched.
    await app.prisma.tenantConfig.update({
      where: { tenantId: seed.tenant.id },
      data: { phorestPassword: encrypt("original-secret") },
    });

    const res = await app.inject({
      method: "PUT",
      url: `${PREFIX}/phorest/config`,
      headers: auth(),
      payload: {
        phorestBusinessId: "biz-changed",
        branchId: "branch-changed",
        phorestUsername: "user@salon.de",
        // NOTE: no phorestPassword — this must NOT 400 and must NOT wipe the stored password.
      },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).success).toBe(true);

    const cfg = await app.prisma.tenantConfig.findUnique({
      where: { tenantId: seed.tenant.id },
    });
    expect(cfg?.phorestBusinessId).toBe("biz-changed");
    expect(decryptSafe(cfg?.phorestPassword)).toBe("original-secret");
  });

  it("PUT /phorest/config with a new password re-encrypts and overwrites it", async () => {
    await app.prisma.tenantConfig.update({
      where: { tenantId: seed.tenant.id },
      data: { phorestPassword: encrypt("original-secret") },
    });

    const res = await app.inject({
      method: "PUT",
      url: `${PREFIX}/phorest/config`,
      headers: auth(),
      payload: {
        phorestBusinessId: "biz-1",
        branchId: "branch-1",
        phorestUsername: "user@salon.de",
        phorestPassword: "new-secret",
      },
    });
    expect(res.statusCode).toBe(200);

    const cfg = await app.prisma.tenantConfig.findUnique({
      where: { tenantId: seed.tenant.id },
    });
    // Stored value is encrypted (iv:tag:ct), not plaintext, and decrypts to the new password.
    expect(cfg?.phorestPassword).not.toBe("new-secret");
    expect(decryptSafe(cfg?.phorestPassword)).toBe("new-secret");
  });

  it("PUT /phorest/config with an EMPTY-STRING password preserves it (BUG-3: masked field submits '')", async () => {
    // The web form's masked password input submits "" (not undefined) when left blank. The old
    // `.min(1).optional()` schema accepted undefined but 400'd on "" — so toggling auto-sync /
    // window without re-typing the password failed. Empty string must be treated as "unchanged".
    await app.prisma.tenantConfig.update({
      where: { tenantId: seed.tenant.id },
      data: { phorestPassword: encrypt("original-secret"), phorestAutoSync: false },
    });

    const res = await app.inject({
      method: "PUT",
      url: `${PREFIX}/phorest/config`,
      headers: auth(),
      payload: {
        phorestBusinessId: "biz-1",
        branchId: "branch-1",
        phorestUsername: "user@salon.de",
        phorestPassword: "", // masked field left blank → empty string, not undefined
        phorestAutoSync: true,
        phorestSyncWindowDays: 30,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).success).toBe(true);

    const cfg = await app.prisma.tenantConfig.findUnique({
      where: { tenantId: seed.tenant.id },
    });
    expect(cfg?.phorestAutoSync).toBe(true);
    expect(cfg?.phorestSyncWindowDays).toBe(30);
    // Empty string must NOT wipe the stored password.
    expect(decryptSafe(cfg?.phorestPassword)).toBe("original-secret");
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

  it("GET /phorest/sync-runs returns latest + history, each carrying salonId and salonName (Phase 65b, D-21)", async () => {
    await app.prisma.phorestSyncRun.create({
      data: {
        tenantId: seed.tenant.id,
        salonId: seed.salonId, // Phase 65b (issue #65, D-03): a run names its salon
        status: "SUCCESS",
        created: 1,
        finishedAt: new Date(),
      },
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
    expect(body.latest.salonId).toBe(seed.salonId);
    expect(body.latest.salonName).toBe(seed.tenant.name);
    for (const run of body.history) {
      expect(run.salonId).toBe(seed.salonId);
      expect(run.salonName).toBe(seed.tenant.name);
    }
  });
});

// ── Salon resolution for test/staff (Phase 65b, issue #65, D-18) ──────────────────────────────

describe("POST /phorest/test + GET /phorest/staff resolve the coupling per salon (Phase 65b, issue #65, D-18)", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;
  let other: Awaited<ReturnType<typeof seedTestData>>;
  let salonB: { id: string; name: string };

  const auth = () => ({ authorization: `Bearer ${seed.adminToken}` });

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "intphres");
    other = await seedTestData(app, "intphres-other");
    await app.prisma.tenantConfig.update({
      where: { tenantId: seed.tenant.id },
      data: {
        phorestBusinessId: "biz-1",
        phorestUsername: "user@salon.de",
        phorestPassword: "secret-pw",
      },
    });
    salonB = await createTestSalon(app.prisma, seed.tenant.id, {
      name: "Resolve Salon B",
      createdAt: new Date(Date.now() + 60_000),
    });
    await app.prisma.salonCoupling.create({
      data: {
        tenantId: seed.tenant.id,
        salonId: seed.salonId,
        provider: "PHOREST",
        externalBranchId: "resolve-a",
      },
    });
    await app.prisma.salonCoupling.create({
      data: {
        tenantId: seed.tenant.id,
        salonId: salonB.id,
        provider: "PHOREST",
        externalBranchId: "resolve-b",
      },
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, seed.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed (seed):", err);
    }
    try {
      await cleanupTestData(app, other.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed (other):", err);
    }
  });

  it("test: two couplings, no salonId -> 400 SALON_REQUIRED", async () => {
    const res = await app.inject({
      method: "POST",
      url: `${PREFIX}/phorest/test`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: "Bitte einen Salon angeben — der Mandant hat mehrere Phorest-Kopplungen.",
      code: "SALON_REQUIRED",
    });
  });

  it("test: two couplings, explicit salonId: null in the body -> 400 SALON_REQUIRED (an explicit null is treated as absent)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `${PREFIX}/phorest/test`,
      headers: { ...auth(), "content-type": "application/json" },
      payload: JSON.stringify({ salonId: null }),
    });
    expect(res.statusCode).toBe(400);
  });

  it("test: two couplings, salon B's id -> the recorded fetch URL uses B's branch", async () => {
    const requested = mockPhorestByBranch({
      "resolve-a": { staff: { _embedded: { staffs: [] } } },
      "resolve-b": { staff: { _embedded: { staffs: [] } } },
    });
    const res = await app.inject({
      method: "POST",
      url: `${PREFIX}/phorest/test`,
      headers: auth(),
      payload: { salonId: salonB.id },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);
    expect(requested.some((u) => u.includes("/branch/resolve-b/staff"))).toBe(true);
  });

  it("test: a foreign tenant's salon id and an unknown UUID both answer byte-identical 404 'Salon nicht gefunden'", async () => {
    const foreignRes = await app.inject({
      method: "POST",
      url: `${PREFIX}/phorest/test`,
      headers: auth(),
      payload: { salonId: other.salonId },
    });
    const unknownRes = await app.inject({
      method: "POST",
      url: `${PREFIX}/phorest/test`,
      headers: auth(),
      payload: { salonId: "00000000-0000-4000-8000-000000000010" },
    });
    expect(foreignRes.statusCode).toBe(404);
    expect(unknownRes.statusCode).toBe(404);
    expect(foreignRes.body).toBe(unknownRes.body);
    expect(JSON.parse(foreignRes.body)).toEqual({ error: "Salon nicht gefunden" });
  });

  it("test: an own uncoupled salon -> 404 'Salon ist nicht mit Phorest gekoppelt.'", async () => {
    const uncoupled = await createTestSalon(app.prisma, seed.tenant.id, {
      name: "Resolve Uncoupled",
    });
    const res = await app.inject({
      method: "POST",
      url: `${PREFIX}/phorest/test`,
      headers: auth(),
      payload: { salonId: uncoupled.id },
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "Salon ist nicht mit Phorest gekoppelt." });
  });

  it("test: zero couplings (credentials configured) -> 200 { ok: false, reason: 'not-configured' }", async () => {
    const zero = await seedTestData(app, "intphres-zero");
    try {
      await app.prisma.tenantConfig.update({
        where: { tenantId: zero.tenant.id },
        data: {
          phorestBusinessId: "biz-z",
          phorestUsername: "z@salon.de",
          phorestPassword: "pw-z",
        },
      });
      const res = await app.inject({
        method: "POST",
        url: `${PREFIX}/phorest/test`,
        headers: { authorization: `Bearer ${zero.adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.ok).toBe(false);
      expect(body.reason).toBe("not-configured");
    } finally {
      await cleanupTestData(app, zero.tenant.id);
    }
  });

  it("test: a coupling only on an INACTIVE salon, no salonId -> 200 not-configured (inactive salons don't count toward the single-coupling rule)", async () => {
    const inactiveOnly = await seedTestData(app, "intphres-inactive");
    try {
      await app.prisma.tenantConfig.update({
        where: { tenantId: inactiveOnly.tenant.id },
        data: {
          phorestBusinessId: "biz-i",
          phorestUsername: "i@salon.de",
          phorestPassword: "pw-i",
        },
      });
      await app.prisma.salon.update({
        where: { id: inactiveOnly.salonId },
        data: { isActive: false, deactivatedAt: new Date() },
      });
      await app.prisma.salonCoupling.create({
        data: {
          tenantId: inactiveOnly.tenant.id,
          salonId: inactiveOnly.salonId,
          provider: "PHOREST",
          externalBranchId: "inactive-branch",
        },
      });
      const res = await app.inject({
        method: "POST",
        url: `${PREFIX}/phorest/test`,
        headers: { authorization: `Bearer ${inactiveOnly.adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.ok).toBe(false);
      expect(body.reason).toBe("not-configured");
    } finally {
      await cleanupTestData(app, inactiveOnly.tenant.id);
    }
  });

  it("staff: two couplings, no salonId -> 400 SALON_REQUIRED", async () => {
    const res = await app.inject({
      method: "GET",
      url: `${PREFIX}/phorest/staff`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: "Bitte einen Salon angeben — der Mandant hat mehrere Phorest-Kopplungen.",
      code: "SALON_REQUIRED",
    });
  });

  it("staff: salon B's id via ?salonId= -> the recorded fetch URL uses B's branch", async () => {
    const requested = mockPhorestByBranch({
      "resolve-a": { staff: { _embedded: { staffs: [] } } },
      "resolve-b": { staff: { _embedded: { staffs: [] } } },
    });
    const res = await app.inject({
      method: "GET",
      url: `${PREFIX}/phorest/staff?salonId=${salonB.id}`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(requested.some((u) => u.includes("/branch/resolve-b/staff"))).toBe(true);
  });

  it("staff: a foreign tenant's salon id and an unknown UUID both answer byte-identical 404 'Salon nicht gefunden'", async () => {
    const foreignRes = await app.inject({
      method: "GET",
      url: `${PREFIX}/phorest/staff?salonId=${other.salonId}`,
      headers: auth(),
    });
    const unknownRes = await app.inject({
      method: "GET",
      url: `${PREFIX}/phorest/staff?salonId=00000000-0000-4000-8000-000000000011`,
      headers: auth(),
    });
    expect(foreignRes.statusCode).toBe(404);
    expect(unknownRes.statusCode).toBe(404);
    expect(foreignRes.body).toBe(unknownRes.body);
    expect(JSON.parse(foreignRes.body)).toEqual({ error: "Salon nicht gefunden" });
  });

  it("staff: zero couplings -> { error: 'Phorest nicht konfiguriert' }", async () => {
    const zero = await seedTestData(app, "intphres-zero2");
    try {
      await app.prisma.tenantConfig.update({
        where: { tenantId: zero.tenant.id },
        data: {
          phorestBusinessId: "biz-z2",
          phorestUsername: "z2@salon.de",
          phorestPassword: "pw-z2",
        },
      });
      const res = await app.inject({
        method: "GET",
        url: `${PREFIX}/phorest/staff`,
        headers: { authorization: `Bearer ${zero.adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ error: "Phorest nicht konfiguriert" });
    } finally {
      await cleanupTestData(app, zero.tenant.id);
    }
  });
});

// ── Config branchId / branchIdEditable (Phase 65b, issue #65, D-19) ───────────────────────────

describe("GET/PUT /phorest/config branchId / branchIdEditable (Phase 65b, issue #65, D-19)", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;
  const auth = () => ({ authorization: `Bearer ${seed.adminToken}` });

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "intphcfg");
    await app.prisma.tenantConfig.update({
      where: { tenantId: seed.tenant.id },
      data: { phorestBusinessId: "biz-cfg", phorestUsername: "cfg@salon.de" },
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, seed.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
  });

  it("GET with exactly one active salon coupled 'cfg-branch-1' -> branchId + branchIdEditable true, no deprecated key", async () => {
    await app.prisma.salonCoupling.create({
      data: {
        tenantId: seed.tenant.id,
        salonId: seed.salonId,
        provider: "PHOREST",
        externalBranchId: "cfg-branch-1",
      },
    });
    const res = await app.inject({
      method: "GET",
      url: `${PREFIX}/phorest/config`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.branchId).toBe("cfg-branch-1");
    expect(body.branchIdEditable).toBe(true);
    expect("phorestBranchId" in body).toBe(false);
  });

  it("PUT the same branchId writes no SalonCoupling UPDATE audit; a different branchId updates the SAME coupling id + UPDATE audit with old/new", async () => {
    const before = await app.prisma.salonCoupling.findUnique({ where: { salonId: seed.salonId } });
    const beforeUpdateAudits = await app.prisma.auditLog.count({
      where: { entity: "SalonCoupling", action: "UPDATE" },
    });

    const same = await app.inject({
      method: "PUT",
      url: `${PREFIX}/phorest/config`,
      headers: auth(),
      payload: {
        phorestBusinessId: "biz-cfg",
        branchId: "cfg-branch-1",
        phorestUsername: "cfg@salon.de",
      },
    });
    expect(same.statusCode).toBe(200);
    expect(
      await app.prisma.auditLog.count({ where: { entity: "SalonCoupling", action: "UPDATE" } }),
    ).toBe(beforeUpdateAudits);

    const changed = await app.inject({
      method: "PUT",
      url: `${PREFIX}/phorest/config`,
      headers: auth(),
      payload: {
        phorestBusinessId: "biz-cfg",
        branchId: "cfg-branch-2",
        phorestUsername: "cfg@salon.de",
      },
    });
    expect(changed.statusCode).toBe(200);
    const afterUpdateAudits = await app.prisma.auditLog.count({
      where: { entity: "SalonCoupling", action: "UPDATE" },
    });
    expect(afterUpdateAudits).toBe(beforeUpdateAudits + 1);

    const after = await app.prisma.salonCoupling.findUnique({ where: { salonId: seed.salonId } });
    expect(after?.id).toBe(before?.id);
    expect(after?.externalBranchId).toBe("cfg-branch-2");

    const audit = await app.prisma.auditLog.findFirst({
      where: { entity: "SalonCoupling", entityId: after!.id, action: "UPDATE" },
      orderBy: { createdAt: "desc" },
    });
    expect(audit?.oldValue).toEqual({ externalBranchId: "cfg-branch-1" });
    expect(audit?.newValue).toEqual({ externalBranchId: "cfg-branch-2" });

    const configAudit = await app.prisma.auditLog.findFirst({
      where: { entity: "PhorestConfig" },
      orderBy: { createdAt: "desc" },
    });
    expect(configAudit?.newValue).not.toHaveProperty("branchId");
    expect(configAudit?.newValue).not.toHaveProperty("branch");
  });

  it("PUT without branchId leaves the coupling untouched", async () => {
    const before = await app.prisma.salonCoupling.findUnique({ where: { salonId: seed.salonId } });
    const res = await app.inject({
      method: "PUT",
      url: `${PREFIX}/phorest/config`,
      headers: auth(),
      payload: { phorestBusinessId: "biz-cfg", phorestUsername: "cfg@salon.de" },
    });
    expect(res.statusCode).toBe(200);
    const after = await app.prisma.salonCoupling.findUnique({ where: { salonId: seed.salonId } });
    expect(after).toEqual(before);
  });

  it("PUT with a branchId creates the coupling when none exists yet + CREATE audit", async () => {
    const fresh = await seedTestData(app, "intphcfg-create");
    try {
      await app.prisma.tenantConfig.update({
        where: { tenantId: fresh.tenant.id },
        data: { phorestBusinessId: "biz-fresh", phorestUsername: "fresh@salon.de" },
      });
      const res = await app.inject({
        method: "PUT",
        url: `${PREFIX}/phorest/config`,
        headers: { authorization: `Bearer ${fresh.adminToken}` },
        payload: {
          phorestBusinessId: "biz-fresh",
          branchId: "fresh-branch",
          phorestUsername: "fresh@salon.de",
        },
      });
      expect(res.statusCode).toBe(200);
      const created = await app.prisma.salonCoupling.findUnique({
        where: { salonId: fresh.salonId },
      });
      expect(created?.externalBranchId).toBe("fresh-branch");
      const audit = await app.prisma.auditLog.findFirst({
        where: { entity: "SalonCoupling", entityId: created!.id, action: "CREATE" },
      });
      expect(audit?.newValue).toEqual({
        salonId: fresh.salonId,
        provider: "PHOREST",
        externalBranchId: "fresh-branch",
      });
    } finally {
      await cleanupTestData(app, fresh.tenant.id);
    }
  });

  it("GET with two active salons -> branchId null, branchIdEditable false; PUT with a branchId -> 400 BRANCH_PER_SALON, config unchanged; PUT without branchId -> 200", async () => {
    const twoSalon = await seedTestData(app, "intphcfg-two");
    try {
      await app.prisma.tenantConfig.update({
        where: { tenantId: twoSalon.tenant.id },
        data: { phorestBusinessId: "biz-two", phorestUsername: "two@salon.de" },
      });
      await app.prisma.salonCoupling.create({
        data: {
          tenantId: twoSalon.tenant.id,
          salonId: twoSalon.salonId,
          provider: "PHOREST",
          externalBranchId: "two-branch-1",
        },
      });
      await createTestSalon(app.prisma, twoSalon.tenant.id, { name: "Config Two Salon B" });

      const res = await app.inject({
        method: "GET",
        url: `${PREFIX}/phorest/config`,
        headers: { authorization: `Bearer ${twoSalon.adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.branchId).toBeNull();
      expect(body.branchIdEditable).toBe(false);

      const before = await app.prisma.tenantConfig.findUnique({
        where: { tenantId: twoSalon.tenant.id },
      });
      const put = await app.inject({
        method: "PUT",
        url: `${PREFIX}/phorest/config`,
        headers: { authorization: `Bearer ${twoSalon.adminToken}` },
        payload: {
          phorestBusinessId: "biz-two-should-not-persist",
          branchId: "should-fail",
          phorestUsername: "two@salon.de",
        },
      });
      expect(put.statusCode).toBe(400);
      expect(JSON.parse(put.body)).toEqual({
        error: "Mehrere aktive Salons: die Phorest-Filiale wird je Salon gekoppelt.",
        code: "BRANCH_PER_SALON",
      });
      const afterRejected = await app.prisma.tenantConfig.findUnique({
        where: { tenantId: twoSalon.tenant.id },
      });
      expect(afterRejected).toEqual(before);

      const putWithoutBranch = await app.inject({
        method: "PUT",
        url: `${PREFIX}/phorest/config`,
        headers: { authorization: `Bearer ${twoSalon.adminToken}` },
        payload: { phorestBusinessId: "biz-two-updated", phorestUsername: "two@salon.de" },
      });
      expect(putWithoutBranch.statusCode).toBe(200);
    } finally {
      await cleanupTestData(app, twoSalon.tenant.id);
    }
  });

  it("PUT with a branchId already coupled to ANOTHER (inactive) salon of the same tenant -> 409 BRANCH_ALREADY_COUPLED, nothing written", async () => {
    const dup = await seedTestData(app, "intphcfg-dup");
    try {
      await app.prisma.tenantConfig.update({
        where: { tenantId: dup.tenant.id },
        data: { phorestBusinessId: "biz-dup", phorestUsername: "dup@salon.de" },
      });
      const inactiveSalon = await createTestSalon(app.prisma, dup.tenant.id, {
        name: "Dup Inactive",
        isActive: false,
      });
      await app.prisma.salonCoupling.create({
        data: {
          tenantId: dup.tenant.id,
          salonId: inactiveSalon.id,
          provider: "PHOREST",
          externalBranchId: "dup-branch",
        },
      });
      const before = await app.prisma.tenantConfig.findUnique({
        where: { tenantId: dup.tenant.id },
      });

      const res = await app.inject({
        method: "PUT",
        url: `${PREFIX}/phorest/config`,
        headers: { authorization: `Bearer ${dup.adminToken}` },
        payload: {
          phorestBusinessId: "biz-dup-changed",
          branchId: "dup-branch",
          phorestUsername: "dup@salon.de",
        },
      });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body)).toEqual({
        error: "Diese Phorest-Filiale ist bereits mit einem anderen Salon gekoppelt.",
        code: "BRANCH_ALREADY_COUPLED",
      });
      const after = await app.prisma.tenantConfig.findUnique({
        where: { tenantId: dup.tenant.id },
      });
      expect(after).toEqual(before);
      const ownCoupling = await app.prisma.salonCoupling.findUnique({
        where: { salonId: dup.salonId },
      });
      expect(ownCoupling).toBeNull();
    } finally {
      await cleanupTestData(app, dup.tenant.id);
    }
  });
});

// ── Manual trigger per salon (Phase 65b, issue #65, D-13) ─────────────────────────────────────

const SYNC_BODY = { startDate: "2026-07-01", endDate: "2026-12-31" };
const MAPPED_65B = "ph-65b-mapped";

/** A worktimetable page with one WORKING slot per entry (fixtures/worktimetables*.json shape). */
function wtt(slots: { staffId: string; date: string }[]): unknown {
  return {
    _embedded: {
      workTimeTables: slots.map((s) => ({
        staffId: s.staffId,
        timeSlots: [{ date: s.date, startTime: "09:00:00", endTime: "17:00:00", type: "WORKING" }],
      })),
    },
    page: { size: 200, totalElements: slots.length, totalPages: 1, number: 0 },
  };
}

const BRANCH_1_WTT = wtt([
  { staffId: MAPPED_65B, date: "2026-08-03" },
  { staffId: "ph-65b-unmapped-1", date: "2026-08-03" },
]);
const BRANCH_2_WTT = wtt([
  { staffId: MAPPED_65B, date: "2026-08-04" },
  { staffId: "ph-65b-unmapped-2", date: "2026-08-04" },
]);

describe("POST /phorest/sync-shifts per salon (Phase 65b, D-13)", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;
  let secondSalon: { id: string; name: string };

  const auth = () => ({ authorization: `Bearer ${seed.adminToken}` });
  const sync = () =>
    app.inject({
      method: "POST",
      url: `${PREFIX}/phorest/sync-shifts`,
      headers: auth(),
      payload: SYNC_BODY,
    });

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "intph65b");
    await app.prisma.tenantConfig.update({
      where: { tenantId: seed.tenant.id },
      data: {
        phorestBusinessId: "biz-1",
        phorestUsername: "user@salon.de",
        phorestPassword: "secret-pw", // decryptSafe tolerates plaintext
      },
    });
    secondSalon = await createTestSalon(app.prisma, seed.tenant.id, {
      name: "Zweitsalon 65b",
      createdAt: new Date(Date.now() + 60_000),
    });
    await app.prisma.salonCoupling.create({
      data: {
        tenantId: seed.tenant.id,
        salonId: seed.salonId,
        provider: "PHOREST",
        externalBranchId: "branch-1",
      },
    });
    await app.prisma.salonCoupling.create({
      data: {
        tenantId: seed.tenant.id,
        salonId: secondSalon.id,
        provider: "PHOREST",
        externalBranchId: "branch-2",
      },
    });
    await app.prisma.phorestStaffMapping.create({
      data: { tenantId: seed.tenant.id, phorestStaffId: MAPPED_65B, employeeId: seed.employee.id },
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    try {
      // Mapping + appointment cache are unknown to cleanupTestData (both Restrict onto Employee);
      // couplings and runs are deleted by cleanupTestData since Phase 65b.
      await app.prisma.phorestStaffMapping.deleteMany({ where: { tenantId: seed.tenant.id } });
      await app.prisma.phorestAppointment.deleteMany({
        where: { employee: { tenantId: seed.tenant.id } },
      });
      await cleanupTestData(app, seed.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
  });

  it("(1) two coupled salons: per-salon results in salon order plus summed top-level fields", async () => {
    mockPhorestByBranch({
      "branch-1": { worktimetables: BRANCH_1_WTT },
      "branch-2": { worktimetables: BRANCH_2_WTT },
    });
    const res = await sync();
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.results).toHaveLength(2);
    expect(body.results.map((r: { salonId: string }) => r.salonId)).toEqual([
      seed.salonId,
      secondSalon.id,
    ]);
    for (const r of body.results) {
      expect(typeof r.salonName).toBe("string");
      expect(typeof r.runId).toBe("string");
      expect(r.runId.length).toBeGreaterThan(0);
      expect(typeof r.appointments).toBe("object");
      expect(r.appointments.status).toBe("SUCCESS");
    }
    expect(body.results[1].salonName).toBe("Zweitsalon 65b");
    const sum = (k: "created" | "cancelled" | "unmapped") =>
      body.results.reduce((acc: number, r: Record<string, number>) => acc + r[k], 0);
    expect(body.created).toBe(sum("created"));
    expect(body.cancelled).toBe(sum("cancelled"));
    expect(body.unmapped).toBe(sum("unmapped"));
    expect(body.created).toBe(2);
    expect(body.unmapped).toBe(2);
    expect(body.status).toBe("SUCCESS");
    expect(body.error).toBeUndefined();
  });

  it("(2) a 503 on the second salon's branch: top-level ERROR with a salon-prefixed error", async () => {
    mockPhorestByBranch({
      "branch-1": { worktimetables: BRANCH_1_WTT },
      "branch-2": { status: 503 },
    });
    const res = await sync();
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("ERROR");
    expect(body.results[0].status).toBe("SUCCESS");
    expect(body.results[1].status).toBe("ERROR");
    expect(body.error.startsWith("Zweitsalon 65b: ")).toBe(true);
  });

  it("(3) single coupled salon: top-level fields equal results[0], error unprefixed", async () => {
    await app.prisma.salonCoupling.deleteMany({ where: { salonId: secondSalon.id } });

    mockPhorestByBranch({ "branch-1": { worktimetables: BRANCH_1_WTT } });
    const ok = JSON.parse((await sync()).body);
    expect(ok.results).toHaveLength(1);
    const only = ok.results[0];
    for (const k of [
      "status",
      "created",
      "updated",
      "cancelled",
      "unmapped",
      "skippedVocationalSchool",
      "replaced",
      "protectedPendingLeave",
      "leaveRecalcFailures",
      "skippedOtherSalon",
    ]) {
      expect(ok[k]).toEqual(only[k]);
    }
    expect(ok.unmappedStaff).toEqual(only.unmappedStaff);

    mockPhorestByBranch({ "branch-1": { status: 503 } });
    const failed = JSON.parse((await sync()).body);
    expect(failed.results).toHaveLength(1);
    expect(failed.status).toBe("ERROR");
    expect(typeof failed.results[0].error).toBe("string");
    expect(failed.error).toBe(failed.results[0].error);
  });

  it("(4) no coupled active salon: 409 NO_PHOREST_COUPLING and no run row", async () => {
    await app.prisma.salonCoupling.deleteMany({ where: { tenantId: seed.tenant.id } });
    const before = await app.prisma.phorestSyncRun.count({ where: { tenantId: seed.tenant.id } });
    const requested = mockPhorestByBranch({ "branch-1": {} });

    const res = await sync();
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({
      error: "Kein aktiver Salon ist mit Phorest gekoppelt.",
      code: "NO_PHOREST_COUPLING",
    });
    expect(await app.prisma.phorestSyncRun.count({ where: { tenantId: seed.tenant.id } })).toBe(
      before,
    );
    expect(requested).toHaveLength(0);
  });
});
