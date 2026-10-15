/**
 * Issue #93 (Phase 93b-05, Task 2, D-10, D-24) — the shape of every support read, pinned by a source scan.
 *
 * What is proven here:
 *   - every GET registration of the support read plugin passes through `runSupportRead`, and the plugin
 *     registers no write method (a write route under `/support` would be a write path for the operator
 *     into tenant data);
 *   - `runSupportRead` decides the grant BEFORE the audit transaction, decides it AGAIN with
 *     `lockGrant: true` inside the transaction before the audit writer, and calls the port only after
 *     the transaction (grant first, audit first);
 *   - at runtime the four read paths answer no POST, PUT, PATCH or DELETE (`app.hasRoute`);
 *   - every Prisma query of `composition/operator-support-ports.ts` names `tenantId` (the tenant-scoping
 *     gate cannot see a composition module without a request), the file registers no route and imports
 *     contexts only through their `index.ts`.
 *
 * Anti-vacuity: every extracted set is asserted non-empty BEFORE a structural assertion runs on it, so a
 * moved file or a renamed function turns this test red instead of letting it pass over nothing.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp } from "./setup";

const SRC = join(__dirname, "..");
const SUPPORT_ROUTES = join(SRC, "contexts", "platform", "api", "operator", "support.ts");
const SUPPORT_PORTS = join(SRC, "composition", "operator-support-ports.ts");

/** Source text without block and line comments, so a docblock that names a call is never counted. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** The text of the balanced parenthesis group that opens at `openIndex` (the index of the `(`). */
function balancedGroup(source: string, openIndex: number): string {
  let depth = 0;
  for (let i = openIndex; i < source.length; i += 1) {
    if (source[i] === "(") depth += 1;
    if (source[i] === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex, i + 1);
    }
  }
  throw new Error("unbalanced parenthesis in scanned source");
}

const routesSource = stripComments(readFileSync(SUPPORT_ROUTES, "utf8"));
const portsSource = stripComments(readFileSync(SUPPORT_PORTS, "utf8"));

const READ_PATHS = [
  "/api/v1/operator/tenants/:id/support/employees",
  "/api/v1/operator/tenants/:id/support/employees/:employeeId/month",
  "/api/v1/operator/tenants/:id/support/employees/:employeeId/contracts",
  "/api/v1/operator/tenants/:id/support/audit-log",
];

