/**
 * Phase 89 plan 10 (#89, AC-89-05, AC-89-06, AC-89-07, D-05, D-06, D-07, D-08, D-16) - the route x
 * principal matrix of the operator salon surface. All five routes
 * (GET /, POST /, PATCH /:salonId, POST /:salonId/deactivate, POST /:salonId/activate) are driven
 * with every principal that must not get through:
 *
 *   1. a tenant admin token         -> 403 and a TENANT_PRINCIPAL_REFUSED row naming that tenant
 *   2. no token                     -> 401
 *   3. an unknown tenant id         -> one fixed 404 body
 *   4. another tenant's salon id    -> byte-identical to an unknown salon id, row untouched
 *   5. a deactivated tenant         -> 409 TENANT_DEACTIVATED on every mutation, GET stays 200, no
 *                                      row and no audit row is written
 *   6. DELETE on a salon            -> no such route (salons are deactivated, never deleted)
 *
 * The table is asserted to have five rows before it is iterated, and a final test proves every
 * principal kind exercised every row it applies to (non-vacuity).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  seedOperator,
  cleanupTestData,
  createTestSalon,
} from "./setup";
import { signOperatorToken } from "../contexts/platform/operator-auth";

const TENANT_BASE = "/api/v1/operator/tenants";
const ROUTE_TEMPLATE_PREFIX = "/api/v1/operator/tenants/:id/salons";

type Method = "GET" | "POST" | "PATCH";

interface MatrixRow {
  name: string;
  method: Method;
  /** The registered route template, as it appears in the refusal audit row. */
  template: string;
  /** Whether the path carries a `:salonId`. */
  withSalonId: boolean;
  /** Whether the route changes data. */
  mutation: boolean;
  url: (tenantId: string, salonId: string) => string;
  body?: () => object;
}

const OPENING_HOURS = [0, 1, 2, 3, 4, 5, 6].map((day) => ({
  day,
  open: "09:00",
  close: "18:00",
  ...(day === 6 ? { closed: true } : {}),
}));

const MATRIX: readonly MatrixRow[] = [
  {
    name: "list",
    method: "GET",
    template: ROUTE_TEMPLATE_PREFIX,
    withSalonId: false,
    mutation: false,
    url: (t) => `${TENANT_BASE}/${t}/salons`,
  },
  {
    name: "create",
    method: "POST",
    template: ROUTE_TEMPLATE_PREFIX,
    withSalonId: false,
    mutation: true,
    url: (t) => `${TENANT_BASE}/${t}/salons`,
    body: () => ({
      name: `Matrix ${randomUUID().slice(0, 8)}`,
      street: "Hauptstrasse 1",
      postalCode: "30159",
      city: "Hannover",
      openingHours: OPENING_HOURS,
      federalState: "NIEDERSACHSEN",
    }),
  },
  {
    name: "edit",
    method: "PATCH",
    template: `${ROUTE_TEMPLATE_PREFIX}/:salonId`,
    withSalonId: true,
    mutation: true,
    url: (t, s) => `${TENANT_BASE}/${t}/salons/${s}`,
    body: () => ({ name: `Umbenannt ${randomUUID().slice(0, 8)}` }),
  },
  {
    name: "deactivate",
    method: "POST",
    template: `${ROUTE_TEMPLATE_PREFIX}/:salonId/deactivate`,
    withSalonId: true,
    mutation: true,
    url: (t, s) => `${TENANT_BASE}/${t}/salons/${s}/deactivate`,
  },
  {
    name: "activate",
    method: "POST",
    template: `${ROUTE_TEMPLATE_PREFIX}/:salonId/activate`,
    withSalonId: true,
    mutation: true,
    url: (t, s) => `${TENANT_BASE}/${t}/salons/${s}/activate`,
  },
];

const TENANT_NOT_FOUND = { error: "Mandant nicht gefunden" };
const TENANT_DEACTIVATED = {
  error: "Der Mandant ist deaktiviert. Änderungen sind erst nach der Reaktivierung möglich.",
  code: "TENANT_DEACTIVATED",
};

let app: FastifyInstance;
let dataA: Awaited<ReturnType<typeof seedTestData>>;
let dataB: Awaited<ReturnType<typeof seedTestData>>;
let dataC: Awaited<ReturnType<typeof seedTestData>>;
let operatorToken: string;
let addressCounter = 0;
/** kind -> names of the matrix rows that were driven with it. */
const exercised = new Map<string, Set<string>>();
let requestsMade = 0;

