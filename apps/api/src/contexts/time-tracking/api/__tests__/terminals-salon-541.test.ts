/**
 * Issue #541 (Phase 541-03) — the admin write path of the terminal salon binding.
 *
 * Proves, through the real routes under `/api/v1/terminals`:
 *
 * - `PATCH /:id` binds, changes and removes the salon of a terminal key and writes exactly one
 *   `UPDATE TerminalApiKey` audit row per real change (old and new `salonId`), none for an
 *   unchanged value (D-03, D-10);
 * - a foreign tenant's salon id and an id that exists nowhere answer a byte-identical 404, an
 *   inactive salon answers 400 `SALON_INACTIVE`, and nothing is written in either case (AC-4,
 *   D-02 revised);
 * - a foreign tenant's key id answers like an unknown one, a revoked key answers 409 `KEY_REVOKED`;
 * - the PATCH is never module-gated (a Grundversion tenant can still change an existing key);
 * - `GET /` carries `salonId`, `salonName`, `salonActive` per key and no nested `salon` object
 *   (D-04, AC-3 list hint);
 * - `POST /` accepts an optional `salonId` after the module gate and before the create (D-03).
 *
 * No person names in fixtures. Every fixture id is a UUID.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import {
  getTestApp,
  seedTestData,
  seedGrundversionTenant,
  createTestSalon,
  auditRowsFor,
  soleAuditRow,
  cleanupTestData,
  closeTestApp,
} from "../../../../__tests__/setup";

const NOT_FOUND_SALON = '{"error":"Salon nicht gefunden"}';
const NOT_FOUND_KEY = '{"error":"Schlüssel nicht gefunden"}';

describe("Issue #541 — terminal key salon binding over HTTP", () => {
  let app: FastifyInstance;
  let own: Awaited<ReturnType<typeof seedTestData>>;
  let foreign: Awaited<ReturnType<typeof seedTestData>>;
  let grund: Awaited<ReturnType<typeof seedGrundversionTenant>>;
  let salonA: { id: string; name: string };
  let salonB: { id: string; name: string };
  let salonZ: { id: string; name: string };
  let foreignSalon: { id: string };
  const tenantIds: string[] = [];

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  /** A key written straight to the database (no module gate, no audit row). */
  async function makeKey(
    tenantId: string,
    extra: { salonId?: string | null; revokedAt?: Date } = {},
  ) {
    const raw = `clk_${randomBytes(32).toString("hex")}`;
    return app.prisma.terminalApiKey.create({
      data: {
        tenantId,
        name: `Terminal ${randomUUID().slice(0, 8)}`,
        keyHash: createHash("sha256").update(raw).digest("hex"),
        keyPrefix: raw.substring(0, 12) + "...",
        ...extra,
      },
    });
  }

  function patch(token: string, id: string, payload: unknown) {
    return app.inject({
      method: "PATCH",
      url: `/api/v1/terminals/${id}`,
      headers: auth(token),
      payload: payload as Record<string, unknown>,
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    own = await seedTestData(app, "term541");
    foreign = await seedTestData(app, "term541f");
    grund = await seedGrundversionTenant(app, "term541g");
    tenantIds.push(own.tenant.id, foreign.tenant.id, grund.tenant.id);
    salonA = await createTestSalon(app.prisma, own.tenant.id, { name: "Salon A 541" });
    salonB = await createTestSalon(app.prisma, own.tenant.id, { name: "Salon B 541" });
    salonZ = await createTestSalon(app.prisma, own.tenant.id, {
      name: "Salon Z 541",
      isActive: false,
    });
    foreignSalon = await createTestSalon(app.prisma, foreign.tenant.id, { name: "Fremd 541" });
  });

  afterAll(async () => {
    // Terminal keys hold an FK onto Salon (Restrict): delete them before the tenants' salons.
    for (const tenantId of tenantIds) {
      await app.prisma.terminalApiKey.deleteMany({ where: { tenantId } });
    }
    for (const tenantId of tenantIds) await cleanupTestData(app, tenantId);
    await closeTestApp();
  });

  describe("PATCH /:id", () => {
    it("binds, changes and removes the salon, one audit row per change", async () => {
      const key = await makeKey(own.tenant.id);

      const bind = await patch(own.adminToken, key.id, { salonId: salonA.id });
      expect(bind.statusCode).toBe(200);
      const bound = JSON.parse(bind.body);
      expect(bound).toEqual({
        id: key.id,
        name: key.name,
        keyPrefix: key.keyPrefix,
        lastUsedAt: null,
        revokedAt: null,
        createdAt: key.createdAt.toISOString(),
        salonId: salonA.id,
        salonName: salonA.name,
        salonActive: true,
      });
      expect(bound).not.toHaveProperty("salon");
      expect(
        (await app.prisma.terminalApiKey.findUniqueOrThrow({ where: { id: key.id } })).salonId,
      ).toBe(salonA.id);

      const change = await patch(own.adminToken, key.id, { salonId: salonB.id });
      expect(change.statusCode).toBe(200);
      expect(JSON.parse(change.body).salonId).toBe(salonB.id);

      const remove = await patch(own.adminToken, key.id, { salonId: null });
      expect(remove.statusCode).toBe(200);
      const removed = JSON.parse(remove.body);
      expect(removed.salonId).toBeNull();
      expect(removed.salonName).toBeNull();
      expect(removed.salonActive).toBeNull();

      const rows = await auditRowsFor(app, "TerminalApiKey", key.id);
      expect(rows.map((r) => [r.action, r.oldValue, r.newValue])).toEqual([
        ["UPDATE", { salonId: null }, { salonId: salonA.id }],
        ["UPDATE", { salonId: salonA.id }, { salonId: salonB.id }],
        ["UPDATE", { salonId: salonB.id }, { salonId: null }],
      ]);
      expect(rows.every((r) => r.userId === own.adminUser.id)).toBe(true);
    });

    it("an unchanged value answers 200 and writes no audit row, also for a deactivated salon", async () => {
      const key = await makeKey(own.tenant.id, { salonId: salonB.id });
      const same = await patch(own.adminToken, key.id, { salonId: salonB.id });
      expect(same.statusCode).toBe(200);
      expect(JSON.parse(same.body).salonId).toBe(salonB.id);
      const unboundSame = await makeKey(own.tenant.id);
      expect((await patch(own.adminToken, unboundSame.id, { salonId: null })).statusCode).toBe(200);

      const deadBound = await makeKey(own.tenant.id, { salonId: salonZ.id });
      const deadSame = await patch(own.adminToken, deadBound.id, { salonId: salonZ.id });
      expect(deadSame.statusCode).toBe(200);
      expect(JSON.parse(deadSame.body).salonActive).toBe(false);

      for (const id of [key.id, unboundSame.id, deadBound.id]) {
        expect(await auditRowsFor(app, "TerminalApiKey", id)).toHaveLength(0);
      }
    });

    it("a foreign and an unknown salon id answer a byte-identical 404, nothing written", async () => {
      const key = await makeKey(own.tenant.id, { salonId: salonA.id });
      const foreignRes = await patch(own.adminToken, key.id, { salonId: foreignSalon.id });
      const unknownRes = await patch(own.adminToken, key.id, { salonId: randomUUID() });
      expect(foreignRes.statusCode).toBe(404);
      expect(unknownRes.statusCode).toBe(404);
      expect(foreignRes.body).toBe(unknownRes.body);
      expect(foreignRes.body).toBe(NOT_FOUND_SALON);
      expect(
        (await app.prisma.terminalApiKey.findUniqueOrThrow({ where: { id: key.id } })).salonId,
      ).toBe(salonA.id);
      expect(await auditRowsFor(app, "TerminalApiKey", key.id)).toHaveLength(0);
    });

    it("an inactive salon answers 400 SALON_INACTIVE, nothing written", async () => {
      const key = await makeKey(own.tenant.id);
      const res = await patch(own.adminToken, key.id, { salonId: salonZ.id });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toEqual({
        error: "Salon ist deaktiviert",
        code: "SALON_INACTIVE",
      });
      expect(
        (await app.prisma.terminalApiKey.findUniqueOrThrow({ where: { id: key.id } })).salonId,
      ).toBeNull();
      expect(await auditRowsFor(app, "TerminalApiKey", key.id)).toHaveLength(0);
    });

    it("a foreign tenant's key id answers like an unknown one", async () => {
      const foreignKey = await makeKey(foreign.tenant.id);
      const foreignRes = await patch(own.adminToken, foreignKey.id, { salonId: salonA.id });
      const unknownRes = await patch(own.adminToken, randomUUID(), { salonId: salonA.id });
      expect(foreignRes.statusCode).toBe(404);
      expect(unknownRes.statusCode).toBe(404);
      expect(foreignRes.body).toBe(unknownRes.body);
      expect(foreignRes.body).toBe(NOT_FOUND_KEY);
      expect(
        (await app.prisma.terminalApiKey.findUniqueOrThrow({ where: { id: foreignKey.id } }))
          .salonId,
      ).toBeNull();
    });

    it("a revoked key answers 409 KEY_REVOKED, row and audit untouched", async () => {
      const key = await makeKey(own.tenant.id, { revokedAt: new Date() });
      const res = await patch(own.adminToken, key.id, { salonId: salonA.id });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body)).toEqual({
        error: "Schlüssel ist widerrufen",
        code: "KEY_REVOKED",
      });
      expect(
        (await app.prisma.terminalApiKey.findUniqueOrThrow({ where: { id: key.id } })).salonId,
      ).toBeNull();
      expect(await auditRowsFor(app, "TerminalApiKey", key.id)).toHaveLength(0);
    });

    it("a revoke landing between the read and the write answers 409 KEY_REVOKED, binding and audit untouched", async () => {
      const key = await makeKey(own.tenant.id);
      // Fire the revoke right after the handler's snapshot read: the PATCH then holds a stale
      // "not revoked" snapshot when it reaches its write.
      const realFindFirst = app.prisma.terminalApiKey.findFirst.bind(app.prisma.terminalApiKey);
      const spy = vi.spyOn(app.prisma.terminalApiKey, "findFirst").mockImplementationOnce(((
        args: never,
      ) => {
        const snapshot = realFindFirst(args);
        return snapshot.then(async (row) => {
          await app.prisma.terminalApiKey.update({
            where: { id: key.id },
            data: { revokedAt: new Date() },
          });
          return row;
        });
      }) as never);
      try {
        const res = await patch(own.adminToken, key.id, { salonId: salonA.id });
        expect(res.statusCode).toBe(409);
        expect(JSON.parse(res.body)).toEqual({
          error: "Schlüssel ist widerrufen",
          code: "KEY_REVOKED",
        });
      } finally {
        spy.mockRestore();
      }
      expect(
        (await app.prisma.terminalApiKey.findUniqueOrThrow({ where: { id: key.id } })).salonId,
      ).toBeNull();
      expect(await auditRowsFor(app, "TerminalApiKey", key.id)).toHaveLength(0);
    });

    it("a PATCH with a stale snapshot answers 409 TERMINAL_CHANGED_CONCURRENTLY; the audit oldValue stays correct", async () => {
      const key = await makeKey(own.tenant.id);
      // Two requests read the unbound key; the first one's write lands before the second one's.
      const realFindFirst = app.prisma.terminalApiKey.findFirst.bind(app.prisma.terminalApiKey);
      const spy = vi.spyOn(app.prisma.terminalApiKey, "findFirst").mockImplementationOnce(((
        args: never,
      ) => {
        const snapshot = realFindFirst(args);
        return snapshot.then(async (row) => {
          const first = await patch(own.adminToken, key.id, { salonId: salonA.id });
          expect(first.statusCode).toBe(200);
          return row;
        });
      }) as never);
      try {
        const second = await patch(own.adminToken, key.id, { salonId: salonB.id });
        expect(second.statusCode).toBe(409);
        expect(JSON.parse(second.body)).toEqual({
          error: "Der Schlüssel wurde zwischenzeitlich geändert. Bitte lade die Liste neu.",
          code: "TERMINAL_CHANGED_CONCURRENTLY",
        });
      } finally {
        spy.mockRestore();
      }
      expect(
        (await app.prisma.terminalApiKey.findUniqueOrThrow({ where: { id: key.id } })).salonId,
      ).toBe(salonA.id);
      const rows = await auditRowsFor(app, "TerminalApiKey", key.id);
      expect(rows.map((r) => [r.action, r.oldValue, r.newValue])).toEqual([
        ["UPDATE", { salonId: null }, { salonId: salonA.id }],
      ]);
    });

    it("DELETE: a second revoke landing between the read and the write overwrites nothing and adds no audit row (Issue #819)", async () => {
      const key = await makeKey(own.tenant.id);
      const del = (token: string, id: string) =>
        app.inject({ method: "DELETE", url: `/api/v1/terminals/${id}`, headers: auth(token) });
      // Two revokes both read the unrevoked key; the first one's write lands before the second's.
      const realFindFirst = app.prisma.terminalApiKey.findFirst.bind(app.prisma.terminalApiKey);
      const spy = vi.spyOn(app.prisma.terminalApiKey, "findFirst").mockImplementationOnce(((
        args: never,
      ) => {
        const snapshot = realFindFirst(args);
        return snapshot.then(async (row) => {
          const first = await del(own.adminToken, key.id);
          expect(first.statusCode).toBe(200);
          return row;
        });
      }) as never);
      let second;
      try {
        second = await del(own.adminToken, key.id);
      } finally {
        spy.mockRestore();
      }
      expect(second.statusCode).toBe(200);
      expect(JSON.parse(second.body)).toEqual({ success: true });
      const after = await app.prisma.terminalApiKey.findUniqueOrThrow({ where: { id: key.id } });
      expect(after.revokedAt).not.toBeNull();
      // Exactly one REVOKE row: the loser wrote and audited nothing.
      const rows = await auditRowsFor(app, "TerminalApiKey", key.id);
      expect(rows.map((r) => r.action)).toEqual(["REVOKE"]);
      // A later revoke still leaves the first timestamp in place.
      const third = await del(own.adminToken, key.id);
      expect(third.statusCode).toBe(200);
      expect(
        (await app.prisma.terminalApiKey.findUniqueOrThrow({ where: { id: key.id } })).revokedAt,
      ).toEqual(after.revokedAt);
      expect(await auditRowsFor(app, "TerminalApiKey", key.id)).toHaveLength(1);
    });

    it("DELETE: a foreign and an unknown id answer the identical 404 (Issue #819)", async () => {
      const foreignKey = await makeKey(foreign.tenant.id);
      const call = (id: string) =>
        app.inject({
          method: "DELETE",
          url: `/api/v1/terminals/${id}`,
          headers: auth(own.adminToken),
        });
      const a = await call(foreignKey.id);
      const b = await call(randomUUID());
      expect([a.statusCode, a.body]).toEqual([404, NOT_FOUND_KEY]);
      expect([b.statusCode, b.body]).toEqual([404, NOT_FOUND_KEY]);
      expect(
        (await app.prisma.terminalApiKey.findUniqueOrThrow({ where: { id: foreignKey.id } }))
          .revokedAt,
      ).toBeNull();
    });

    it("rejects a malformed body: empty, non-uuid, unknown key", async () => {
      const key = await makeKey(own.tenant.id);
      for (const payload of [{}, { salonId: "x" }, { salonId: salonA.id, name: "n" }]) {
        const res = await patch(own.adminToken, key.id, payload);
        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.body).error).toBe("Validierungsfehler");
      }
      expect(await auditRowsFor(app, "TerminalApiKey", key.id)).toHaveLength(0);
    });

    it("is not module-gated: a Grundversion tenant can bind an existing key", async () => {
      const grundSalon = await createTestSalon(app.prisma, grund.tenant.id, { name: "G 541" });
      const key = await makeKey(grund.tenant.id);
      const res = await patch(grund.adminToken, key.id, { salonId: grundSalon.id });
      expect(res.statusCode).toBe(200);
      const row = await soleAuditRow(app.prisma, {
        where: { entity: "TerminalApiKey", entityId: key.id, action: "UPDATE" },
      });
      expect(row.newValue).toEqual({ salonId: grundSalon.id });
    });

    it("answers 403 to an employee", async () => {
      const key = await makeKey(own.tenant.id);
      const res = await patch(own.empToken, key.id, { salonId: salonA.id });
      expect(res.statusCode).toBe(403);
    });
  });

  describe("GET /", () => {
    function list(token: string) {
      return app.inject({ method: "GET", url: "/api/v1/terminals", headers: auth(token) });
    }

    it("carries the flattened salon fields, null/null/null when unbound, no nested salon", async () => {
      const unbound = await makeKey(own.tenant.id);
      const bound = await makeKey(own.tenant.id, { salonId: salonA.id });
      const res = await list(own.adminToken);
      expect(res.statusCode).toBe(200);
      const keys = JSON.parse(res.body).keys as Array<Record<string, unknown>>;
      const u = keys.find((k) => k.id === unbound.id)!;
      const b = keys.find((k) => k.id === bound.id)!;
      expect([u.salonId, u.salonName, u.salonActive]).toEqual([null, null, null]);
      expect([b.salonId, b.salonName, b.salonActive]).toEqual([salonA.id, salonA.name, true]);
      for (const k of keys) expect(k).not.toHaveProperty("salon");
      expect(Object.keys(b).sort()).toEqual(
        [
          "createdAt",
          "id",
          "keyPrefix",
          "lastUsedAt",
          "name",
          "revokedAt",
          "salonActive",
          "salonId",
          "salonName",
        ].sort(),
      );
    });

    it("shows salonActive false after the bound salon was deactivated, binding kept", async () => {
      const salon = await createTestSalon(app.prisma, own.tenant.id, { name: "Hint 541" });
      const key = await makeKey(own.tenant.id, { salonId: salon.id });
      const off = await app.inject({
        method: "POST",
        url: `/api/v1/salons/${salon.id}/deactivate`,
        headers: auth(own.adminToken),
      });
      expect(off.statusCode).toBe(200);
      const keys = JSON.parse((await list(own.adminToken)).body).keys as Array<{
        id: string;
        salonId: string;
        salonActive: boolean;
      }>;
      const item = keys.find((k) => k.id === key.id)!;
      expect(item.salonId).toBe(salon.id);
      expect(item.salonActive).toBe(false);
    });
  });

  describe("POST /", () => {
    function create(token: string, payload?: unknown) {
      return app.inject({
        method: "POST",
        url: "/api/v1/terminals",
        headers: auth(token),
        payload: payload as Record<string, unknown> | undefined,
      });
    }
    const keyCount = (tenantId: string) => app.prisma.terminalApiKey.count({ where: { tenantId } });

    it("binds at once with salonId; the CREATE audit carries it", async () => {
      const res = await create(own.adminToken, { name: "Bound 541", salonId: salonA.id });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.salonId).toBe(salonA.id);
      expect(
        (await app.prisma.terminalApiKey.findUniqueOrThrow({ where: { id: body.id } })).salonId,
      ).toBe(salonA.id);
      const row = await soleAuditRow(app.prisma, {
        where: { entity: "TerminalApiKey", entityId: body.id, action: "CREATE" },
      });
      expect(row.newValue).toEqual({
        name: "Bound 541",
        keyPrefix: body.keyPrefix,
        salonId: salonA.id,
      });
    });

    it("an absent or null salonId creates an unbound key with today's audit shape", async () => {
      for (const payload of [{ name: "Free 541" }, { name: "Free 541", salonId: null }]) {
        const res = await create(own.adminToken, payload);
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.salonId).toBeNull();
        const row = await soleAuditRow(app.prisma, {
          where: { entity: "TerminalApiKey", entityId: body.id, action: "CREATE" },
        });
        expect(row.newValue).toEqual({ name: "Free 541", keyPrefix: body.keyPrefix });
      }
    });

    it("a foreign and an unknown salon answer a byte-identical 404, no key created", async () => {
      const before = await keyCount(own.tenant.id);
      const f = await create(own.adminToken, { name: "X 541", salonId: foreignSalon.id });
      const u = await create(own.adminToken, { name: "X 541", salonId: randomUUID() });
      expect(f.statusCode).toBe(404);
      expect(u.statusCode).toBe(404);
      expect(f.body).toBe(u.body);
      expect(f.body).toBe(NOT_FOUND_SALON);
      expect(await keyCount(own.tenant.id)).toBe(before);
    });

    it("an inactive salon answers 400 SALON_INACTIVE, no key created", async () => {
      const before = await keyCount(own.tenant.id);
      const res = await create(own.adminToken, { name: "X 541", salonId: salonZ.id });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toEqual({
        error: "Salon ist deaktiviert",
        code: "SALON_INACTIVE",
      });
      expect(await keyCount(own.tenant.id)).toBe(before);
    });

    it("the module gate answers first for a Grundversion tenant", async () => {
      const grundSalon = await createTestSalon(app.prisma, grund.tenant.id, { name: "G2 541" });
      const before = await keyCount(grund.tenant.id);
      const res = await create(grund.adminToken, { name: "X 541", salonId: grundSalon.id });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).code).toBe("MODULE_NOT_BOOKED");
      expect(await keyCount(grund.tenant.id)).toBe(before);
    });

    it("a missing body is a 400 Validierungsfehler", async () => {
      const res = await create(own.adminToken);
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe("Validierungsfehler");
    });
  });
});
