/**
 * Issue #610 (Phase 610-01) - the pairing-code contract.
 *
 * Pins: the 5-minute lifetime, single use, ONE uniform refusal for every invalid state, supersede,
 * hostname hygiene, strict bodies and no query string, the byte-identical presence key refusals, the
 * 409 for a taken MAC, and - the orchestrator amendment of 02.11.2026 - that the raw code never
 * appears in an API request log line (both pairing routes take it only in the JSON body).
 */
import { createHash, randomBytes } from "crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { cleanupTestData, closeTestApp, getTestApp, seedTestData } from "./setup";
import {
  PAIRING_CODE_INVALID_ERROR,
  PAIRING_CODE_TTL_MS,
  hashPairingCode,
} from "../contexts/time-tracking/pairing-code";
import {
  confirmCode,
  createPresenceSourceWithKey,
  issueCode,
  previewCode,
  randomTestMac,
} from "./presence-pairing-fixtures-610";

type Seed = Awaited<ReturnType<typeof seedTestData>>;

const PREVIEW_URL = "/api/v1/employees/me/wifi/pairing/preview";
const CONFIRM_URL = "/api/v1/employees/me/wifi/pairing";

/** A well-formed code that no row holds. */
function unknownCode(): string {
  return randomBytes(32).toString("hex");
}

