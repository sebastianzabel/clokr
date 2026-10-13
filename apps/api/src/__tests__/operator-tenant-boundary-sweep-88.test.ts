/**
 * Phase 88 plan 13 (AC-88-03, AC-88-04, D-08a, D-10) — a missing, empty or foreign tenant context never
 * leads to tenant data or to an unfiltered query on ANY derived tenant route.
 *
 * Every route `deriveMatrixRoutes()` finds (minus the matrix's own excluded / outside-derivation routes
 * and the operator routes themselves) is requested with three tenant-less principals:
 *
 *   1. an operator access token (a principal that carries no tenant by type),
 *   2. a tenant token with `tenantId: ""` — a real User row without an Employee (the legacy user, D-10),
 *   3. a tenant token naming a tenant that does not exist.
 *
 * Invariants:
 *   - operator token: 403 on every swept route, never a 2xx (no route is excused);
 *   - empty / nonexistent tenant: no response body contains any identifier of the victim tenant, no victim row
 *     changes, every 5xx carries exactly the fixed `Interner Serverfehler` body;
 *   - a Prisma-call interceptor (call-through spies on every model method of `app.prisma`) records every call
 *     of the sweeps; none carries a `tenantId` key whose value is undefined at any depth. This is the RUNTIME
 *     half of D-08c, covering inferred types the static gate (88-04) cannot see. HONEST LIMIT: the clients an
 *     interactive `$transaction(async (tx) => ...)` hands out are not the spied object, so calls made on `tx`
 *     are invisible here; the static gate covers the syntactic class there.
 *
 * Non-vacuity (T-88-65): the swept set equals the derived set minus the named exclusions exactly, the operator
 * routes are in the derived set, the interceptor recorded calls, and a control run with the victim admin's
 * token receives victim data on at least one swept route (so the leak detector demonstrably sees a leak).
 *
 * D-10 characterisation: the legacy user without an Employee keeps passing permission guards through the
 * legacy-role fallback (`request-permissions.ts`); #551 fixes that. This file only proves it never yields
 * data. The status histograms of the run are the characterisation.
 *
 * Mutation proofs (plan 88-13 SUMMARY): (a) removing the operator probe from `middleware/auth.ts` turns the
 * operator cases red; (b) replacing the tenant value of a tenant-filtered read by `undefined` turns the
 * empty-tenant sweep (leak) and the interceptor red.
 */
import { randomUUID, randomBytes } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { MockInstance } from "vitest";
import type { FastifyInstance } from "fastify";
import { Prisma } from "@clokr/db";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  seedOperator,
  cleanupTestData,
  createTestSalon,
  salonIdForEmployee,
} from "./setup";
import { signOperatorToken } from "../contexts/platform/operator-auth";
import type { JwtPayload } from "../middleware/auth";
import { deriveMatrixRoutes, pathParams } from "./neutrality/route-derivation";
import { EXCLUDED_ROUTES, OUTSIDE_DERIVATION } from "./neutrality/matrix-config";

let app: FastifyInstance;
let victim: Awaited<ReturnType<typeof seedTestData>>;
let extraSalonId: string;
let timeEntryId: string;
let leaveRequestId: string;
let legacyUserId: string;
let operatorToken: string;
let emptyTenantToken: string;
let foreignTenantToken: string;
let victimIdentifiers: string[] = [];

let addressCounter = 0;
function uniqueAddress(): string {
  const n = addressCounter++;
  return `10.88.${Math.floor(n / 250) % 250}.${(n % 250) + 1}`;
}

/** The swept set: derived minus the matrix's own exclusions and the operator routes. */
function sweptRoutes(): string[] {
  const derived = deriveMatrixRoutes();
  const excluded = new Set<string>([
    ...EXCLUDED_ROUTES.map((r) => r.route),
    ...OUTSIDE_DERIVATION.map((r) => r.route),
  ]);
  return derived.filter(
    (r) => !excluded.has(r) && !r.split(" ")[1].startsWith("/api/v1/operator/"),
  );
}

