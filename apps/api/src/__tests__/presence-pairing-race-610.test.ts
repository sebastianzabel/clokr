/**
 * Issue #610 (Phase 610-02, Task 1) - concurrent confirms of ONE code have exactly one winner
 * (T-610-11): the code row is locked FOR UPDATE inside the confirm transaction, the loser sees a
 * consumed code and gets the uniform 404. A unique race on [tenantId, mac] against a concurrent
 * manual mapping answers 409 and leaves the code unconsumed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { cleanupTestData, closeTestApp, getTestApp, seedTestData } from "./setup";
import { PAIRING_CODE_INVALID_ERROR } from "../contexts/time-tracking/pairing-code";
import {
  confirmCode,
  createPeerEmployee,
  createPresenceSourceWithKey,
  issueCode,
  randomTestMac,
} from "./presence-pairing-fixtures-610";

describe("concurrent QR confirms (Issue #610, D-06)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let rawKey: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "pc610");
    ({ rawKey } = await createPresenceSourceWithKey(app, data.tenant.id));
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("presence-pairing-race-610 cleanup failed:", err);
    }
    await closeTestApp();
  });

  async function codeFor(mac: string): Promise<string> {
    const issued = await issueCode(app, rawKey, mac, "Rennen");
    expect(issued.statusCode).toBe(201);
    return JSON.parse(issued.body).code as string;
  }

  it("two different employees confirm the same code together: one success, one uniform 404", async () => {
    const first = await createPeerEmployee(app, data.tenant.id, "race-a");
    const second = await createPeerEmployee(app, data.tenant.id, "race-b");
    const mac = randomTestMac();
    const code = await codeFor(mac);

    const results = await Promise.all([
      confirmCode(app, first.token, code),
      confirmCode(app, second.token, code),
    ]);

    const statuses = results.map((r) => r.statusCode);
    expect(statuses.filter((s) => s === 201 || s === 200)).toHaveLength(1);
    const lost = results.filter((r) => r.statusCode === 404);
    expect(lost).toHaveLength(1);
    expect(JSON.parse(lost[0].body)).toEqual(PAIRING_CODE_INVALID_ERROR);

    const devices = await app.prisma.presenceDevice.findMany({
      where: { tenantId: data.tenant.id, mac },
    });
    expect(devices).toHaveLength(1);
    const row = await app.prisma.presencePairingCode.findFirstOrThrow({
      where: { tenantId: data.tenant.id, mac },
    });
    expect(row.consumedByUserId).toBe(
      devices[0].employeeId === first.employeeId ? first.userId : second.userId,
    );
  });

  it("one employee confirms the same code twice together: one 201, one 404, one device", async () => {
    const peer = await createPeerEmployee(app, data.tenant.id, "race-self");
    const mac = randomTestMac();
    const code = await codeFor(mac);

    const results = await Promise.all([
      confirmCode(app, peer.token, code),
      confirmCode(app, peer.token, code),
    ]);

    expect(results.map((r) => r.statusCode).sort((a, b) => a - b)).toEqual([201, 404]);
    expect(
      await app.prisma.presenceDevice.count({ where: { tenantId: data.tenant.id, mac } }),
    ).toBe(1);
  });

  it("a unique violation on [tenantId, mac] from a concurrent mapping answers 409 and leaves the code unconsumed", async () => {
    const peer = await createPeerEmployee(app, data.tenant.id, "race-unique");
    const intruder = await createPeerEmployee(app, data.tenant.id, "race-intruder");
    const mac = randomTestMac();
    const code = await codeFor(mac);

    // Deterministic stand-in for "a concurrent mapping appears after the confirm's device check":
    // the intruder's row is inserted in a transaction that stays UNCOMMITTED, so the confirm reads no
    // device, claims the code, and blocks on the unique index when it inserts its own row. Once the
    // intruder commits, the confirm's insert fails with a unique violation.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let inserted: () => void = () => undefined;
    const insertedSignal = new Promise<void>((resolve) => {
      inserted = resolve;
    });
    const holder = app.prisma.$transaction(
      async (tx) => {
        await tx.presenceDevice.create({
          data: {
            tenantId: data.tenant.id,
            employeeId: intruder.employeeId,
            mac,
            pairedVia: "MANUAL",
          },
        });
        inserted();
        await gate;
      },
      { timeout: 20000 },
    );
    await insertedSignal;

    const confirm = confirmCode(app, peer.token, code);
    await new Promise((resolve) => setTimeout(resolve, 500));
    release();
    await holder;
    const res = await confirm;

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("PRESENCE_DEVICE_TAKEN");
    const row = await app.prisma.presencePairingCode.findFirstOrThrow({
      where: { tenantId: data.tenant.id, mac },
    });
    expect(row.consumedAt).toBeNull();
    expect(row.consumedByUserId).toBeNull();
    const devices = await app.prisma.presenceDevice.findMany({
      where: { tenantId: data.tenant.id, mac },
    });
    expect(devices).toHaveLength(1);
    expect(devices[0].employeeId).toBe(intruder.employeeId);
  });
});