describe("support read plugin shape (D-10, D-19)", () => {
  // Each GET registration, from its `app.get(` up to the next one (or the end of the file).
  const getStarts = [...routesSource.matchAll(/\bapp\.get\(/g)].map((m) => m.index ?? 0);
  const registrations = getStarts.map((start, i) =>
    routesSource.slice(start, getStarts[i + 1] ?? routesSource.length),
  );

  it("walks a non-empty set of GET registrations", () => {
    expect(routesSource.length).toBeGreaterThan(0);
    expect(registrations.length).toBeGreaterThanOrEqual(4);
  });

  it("routes every GET registration through runSupportRead and guards it with requireOperator", () => {
    expect(registrations.length).toBeGreaterThan(0);
    for (const registration of registrations) {
      expect(registration, registration.slice(0, 60)).toMatch(/\brunSupportRead\(\s*req,/);
      expect(registration, registration.slice(0, 60)).toContain("preHandler: requireOperator");
    }
  });

  it("has as many runSupportRead call sites as GET registrations", () => {
    const callSites = [...routesSource.matchAll(/\brunSupportRead\(\s*req,/g)];
    expect(callSites.length).toBeGreaterThanOrEqual(4);
    expect(callSites.length).toBe(registrations.length);
  });

  it("registers no write method and no generic route", () => {
    expect(registrations.length).toBeGreaterThan(0);
    expect(routesSource).not.toMatch(/\bapp\.(post|put|patch|delete|route|all)\(/);
    expect(routesSource).not.toMatch(/\bapp\.(post|put|patch|delete)\b/);
  });

  it("reads tenant data only through the injected ports", () => {
    const portCalls = [...routesSource.matchAll(/\bopts\.ports\.([A-Za-z]+)\(/g)].map((m) => m[1]);
    expect(portCalls.length).toBeGreaterThanOrEqual(5);
    // employeeExists is the audit transaction's existence check; every other port call is a read that
    // sits inside one of the GET registrations.
    const reads = portCalls.filter((name) => name !== "employeeExists");
    expect(reads.length).toBeGreaterThanOrEqual(4);
    for (const registration of registrations) {
      expect(registration).toMatch(/\bopts\.ports\.[A-Za-z]+\(/);
    }
    expect(routesSource).not.toMatch(
      /\bapp\.prisma\.(employee|timeEntry|leaveRequest|absence|auditLog|workSchedule)\b/,
    );
  });

  it("decides the grant, then the audit transaction (re-decided under lockGrant), then the port", () => {
    const start = routesSource.indexOf("async function runSupportRead");
    expect(start).toBeGreaterThan(-1);
    // The body ends where the first route registration begins.
    const end = routesSource.indexOf("app.get(", start);
    expect(end).toBeGreaterThan(start);
    const body = routesSource.slice(start, end);

    const firstDecision = body.indexOf("assertActiveSupportAccess(app.prisma");
    const prepareCall = body.indexOf("prepare()");
    const transaction = body.indexOf("$transaction(");
    const recheck = body.indexOf("assertActiveSupportAccess(tx");
    const lockGrant = body.indexOf("lockGrant: true");
    const auditWriter = body.indexOf("writeSupportReadAudit(");
    const portCall = body.lastIndexOf("read(tenantId, input)");

    for (const [name, index] of Object.entries({
      firstDecision,
      prepareCall,
      transaction,
      recheck,
      lockGrant,
      auditWriter,
      portCall,
    })) {
      expect(index, `${name} not found in runSupportRead`).toBeGreaterThan(-1);
    }
    // Grant decision first, input validation after it, the transaction after both.
    expect(firstDecision).toBeLessThan(prepareCall);
    expect(prepareCall).toBeLessThan(transaction);
    // Inside the transaction: the locked re-check precedes the audit writer.
    expect(transaction).toBeLessThan(recheck);
    expect(recheck).toBeLessThan(lockGrant);
    expect(lockGrant).toBeLessThan(auditWriter);
    // The data is read only after the transaction closed (the writer is the transaction's last step).
    expect(auditWriter).toBeLessThan(portCall);
    expect(body.indexOf("RECORDED", auditWriter)).toBeLessThan(portCall);
    // The data read is not inside the transaction callback: the callback closes before the read.
    const transactionGroup = balancedGroup(body, body.indexOf("(", transaction));
    expect(transactionGroup.length).toBeGreaterThan(0);
    expect(transactionGroup).not.toContain("read(tenantId, input)");
  });
});

describe("support read paths at runtime (D-10, T-93b-23)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await getTestApp();
  });

  afterAll(async () => {
    await closeTestApp();
  });

  it("registers GET on every read path (non-vacuity)", () => {
    expect(READ_PATHS.length).toBeGreaterThanOrEqual(4);
    for (const url of READ_PATHS) {
      expect(app.hasRoute({ method: "GET", url }), `GET ${url}`).toBe(true);
    }
  });

  it("registers no POST, PUT, PATCH or DELETE on any read path", () => {
    expect(READ_PATHS.length).toBeGreaterThanOrEqual(4);
    for (const url of READ_PATHS) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
        expect(app.hasRoute({ method, url }), `${method} ${url}`).toBe(false);
      }
    }
  });
});

describe("composition/operator-support-ports.ts (D-24, T-93b-20)", () => {
  const QUERY_CALL =
    /\b(?:app\.prisma|db|tx)\.[A-Za-z]+\.(findMany|findFirst|findFirstOrThrow|findUnique|findUniqueOrThrow|count|aggregate|groupBy)\(/g;

  it("names tenantId in every Prisma query call", () => {
    expect(portsSource.length).toBeGreaterThan(0);
    const calls = [...portsSource.matchAll(QUERY_CALL)];
    expect(calls.length).toBeGreaterThanOrEqual(5);
    for (const call of calls) {
      const open = (call.index ?? 0) + call[0].length - 1;
      const args = balancedGroup(portsSource, open);
      expect(args, `${call[0]} ${args.slice(0, 80)}`).toContain("tenantId");
    }
  });

  it("holds an audit-log query and it carries the tenant two-branch scope", () => {
    const calls = [...portsSource.matchAll(QUERY_CALL)].filter((call) =>
      call[0].includes(".auditLog."),
    );
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const call of calls) {
      const open = (call.index ?? 0) + call[0].length - 1;
      const args = balancedGroup(portsSource, open);
      expect(args).toContain("user: { employee: { tenantId");
      expect(args).toContain('path: ["actor", "tenantId"]');
    }
  });

  it("writes nothing", () => {
    expect(portsSource.length).toBeGreaterThan(0);
    expect(portsSource).not.toMatch(
      /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/,
    );
    expect(portsSource).not.toMatch(/\$executeRaw|\$queryRaw/);
  });

  it("registers no route and imports contexts only through their index", () => {
    expect(portsSource).not.toMatch(/\bapp\.(get|post|put|patch|delete|route|register)\(/);
    const specifiers = [...portsSource.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    const contextImports = specifiers.filter((spec) => spec.includes("contexts/"));
    expect(contextImports.length).toBeGreaterThanOrEqual(4);
    for (const spec of contextImports) {
      expect(spec, spec).toMatch(/^\.\.\/contexts\/[a-z-]+$/);
    }
  });
});