/** Substitutes the path parameters with victim ids by the segment that precedes them. */
function urlFor(route: string): string {
  const [, rawUrl] = route.split(" ");
  const segments = rawUrl.split("/");
  return segments
    .map((segment, index) => {
      if (!segment.startsWith(":")) return segment;
      const name = segment.slice(1);
      const previous = segments[index - 1] ?? "";
      if (name === "employeeId") return victim.employee.id;
      if (name === "salonId") return extraSalonId;
      if (name === "leaveRequestId") return leaveRequestId;
      if (previous === "employees") return victim.employee.id;
      if (previous === "salons") return extraSalonId;
      if (previous === "time-entries") return timeEntryId;
      if (previous === "requests" || previous === "leave") return leaveRequestId;
      return randomUUID();
    })
    .join("/");
}

type SweepResult = { route: string; status: number; body: string };

async function request(route: string, token: string | null): Promise<SweepResult> {
  const method = route.split(" ")[0] as "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  const hasBody = method === "POST" || method === "PUT" || method === "PATCH";
  const res = await app.inject({
    method,
    url: urlFor(route),
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(hasBody ? { "content-type": "application/json" } : {}),
    },
    ...(hasBody ? { payload: "{}" } : {}),
    remoteAddress: uniqueAddress(),
  });
  return { route, status: res.statusCode, body: res.body };
}

async function sweep(routes: readonly string[], token: string | null): Promise<SweepResult[]> {
  const out: SweepResult[] = [];
  for (const route of routes) out.push(await request(route, token));
  return out;
}

function histogram(results: readonly SweepResult[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of results) out[String(r.status)] = (out[String(r.status)] ?? 0) + 1;
  return out;
}

function leaksOf(results: readonly SweepResult[]): string[] {
  const found: string[] = [];
  for (const r of results) {
    const hit = victimIdentifiers.find((id) => r.body.includes(id));
    if (hit) found.push(`${r.route} -> ${r.status} contains ${hit}`);
  }
  return found;
}

async function victimCounts() {
  const employeeIds = (
    await app.prisma.employee.findMany({
      where: { tenantId: victim.tenant.id },
      select: { id: true },
    })
  ).map((e) => e.id);
  return {
    employee: employeeIds.length,
    user: await app.prisma.user.count({
      where: { id: { in: [victim.adminUser.id, victim.empUser.id] } },
    }),
    timeEntry: await app.prisma.timeEntry.count({ where: { employeeId: { in: employeeIds } } }),
    leaveRequest: await app.prisma.leaveRequest.count({
      where: { employeeId: { in: employeeIds } },
    }),
    salon: await app.prisma.salon.count({ where: { tenantId: victim.tenant.id } }),
    tenantConfig: await app.prisma.tenantConfig.count({ where: { tenantId: victim.tenant.id } }),
    absence: await app.prisma.absence.count({ where: { employeeId: { in: employeeIds } } }),
  };
}

// ── Prisma interceptor ──────────────────────────────────────────────────────────────────────────────────────

type RecordedCall = { model: string; method: string; args: unknown };
const recorded: RecordedCall[] = [];
const spies: Array<{ mockRestore: () => void }> = [];

function installInterceptor(): void {
  const client = app.prisma as unknown as Record<string, Record<string, unknown>>;
  for (const model of Prisma.dmmf.datamodel.models) {
    const delegate = model.name[0].toLowerCase() + model.name.slice(1);
    const target = client[delegate];
    if (!target) continue;
    for (const method of Object.keys(target)) {
      if (typeof target[method] !== "function") continue;
      const original = target[method] as (...a: unknown[]) => unknown;
      const spy = (vi.spyOn(target, method as never) as unknown as MockInstance).mockImplementation(
        function (this: unknown, ...a: unknown[]) {
          recorded.push({ model: delegate, method, args: a[0] });
          return original.apply(this, a);
        } as never,
      );
      spies.push(spy);
    }
  }
}

