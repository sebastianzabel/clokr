import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { createHash, randomBytes } from "crypto";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../../__tests__/setup";

// Phase 76.2 (ARCH-V19-01 sub-req A / GH #215) — End-to-end audit-actor resolution coverage.
//
// Block A: Terminal API key auth on /nfc-punch → AuditLog.userId = null,
//          newValue.actor = { type: 'TERMINAL', terminalApiKeyId }.
//          THIS IS THE CLOSURE TEST FOR #215 (no FK violation when actor is a Terminal).
//
// Block B: Programmatic API key auth (clk_-prefix) on /clock-in → AuditLog.userId = null,
//          newValue.actor = { type: 'API_KEY', apiKeyId: <uuid> }.
//          Mode A (clk_ middleware path EXISTS at apps/api/src/middleware/auth.ts:33).
//
// Block C: Cross-actor consistency — JWT user on /clock-in produces AuditLog.userId === JWT.sub
//          AND no actor embedding in newValue (the legacy/preserved JWT-path semantics).

describe("services/clock/audit-actor — integration (sub-req A / GH #215)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  const NFC_CARD_ID = "NFC-AUDIT-ACTOR-INT";
  let terminalApiKey: string;
  let terminalApiKeyId: string;
  let programmaticApiKey: string;
  let programmaticApiKeyId: string;
  let jwtToken: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "audit-actor-int");

    await app.prisma.employee.update({
      where: { id: data.employee.id },
      data: { nfcCardId: NFC_CARD_ID },
    });

    // Terminal API key for /nfc-punch (Block A)
    terminalApiKey = `clk_${randomBytes(32).toString("hex")}`;
    const termKeyHash = createHash("sha256").update(terminalApiKey).digest("hex");
    const term = await app.prisma.terminalApiKey.create({
      data: {
        tenantId: data.tenant.id,
        name: "Audit Actor Test Terminal",
        keyHash: termKeyHash,
        keyPrefix: terminalApiKey.substring(0, 12) + "...",
      },
    });
    terminalApiKeyId = term.id;

    // Programmatic API key (clk_-prefix) for /clock-in (Block B — Mode A)
    programmaticApiKey = `clk_${randomBytes(32).toString("hex")}`;
    const progKeyHash = createHash("sha256").update(programmaticApiKey).digest("hex");
    const prog = await app.prisma.apiKey.create({
      data: {
        tenantId: data.tenant.id,
        name: "Audit Actor Test Programmatic Key",
        keyHash: progKeyHash,
        keyPrefix: programmaticApiKey.substring(0, 12),
        scopes: ["admin"],
        createdBy: data.adminUser.id,
      },
    });
    programmaticApiKeyId = prog.id;

    // JWT for Block C — cross-actor consistency check (JWT path = USER actor, AuditLog.userId set)
    jwtToken = app.jwt.sign({
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
    await app.prisma.apiKey.deleteMany({
      where: { tenantId: data.tenant.id },
    });
    await app.prisma.terminalApiKey.deleteMany({
      where: { tenantId: data.tenant.id },
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

  // ── Block A — Terminal API key on /nfc-punch (closes #215) ─────────────────
  it("Block A — /nfc-punch with Terminal API key → AuditLog.userId null + newValue.actor.type === 'TERMINAL' (closes #215)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/time-entries/nfc-punch",
      headers: { authorization: `Bearer ${terminalApiKey}` },
      payload: { nfcCardId: NFC_CARD_ID },
    });

    expect(res.statusCode).toBe(200);

    const entries = await app.prisma.timeEntry.findMany({
      where: { employeeId: data.employee.id, deletedAt: null },
    });
    expect(entries).toHaveLength(1);

    // Filter by entityId — shared test DB may contain stale CLOCK_IN audits from other suites.
    const audits = await app.prisma.auditLog.findMany({
      where: { entity: "TimeEntry", entityId: entries[0].id, action: "CLOCK_IN" },
    });
    expect(audits).toHaveLength(1);
    // Sub-req A — closes FK violation #215: no User FK reference when actor is a Terminal.
    expect(audits[0].userId).toBeNull();
    const newValue = audits[0].newValue as { actor?: { type?: string; terminalApiKeyId?: string } };
    expect(newValue.actor?.type).toBe("TERMINAL");
    expect(newValue.actor?.terminalApiKeyId).toBe(terminalApiKeyId);
  });

  // ── Block B — Programmatic API key (clk_-prefix) on /clock-in (Mode A) ─────
  // Task 0 pre-flight confirmed apps/api/src/middleware/auth.ts:26,32,33 contain the
  // `clk_` prefix path — req.user.sub = `apikey:${apiKey.id}` for clk_-authenticated requests.
  // resolveActor() (Plan 1) maps that to { type: 'API_KEY', apiKeyId } at the resolver entry.
  it("Block B — /clock-in with programmatic API key (clk_-prefix) → AuditLog.userId null + newValue.actor.type === 'API_KEY' (sub-req A end-to-end)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/time-entries/clock-in",
      headers: { authorization: `Bearer ${programmaticApiKey}` },
      payload: { source: "MOBILE", employeeId: data.employee.id },
    });

    expect(res.statusCode).toBe(200);

    const entries = await app.prisma.timeEntry.findMany({
      where: { employeeId: data.employee.id, deletedAt: null },
    });
    expect(entries).toHaveLength(1);

    const audits = await app.prisma.auditLog.findMany({
      where: { entity: "TimeEntry", entityId: entries[0].id, action: "CLOCK_IN" },
    });
    expect(audits).toHaveLength(1);
    // The clk_-path produces userId = null AND actor = API_KEY (since sub starts with 'apikey:').
    expect(audits[0].userId).toBeNull();
    const newValue = audits[0].newValue as { actor?: { type?: string; apiKeyId?: string } };
    expect(newValue.actor?.type).toBe("API_KEY");
    expect(newValue.actor?.apiKeyId).toBe(programmaticApiKeyId);
  });

  // ── Block C — Cross-actor consistency: JWT path preserves legacy AuditLog.userId ─
  it("Block C — /clock-in with JWT → AuditLog.userId === JWT.sub, no actor embedding (legacy USER-path semantics preserved)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/time-entries/clock-in",
      headers: { authorization: `Bearer ${jwtToken}` },
      payload: { source: "MOBILE" },
    });

    expect(res.statusCode).toBe(200);

    const entries = await app.prisma.timeEntry.findMany({
      where: { employeeId: data.employee.id, deletedAt: null },
    });
    expect(entries).toHaveLength(1);

    const audits = await app.prisma.auditLog.findMany({
      where: { entity: "TimeEntry", entityId: entries[0].id, action: "CLOCK_IN" },
    });
    expect(audits).toHaveLength(1);
    // JWT-path: userId is set (NOT null), and the actor is NOT embedded in newValue (USER type
    // is the implicit default — only non-USER actors get embedded by emitClockAudit).
    expect(audits[0].userId).toBe(data.empUser.id);
    const newValue = audits[0].newValue as { actor?: unknown };
    // Legacy semantics preserved — USER actor not embedded
    expect(newValue.actor).toBeUndefined();
  });
});
