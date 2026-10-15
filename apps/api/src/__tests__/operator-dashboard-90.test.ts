/**
 * Issue #90 — the operator dashboard: aggregated, person-free tenant metrics through
 * GET /api/v1/operator/dashboard (D-01..D-05, D-08). Tracer first; the counts, the inactivity
 * boundary, the refusals, the privacy whitelist and the query shape follow in the same file.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  seedGrundversionTenant,
  seedOperator,
  createTestSalon,
  cleanupTestData,
} from "./setup";
import { signOperatorToken } from "../contexts/platform/operator-auth";
import { OPERATOR_AUDIT_RETENTION_CLASS } from "../contexts/platform/operator-audit";
import {
  OPERATOR_INACTIVITY_DAYS,
  operatorTenantMetrics,
} from "../contexts/platform/facade/operator-metrics";
import { buildOperatorDashboardBody } from "../contexts/platform/api/operator/dashboard";

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

type Item = {
  id: string;
  name: string;
  slug: string;
  deactivatedAt: string | null;
  activeSalons: number;
  totalSalons: number;
  activeEmployees: number;
  lastActivityAt: string | null;
  inactive: boolean;
};
type Body = {
  inactivityDays: number;
  totals: Record<string, number>;
  tenants: Item[];
};
type Fixture = Awaited<ReturnType<typeof seedGrundversionTenant>>;

const DAY_MS = 24 * 60 * 60 * 1000;
const TOP_KEYS = ["inactivityDays", "tenants", "totals"];
const TOTAL_KEYS = [
  "activeEmployees",
  "activeSalons",
  "activeTenants",
  "deactivatedTenants",
  "inactiveTenants",
  "tenants",
];
const byKey = (a: string, b: string) => a.localeCompare(b);

async function fetchBody(): Promise<Body> {
  const res = await getDashboard(operatorToken);
  expect(res.statusCode, res.body).toBe(200);
  return JSON.parse(res.body) as Body;
}

async function fetchItem(tenantId: string): Promise<Item> {
  const item = (await fetchBody()).tenants.find((entry) => entry.id === tenantId);
  if (!item) throw new Error("tenant missing in the dashboard");
  return item;
}

async function newTenant(label: string): Promise<Fixture> {
  const fixture = await seedGrundversionTenant(app, `op90-${label}`);
  tenants.push(fixture);
  return fixture;
}

/** Sets lastLoginAt of EVERY user of the fixture (the seed logs both in, which stamps them). */
async function setLogins(t: Fixture, lastLoginAt: Date | null) {
  await app.prisma.user.updateMany({
    where: { id: { in: [t.adminUser.id, t.empUser.id] } },
    data: { lastLoginAt },
  });
}

const created: { userId: string; employeeId: string; firstName: string; lastName: string }[] = [];

async function addEmployee(
  tenantId: string,
  opts: {
    firstName?: string;
    lastName?: string;
    exitDate?: Date | null;
    lastLoginAt?: Date | null;
  } = {},
) {
  const tag = randomUUID().slice(0, 8);
  const firstName = opts.firstName ?? `Fx${tag}`;
  const lastName = opts.lastName ?? `Ly${tag}`;
  const user = await app.prisma.user.create({
    data: {
      email: `op90-${tag}@example.invalid`,
      passwordHash: "x".repeat(40),
      role: "EMPLOYEE",
      isActive: true,
      lastLoginAt: opts.lastLoginAt ?? null,
    },
  });
  const employee = await app.prisma.employee.create({
    data: {
      tenantId,
      userId: user.id,
      employeeNumber: `N-${tag}`,
      firstName,
      lastName,
      hireDate: new Date("2024-01-01"),
      exitDate: opts.exitDate ?? null,
    },
  });
  created.push({ userId: user.id, employeeId: employee.id, firstName, lastName });
  return { user, employee };
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
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
    const t = await newTenant("tracer");
    const before = (await viewedRows()).length;

    const res = await getDashboard(operatorToken);
    expect(res.statusCode, res.body).toBe(200);
    const body = JSON.parse(res.body) as Body;
    expect(body.inactivityDays).toBe(30);
    const item = body.tenants.find((entry) => entry.id === t.tenant.id);
    expect(item).toBeDefined();
    expect(Object.keys(item ?? {}).sort(byKey)).toEqual(ITEM_KEYS);

    expect((await viewedRows()).length).toBe(before + 1);
  });
});

