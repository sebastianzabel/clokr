import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createHash, randomBytes } from "crypto";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../__tests__/setup";

// Phase 76.2 (ARCH-V19-01) — Plan 4 regression test for POST /nfc-punch via the resolver.
//
// Block A: happy IN — first /nfc-punch returns legacy { action: 'IN', employee, time, balanceHours }
//          (firmware compatibility — out-of-tree per RESEARCH.md A4) AND new D-03 additive field
//          { resolution: { kind: 'CLOCKED_IN', entry, audit } }.
// Block B: happy OUT — second /nfc-punch returns { action: 'OUT', resolution: { kind: 'CLOCKED_OUT' | 'CONSOLIDATED' } }.
// Block C: race via resolver — 5 concurrent /nfc-punch → 5× 200, exactly 1 IN + 4 OUT, exactly 1
//          TimeEntry row (76.1's contract via the resolver's FOR UPDATE — the per-route lock is gone).
//
// Pre-Task-4 baseline: Block A FAILS (legacy adapter does not emit `resolution`).
// Block C may pass on the legacy path because 76.1's per-route lock still serializes — but
// the contract is fully transferred to the resolver by Task 4.

describe("POST /nfc-punch — Phase 76.2 resolver migration", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  const NFC_CARD_ID = "NFC-RESOLVER-76-2";
  let terminalApiKey: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "nfc-resolver");
    // nfcCardId is globally unique — release it from any leftover employee
    // (residue from a prior run whose beforeAll threw partway) so setup is idempotent.
    await app.prisma.employee.updateMany({
      where: { nfcCardId: NFC_CARD_ID },
      data: { nfcCardId: null },
    });
    await app.prisma.employee.update({
      where: { id: data.employee.id },
      data: { nfcCardId: NFC_CARD_ID },
    });
    terminalApiKey = `clk_${randomBytes(32).toString("hex")}`;
    const keyHash = createHash("sha256").update(terminalApiKey).digest("hex");
    await app.prisma.terminalApiKey.create({
      data: {
        tenantId: data.tenant.id,
        name: "NFC Resolver Test Terminal",
        keyHash,
        keyPrefix: terminalApiKey.substring(0, 12) + "...",
      },
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

  // ── Block A — Happy IN preserves legacy fields + adds resolution ──────────
  it("Block A — happy IN: first /nfc-punch returns legacy { action, employee, time, balanceHours } + new { resolution: { kind: 'CLOCKED_IN' } }", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/time-entries/nfc-punch",
      headers: { authorization: `Bearer ${terminalApiKey}` },
      payload: { nfcCardId: NFC_CARD_ID },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      action: string;
      employee: { firstName: string; lastName: string; employeeNumber: string };
      time: string;
      balanceHours: number;
      resolution: { kind: string; entry: { id: string; source: string } };
    };
    // Legacy fields preserved (firmware compatibility — out-of-tree per RESEARCH.md A4)
    expect(body.action).toBe("IN");
    expect(body.employee).toBeDefined();
    expect(body.employee.firstName).toBe(data.employee.firstName);
    expect(typeof body.time).toBe("string");
    expect(typeof body.balanceHours).toBe("number");
    // New D-03 additive field
    expect(body.resolution.kind).toBe("CLOCKED_IN");
    expect(body.resolution.entry.source).toBe("NFC");
  });

  // ── Block B — Happy OUT toggle ─────────────────────────────────────────────
  it("Block B — happy OUT: second /nfc-punch returns { action: 'OUT', ..., resolution: { kind: 'CLOCKED_OUT' | 'CONSOLIDATED' } }", async () => {
    // First punch — IN
    await app.inject({
      method: "POST",
      url: "/api/v1/time-entries/nfc-punch",
      headers: { authorization: `Bearer ${terminalApiKey}` },
      payload: { nfcCardId: NFC_CARD_ID },
    });

    // 76.19.1 D-02: a STOP within 60s of START is a debounced NOOP. Backdate the open
    // entry so the second punch is treated as a valid STOP (>60s after start).
    const openEntry = await app.prisma.timeEntry.findFirst({
      where: { employeeId: data.employee.id, endTime: null, deletedAt: null },
    });
    if (openEntry) {
      await app.prisma.timeEntry.update({
        where: { id: openEntry.id },
        data: { startTime: new Date(Date.now() - 70_000) },
      });
    }

    // Second punch — OUT
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/time-entries/nfc-punch",
      headers: { authorization: `Bearer ${terminalApiKey}` },
      payload: { nfcCardId: NFC_CARD_ID },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      action: string;
      employee: { firstName: string };
      balanceHours: number;
      resolution: { kind: string };
    };
    expect(body.action).toBe("OUT");
    expect(body.employee).toBeDefined();
    expect(typeof body.balanceHours).toBe("number");
    expect(["CLOCKED_OUT", "CONSOLIDATED"]).toContain(body.resolution.kind);
  });

  // ── Block C — Race via resolver (76.1 contract preserved) ──────────────────
  // The /nfc-punch handler is a strict per-tx toggle: under serial execution enforced by
  // the resolver's FOR UPDATE row lock, the action sequence alternates strictly starting
  // with IN. 5 requests → IN/OUT/IN/OUT/IN → 3 IN + 2 OUT (same contract as 76.1's
  // nfc-punch-race.test.ts:106-110). The CORE prod-incident invariant is the open-row count.
  // 76.19.1 D-02: rapid concurrent punches now produce IN + NOOP (not IN/OUT alternation).
  // The first transaction to acquire the FOR UPDATE lock creates the entry (IN); all
  // subsequent STOP attempts arrive within the 60s debounce window and are NOOPs.
  // The pre-76.19.1 comment "5 → IN/OUT/IN/OUT/IN → 3 IN + 2 OUT" no longer applies.
  it("Block C — race: 5 concurrent /nfc-punch → 5× 200, at most 1 open TimeEntry (76.1 core invariant via resolver)", async () => {
    const headers = { authorization: `Bearer ${terminalApiKey}` };
    const payload = { nfcCardId: NFC_CARD_ID };
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        app.inject({ method: "POST", url: "/api/v1/time-entries/nfc-punch", headers, payload }),
      ),
    );
    for (const r of responses) expect(r.statusCode).toBe(200);
    const bodies = responses.map((r) => JSON.parse(r.body) as { action: string });
    const inCount = bodies.filter((b) => b.action === "IN").length;
    // 76.19.1 D-02: outCount may be 0 — rapid STOPs within the 60s window become NOOPs.
    // Pre-76.19.1 assertion `inCount + outCount === 5` removed; NOOP responses are expected.
    expect(inCount).toBeGreaterThanOrEqual(1);

    // CORE PROD-INCIDENT INVARIANT (76.1): at most ONE TimeEntry has endTime=null after
    // all 5 requests resolve. Without the resolver's FOR UPDATE, 2+ concurrent INs would
    // leave 2+ rows open — that is the 2026-06-04 prod incident shape.
    const allRows = await app.prisma.timeEntry.findMany({
      where: { employeeId: data.employee.id, deletedAt: null },
    });
    const openRows = allRows.filter((r) => r.endTime === null);
    expect(openRows.length).toBeLessThanOrEqual(1);
  });
});