describe("WLAN pairing code contract (Issue #610)", () => {
  let app: FastifyInstance;
  let data: Seed;
  let other: Seed;
  let rawKey: string;
  let sourceId: string;
  let otherKey: string;
  const apiKeyIds: string[] = [];

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "pc610");
    other = await seedTestData(app, "pc610o");
    ({ rawKey, sourceId } = await createPresenceSourceWithKey(app, data.tenant.id));
    ({ rawKey: otherKey } = await createPresenceSourceWithKey(app, other.tenant.id));
  });

  afterEach(async () => {
    // Every case starts from "no device, nobody opted in"; codes are left to the tenant cleanup.
    for (const seed of [data, other]) {
      await app.prisma.presenceDevice.deleteMany({ where: { tenantId: seed.tenant.id } });
    }
    await app.prisma.employee.update({
      where: { id: data.employee.id },
      data: { wifiPresenceEnabled: false, wifiOptInAt: null },
    });
  });

  afterAll(async () => {
    try {
      await app.prisma.apiKey.deleteMany({ where: { id: { in: apiKeyIds } } });
      await app.prisma.auditLog.deleteMany({
        where: {
          OR: [
            { entity: { in: ["PresenceDevice", "Employee"] }, entityId: data.employee.id },
            { entity: "PresenceDevice", entityId: data.adminEmployee.id },
            { entity: "Employee", entityId: data.adminEmployee.id },
            { action: "WIFI_UNKNOWN_MAC", newValue: { path: ["adapter"], equals: "contract610" } },
          ],
        },
      });
      await cleanupTestData(app, data.tenant.id);
      await cleanupTestData(app, other.tenant.id);
    } catch (err) {
      console.error("presence-pairing-contract-610 cleanup failed:", err);
    }
    await closeTestApp();
  });

  /** Issues a code for a fresh MAC through the given key and returns both. */
  async function freshCode(key = rawKey, hostname: string | null = "Test-iPhone") {
    const mac = randomTestMac();
    const res = await issueCode(app, key, mac, hostname);
    expect(res.statusCode).toBe(201);
    return { mac, code: JSON.parse(res.body).code as string };
  }

  // ── lifetime and single use ───────────────────────────────────────────────

  describe("lifetime and single use", () => {
    it("a code lives at most five minutes and the 201 expiresAt is the stored value", async () => {
      const mac = randomTestMac();
      const res = await issueCode(app, rawKey, mac, "iPhone");
      const body = JSON.parse(res.body);
      const row = await app.prisma.presencePairingCode.findFirstOrThrow({
        where: { tenantId: data.tenant.id, mac },
      });
      const lifetime = row.expiresAt.getTime() - row.createdAt.getTime();
      expect(lifetime).toBeGreaterThan(0);
      expect(lifetime).toBeLessThanOrEqual(PAIRING_CODE_TTL_MS);
      expect(PAIRING_CODE_TTL_MS).toBe(300_000);
      expect(body.expiresAt).toBe(row.expiresAt.toISOString());
      expect(row.codeHash).toBe(hashPairingCode(body.code));
    });

    it("confirming the same code twice: first 201, second the uniform 404", async () => {
      const { code } = await freshCode();
      const first = await confirmCode(app, data.empToken, code);
      expect(first.statusCode).toBe(201);
      const second = await confirmCode(app, data.empToken, code);
      expect(second.statusCode).toBe(404);
      expect(JSON.parse(second.body)).toEqual(PAIRING_CODE_INVALID_ERROR);
    });
  });

  // ── one uniform refusal ───────────────────────────────────────────────────

  describe("uniform refusal", () => {
    /** Prepares one invalid-state code per case; the value is what the caller submits. */
    async function invalidCodes(): Promise<Record<string, string>> {
      const out: Record<string, string> = {};

      const { code: valid } = await freshCode();
      out["malformed: 63 hex characters"] = valid.slice(0, 63);
      out["malformed: upper-case hex"] = valid.toUpperCase();
      out["malformed: 64 non-hex characters"] = "z".repeat(64);
      out["malformed: empty"] = "";
      out["unknown well-formed code"] = unknownCode();

      const expired = await freshCode();
      await app.prisma.presencePairingCode.updateMany({
        where: { tenantId: data.tenant.id, codeHash: hashPairingCode(expired.code) },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });
      out["expired"] = expired.code;

      const consumed = await freshCode();
      await app.prisma.presencePairingCode.updateMany({
        where: { tenantId: data.tenant.id, codeHash: hashPairingCode(consumed.code) },
        data: { consumedAt: new Date(), consumedByUserId: data.empUser.id },
      });
      out["consumed"] = consumed.code;

      out["code of another tenant"] = (await freshCode(otherKey)).code;

      for (const [label, patch] of [
        ["source inactive", { isActive: false }],
        ["source revoked", { revokedAt: new Date() }],
        ["source soft-deleted", { deletedAt: new Date() }],
      ] as const) {
        const own = await createPresenceSourceWithKey(app, data.tenant.id);
        const issued = await freshCode(own.rawKey);
        await app.prisma.presenceSource.update({ where: { id: own.sourceId }, data: patch });
        out[label] = issued.code;
      }
      return out;
    }

    for (const [url, call] of [
      [PREVIEW_URL, (code: string) => previewCode(app, data.empToken, code)],
      [CONFIRM_URL, (code: string) => confirmCode(app, data.empToken, code)],
    ] as const) {
      it(`${url}: every invalid state answers the same status and the same body bytes`, async () => {
        const cases = await invalidCodes();
        const reference = await call(unknownCode());
        expect(reference.statusCode).toBe(404);
        expect(JSON.parse(reference.body)).toEqual(PAIRING_CODE_INVALID_ERROR);
        expect(Object.keys(cases).length).toBeGreaterThanOrEqual(10);

        for (const [label, code] of Object.entries(cases)) {
          const res = await call(code);
          expect(res.statusCode, label).toBe(404);
          expect(res.body, label).toBe(reference.body);
        }
        // a refused confirm creates nothing
        expect(await app.prisma.presenceDevice.count({ where: { tenantId: data.tenant.id } })).toBe(
          0,
        );
      });
    }
  });

  // ── supersede ─────────────────────────────────────────────────────────────

  describe("supersede", () => {
    it("a newer code for the same tenant and MAC deletes the older unconsumed one", async () => {
      const mac = randomTestMac();
      const first = JSON.parse((await issueCode(app, rawKey, mac, "A")).body).code as string;
      const second = JSON.parse((await issueCode(app, rawKey, mac, "B")).body).code as string;

      const stale = await previewCode(app, data.empToken, first);
      expect(stale.statusCode).toBe(404);
      const live = await previewCode(app, data.empToken, second);
      expect(live.statusCode).toBe(200);
      expect(JSON.parse(live.body).deviceLabel).toBe("B");
      expect(
        await app.prisma.presencePairingCode.count({ where: { tenantId: data.tenant.id, mac } }),
      ).toBe(1);
    });

    it("a consumed code of that MAC is not deleted by a later issue", async () => {
      const mac = randomTestMac();
      const first = JSON.parse((await issueCode(app, rawKey, mac, "A")).body).code as string;
      expect((await confirmCode(app, data.empToken, first)).statusCode).toBe(201);
      await issueCode(app, rawKey, mac, "B");

      const rows = await app.prisma.presencePairingCode.findMany({
        where: { tenantId: data.tenant.id, mac },
      });
      expect(rows).toHaveLength(2);
      expect(rows.filter((r) => r.consumedAt !== null)).toHaveLength(1);
    });
  });

  // ── hostname hygiene ──────────────────────────────────────────────────────

  describe("hostname", () => {
    async function storedHostname(hostname: string | null): Promise<string | null> {
      const mac = randomTestMac();
      const res = await issueCode(app, rawKey, mac, hostname);
      expect(res.statusCode).toBe(201);
      const row = await app.prisma.presencePairingCode.findFirstOrThrow({
        where: { tenantId: data.tenant.id, mac },
      });
      return row.hostname;
    }

    it("control and format characters are stripped, whitespace collapsed", async () => {
      const bel = String.fromCharCode(7);
      const rlo = String.fromCharCode(0x202e);
      const stored = await storedHostname(`  iPhone${bel} von${rlo} Test  `);
      expect(stored).toBe("iPhone von Test");
      expect(stored).not.toContain(bel);
      expect(stored).not.toContain(rlo);
    });

    it("an all-control hostname is stored as null", async () => {
      const raw = [7, 0x202e, 0x200b, 10].map((c) => String.fromCharCode(c)).join("");
      expect(await storedHostname(raw)).toBeNull();
    });

    it("at most 64 code points are kept", async () => {
      const stored = await storedHostname("x".repeat(200));
      expect(Array.from(stored ?? "")).toHaveLength(64);
    });

    it("a 300-character hostname is refused with 400", async () => {
      const res = await issueCode(app, rawKey, randomTestMac(), "x".repeat(300));
      expect(res.statusCode).toBe(400);
    });
  });

  // ── issuer: key refusals, MAC, strict body ────────────────────────────────

  describe("issuer", () => {
    it("no Authorization header: 401 Presence-Key erforderlich", async () => {
      const res = await issueCode(app, null, randomTestMac());
      expect(res.statusCode).toBe(401);
      expect(res.body).toBe(JSON.stringify({ error: "Presence-Key erforderlich" }));
    });

    it("an unknown key and a revoked source key: the same 401", async () => {
      const unknown = await issueCode(app, "clk_p610_unknown", randomTestMac());
      expect(unknown.statusCode).toBe(401);
      expect(unknown.body).toBe(
        JSON.stringify({ error: "Ungültiger oder widerrufener Presence-Key" }),
      );
      const revoked = await createPresenceSourceWithKey(app, data.tenant.id, {
        revokedAt: new Date(),
      });
      const res = await issueCode(app, revoked.rawKey, randomTestMac());
      expect(res.statusCode).toBe(401);
      expect(res.body).toBe(unknown.body);
    });

    it("a deactivated tenant's key: 403 with the tenant-deactivated body", async () => {
      const dead = await createPresenceSourceWithKey(app, other.tenant.id);
      await app.prisma.tenant.update({
        where: { id: other.tenant.id },
        data: { deactivatedAt: new Date() },
      });
      app.invalidateTenantState(other.tenant.id);
      try {
        const res = await issueCode(app, dead.rawKey, randomTestMac());
        expect(res.statusCode).toBe(403);
        expect(res.body).toBe(JSON.stringify(app.tenantDeactivatedError));
      } finally {
        await app.prisma.tenant.update({
          where: { id: other.tenant.id },
          data: { deactivatedAt: null },
        });
        app.invalidateTenantState(other.tenant.id);
      }
    });

    it("an invalid MAC: 400 with a fixed text that does not echo the input", async () => {
      const res = await issueCode(app, rawKey, "not-a-mac-ZZ99");
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toEqual({ error: "Ungültige MAC-Adresse" });
      expect(res.body).not.toContain("ZZ99");
    });

    it("an unknown body key is a 400 and issues nothing", async () => {
      const mac = randomTestMac();
      const res = await issueCode(app, rawKey, mac, "iPhone", { employeeId: data.employee.id });
      expect(res.statusCode).toBe(400);
      expect(
        await app.prisma.presencePairingCode.count({ where: { tenantId: data.tenant.id, mac } }),
      ).toBe(0);
    });

    it("issuing does not touch the source's lastUsedAt (the webhook's health signal)", async () => {
      const before = await app.prisma.presenceSource.findUniqueOrThrow({
        where: { id: sourceId },
        select: { lastUsedAt: true },
      });
      await freshCode();
      const after = await app.prisma.presenceSource.findUniqueOrThrow({
        where: { id: sourceId },
        select: { lastUsedAt: true },
      });
      expect(after.lastUsedAt).toEqual(before.lastUsedAt);
    });
  });

  // ── preview / confirm: no client MAC, no query, consent ───────────────────

  describe("preview and confirm accept no MAC, IP or query string", () => {
    for (const key of ["mac", "ip", "employeeId"] as const) {
      it(`an extra body key '${key}' is a 400 on both routes`, async () => {
        const { code } = await freshCode();
        const extra = { [key]: "02:00:00:00:00:01" };
        expect((await previewCode(app, data.empToken, code, { extraBody: extra })).statusCode).toBe(
          400,
        );
        expect((await confirmCode(app, data.empToken, code, { extraBody: extra })).statusCode).toBe(
          400,
        );
        const row = await app.prisma.presencePairingCode.findFirstOrThrow({
          where: { tenantId: data.tenant.id, codeHash: hashPairingCode(code) },
        });
        expect(row.consumedAt).toBeNull();
        expect(await app.prisma.presenceDevice.count({ where: { tenantId: data.tenant.id } })).toBe(
          0,
        );
      });
    }

    it("any query parameter is a 400 even when the body is valid; the code stays usable", async () => {
      const { code } = await freshCode();
      for (const query of [`?code=${code}`, "?mac=02:00:00:00:00:01", "?x=1"]) {
        expect((await previewCode(app, data.empToken, code, { query })).statusCode, query).toBe(
          400,
        );
        expect((await confirmCode(app, data.empToken, code, { query })).statusCode, query).toBe(
          400,
        );
      }
      const row = await app.prisma.presencePairingCode.findFirstOrThrow({
        where: { tenantId: data.tenant.id, codeHash: hashPairingCode(code) },
      });
      expect(row.consumedAt).toBeNull();
      expect((await confirmCode(app, data.empToken, code)).statusCode).toBe(201);
    });

    it("confirm without consent or with consent false is a 400 and consumes nothing", async () => {
      const { code } = await freshCode();
      expect((await confirmCode(app, data.empToken, code, { consent: null })).statusCode).toBe(400);
      expect((await confirmCode(app, data.empToken, code, { consent: false })).statusCode).toBe(
        400,
      );
      const row = await app.prisma.presencePairingCode.findFirstOrThrow({
        where: { tenantId: data.tenant.id, codeHash: hashPairingCode(code) },
      });
      expect(row.consumedAt).toBeNull();
      expect(await app.prisma.presenceDevice.count({ where: { tenantId: data.tenant.id } })).toBe(
        0,
      );
      const employee = await app.prisma.employee.findUniqueOrThrow({
        where: { id: data.employee.id },
        select: { wifiPresenceEnabled: true },
      });
      expect(employee.wifiPresenceEnabled).toBe(false);
    });
  });

  // ── authentication of the two person routes ───────────────────────────────

  describe("authentication", () => {
    it("an API key (no employeeId) and no token: 401", async () => {
      const raw = `clk_${randomBytes(24).toString("hex")}`;
      const key = await app.prisma.apiKey.create({
        data: {
          tenantId: data.tenant.id,
          name: `pc610-${Date.now().toString(36)}`,
          keyHash: createHash("sha256").update(raw).digest("hex"),
          keyPrefix: raw.slice(0, 8),
          scopes: ["admin"],
          createdBy: data.adminUser.id,
        },
      });
      apiKeyIds.push(key.id);
      const { code } = await freshCode();

      for (const url of [PREVIEW_URL, CONFIRM_URL]) {
        const asKey = await app.inject({
          method: "POST",
          url,
          headers: { authorization: `Bearer ${raw}` },
          payload: { code, consent: true },
        });
        expect(asKey.statusCode, url).toBe(401);
        expect(JSON.parse(asKey.body).error).toBe("Nicht authentifiziert");
        const anonymous = await app.inject({ method: "POST", url, payload: { code } });
        expect(anonymous.statusCode, url).toBe(401);
      }
    });
  });

  // ── a MAC that already belongs to someone else ────────────────────────────

  describe("taken device", () => {
    it("409 PRESENCE_DEVICE_TAKEN: no name or id of the owner, code unconsumed, owner untouched", async () => {
      const mac = randomTestMac();
      const manual = await app.inject({
        method: "POST",
        url: "/api/v1/employees/me/wifi/devices",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { mac, label: "Admin-Handy" },
      });
      expect(manual.statusCode).toBe(201);
      const ownerDeviceId = JSON.parse(manual.body).id as string;

      const code = JSON.parse((await issueCode(app, rawKey, mac, "iPhone")).body).code as string;
      const res = await confirmCode(app, data.empToken, code);
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).code).toBe("PRESENCE_DEVICE_TAKEN");
      for (const secret of [
        data.adminEmployee.id,
        data.adminUser.id,
        data.adminEmployee.firstName,
        data.adminEmployee.lastName,
        "Admin-Handy",
      ]) {
        expect(res.body).not.toContain(secret);
      }

      const row = await app.prisma.presencePairingCode.findFirstOrThrow({
        where: { tenantId: data.tenant.id, codeHash: hashPairingCode(code) },
      });
      expect(row.consumedAt).toBeNull();
      const owner = await app.prisma.presenceDevice.findUniqueOrThrow({
        where: { id: ownerDeviceId },
      });
      expect(owner.employeeId).toBe(data.adminEmployee.id);
      expect(owner.pairedVia).toBe("MANUAL");
      const employee = await app.prisma.employee.findUniqueOrThrow({
        where: { id: data.employee.id },
        select: { wifiPresenceEnabled: true },
      });
      expect(employee.wifiPresenceEnabled).toBe(false);
    });
  });

  // ── the webhook still answers byte-identically ────────────────────────────

  describe("presence webhook key refusals (byte-identical after the check moved)", () => {
    const event = (mac: string) => ({
      mac,
      eventType: "connected",
      timestamp: new Date().toISOString(),
      adapter: "contract610",
    });

    it("401 / 401 / 403 / 200 with the literal bodies", async () => {
      const none = await app.inject({
        method: "POST",
        url: "/api/v1/presence/events",
        payload: event(randomTestMac()),
      });
      expect(none.statusCode).toBe(401);
      expect(none.body).toBe('{"error":"Presence-Key erforderlich"}');

      const bad = await app.inject({
        method: "POST",
        url: "/api/v1/presence/events",
        headers: { authorization: "Bearer clk_p610_unknown" },
        payload: event(randomTestMac()),
      });
      expect(bad.statusCode).toBe(401);
      expect(bad.body).toBe('{"error":"Ungültiger oder widerrufener Presence-Key"}');

      const revoked = await createPresenceSourceWithKey(app, data.tenant.id, {
        revokedAt: new Date(),
      });
      const revokedRes = await app.inject({
        method: "POST",
        url: "/api/v1/presence/events",
        headers: { authorization: `Bearer ${revoked.rawKey}` },
        payload: event(randomTestMac()),
      });
      expect(revokedRes.statusCode).toBe(401);
      expect(revokedRes.body).toBe(bad.body);

      const dead = await createPresenceSourceWithKey(app, other.tenant.id);
      await app.prisma.tenant.update({
        where: { id: other.tenant.id },
        data: { deactivatedAt: new Date() },
      });
      app.invalidateTenantState(other.tenant.id);
      try {
        const deadRes = await app.inject({
          method: "POST",
          url: "/api/v1/presence/events",
          headers: { authorization: `Bearer ${dead.rawKey}` },
          payload: event(randomTestMac()),
        });
        expect(deadRes.statusCode).toBe(403);
        expect(deadRes.body).toBe(JSON.stringify(app.tenantDeactivatedError));
      } finally {
        await app.prisma.tenant.update({
          where: { id: other.tenant.id },
          data: { deactivatedAt: null },
        });
        app.invalidateTenantState(other.tenant.id);
      }

      const ok = await app.inject({
        method: "POST",
        url: "/api/v1/presence/events",
        headers: { authorization: `Bearer ${rawKey}` },
        payload: event(randomTestMac()),
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.body).toBe('{"ok":true}');
    });
  });
});

