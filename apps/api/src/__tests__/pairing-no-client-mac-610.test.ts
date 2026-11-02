/**
 * Issue #610 (Phase 610-02, Task 2) - AC-3 "kein fremdes Geraet": no route of the pairing flow takes a
 * MAC or an address from the client. The only MAC a confirm can couple is the one the presence-source
 * key stored with the code. A forwarded link couples that stored MAC to the confirmer (a documented
 * residual, D-09), never a MAC the confirmer names.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { cleanupTestData, closeTestApp, getTestApp, seedTestData } from "./setup";
import {
  confirmCode,
  createPeerEmployee,
  createPresenceSourceWithKey,
  issueCode,
  previewCode,
  randomTestMac,
} from "./presence-pairing-fixtures-610";

const ROUTE_FILE = join(__dirname, "../contexts/time-tracking/api/employee-wifi.ts");
const SERVICE_FILE = join(__dirname, "../contexts/time-tracking/presence-pairing.ts");

/** The source text of one route registration, up to the next `app.` registration (or the file end). */
function routeRegion(source: string, registration: string): string {
  const start = source.indexOf(registration);
  if (start === -1) return "";
  const next = source.indexOf("\n  app.", start + registration.length);
  return source.slice(start, next === -1 ? source.length : next);
}

/** The text of `const <name> = ...;` up to the first `;` at depth zero. */
function schemaDeclaration(source: string, name: string): string {
  const start = source.indexOf(`const ${name} =`);
  if (start === -1) return "";
  const end = source.indexOf(";", start);
  return source.slice(start, end);
}

/** The body of `interface <name> { ... }` with balanced braces. */
function interfaceBody(source: string, name: string): string {
  const match = new RegExp(`interface ${name}\\s*\\{`).exec(source);
  if (!match) return "";
  let depth = 0;
  for (let i = match.index + match[0].length - 1; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(match.index, i + 1);
    }
  }
  return "";
}