/** Paths of every `tenantId` key whose value is undefined, at any depth (bounded, cycle-safe). */
function nullishTenantPaths(
  value: unknown,
  path = "$",
  seen = new WeakSet<object>(),
  depth = 0,
): string[] {
  if (depth > 12 || value === null || typeof value !== "object") return [];
  if (value instanceof Date || Buffer.isBuffer(value)) return [];
  if (seen.has(value)) return [];
  seen.add(value);
  const hits: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((v, i) => hits.push(...nullishTenantPaths(v, `${path}[${i}]`, seen, depth + 1)));
    return hits;
  }
  for (const [key, v] of Object.entries(value)) {
    if (key === "tenantId" && v === undefined) hits.push(`${path}.${key}`);
    hits.push(...nullishTenantPaths(v, `${path}.${key}`, seen, depth + 1));
  }
  return hits;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  app = await getTestApp();
  victim = await seedTestData(app, "vic88");

  const extraSalon = await createTestSalon(app.prisma, victim.tenant.id, {
    name: `Salon vic88 ${randomBytes(3).toString("hex")}`,
  });
  extraSalonId = extraSalon.id;
  const entry = await app.prisma.timeEntry.create({
    data: {
      employeeId: victim.employee.id,
      date: new Date("2026-06-15"),
      startTime: new Date("2026-06-15T07:00:00Z"),
      endTime: new Date("2026-06-15T15:00:00Z"),
      breakMinutes: 30,
      source: "MANUAL",
      type: "WORK",
      salonId: await salonIdForEmployee(app.prisma, victim.employee.id),
    },
  });
  timeEntryId = entry.id;
  const leave = await app.prisma.leaveRequest.create({
    data: {
      employeeId: victim.employee.id,
      leaveTypeId: victim.vacationType.id,
      startDate: new Date("2026-08-03"),
      endDate: new Date("2026-08-03"),
      days: 1,
      status: "PENDING",
    },
  });
  leaveRequestId = leave.id;

  victimIdentifiers = [
    victim.tenant.id,
    victim.tenant.name,
    victim.tenant.slug,
    victim.adminUser.id,
    victim.adminUser.email,
    victim.empUser.id,
    victim.empUser.email,
    victim.adminEmployee.id,
    victim.employee.id,
    victim.salonId,
    extraSalon.id,
    extraSalon.name,
    entry.id,
    leave.id,
  ];

  // The legacy user: ADMIN role, no Employee row. Distinct from every victim identifier.
  const legacy = await app.prisma.user.create({
    data: {
      email: `legacy-${randomBytes(5).toString("hex")}@test.invalid`,
      passwordHash: "x",
      role: "ADMIN",
      isActive: true,
    },
  });
  legacyUserId = legacy.id;
  emptyTenantToken = app.jwt.sign({
    sub: legacyUserId,
    role: "ADMIN",
    tenantId: "",
  } as unknown as JwtPayload);
  foreignTenantToken = app.jwt.sign({
    sub: legacyUserId,
    role: "ADMIN",
    tenantId: randomUUID(),
  } as unknown as JwtPayload);

  const operator = await seedOperator(app);
  operatorToken = signOperatorToken(app, operator.id, "access");
});

afterAll(async () => {
  for (const spy of spies) spy.mockRestore();
  await app.prisma.user.deleteMany({ where: { id: legacyUserId } });
  await cleanupTestData(app, victim.tenant.id);
  await closeTestApp();
});

// ── The sweep ─────────────────────────────────────────────────────────────────────────────────────────────