describe("counts (D-02)", () => {
  it("counts active and total salons and active, non-anonymized, not-exited employees", async () => {
    const t = await newTenant("counts");
    const seeded = [t.adminEmployee, t.employee].length;
    const base = await fetchItem(t.tenant.id);
    expect(base.activeSalons).toBe(1);
    expect(base.totalSalons).toBe(1);
    expect(base.activeEmployees).toBe(seeded);

    const second = await createTestSalon(app.prisma, t.tenant.id);
    let item = await fetchItem(t.tenant.id);
    expect([item.activeSalons, item.totalSalons]).toEqual([2, 2]);

    await app.prisma.salon.update({ where: { id: second.id }, data: { isActive: false } });
    item = await fetchItem(t.tenant.id);
    expect([item.activeSalons, item.totalSalons]).toEqual([1, 2]);

    await addEmployee(t.tenant.id);
    expect((await fetchItem(t.tenant.id)).activeEmployees).toBe(seeded + 1);

    await addEmployee(t.tenant.id, { firstName: "Gelöscht", lastName: `GELÖSCHT-${Date.now()}` });
    expect((await fetchItem(t.tenant.id)).activeEmployees).toBe(seeded + 1);

    const today = new Date(`${utcDay(new Date())}T00:00:00.000Z`);
    await addEmployee(t.tenant.id, { exitDate: new Date(today.getTime() - DAY_MS) });
    expect((await fetchItem(t.tenant.id)).activeEmployees).toBe(seeded + 1);

    await addEmployee(t.tenant.id, { exitDate: new Date(today.getTime() + DAY_MS) });
    expect((await fetchItem(t.tenant.id)).activeEmployees).toBe(seeded + 2);
  });
});

describe("last activity and inactivity (D-03)", () => {
  it("serves the UTC day of the newest login of the tenant's users, never a time", async () => {
    const t = await newTenant("lastday");
    await app.prisma.user.update({
      where: { id: t.adminUser.id },
      data: { lastLoginAt: new Date("2026-03-14T23:30:00.000Z") },
    });
    await app.prisma.user.update({
      where: { id: t.empUser.id },
      data: { lastLoginAt: new Date("2026-02-01T08:00:00.000Z") },
    });
    const item = await fetchItem(t.tenant.id);
    expect(item.lastActivityAt).toBe("2026-03-14");
    expect(item.inactive).toBe(true);
  });

  it("a tenant whose users never logged in has lastActivityAt null and is inactive", async () => {
    const t = await newTenant("never");
    await setLogins(t, null);
    const item = await fetchItem(t.tenant.id);
    expect(item.lastActivityAt).toBeNull();
    expect(item.inactive).toBe(true);
  });

  it("the route flags a login 30 days minus 10 minutes ago as active and plus 10 minutes as inactive", async () => {
    const t = await newTenant("edge");
    await setLogins(t, new Date(Date.now() - 30 * DAY_MS + 10 * 60_000));
    expect((await fetchItem(t.tenant.id)).inactive).toBe(false);
    await setLogins(t, new Date(Date.now() - 30 * DAY_MS - 10 * 60_000));
    expect((await fetchItem(t.tenant.id)).inactive).toBe(true);
  });

  it("with an injected now, exactly 30 days is still active and 30 days plus 1 ms is inactive", () => {
    expect(OPERATOR_INACTIVITY_DAYS).toBe(30);
    const now = new Date("2026-10-15T13:37:42.123Z");
    const tenant = { id: "t1", name: "T", slug: "t", deactivatedAt: null };
    const metrics = (lastActivityAt: Date | null) => [
      { tenantId: "t1", activeSalons: 1, totalSalons: 1, activeEmployees: 1, lastActivityAt },
    ];
    const at = (offsetMs: number) =>
      buildOperatorDashboardBody(
        [tenant],
        metrics(new Date(now.getTime() - 30 * DAY_MS - offsetMs)),
        now,
      ).tenants[0];
    expect(at(0).inactive).toBe(false);
    expect(at(1).inactive).toBe(true);
    expect(at(-1).inactive).toBe(false);
    // The served day is the UTC calendar day of the stored instant, asserted separately.
    expect(at(0).lastActivityAt).toBe("2026-09-15");
    expect(buildOperatorDashboardBody([tenant], metrics(null), now).tenants[0].inactive).toBe(true);
  });

  it("an anonymized employee's recent login does not set the tenant's lastActivityAt", async () => {
    const t = await newTenant("anonlogin");
    await setLogins(t, null);
    await addEmployee(t.tenant.id, {
      firstName: "Gelöscht",
      lastName: `GELÖSCHT-${Date.now()}`,
      lastLoginAt: new Date(),
    });
    const item = await fetchItem(t.tenant.id);
    expect(item.lastActivityAt).toBeNull();
    expect(item.inactive).toBe(true);
  });
});