/** Every request carries its own remote address so the per-route rate limits never interfere. */
function uniqueAddress(): string {
  const n = addressCounter++;
  return `10.90.${Math.floor(n / 250) % 250}.${(n % 250) + 1}`;
}

function fire(
  kind: string,
  row: MatrixRow,
  tenantId: string,
  salonId: string,
  token: string | undefined,
) {
  requestsMade += 1;
  if (!exercised.has(kind)) exercised.set(kind, new Set());
  exercised.get(kind)!.add(row.name);
  const body = row.body?.();
  return app.inject({
    method: row.method,
    url: row.url(tenantId, salonId),
    headers: {
      "user-agent": "vitest-operator-salons-boundary",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { payload: body } : {}),
    remoteAddress: uniqueAddress(),
  });
}

function operatorCall(method: "POST" | "GET", url: string, body?: object) {
  return app.inject({
    method,
    url,
    headers: {
      "user-agent": "vitest-operator-salons-boundary",
      authorization: `Bearer ${operatorToken}`,
    },
    ...(body ? { payload: body } : {}),
    remoteAddress: uniqueAddress(),
  });
}

async function salonRows(tenantId: string) {
  return app.prisma.salon.findMany({ where: { tenantId }, orderBy: { id: "asc" } });
}

async function auditCounts(tenantId: string, salonIds: string[]) {
  return {
    operatorRows: await app.prisma.operatorAuditLog.count({
      where: { subjectTenantId: tenantId },
    }),
    tenantRows: await app.prisma.auditLog.count({
      where: { entity: { in: ["Salon", "SalonCoupling"] }, entityId: { in: salonIds } },
    }),
  };
}

beforeAll(async () => {
  app = await getTestApp();
  dataA = await seedTestData(app, "os89xa");
  dataB = await seedTestData(app, "os89xb");
  dataC = await seedTestData(app, "os89xc");
  const operator = await seedOperator(app);
  operatorToken = signOperatorToken(app, operator.id, "access", operator.tokenVersion);
});

afterAll(async () => {
  // The deactivated-tenant test reactivates its tenant itself; this is the safety net.
  await app.prisma.tenant.updateMany({
    where: { id: dataC.tenant.id, deactivatedAt: { not: null } },
    data: { deactivatedAt: null, deactivatedReason: null },
  });
  await cleanupTestData(app, dataA.tenant.id);
  await cleanupTestData(app, dataB.tenant.id);
  await cleanupTestData(app, dataC.tenant.id);
  await closeTestApp();
});

