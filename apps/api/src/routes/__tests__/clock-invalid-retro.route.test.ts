// Phase 118 (Issue #124) — HTTP-level proof that the resolver-level fixes (118-01, 118-02)
// actually surface correctly through POST /clock-in, POST /:id/clock-out and POST /nfc-punch.
//
// D-11c (HTTP): a second /clock-in while an isInvalid entry is open must answer 409, never the
// 500 issue #124 originally produced.
// D-11a (HTTP): /:id/clock-out on an isInvalid open entry (the CANCELLATION_REQUESTED shape)
// must succeed and must not silently revalidate the row.
// D-11d (HTTP): a pending Zeitnachtrag for today must be honestly rejected — with the correct
// German message and RETRO_PENDING resolution — by BOTH /clock-in and /nfc-punch, and the
// Nachtrag row must come out bit-identical.
import { createHash } from "crypto";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../__tests__/setup";
import { todayInTz, dateStrInTz } from "../../utils/timezone";

describe("POST /clock-in, /:id/clock-out, /nfc-punch — D-11 HTTP-level proof (clock-invalid-retro.route)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  // D-12: the routes derive "today" from the tenant timezone (todayInTz), never a hardcoded
  // literal — the fixture must do the same so a run near a day boundary can never desync from
  // what the route computes. Hardcoded date literals are a known time bomb in this repo
  // (Issue #34, docs/testing.md); per that doc a run between 00:00 and 02:00 local is not
  // conclusive either way — repeat outside that window rather than reading a result from it.
  const TZ = "Europe/Berlin"; // seedTestData's fixture TenantConfig.timezone
  const today = todayInTz(TZ);
  const todayStr = dateStrInTz(new Date(), TZ);

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "clock-invalid-retro");
  });

  afterAll(async () => {
    await cleanupEmployeeState();
    await cleanupTestData(app, data.tenant.id);
    await closeTestApp();
  });

  beforeEach(async () => {
    await cleanupEmployeeState();
  });

  async function cleanupEmployeeState() {
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
    // TimeEntry.retroRequestId is onDelete: Restrict — TimeEntry rows must be gone
    // before their coupled RetroEntryRequest rows can be deleted.
    await app.prisma.timeEntry.deleteMany({
      where: { employeeId: data.employee.id },
    });
    await app.prisma.retroEntryRequest.deleteMany({
      where: { employeeId: data.employee.id },
    });
    await app.prisma.terminalApiKey.deleteMany({ where: { tenantId: data.tenant.id } });
  }

  async function createOpenInvalidEntry(invalidReason: string, hoursAgo = 2) {
    const startTime = new Date(Date.now() - hoursAgo * 3600_000);
    return app.prisma.timeEntry.create({
      data: {
        employeeId: data.employee.id,
        date: today,
        startTime,
        endTime: null,
        source: "MOBILE",
        isInvalid: true,
        invalidReason,
      },
    });
  }

  async function seedPendingRetro() {
    const request = await app.prisma.retroEntryRequest.create({
      data: {
        employeeId: data.employee.id,
        targetDate: new Date(todayStr),
        reason: "118-03 fixture: pending Zeitnachtrag for today (route-level)",
        startTime: "08:00",
        endTime: "16:00",
        breakMinutes: 30,
        status: "PENDING",
      },
    });
    const entry = await app.prisma.timeEntry.create({
      data: {
        employeeId: data.employee.id,
        date: today,
        startTime: new Date(`${todayStr}T08:00:00.000Z`),
        endTime: new Date(`${todayStr}T16:00:00.000Z`),
        breakMinutes: 30,
        source: "MANUAL",
        createdBy: data.employee.id,
        isInvalid: true,
        invalidReason: "Nachtrag – Genehmigung ausstehend",
        retroRequestId: request.id,
      },
    });
    return { request, entry };
  }

  async function seedTerminalKey() {
    const keyPlain = `clk_test_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const keyHash = createHash("sha256").update(keyPlain).digest("hex");
    await app.prisma.terminalApiKey.create({
      data: {
        tenantId: data.tenant.id,
        keyHash,
        name: "Test NFC key (118-03)",
        keyPrefix: keyPlain.slice(0, 8),
      },
    });
    const nfcCardId = `nfc-118-03-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    await app.prisma.employee.update({
      where: { id: data.employee.id },
      data: { nfcCardId },
    });
    return { keyPlain, nfcCardId };
  }

  // ── Test 1 (D-11c, HTTP): second /clock-in on an open isInvalid entry → 409, never 500 ────
  it("D-11c: /clock-in on an already-open isInvalid entry answers 409 ALREADY_CLOCKED_IN, never 500", async () => {
    await createOpenInvalidEntry("Ausstempeln fehlt");

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/time-entries/clock-in",
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: { source: "MOBILE" },
    });

    expect(
      res.statusCode,
      "Issue #124: a unique-constraint conflict on the day-index must never surface as a 500",
    ).not.toBe(500);
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("Bereits eingestempelt");
    expect(body.resolution.reason).toBe("ALREADY_CLOCKED_IN");
  });

  // ── Test 2 (D-11a, HTTP): /:id/clock-out on an isInvalid open entry succeeds ────────────────
  it("D-11a: /:id/clock-out on an isInvalid open entry (CANCELLATION_REQUESTED shape) succeeds and keeps isInvalid", async () => {
    const entry = await createOpenInvalidEntry("Urlaubsstornierung ausstehend");

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/time-entries/${entry.id}/clock-out`,
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: {},
    });

    expect(res.statusCode).toBe(200);

    const reloaded = await app.prisma.timeEntry.findUnique({ where: { id: entry.id } });
    expect(reloaded?.endTime).not.toBeNull();
    expect(reloaded?.isInvalid).toBe(true);
  });

  // ── Test 3 (D-11d, HTTP /clock-in): pending Zeitnachtrag for today → 409 RETRO_PENDING ─────
  it("D-11d: /clock-in with a pending Zeitnachtrag for today → 409 RETRO_PENDING with the honest German message", async () => {
    await seedPendingRetro();

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/time-entries/clock-in",
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: { source: "MOBILE" },
    });

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("Für diesen Tag liegt ein offener Zeitnachtrag zur Genehmigung vor.");
    expect(body.resolution.reason).toBe("RETRO_PENDING");
  });

  // ── Test 4 (D-11d, HTTP /nfc-punch): same guard on the terminal punch path ─────────────────
  it("D-11d: /nfc-punch with a pending Zeitnachtrag for today → 409 RETRO_PENDING, action BLOCKED", async () => {
    await seedPendingRetro();
    const { keyPlain, nfcCardId } = await seedTerminalKey();

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/time-entries/nfc-punch",
      headers: { authorization: `Bearer ${keyPlain}` },
      payload: { nfcCardId },
    });

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("Für diesen Tag liegt ein offener Zeitnachtrag zur Genehmigung vor.");
    expect(body.action).toBe("BLOCKED");
    expect(body.resolution.reason).toBe("RETRO_PENDING");
  });

  // ── Test 5 (D-11d, integrity): the Nachtrag row survives both blocked attempts bit-identical ─
  it("D-11d: after /clock-in AND /nfc-punch are both blocked, the Nachtrag row is bit-identical and still PENDING", async () => {
    const { request, entry } = await seedPendingRetro();
    const { keyPlain, nfcCardId } = await seedTerminalKey();
    const beforeUpdatedAt = entry.updatedAt.getTime();

    const clockInRes = await app.inject({
      method: "POST",
      url: "/api/v1/time-entries/clock-in",
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: { source: "MOBILE" },
    });
    expect(clockInRes.statusCode).toBe(409);

    const nfcRes = await app.inject({
      method: "POST",
      url: "/api/v1/time-entries/nfc-punch",
      headers: { authorization: `Bearer ${keyPlain}` },
      payload: { nfcCardId },
    });
    expect(nfcRes.statusCode).toBe(409);

    const reloaded = await app.prisma.timeEntry.findUnique({ where: { id: entry.id } });
    expect(reloaded?.endTime).not.toBeNull();
    expect(reloaded?.retroRequestId).toBe(request.id);
    expect(reloaded?.isInvalid).toBe(true);
    expect(reloaded?.updatedAt.getTime()).toBe(beforeUpdatedAt);

    const rows = await app.prisma.timeEntry.findMany({
      where: { employeeId: data.employee.id, deletedAt: null },
    });
    expect(rows).toHaveLength(1);

    const reloadedRequest = await app.prisma.retroEntryRequest.findUnique({
      where: { id: request.id },
    });
    expect(reloadedRequest?.status).toBe("PENDING");
  });
});