describe("operator and tenant-less tokens over every derived tenant route (AC-88-03/04, D-08a)", () => {
  let swept: string[];
  let operatorResults: SweepResult[] = [];
  let emptyResults: SweepResult[] = [];
  let foreignResults: SweepResult[] = [];
  let controlResults: SweepResult[] = [];
  let before: Awaited<ReturnType<typeof victimCounts>>;
  let after: Awaited<ReturnType<typeof victimCounts>>;

  beforeAll(async () => {
    swept = sweptRoutes();
    before = await victimCounts();
    installInterceptor();
    operatorResults = await sweep(swept, operatorToken);
    emptyResults = await sweep(swept, emptyTenantToken);
    foreignResults = await sweep(swept, foreignTenantToken);
    after = await victimCounts();
    // Control: GET routes only, so the victim's own admin cannot change anything.
    controlResults = await sweep(
      swept.filter((r) => r.startsWith("GET ")),
      victim.adminToken,
    );
    console.warn(
      `[88-13] swept=${swept.length} operator=${JSON.stringify(histogram(operatorResults))} ` +
        `empty=${JSON.stringify(histogram(emptyResults))} foreign=${JSON.stringify(histogram(foreignResults))} ` +
        `prismaCalls=${recorded.length}`,
    );
    console.warn(
      `[88-13] empty-tenant 200 routes: ${emptyResults
        .filter((r) => r.status === 200)
        .map((r) => r.route)
        .join(" | ")}`,
    );
  }, 900_000);

  it("sweeps exactly the derived routes minus the named exclusions and the operator routes", () => {
    const derived = deriveMatrixRoutes();
    expect(derived.some((r) => r.split(" ")[1].startsWith("/api/v1/operator/"))).toBe(true);
    const excluded = new Set<string>([
      ...EXCLUDED_ROUTES.map((r) => r.route),
      ...OUTSIDE_DERIVATION.map((r) => r.route),
    ]);
    const expected = derived.filter(
      (r) => !excluded.has(r) && !r.split(" ")[1].startsWith("/api/v1/operator/"),
    );
    expect(swept).toEqual(expected);
    expect(swept.length).toBeGreaterThan(100);
    expect(operatorResults).toHaveLength(swept.length);
    expect(pathParams(swept.find((r) => r.includes("/:employeeId")) ?? "")).toContain("employeeId");
  });

  it("operator token: 403 on every swept route, never a 2xx, no victim identifier", () => {
    // No route is excused: every swept route runs requireAuth (or a permission guard behind it) and refuses
    // the operator principal. A schema-validation 400 before the guard would show up here and must be named.
    const unexpected = operatorResults.filter((r) => r.status !== 403);
    expect(unexpected.map((r) => `${r.route} -> ${r.status}`)).toEqual([]);
    expect(operatorResults.some((r) => r.status >= 200 && r.status < 300)).toBe(false);
    expect(leaksOf(operatorResults)).toEqual([]);
  });

  it.each([
    ["empty tenant", () => emptyResults],
    ["nonexistent tenant", () => foreignResults],
  ])("%s: no victim identifier in any body and only the fixed 5xx body", (_name, results) => {
    const rs = results();
    expect(rs).toHaveLength(swept.length);
    expect(leaksOf(rs)).toEqual([]);
    const badFiveHundreds = rs.filter(
      (r) => r.status >= 500 && r.body !== JSON.stringify({ error: "Interner Serverfehler" }),
    );
    expect(badFiveHundreds.map((r) => `${r.route} -> ${r.status} ${r.body.slice(0, 120)}`)).toEqual(
      [],
    );
  });

  it("leaves every victim row count unchanged", () => {
    expect(after).toEqual(before);
  });

  it("interceptor: recorded calls, none with an undefined tenantId at any depth", () => {
    expect(recorded.length).toBeGreaterThan(0);
    const offenders = recorded
      .map((c) => ({ c, paths: nullishTenantPaths(c.args) }))
      .filter((x) => x.paths.length > 0)
      .map((x) => `${x.c.model}.${x.c.method} ${x.paths.join(",")}`);
    expect(offenders).toEqual([]);
  });

  it("interceptor sanity: the walker flags an undefined tenantId nested in a where", () => {
    expect(nullishTenantPaths({ where: { AND: [{ tenantId: undefined }] } })).toEqual([
      "$.where.AND[0].tenantId",
    ]);
    expect(nullishTenantPaths({ where: { tenantId: "t" } })).toEqual([]);
  });

  it("control: the victim admin's token receives victim data on at least one swept route", () => {
    const leaking = leaksOf(controlResults);
    expect(controlResults.length).toBeGreaterThan(0);
    expect(leaking.length).toBeGreaterThan(0);
  });
});