describe("deactivated tenants and totals (D-04)", () => {
  it("lists a deactivated tenant with its counts, never inactive, and totals change by exactly the fixtures", async () => {
    const before = await fetchBody();

    const stale = await newTenant("tot-stale");
    await setLogins(stale, new Date(Date.now() - 90 * DAY_MS));
    const fresh = await newTenant("tot-fresh");
    await setLogins(fresh, new Date());
    const off = await newTenant("tot-off");
    await setLogins(off, null);
    const deactivatedAt = new Date("2026-05-05T10:00:00.000Z");
    await app.prisma.tenant.update({ where: { id: off.tenant.id }, data: { deactivatedAt } });

    const after = await fetchBody();
    const offItem = after.tenants.find((entry) => entry.id === off.tenant.id);
    expect(offItem).toMatchObject({
      deactivatedAt: deactivatedAt.toISOString(),
      activeSalons: 1,
      totalSalons: 1,
      activeEmployees: 2,
      lastActivityAt: null,
      inactive: false,
    });

    expect(after.totals.tenants - before.totals.tenants).toBe(3);
    expect(after.totals.activeTenants - before.totals.activeTenants).toBe(2);
    expect(after.totals.deactivatedTenants - before.totals.deactivatedTenants).toBe(1);
    expect(after.totals.activeSalons - before.totals.activeSalons).toBe(2);
    expect(after.totals.activeEmployees - before.totals.activeEmployees).toBe(4);
    expect(after.totals.inactiveTenants - before.totals.inactiveTenants).toBe(1);

    // Every total equals what the items say.
    const live = after.tenants.filter((entry) => entry.deactivatedAt === null);
    expect(after.totals.tenants).toBe(after.tenants.length);
    expect(after.totals.activeTenants).toBe(live.length);
    expect(after.totals.deactivatedTenants).toBe(after.tenants.length - live.length);
    expect(after.totals.activeSalons).toBe(live.reduce((n, i) => n + i.activeSalons, 0));
    expect(after.totals.activeEmployees).toBe(live.reduce((n, i) => n + i.activeEmployees, 0));
    expect(after.totals.inactiveTenants).toBe(after.tenants.filter((i) => i.inactive).length);
  });

  it("sorts items by name, then id", async () => {
    const a = await newTenant("sort-a");
    const b = await newTenant("sort-b");
    const sameName = `Sortiertest ${randomUUID().slice(0, 8)}`;
    await app.prisma.tenant.updateMany({
      where: { id: { in: [a.tenant.id, b.tenant.id] } },
      data: { name: sameName },
    });
    const body = await fetchBody();
    const expected = await app.prisma.tenant.findMany({
      select: { id: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    });
    expect(body.tenants.map((entry) => entry.id)).toEqual(expected.map((row) => row.id));
    const ids = body.tenants.filter((entry) => entry.name === sameName).map((entry) => entry.id);
    expect(ids).toHaveLength(2);
    expect(ids).toEqual([...ids].sort(byKey));
  });
});

describe("shape and privacy (D-01, D-08)", () => {
  it("serves only whitelisted keys at any depth and none of the fixture persons' values", async () => {
    const t = await newTenant("privacy");
    const extra = await addEmployee(t.tenant.id, { lastLoginAt: new Date() });
    const res = await getDashboard(operatorToken);
    expect(res.statusCode, res.body).toBe(200);
    const body = JSON.parse(res.body) as Body;

    expect(Object.keys(body).sort(byKey)).toEqual(TOP_KEYS);
    expect(Object.keys(body.totals).sort(byKey)).toEqual(TOTAL_KEYS);
    expect(body.tenants.length).toBeGreaterThan(0);
    const allowed = new Set([...TOP_KEYS, ...TOTAL_KEYS, ...ITEM_KEYS]);
    const walk = (node: unknown) => {
      if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === "object") {
        for (const [key, value] of Object.entries(node)) {
          expect(allowed.has(key), `unexpected key ${key}`).toBe(true);
          walk(value);
        }
      }
    };
    walk(body);
    for (const item of body.tenants) {
      expect(Object.keys(item).sort(byKey)).toEqual(ITEM_KEYS);
      expect(item.lastActivityAt === null || /^\d{4}-\d{2}-\d{2}$/.test(item.lastActivityAt)).toBe(
        true,
      );
    }

    const forbidden = [
      t.adminUser.id,
      t.adminUser.email,
      t.empUser.id,
      t.empUser.email,
      t.adminEmployee.id,
      t.adminEmployee.employeeNumber,
      t.employee.id,
      t.employee.employeeNumber,
      extra.user.id,
      extra.user.email,
      extra.employee.id,
      extra.employee.employeeNumber,
      extra.employee.firstName,
      extra.employee.lastName,
    ];
    for (const value of forbidden) {
      expect(res.body.includes(value), `body leaks ${value}`).toBe(false);
    }
  });
});