describe("operator salon surface - route x principal matrix", () => {
  it("covers exactly the five salon routes", () => {
    expect(MATRIX).toHaveLength(5);
    expect(MATRIX.map((r) => `${r.method} ${r.template}`)).toEqual([
      `GET ${ROUTE_TEMPLATE_PREFIX}`,
      `POST ${ROUTE_TEMPLATE_PREFIX}`,
      `PATCH ${ROUTE_TEMPLATE_PREFIX}/:salonId`,
      `POST ${ROUTE_TEMPLATE_PREFIX}/:salonId/deactivate`,
      `POST ${ROUTE_TEMPLATE_PREFIX}/:salonId/activate`,
    ]);
  });

  it("(1) refuses a tenant admin token on every route with 403 and an audit row naming its tenant", async () => {
    expect(MATRIX).toHaveLength(5);
    const foreignSalon = (await salonRows(dataB.tenant.id))[0];
    const before = await salonRows(dataB.tenant.id);
    const t0 = new Date();

    for (const row of MATRIX) {
      const res = await fire(
        "tenant-token",
        row,
        dataB.tenant.id,
        foreignSalon.id,
        dataA.adminToken,
      );
      expect(res.statusCode, row.name).toBe(403);
      expect(JSON.parse(res.body), row.name).toEqual({ error: "Forbidden" });
    }

    // One row per distinct route path (refusals are de-duplicated per token holder, route path and
    // minute, so GET and POST on the collection share one row).
    const rows = await app.prisma.operatorAuditLog.findMany({
      where: {
        action: "TENANT_PRINCIPAL_REFUSED",
        subjectTenantId: dataA.tenant.id,
        createdAt: { gte: t0 },
      },
    });
    const distinctTemplates = [...new Set(MATRIX.map((r) => r.template))];
    expect(distinctTemplates).toHaveLength(4);
    expect(rows.map((r) => r.entityId).sort(byText)).toEqual([...distinctTemplates].sort(byText));
    for (const refusal of rows) {
      expect(refusal.operatorId).toBeNull();
      expect(JSON.stringify(refusal.newValue)).toContain(dataA.adminUser.id);
    }

    // Nothing of the other tenant moved.
    expect(await salonRows(dataB.tenant.id)).toEqual(before);
  });

  it("(2) answers 401 without a token on every route and changes nothing", async () => {
    expect(MATRIX).toHaveLength(5);
    const salon = (await salonRows(dataA.tenant.id))[0];
    const before = await salonRows(dataA.tenant.id);
    for (const row of MATRIX) {
      const res = await fire("no-token", row, dataA.tenant.id, salon.id, undefined);
      expect(res.statusCode, row.name).toBe(401);
      expect(JSON.parse(res.body), row.name).toEqual({ error: "Unauthorized" });
    }
    expect(await salonRows(dataA.tenant.id)).toEqual(before);
  });

  it("(3) answers an unknown tenant id with one fixed 404 body on every route", async () => {
    expect(MATRIX).toHaveLength(5);
    const realSalonOfB = (await salonRows(dataB.tenant.id))[0];
    const bodies = new Set<string>();
    for (const row of MATRIX) {
      for (const salonId of [randomUUID(), realSalonOfB.id]) {
        const res = await fire("unknown-tenant", row, randomUUID(), salonId, operatorToken);
        expect(res.statusCode, row.name).toBe(404);
        expect(JSON.parse(res.body), row.name).toEqual(TENANT_NOT_FOUND);
        bodies.add(res.body);
      }
    }
    expect(bodies.size).toBe(1);
  });

  it("(4) answers another tenant's salon and an unknown salon id byte-identically and leaves the row alone", async () => {
    const salonRowsOnly = MATRIX.filter((r) => r.withSalonId);
    expect(salonRowsOnly).toHaveLength(3);
    const foreign = await createTestSalon(app.prisma, dataB.tenant.id, { name: "Fremdsalon" });
    const inactiveForeign = await createTestSalon(app.prisma, dataB.tenant.id, {
      name: "Fremdsalon inaktiv",
      isActive: false,
    });
    const before = await salonRows(dataB.tenant.id);
    const auditBefore = await auditCounts(dataB.tenant.id, [foreign.id, inactiveForeign.id]);

    for (const row of salonRowsOnly) {
      for (const real of [foreign.id, inactiveForeign.id]) {
        const asForeign = await fire("foreign-salon", row, dataA.tenant.id, real, operatorToken);
        const asUnknown = await fire(
          "foreign-salon",
          row,
          dataA.tenant.id,
          randomUUID(),
          operatorToken,
        );
        expect(asForeign.statusCode, row.name).toBe(404);
        expect(asForeign.statusCode, row.name).toBe(asUnknown.statusCode);
        expect(asForeign.body, row.name).toBe(asUnknown.body);
        expect(asForeign.headers["content-type"], row.name).toBe(asUnknown.headers["content-type"]);
        expect(asForeign.headers["content-length"], row.name).toBe(
          asUnknown.headers["content-length"],
        );
        expect(JSON.parse(asForeign.body), row.name).toEqual({ error: "Salon nicht gefunden" });
      }
    }

    expect(await salonRows(dataB.tenant.id)).toEqual(before);
    expect(await auditCounts(dataB.tenant.id, [foreign.id, inactiveForeign.id])).toEqual(
      auditBefore,
    );
    expect(await auditCounts(dataA.tenant.id, [foreign.id, inactiveForeign.id])).toMatchObject({
      tenantRows: 0,
    });
  });

  it("(5) keeps a deactivated tenant readable and refuses every mutation without writing a row", async () => {
    expect(MATRIX).toHaveLength(5);
    const active = (await salonRows(dataC.tenant.id))[0];
    const inactive = await createTestSalon(app.prisma, dataC.tenant.id, {
      name: "Inaktiv im Mandanten",
      isActive: false,
    });

    const deactivate = await operatorCall("POST", `${TENANT_BASE}/${dataC.tenant.id}/deactivate`, {
      reason: "Vertrag beendet",
    });
    expect(deactivate.statusCode, deactivate.body).toBe(200);
    try {
      const salonIds = (await salonRows(dataC.tenant.id)).map((s) => s.id);
      const rowsBefore = await salonRows(dataC.tenant.id);
      const auditBefore = await auditCounts(dataC.tenant.id, salonIds);

      for (const row of MATRIX) {
        const salonId = row.name === "activate" ? inactive.id : active.id;
        const res = await fire("deactivated-tenant", row, dataC.tenant.id, salonId, operatorToken);
        if (!row.mutation) {
          expect(res.statusCode, row.name).toBe(200);
          const list = JSON.parse(res.body) as { id: string }[];
          expect(list.map((s) => s.id).sort(byText)).toEqual([...salonIds].sort(byText));
        } else {
          expect(res.statusCode, row.name).toBe(409);
          expect(JSON.parse(res.body), row.name).toEqual(TENANT_DEACTIVATED);
        }
      }

      expect(await salonRows(dataC.tenant.id)).toEqual(rowsBefore);
      expect(await auditCounts(dataC.tenant.id, salonIds)).toEqual(auditBefore);
    } finally {
      const reactivate = await operatorCall("POST", `${TENANT_BASE}/${dataC.tenant.id}/reactivate`);
      expect(reactivate.statusCode, reactivate.body).toBe(200);
    }
  });

  it("(6) has no DELETE route for a salon: the request is a 404 and the route table has none", async () => {
    const salon = (await salonRows(dataA.tenant.id))[0];
    const before = await salonRows(dataA.tenant.id);
    requestsMade += 1;
    const res = await app.inject({
      method: "DELETE",
      url: `${TENANT_BASE}/${dataA.tenant.id}/salons/${salon.id}`,
      headers: {
        "user-agent": "vitest-operator-salons-boundary",
        authorization: `Bearer ${operatorToken}`,
      },
      remoteAddress: uniqueAddress(),
    });
    expect(res.statusCode).toBe(404);
    expect(await salonRows(dataA.tenant.id)).toEqual(before);

    for (const url of [
      `${ROUTE_TEMPLATE_PREFIX}`,
      `${ROUTE_TEMPLATE_PREFIX}/:salonId`,
      `${ROUTE_TEMPLATE_PREFIX}/:salonId/deactivate`,
      `${ROUTE_TEMPLATE_PREFIX}/:salonId/activate`,
    ]) {
      expect(app.hasRoute({ method: "DELETE", url }), url).toBe(false);
    }

    // The frozen route table: the operator salon node sits at one fixed depth and lists PATCH only.
    // Issue #93 moved that depth: the `/support` and `/support-access` siblings under
    // `/operator/tenants/:id` made the tree draw the salon subtree one level further in (a `\u2502`
    // column instead of blank padding) — the same route, the same PATCH-only surface, a different indent.
    const baseline = readFileSync(
      join(__dirname, "../../baselines/route-surface.txt"),
      "utf-8",
    ).split("\n");
    const operatorSalonNodes = baseline.filter(
      (line) =>
        line.startsWith("\u2502       \u2502   \u2514\u2500\u2500 /:salonId (") ||
        line.startsWith("\u2502       \u2502   \u251C\u2500\u2500 /:salonId ("),
    );
    expect(operatorSalonNodes).toEqual([
      "\u2502       \u2502   \u2514\u2500\u2500 /:salonId (PATCH)",
    ]);
    expect(baseline.some((line) => line.includes("/deactivate (POST)"))).toBe(true);
    expect(baseline.some((line) => line.includes("/activate (POST)"))).toBe(true);
  });

  it("exercised every row with every principal it applies to", () => {
    const names = MATRIX.map((r) => r.name);
    const salonRouteNames = MATRIX.filter((r) => r.withSalonId).map((r) => r.name);
    expect([...(exercised.get("tenant-token") ?? [])].sort(byText)).toEqual(
      [...names].sort(byText),
    );
    expect([...(exercised.get("no-token") ?? [])].sort(byText)).toEqual([...names].sort(byText));
    expect([...(exercised.get("unknown-tenant") ?? [])].sort(byText)).toEqual(
      [...names].sort(byText),
    );
    expect([...(exercised.get("deactivated-tenant") ?? [])].sort(byText)).toEqual(
      [...names].sort(byText),
    );
    expect([...(exercised.get("foreign-salon") ?? [])].sort(byText)).toEqual(
      [...salonRouteNames].sort(byText),
    );
    // 5 + 5 + 10 + 12 + 5 matrix requests, plus the single DELETE probe.
    expect(requestsMade).toBe(5 + 5 + 10 + 12 + 5 + 1);
  });
});

function byText(a: string | null, b: string | null): number {
  const x = a ?? "";
  const y = b ?? "";
  return x < y ? -1 : x > y ? 1 : 0;
}
