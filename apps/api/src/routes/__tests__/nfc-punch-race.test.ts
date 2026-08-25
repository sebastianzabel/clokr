import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../__tests__/setup";
import type { FastifyInstance } from "fastify";
import { createHash, randomBytes } from "crypto";

// TIME-V19-03 regression: NFC double-tap race condition.
// Reproduces the prod incident from 2026-06-04 — admin user produced two
// NFC entries 3 ms apart, both ran ~63 min. Without the SELECT FOR UPDATE
// row lock in apps/api/src/routes/time-entries.ts, concurrent reads of
// `endTime: null` both miss the existing open entry and both INSERT.

describe("TIME-V19-03 — NFC double-tap + clock-in race", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  const NFC_CARD_ID = "NFC-RACE-CARD-76-1";
  let terminalApiKey: string;
  let jwt: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "race");

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
        name: "Race Test Terminal",
        keyHash,
        keyPrefix: terminalApiKey.substring(0, 12) + "...",
      },
    });

    // JWT for the /clock-in block (employee-self path)
    jwt = app.jwt.sign({
      sub: data.empUser.id,
      tenantId: data.tenant.id,
      role: data.empUser.role,
      employeeId: data.employee.id,
    });
  });

  afterAll(async () => {
    await app.prisma.break.deleteMany({
      where: { timeEntry: { employeeId: data.employee.id } },
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
    // Hard-reset: delete any leftover entries so each test starts from a clean slate.
    await app.prisma.break.deleteMany({
      where: { timeEntry: { employeeId: data.employee.id } },
    });
    await app.prisma.timeEntry.deleteMany({
      where: { employeeId: data.employee.id },
    });
  });

  it("5 concurrent /nfc-punch requests never create more than 1 open TimeEntry (prod-incident invariant)", async () => {
    const headers = { authorization: `Bearer ${terminalApiKey}` };
    const payload = { nfcCardId: NFC_CARD_ID };

    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        app.inject({
          method: "POST",
          url: "/api/v1/time-entries/nfc-punch",
          headers,
          payload,
        }),
      ),
    );

    // All 5 must be HTTP 200 — /nfc-punch is a toggle, not a 409 gate.
    for (const res of responses) {
      expect(res.statusCode).toBe(200);
    }

    const bodies = responses.map((r) => JSON.parse(r.body) as { action: string });
    const inCount = bodies.filter((b) => b.action === "IN").length;
    const outCount = bodies.filter((b) => b.action === "OUT").length;

    // 76.19.1 D-02: the 60s double-tap debounce changes the race outcome. Under serial
    // execution enforced by the FOR UPDATE row lock, the first transaction INSERTs (IN)
    // and subsequent STOP attempts arrive within the 60s debounce window → NOOP (not OUT).
    // Pre-76.19.1 behavior was IN/OUT/IN/OUT/IN (3 IN + 2 OUT = 5). Post-76.19.1: the
    // first rapid concurrent punch is IN; the rest are NOOPed → inCount ≥ 1, outCount
    // may be 0.  The assertion `inCount + outCount === 5` is removed because NOOP
    // responses are now the expected outcome for sub-60s concurrent punches.
    //
    // Without the row lock, the prod incident shape is still reproducible: multiple
    // concurrent transactions all read "no open entry" and all INSERT, producing
    // 2+ rows with endTime=null simultaneously (the 2026-06-04 incident). The CORE
    // INVARIANT below still detects this.
    expect(inCount).toBeGreaterThanOrEqual(1);
    // outCount may be 0 under D-02 — not asserted here.
    void outCount;

    // CORE INVARIANT (prod bug detector): after all 5 requests resolve, at most
    // ONE TimeEntry has endTime=null. Without the lock, 2+ concurrent INs leave
    // 2+ rows open — that is the prod incident shape we must prevent.
    const allRows = await app.prisma.timeEntry.findMany({
      where: { employeeId: data.employee.id, deletedAt: null },
    });
    const openRows = allRows.filter((r) => r.endTime === null);
    expect(openRows.length).toBeLessThanOrEqual(1);

    // Action ordering invariant: under strict serial toggle, the number of IN
    // actions equals the number of non-soft-deleted rows created in this run
    // (each IN INSERTs exactly one row; OUTs only UPDATE existing rows).
    // The merge logic may soft-delete short OUT'd entries — so we count both
    // live AND soft-deleted rows for this assertion.
    const allRowsIncludingDeleted = await app.prisma.timeEntry.findMany({
      where: { employeeId: data.employee.id },
    });
    expect(allRowsIncludingDeleted.length).toBe(inCount);
  });

  it("5 concurrent /clock-in requests produce 1x 200 + 4x 409 'Bereits eingestempelt'", async () => {
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

    // The single 409 message string is preserved verbatim (German, UI contract).
    const conflicts = responses.filter((r) => r.statusCode === 409);
    for (const c of conflicts) {
      const body = JSON.parse(c.body) as { error: string };
      expect(body.error).toBe("Bereits eingestempelt");
    }

    // The DB must contain exactly one non-soft-deleted entry for today.
    const rows = await app.prisma.timeEntry.findMany({
      where: { employeeId: data.employee.id, deletedAt: null },
    });
    expect(rows).toHaveLength(1);
  });
});