describe("refusals and access logging (T-90-02, D-05)", () => {
  it("answers 401 without a token and 403 for a tenant token, and logs no view for either", async () => {
    const t = await newTenant("refuse");
    const before = (await viewedRows()).length;

    const anonymous = await getDashboard();
    expect(anonymous.statusCode).toBe(401);

    const tenantCall = await getDashboard(t.adminToken);
    expect(tenantCall.statusCode).toBe(403);
    const refusals = await app.prisma.operatorAuditLog.findMany({
      where: { action: "TENANT_PRINCIPAL_REFUSED", entityId: { contains: "/operator/dashboard" } },
    });
    expect(
      refusals.some(
        (row) =>
          (row.newValue as { principalSub?: string } | null)?.principalSub === t.adminUser.id,
      ),
    ).toBe(true);

    expect((await viewedRows()).length).toBe(before);
  });

  it("writes one DASHBOARD_VIEWED row per call without a subject tenant, retention AUTH_EVENT", async () => {
    const before = await viewedRows();
    await fetchBody();
    await fetchBody();
    const after = await viewedRows();
    expect(after.length - before.length).toBe(2);
    const knownIds = new Set(before.map((row) => row.id));
    for (const row of after.filter((entry) => !knownIds.has(entry.id))) {
      expect(row.subjectTenantId).toBeNull();
      expect(row.entity).toBe("OperatorDashboard");
      expect(row.operatorId).toBe(operatorId);
    }
    expect(OPERATOR_AUDIT_RETENTION_CLASS.DASHBOARD_VIEWED).toBe("AUTH_EVENT");
  });
});

describe("query shape (D-02)", () => {
  it("issues a constant, small number of statements regardless of the tenant count", async () => {
    function counting(counter: { n: number }) {
      const wrapFn = (target: object, fn: (...args: unknown[]) => unknown) => {
        return (...args: unknown[]) => {
          counter.n += 1;
          return fn.apply(target, args);
        };
      };
      return new Proxy(app.prisma as object, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target) as unknown;
          if (typeof value === "function") {
            return wrapFn(target, value as (...args: unknown[]) => unknown);
          }
          if (
            value &&
            typeof value === "object" &&
            typeof prop === "string" &&
            !prop.startsWith("$")
          ) {
            return new Proxy(value, {
              get(delegate, method) {
                const inner = Reflect.get(delegate, method, delegate) as unknown;
                return typeof inner === "function"
                  ? wrapFn(delegate, inner as (...args: unknown[]) => unknown)
                  : inner;
              },
            });
          }
          return value;
        },
      }) as unknown as typeof app.prisma;
    }

    const first = { n: 0 };
    await operatorTenantMetrics(counting(first), new Date());
    await newTenant("shape-1");
    await newTenant("shape-2");
    await newTenant("shape-3");
    const second = { n: 0 };
    await operatorTenantMetrics(counting(second), new Date());

    expect(first.n).toBeGreaterThan(0);
    expect(first.n).toBeLessThanOrEqual(6);
    expect(second.n).toBe(first.n);
  });
});

describe("source boundaries (D-01, T-90-05)", () => {
  const operatorDir = join(__dirname, "..", "contexts", "platform", "api", "operator");
  const files = readdirSync(operatorDir).filter((name) => name.endsWith(".ts"));

  it("only dashboard.ts names the metrics facade and no operator file runs grouped or raw queries", () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files).toContain("dashboard.ts");
    for (const file of files) {
      const text = readFileSync(join(operatorDir, file), "utf8");
      expect(text.includes("operatorTenantMetrics"), file).toBe(file === "dashboard.ts");
      expect(text.includes("groupBy("), file).toBe(false);
      expect(text.includes("$queryRaw"), file).toBe(false);
    }
  });

  it("the facade is not re-exported from the platform index", () => {
    const index = readFileSync(join(__dirname, "..", "contexts", "platform", "index.ts"), "utf8");
    expect(index.length).toBeGreaterThan(0);
    expect(index.includes("operator-metrics")).toBe(false);
    expect(index.includes("operatorTenantMetrics")).toBe(false);
  });
});