describe("pairing never takes a MAC or an address from the client (AC-3, Issue #610)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let rawKey: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "nm610");
    ({ rawKey } = await createPresenceSourceWithKey(app, data.tenant.id));
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("pairing-no-client-mac-610 cleanup failed:", err);
    }
    await closeTestApp();
  });

  async function codeFor(mac: string): Promise<string> {
    const issued = await issueCode(app, rawKey, mac, "Handy");
    expect(issued.statusCode).toBe(201);
    return JSON.parse(issued.body).code as string;
  }

  it("(a) a forwarded link couples the STORED MAC to whoever confirms it (documented residual, D-09)", async () => {
    const scanner = await createPeerEmployee(app, data.tenant.id, "nm-scanner");
    const confirmer = await createPeerEmployee(app, data.tenant.id, "nm-confirmer");
    const mac = randomTestMac();
    const code = await codeFor(mac); // the link was meant for the scanner's phone

    const res = await confirmCode(app, confirmer.token, code);
    expect(res.statusCode).toBe(201);
    const device = await app.prisma.presenceDevice.findUniqueOrThrow({
      where: { tenantId_mac: { tenantId: data.tenant.id, mac } },
    });
    expect(device.mac).toBe(mac);
    expect(device.employeeId).toBe(confirmer.employeeId);
    expect(
      await app.prisma.presenceDevice.count({
        where: { tenantId: data.tenant.id, employeeId: scanner.employeeId },
      }),
    ).toBe(0);
  });

  it.each(["mac", "ip", "macAddress", "hostname"])(
    "(b) preview and confirm refuse the body key %s with 400 and change nothing",
    async (key) => {
      const peer = await createPeerEmployee(app, data.tenant.id, `nm-key-${key}`);
      const mac = randomTestMac();
      const code = await codeFor(mac);
      const extra = { [key]: "02:00:00:00:00:99" };

      const preview = await previewCode(app, peer.token, code, { extraBody: extra });
      expect(preview.statusCode).toBe(400);
      const confirm = await confirmCode(app, peer.token, code, { extraBody: extra });
      expect(confirm.statusCode).toBe(400);

      expect(
        await app.prisma.presenceDevice.count({
          where: { tenantId: data.tenant.id, employeeId: peer.employeeId },
        }),
      ).toBe(0);
      const row = await app.prisma.presencePairingCode.findFirstOrThrow({
        where: { tenantId: data.tenant.id, mac },
      });
      expect(row.consumedAt).toBeNull();
    },
  );

  it.each(["?mac=02:00:00:00:00:99", "?ip=10.0.0.9", "?anything=1"])(
    "(b) preview and confirm refuse the query %s with 400 and change nothing",
    async (query) => {
      const peer = await createPeerEmployee(app, data.tenant.id, "nm-query");
      const mac = randomTestMac();
      const code = await codeFor(mac);

      expect((await previewCode(app, peer.token, code, { query })).statusCode).toBe(400);
      expect((await confirmCode(app, peer.token, code, { query })).statusCode).toBe(400);
      expect(
        await app.prisma.presenceDevice.count({
          where: { tenantId: data.tenant.id, employeeId: peer.employeeId },
        }),
      ).toBe(0);
      const row = await app.prisma.presencePairingCode.findFirstOrThrow({
        where: { tenantId: data.tenant.id, mac },
      });
      expect(row.consumedAt).toBeNull();
    },
  );

  describe("(c) source scan of the two pairing routes", () => {
    const source = readFileSync(ROUTE_FILE, "utf8");
    const regions = {
      preview: routeRegion(source, 'app.post("/me/wifi/pairing/preview"'),
      confirm: routeRegion(source, 'app.post("/me/wifi/pairing",'),
    };

    it("walks two non-empty route regions", () => {
      expect(source.length).toBeGreaterThan(0);
      expect(regions.preview.length).toBeGreaterThan(100);
      expect(regions.confirm.length).toBeGreaterThan(100);
      expect(regions.preview).not.toBe(regions.confirm);
    });

    it.each(["preview", "confirm"] as const)(
      "the %s route reads nothing from the request but the strict query and body",
      (which) => {
        // The two allowed reads and the audit request context (ip + headers go to the audit row only).
        const stripped = regions[which]
          .replace(/pairingQuerySchema\.parse\(req\.query\)/g, "")
          .replace(/pairing(Preview|Confirm)BodySchema\.parse\(req\.body\)/g, "")
          .replace(
            /request:\s*\{\s*ip:\s*req\.ip,\s*headers:\s*req\.headers as Record<string, string>\s*\}/g,
            "",
          );
        expect(stripped).not.toMatch(/req\.(ip|headers|query|body|socket|raw|hostname)/);
        expect(stripped).not.toMatch(/\b(mac|macAddress|hostname)\b/i);
      },
    );

    it("the strict body schemas hold only code (and consent for the confirm)", () => {
      const preview = schemaDeclaration(source, "pairingPreviewBodySchema");
      const confirm = schemaDeclaration(source, "pairingConfirmBodySchema");
      const query = schemaDeclaration(source, "pairingQuerySchema");
      for (const decl of [preview, confirm, query]) {
        expect(decl.length).toBeGreaterThan(0);
        expect(decl).toContain(".strict()");
      }
      const keysOf = (decl: string) =>
        [...decl.matchAll(/(\w+):\s*z\./g)].map((m) => m[1]).sort((a, b) => a.localeCompare(b));
      expect(keysOf(preview)).toEqual(["code"]);
      expect(keysOf(confirm)).toEqual(["code", "consent"]);
      expect(keysOf(query)).toEqual([]);
    });
  });

  describe("(d) the pairing service exports no function that takes a MAC from a caller but the issuer", () => {
    const source = readFileSync(SERVICE_FILE, "utf8");

    it("only issuePairingCode has a parameter type with a mac key", () => {
      const exported = [...source.matchAll(/export (?:async )?function (\w+)\(([\s\S]*?)\)\s*:/g)];
      expect(exported.length).toBeGreaterThanOrEqual(5);
      const names = exported.map((m) => m[1]);
      expect(names).toEqual(
        expect.arrayContaining([
          "issuePairingCode",
          "lockPresenceOwner",
          "previewPairing",
          "confirmPairing",
        ]),
      );

      const withMacParameter: string[] = [];
      for (const match of exported) {
        const [, name, params] = match;
        // inline type literals in the signature, plus every interface the signature names
        let text = params;
        for (const typeName of params.match(/\b[A-Z]\w+/g) ?? []) {
          text += interfaceBody(source, typeName);
        }
        if (/\bmac\s*\??\s*:/.test(text)) withMacParameter.push(name);
      }
      expect(withMacParameter).toEqual(["issuePairingCode"]);
    });
  });
});
