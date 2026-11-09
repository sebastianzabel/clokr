/**
 * Issue #847 — GET /settings/smtp says whether mail can be delivered at all (`deliveryReady`), so the
 * Verwalten overview and the mail settings can warn „E-Mail aktiv, SMTP nicht eingerichtet“ without a
 * false alarm on a server that sends through its own fallback. The answer is the mailer's one rule
 * (`getSmtpConfig`: tenant SMTP first, the server's fallback second) and only a boolean leaves the
 * server — never a fallback host, user or address.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";

const KEYS = [
  "deliveryReady",
  "smtpFromEmail",
  "smtpFromName",
  "smtpHost",
  "smtpPasswordSet",
  "smtpPort",
  "smtpSecure",
  "smtpUser",
];

describe("GET /settings/smtp deliveryReady (#847)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  const auth = () => ({ authorization: `Bearer ${data.adminToken}` });

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "smtp847");
  });
  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Cleanup failed:", err);
    }
  });

  it("equals the mailer's own answer and carries no fallback value", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/settings/smtp", headers: auth() });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(KEYS);
    const mailer = await app.mailer.getSmtpConfig(data.tenant.id);
    expect(body.deliveryReady).toBe(mailer !== null);
    // tenant fields are the tenant's own (null without a tenant SMTP), never the server fallback
    const cfg = await app.prisma.tenantConfig.findUnique({ where: { tenantId: data.tenant.id } });
    expect(body.smtpHost).toBe(cfg?.smtpHost ?? null);
  });

  it("is true once the tenant has a complete SMTP of its own", async () => {
    const put = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/smtp",
      headers: auth(),
      payload: {
        smtpHost: "smtp.example.invalid",
        smtpPort: 587,
        smtpUser: "mailer",
        smtpPassword: "secret-847",
        smtpFromEmail: "noreply@example.invalid",
        smtpFromName: "Clokr",
        smtpSecure: false,
      },
    });
    expect(put.statusCode, put.body).toBe(200);
    const res = await app.inject({ method: "GET", url: "/api/v1/settings/smtp", headers: auth() });
    expect(res.json().deliveryReady).toBe(true);
    expect(JSON.stringify(res.json())).not.toContain("secret-847");
  });
});
