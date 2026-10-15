/**
 * Issue #90 — the operator dashboard: aggregated, person-free tenant metrics through
 * GET /api/v1/operator/dashboard (D-01..D-05, D-08). Tracer first; the counts, the inactivity
 * boundary, the refusals, the privacy whitelist and the query shape follow in the same file.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  seedGrundversionTenant,
  seedOperator,
  cleanupTestData,
} from "./setup";
import { signOperatorToken } from "../contexts/platform/operator-auth";

const URL = "/api/v1/operator/dashboard";
const ITEM_KEYS = [
  "activeEmployees",
  "activeSalons",
  "deactivatedAt",
  "id",
  "inactive",
  "lastActivityAt",
  "name",
  "slug",
  "totalSalons",
];

let app: FastifyInstance;
let operatorId: string;
let operatorToken: string;
let addressCounter = 0;
const tenants: Awaited<ReturnType<typeof seedGrundversionTenant>>[] = [];

/** Every request carries its own remote address so the per-route rate limits never interfere. */
function uniqueAddress(): string {
  const n = addressCounter++;
  return `10.90.${Math.floor(n / 250) % 250}.${(n % 250) + 1}`;
}

function getDashboard(token?: string) {
  return app.inject({
    method: "GET",
    url: URL,
    headers: {
      "user-agent": "vitest-operator-dashboard",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    remoteAddress: uniqueAddress(),
  });
}

function viewedRows() {
  return app.prisma.operatorAuditLog.findMany({
    where: { action: "DASHBOARD_VIEWED", operatorId },
  });
}

beforeAll(async () => {
  app = await getTestApp();
  const operator = await seedOperator(app);
  operatorId = operator.id;
  operatorToken = signOperatorToken(app, operatorId, "access", operator.tokenVersion);
});

afterAll(async () => {
  for (const t of tenants) {
    try {
      await cleanupTestData(app, t.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
  }
  await closeTestApp();
});

describe("GET /api/v1/operator/dashboard (tracer)", () => {
  it("serves the D-04 shape for an operator and logs exactly one DASHBOARD_VIEWED row", async () => {
    const t = await seedGrundversionTenant(app, "op90-tracer");
    tenants.push(t);
    const before = (await viewedRows()).length;

    const res = await getDashboard(operatorToken);
    expect(res.statusCode, res.body).toBe(200);
    const body = JSON.parse(res.body) as {
      inactivityDays: number;
      tenants: Array<Record<string, unknown>>;
    };
    expect(body.inactivityDays).toBe(30);
    const item = body.tenants.find((entry) => entry.id === t.tenant.id);
    expect(item).toBeDefined();
    expect(Object.keys(item ?? {}).sort((a, b) => a.localeCompare(b))).toEqual(ITEM_KEYS);

    expect((await viewedRows()).length).toBe(before + 1);
  });
});
