/**
 * Issue #85 (D-13) — `resolveSalonInReach`, the one validator of a chosen salon.
 *
 * The salon choice narrows a view, it is never an access boundary (#82 D-05): the chosen salon must
 * be an ACTIVE salon of the caller's tenant inside the caller's reach, and every rejection cause
 * yields the same `{ ok: false }` so a caller answers one 404 body (T-100-09).
 *
 * Deep imports of the facade file are allowed here: this test lives inside the platform context.
 * No person names in fixtures.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  createTestSalon,
} from "../../../__tests__/setup";
import type { AccessReach } from "../access-context";
import { resolveSalonInReach } from "../facade/salons";

type Seed = Awaited<ReturnType<typeof seedTestData>>;

describe("Issue #85 (D-13) — resolveSalonInReach", () => {
  let app: FastifyInstance;
  let data: Seed;
  let foreign: Seed;
  let salonB: { id: string };
  let salonGone: { id: string };

  const whole: AccessReach = { kind: "wholeTenant" };

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "rsir85a");
    foreign = await seedTestData(app, "rsir85b");
    salonB = await createTestSalon(app.prisma, data.tenant.id, { name: "ReachB85" });
    salonGone = await createTestSalon(app.prisma, data.tenant.id, {
      name: "ReachGone85",
      isActive: false,
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
      await cleanupTestData(app, foreign.tenant.id);
    } finally {
      await closeTestApp();
    }
  });

  it("returns { ok: true, salonId: null } for an undefined choice without any database read", async () => {
    const calls: string[] = [];
    const spy = new Proxy(app.prisma, {
      get(target, prop) {
        calls.push(String(prop));
        return Reflect.get(target, prop);
      },
    });
    const result = await resolveSalonInReach(spy, data.tenant.id, whole, undefined);
    expect(result).toEqual({ ok: true, salonId: null });
    expect(calls).toEqual([]);
  });

  it("accepts an active salon of the tenant for a whole-tenant reach", async () => {
    const result = await resolveSalonInReach(app.prisma, data.tenant.id, whole, salonB.id);
    expect(result).toEqual({ ok: true, salonId: salonB.id });
  });

  it("accepts a salon inside a scoped reach and rejects one outside it", async () => {
    const reach: AccessReach = { kind: "scoped", salonIds: [salonB.id], employeeIds: [] };
    expect(await resolveSalonInReach(app.prisma, data.tenant.id, reach, salonB.id)).toEqual({
      ok: true,
      salonId: salonB.id,
    });
    expect(await resolveSalonInReach(app.prisma, data.tenant.id, reach, data.salonId)).toEqual({
      ok: false,
    });
  });

  it("rejects every salon for a persons-only reach", async () => {
    const reach: AccessReach = { kind: "scoped", salonIds: [], employeeIds: [randomUUID()] };
    expect(await resolveSalonInReach(app.prisma, data.tenant.id, reach, data.salonId)).toEqual({
      ok: false,
    });
    expect(await resolveSalonInReach(app.prisma, data.tenant.id, reach, salonB.id)).toEqual({
      ok: false,
    });
  });

  it("rejects a deactivated salon even for a whole-tenant reach", async () => {
    expect(await resolveSalonInReach(app.prisma, data.tenant.id, whole, salonGone.id)).toEqual({
      ok: false,
    });
  });

  it("answers a foreign tenant's salon and an unknown id with the identical result", async () => {
    const foreignResult = await resolveSalonInReach(
      app.prisma,
      data.tenant.id,
      whole,
      foreign.salonId,
    );
    const unknownResult = await resolveSalonInReach(
      app.prisma,
      data.tenant.id,
      whole,
      randomUUID(),
    );
    expect(foreignResult).toEqual({ ok: false });
    expect(unknownResult).toEqual(foreignResult);
    expect(JSON.stringify(unknownResult)).toBe(JSON.stringify(foreignResult));
  });
});