// ── the raw code never reaches an API request log line ──────────────────────

interface LogRecord {
  level: string;
  args: unknown[];
}

const SKIPPED_KEYS = new Set([
  "socket",
  "connection",
  "server",
  "parser",
  "client",
  "_readableState",
  "_events",
  "log",
  "prisma",
]);

/** Every string reachable from a logged argument, depth-limited and cycle-safe. */
function collectStrings(value: unknown, out: string[], depth = 0, seen = new WeakSet<object>()) {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (value === null || typeof value !== "object" || depth > 5 || seen.has(value)) return;
  seen.add(value);
  const holder = value as Record<string, unknown>;
  // `url` is a prototype getter on the Fastify request, so it is read explicitly
  for (const key of ["url", "originalUrl", "method"]) {
    const v = holder[key];
    if (typeof v === "string") out.push(v);
  }
  for (const key of Object.keys(holder)) {
    if (SKIPPED_KEYS.has(key)) continue;
    let child: unknown;
    try {
      child = holder[key];
    } catch {
      continue;
    }
    if (typeof child !== "function") collectStrings(child, out, depth + 1, seen);
  }
}

describe("request log capture - the raw pairing code never reaches an API request log line", () => {
  let app: FastifyInstance;
  let data: Seed;
  let rawKey: string;
  const records: LogRecord[] = [];
  const LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;

  type Instrumentable = {
    child: (...a: unknown[]) => Instrumentable;
  } & Record<string, unknown>;

  function instrument(logger: Instrumentable): Instrumentable {
    for (const level of LEVELS) {
      const original = logger[level] as (...a: unknown[]) => unknown;
      if (typeof original !== "function") continue;
      logger[level] = function (this: unknown, ...args: unknown[]) {
        records.push({ level, args });
        return original.apply(this, args);
      };
    }
    const originalChild = logger.child;
    logger.child = (...a: unknown[]) => instrument(originalChild.apply(logger, a));
    return logger;
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "pc610l");
    ({ rawKey } = await createPresenceSourceWithKey(app, data.tenant.id));
    const log = app.log as unknown as Instrumentable;
    const originalChild = log.child;
    vi.spyOn(log, "child").mockImplementation(function (this: unknown, ...a: unknown[]) {
      return instrument(originalChild.apply(log, a));
    });
  });

  afterEach(async () => {
    await app.prisma.presenceDevice.deleteMany({ where: { tenantId: data.tenant.id } });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    try {
      await app.prisma.auditLog.deleteMany({
        where: { entity: { in: ["PresenceDevice", "Employee"] }, entityId: data.employee.id },
      });
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("presence-pairing-contract-610 (log) cleanup failed:", err);
    }
    await closeTestApp();
  });

  /**
   * What the logger would write for an argument: pino runs the logger's own serializers over the
   * merging object (`req` becomes method, url, host and peer - never the body). Walking the raw
   * Fastify request instead would report the body, which is not what any log line contains.
   */
  function serialized(arg: unknown): unknown {
    if (arg === null || typeof arg !== "object") return arg;
    const serializers = (app.log as unknown as Record<symbol, unknown>)[
      Symbol.for("pino.serializers")
    ] as Record<string, (v: unknown) => unknown>;
    const copy: Record<string, unknown> = { ...(arg as Record<string, unknown>) };
    for (const key of Object.keys(copy)) {
      if (typeof serializers[key] === "function") copy[key] = serializers[key](copy[key]);
    }
    return copy;
  }

  function strings(): string {
    const out: string[] = [];
    for (const r of records) for (const a of r.args) collectStrings(serialized(a), out);
    return out.join("\n");
  }

  function completedUrls(): string[] {
    const urls: string[] = [];
    for (const r of records) {
      for (const a of r.args) {
        const url = (a as { http?: { url?: unknown } } | null)?.http?.url;
        if (typeof url === "string") urls.push(url);
      }
    }
    return urls;
  }

  async function issue(): Promise<string> {
    const res = await issueCode(app, rawKey, randomTestMac(), "Log-iPhone");
    expect(res.statusCode).toBe(201);
    return JSON.parse(res.body).code as string;
  }

  it("the capture sees the logger's own serializers (a guard against a vacuous capture)", () => {
    const serializers = (app.log as unknown as Record<symbol, unknown>)[
      Symbol.for("pino.serializers")
    ] as Record<string, unknown>;
    expect(typeof serializers.req).toBe("function");
  });

  it("a successful preview logs the bare path and neither the code nor its hash", async () => {
    const code = await issue();
    records.length = 0;
    const res = await previewCode(app, data.empToken, code);
    expect(res.statusCode).toBe(200);

    expect(records.length).toBeGreaterThan(0);
    expect(completedUrls()).toContain(PREVIEW_URL);
    for (const url of completedUrls()) expect(url).not.toContain("?");
    const logged = strings();
    expect(logged).toContain(PREVIEW_URL);
    expect(logged).not.toContain(code);
    expect(logged).not.toContain(hashPairingCode(code));
  });

  it("a successful confirm logs the bare path and neither the code nor its hash", async () => {
    const code = await issue();
    records.length = 0;
    const res = await confirmCode(app, data.empToken, code);
    expect(res.statusCode).toBe(201);

    expect(records.length).toBeGreaterThan(0);
    expect(completedUrls()).toContain(CONFIRM_URL);
    for (const url of completedUrls()) expect(url).not.toContain("?");
    const logged = strings();
    expect(logged).toContain(CONFIRM_URL);
    expect(logged).not.toContain(code);
    expect(logged).not.toContain(hashPairingCode(code));
  });

  it("positive control: a code appended to a URL IS captured (the capture would see it)", async () => {
    const code = unknownCode();
    records.length = 0;
    await app.inject({
      method: "GET",
      url: `/api/v1/employees/me/wifi?code=${code}`,
      headers: { authorization: `Bearer ${data.empToken}` },
    });
    expect(records.length).toBeGreaterThan(0);
    expect(strings()).toContain(code);
  });
});
