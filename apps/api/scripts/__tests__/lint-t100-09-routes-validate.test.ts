/**
 * Phase 259 Plan 02 (Issue #259, D-03/D-03a/D-05/D-06/D-06a/D-07) — table-driven, DB-free unit
 * coverage of the pure module `../lint-t100-09-routes-validate.ts`. Every case drives the module
 * from in-memory fixture strings and objects — this file must NEVER read the real
 * `apps/api/src/contexts` tree or the real `apps/api/src/app.ts`, or it becomes a tree-walking
 * asserter itself and inherits the same empty-set obligation the gate under test exists to enforce
 * (see `lint-t100-09-routes.ts`'s own module docblock).
 */
import { describe, it, expect } from "vitest";
import {
  CATEGORIES,
  MIN_REASON_LENGTH,
  DEFAULT_MAX_DEVIATION_AGE_DAYS,
  extractRouteDeclarations,
  extractPrefixMap,
  joinRoutes,
  hasPathParameter,
  pathParamNames,
  validateRegisterDocument,
  diffRegisterAgainstRoutes,
  findExpiredDeviations,
  type RegisterEntry,
} from "../lint-t100-09-routes-validate";

const REASON = "x".repeat(MIN_REASON_LENGTH);
const SHORT_REASON = "too short";

function entry(route: string, overrides: Partial<RegisterEntry> = {}): RegisterEntry {
  return {
    route,
    file: "apps/api/src/contexts/absence/api/leave.ts",
    category: "nicht anwendbar",
    params: null,
    minimalBody: null,
    reason: REASON,
    ticket: null,
    validatedAt: null,
    ...overrides,
  };
}

function doc(entries: unknown[]): unknown {
  return { registerSource: "test source", entries };
}

function addDays(iso: string, days: number): string {
  return new Date(new Date(iso).getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

describe("CATEGORIES", () => {
  it("is exactly the three D-06/D-07 literal values, kept verbatim (German words are data, not code)", () => {
    expect(CATEGORIES).toEqual(["probe", "nicht anwendbar", "bekannt-abweichend"]);
  });
});

describe("extractRouteDeclarations", () => {
  it("finds a single-line route declaration and attributes it to the enclosing exported function", () => {
    const src = `
export async function fooRoutes(app: FastifyInstance) {
  app.get("/:id", { handler: async () => {} });
}
`;
    const decls = extractRouteDeclarations(src, "fake.ts");
    expect(decls).toHaveLength(1);
    expect(decls[0]).toMatchObject({ exportedFn: "fooRoutes", method: "GET", path: "/:id" });
  });

  it("finds a route declaration whose path string is on the NEXT line (company-shutdowns.ts:183 shape)", () => {
    const src = `
export async function companyShutdownRoutes(app: FastifyInstance) {
  app.delete(
    "/:id/exceptions/:employeeId",
    { preHandler: requireRole("ADMIN") },
    async (req, reply) => {},
  );
}
`;
    const decls = extractRouteDeclarations(src, "fake.ts");
    expect(decls).toHaveLength(1);
    expect(decls[0]).toMatchObject({
      exportedFn: "companyShutdownRoutes",
      method: "DELETE",
      path: "/:id/exceptions/:employeeId",
    });
  });

  it("attributes two route functions in one file to two DIFFERENT exported functions (shift-patterns.ts shape)", () => {
    const src = `
export async function shiftPatternRoutes(app: FastifyInstance) {
  app.get("/:id/shift-patterns", { handler: async () => {} });
  app.put("/:id/shift-patterns", { handler: async () => {} });
}

export async function shiftPatternTenantRoutes(app: FastifyInstance) {
  app.get("/tenant", { handler: async () => {} });
}
`;
    const decls = extractRouteDeclarations(src, "fake.ts");
    expect(decls).toHaveLength(3);
    expect(decls.filter((d) => d.exportedFn === "shiftPatternRoutes")).toHaveLength(2);
    expect(decls.filter((d) => d.exportedFn === "shiftPatternTenantRoutes")).toHaveLength(1);
  });

  it("does not miscount braces inside a regex literal appearing before the route function (schema regex shape)", () => {
    const src = `
const schema = z.object({
  startDate: z.string().regex(/^\\d{4}-\\d{2}-\\d{2}$/),
});

export async function fooRoutes(app: FastifyInstance) {
  app.get("/:id", { handler: async () => {} });
}
`;
    const decls = extractRouteDeclarations(src, "fake.ts");
    expect(decls).toHaveLength(1);
    expect(decls[0]).toMatchObject({ exportedFn: "fooRoutes", method: "GET", path: "/:id" });
  });

  it("attributes a route call before any exported function to a non-null sentinel owner, never dropping it", () => {
    const src = `app.get("/:id", { handler: async () => {} });\n`;
    const decls = extractRouteDeclarations(src, "fake.ts");
    expect(decls).toHaveLength(1);
    expect(decls[0].exportedFn).toBe("<module-level, no enclosing exported function>");
  });
});

describe("extractPrefixMap", () => {
  it("resolves a single-line named import to its registration prefix", () => {
    const appTs = `
import { avatarRoutes } from "./contexts/platform/api/avatars";
await app.register(avatarRoutes, { prefix: "/api/v1/avatars" });
`;
    const map = extractPrefixMap(appTs);
    expect(map.get("avatarRoutes")).toBe("/api/v1/avatars");
  });

  it("resolves a MULTI-LINE named import bringing in two functions under two different prefixes (shift-patterns.ts shape)", () => {
    const appTs = `
import {
  shiftPatternRoutes,
  shiftPatternTenantRoutes,
} from "./contexts/scheduling/api/shift-patterns";
await app.register(shiftPatternRoutes, { prefix: "/api/v1/employees" });
await app.register(shiftPatternTenantRoutes, { prefix: "/api/v1/shift-patterns" });
`;
    const map = extractPrefixMap(appTs);
    expect(map.get("shiftPatternRoutes")).toBe("/api/v1/employees");
    expect(map.get("shiftPatternTenantRoutes")).toBe("/api/v1/shift-patterns");
  });

  it("resolves an ALIASED named import back to the route file's own export name", () => {
    const appTs = `
import { fooRoutes as barRoutes } from "./contexts/platform/api/foo";
await app.register(barRoutes, { prefix: "/api/v1/foo" });
`;
    const map = extractPrefixMap(appTs);
    expect(map.get("fooRoutes")).toBe("/api/v1/foo");
    expect(map.has("barRoutes")).toBe(false);
  });

  it("skips a plugin registration with no 'prefix' field", () => {
    const appTs = `
import { prismaPlugin } from "./contexts/platform/plugins/prisma";
await app.register(prismaPlugin);
`;
    const map = extractPrefixMap(appTs);
    expect(map.size).toBe(0);
  });
});

describe("joinRoutes", () => {
  it("joins a declaration against its prefix into '<METHOD> <url>'", () => {
    const { routes, unresolved } = joinRoutes(
      [{ exportedFn: "avatarRoutes", method: "POST", path: "/:employeeId", line: 10 }],
      new Map([["avatarRoutes", "/api/v1/avatars"]]),
    );
    expect(routes).toEqual(["POST /api/v1/avatars/:employeeId"]);
    expect(unresolved).toEqual([]);
  });

  it("reports an unresolved exported function as an ERROR, never a silently dropped route", () => {
    const { routes, unresolved } = joinRoutes(
      [{ exportedFn: "ghostRoutes", method: "GET", path: "/:id", line: 1 }],
      new Map(),
    );
    expect(routes).toEqual([]);
    expect(unresolved).toEqual(["ghostRoutes"]);
  });

  it("joins a root path '/' without a doubled or dangling segment", () => {
    const { routes } = joinRoutes(
      [{ exportedFn: "fooRoutes", method: "GET", path: "/", line: 1 }],
      new Map([["fooRoutes", "/api/v1/foo"]]),
    );
    expect(routes).toEqual(["GET /api/v1/foo"]);
  });
});

describe("hasPathParameter", () => {
  it("is true for a URL with a ':' segment", () => {
    expect(hasPathParameter("/api/v1/avatars/:employeeId")).toBe(true);
  });
  it("is false for a URL with no ':' segment", () => {
    expect(hasPathParameter("/api/v1/holidays")).toBe(false);
  });
});

describe("pathParamNames", () => {
  it("extracts every ':name' segment from a route string's URL half, in order", () => {
    expect(pathParamNames("DELETE /api/v1/company-shutdowns/:id/exceptions/:employeeId")).toEqual([
      "id",
      "employeeId",
    ]);
  });
  it("is empty for a route with no path parameter", () => {
    expect(pathParamNames("GET /api/v1/holidays")).toEqual([]);
  });
});

describe("validateRegisterDocument", () => {
  const ROUTE = "POST /api/v1/avatars/:employeeId";
  const DERIVED = [ROUTE];

  it("fails when the document is not an object", () => {
    expect(validateRegisterDocument(null, DERIVED).ok).toBe(false);
  });

  it("fails when the document is an array", () => {
    expect(validateRegisterDocument([], DERIVED).ok).toBe(false);
  });

  it("fails when registerSource is empty", () => {
    const result = validateRegisterDocument({ registerSource: "  ", entries: [] }, DERIVED);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.includes("registerSource"))).toBe(true);
  });

  it("fails on an entry whose category is not one of the three literal values", () => {
    const result = validateRegisterDocument(
      doc([entry(ROUTE, { category: "not-a-real-category" as never })]),
      DERIVED,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.includes("category"))).toBe(true);
  });

  it("fails on an entry whose reason is shorter than MIN_REASON_LENGTH, with the 'measured sentence' message", () => {
    const result = validateRegisterDocument(doc([entry(ROUTE, { reason: SHORT_REASON })]), DERIVED);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("measured sentence"))).toBe(true);
    }
  });

  it("fails on two entries naming the same route as a duplicate", () => {
    const result = validateRegisterDocument(doc([entry(ROUTE), entry(ROUTE)]), DERIVED);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.includes("duplicate"))).toBe(true);
  });

  it("fails on an entry whose route is not among the derived routes, naming it as STALE", () => {
    const result = validateRegisterDocument(doc([entry("GET /api/v1/ghost/:id")]), DERIVED);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("STALE") && e.includes("ghost"))).toBe(true);
    }
  });

  it("fails on a non-object entry", () => {
    const result = validateRegisterDocument(doc(["not-an-object"]), DERIVED);
    expect(result.ok).toBe(false);
  });

  // ── Field rules: params required for 'probe', rejected elsewhere ───────────────────────────────
  it("fails a 'probe' entry with no params", () => {
    const result = validateRegisterDocument(doc([entry(ROUTE, { category: "probe" })]), DERIVED);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errors.some((e) => e.includes("'params' is required"))).toBe(true);
  });

  it("passes a 'probe' entry whose params exactly match the route's path parameter(s)", () => {
    const result = validateRegisterDocument(
      doc([entry(ROUTE, { category: "probe", params: { employeeId: "employee" } })]),
      DERIVED,
    );
    expect(result.ok).toBe(true);
  });

  it("fails a 'probe' entry whose params is missing a key for a real path parameter", () => {
    const twoParamRoute = "DELETE /api/v1/company-shutdowns/:id/exceptions/:employeeId";
    const result = validateRegisterDocument(
      doc([entry(twoParamRoute, { category: "probe", params: { employeeId: "employee" } })]),
      [twoParamRoute],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.includes("missing key"))).toBe(true);
  });

  it("fails a 'probe' entry whose params has an extra key not present as a path parameter", () => {
    const result = validateRegisterDocument(
      doc([
        entry(ROUTE, {
          category: "probe",
          params: { employeeId: "employee", extra: "ghost" },
        }),
      ]),
      DERIVED,
    );
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errors.some((e) => e.includes("not present as a path parameter"))).toBe(true);
  });

  it("fails a non-'probe' entry that sets params", () => {
    const result = validateRegisterDocument(
      doc([entry(ROUTE, { category: "nicht anwendbar", params: { employeeId: "employee" } })]),
      DERIVED,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("'params' must be null"))).toBe(true);
    }
  });

  // ── Field rules: ticket + validatedAt required for 'bekannt-abweichend', rejected elsewhere ─────
  it("fails a 'bekannt-abweichend' entry with no ticket", () => {
    const result = validateRegisterDocument(
      doc([entry(ROUTE, { category: "bekannt-abweichend", validatedAt: "2026-09-22" })]),
      DERIVED,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.includes("'ticket' must be"))).toBe(true);
  });

  it("fails a 'bekannt-abweichend' entry with no validatedAt", () => {
    const result = validateRegisterDocument(
      doc([entry(ROUTE, { category: "bekannt-abweichend", ticket: 310 })]),
      DERIVED,
    );
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errors.some((e) => e.includes("'validatedAt' must be"))).toBe(true);
  });

  it("passes a 'bekannt-abweichend' entry with both ticket and validatedAt", () => {
    const result = validateRegisterDocument(
      doc([
        entry(ROUTE, { category: "bekannt-abweichend", ticket: 310, validatedAt: "2026-09-22" }),
      ]),
      DERIVED,
    );
    expect(result.ok).toBe(true);
  });

  it("fails a 'probe' entry that sets ticket/validatedAt", () => {
    const result = validateRegisterDocument(
      doc([
        entry(ROUTE, {
          category: "probe",
          params: { employeeId: "employee" },
          ticket: 1,
          validatedAt: "2026-09-22",
        }),
      ]),
      DERIVED,
    );
    expect(result.ok).toBe(false);
  });

  it("fails a 'nicht anwendbar' entry that sets ticket/validatedAt", () => {
    const result = validateRegisterDocument(
      doc([entry(ROUTE, { category: "nicht anwendbar", ticket: 1, validatedAt: "2026-09-22" })]),
      DERIVED,
    );
    expect(result.ok).toBe(false);
  });

  it("validates a clean, consistent register", () => {
    const result = validateRegisterDocument(
      doc([entry(ROUTE, { category: "probe", params: { employeeId: "employee" } })]),
      DERIVED,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.doc.entries).toHaveLength(1);
  });
});

describe("diffRegisterAgainstRoutes", () => {
  const DERIVED = ["GET /api/v1/a/:id", "GET /api/v1/b/:id", "GET /api/v1/c/:id"];

  it("fails and names a derived route with no register entry", () => {
    const result = diffRegisterAgainstRoutes([entry(DERIVED[0]), entry(DERIVED[1])], DERIVED);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.includes(DERIVED[2]))).toBe(true);
  });

  it("passes when entries and derived routes match exactly", () => {
    const result = diffRegisterAgainstRoutes(
      DERIVED.map((r) => entry(r)),
      DERIVED,
    );
    expect(result.ok).toBe(true);
  });

  it("reports every missing route, not only the first", () => {
    const result = diffRegisterAgainstRoutes([entry(DERIVED[0])], DERIVED);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.filter((e) => e.includes("no register entry"))).toHaveLength(2);
    }
  });
});

describe("findExpiredDeviations", () => {
  const NOW = "2026-09-22T00:00:00.000Z";

  function deviationDatedDaysBeforeNow(days: number): RegisterEntry {
    const validatedAt = addDays(NOW, -days).slice(0, 10);
    return entry("GET /api/v1/ghost/:id", {
      category: "bekannt-abweichend",
      ticket: 999,
      validatedAt,
    });
  }

  it("does not expire a deviation exactly at the 89-day mark", () => {
    const result = findExpiredDeviations(
      [deviationDatedDaysBeforeNow(89)],
      NOW,
      DEFAULT_MAX_DEVIATION_AGE_DAYS,
    );
    expect(result.ok).toBe(true);
  });

  it("does not expire a deviation exactly at the 90-day boundary", () => {
    const result = findExpiredDeviations(
      [deviationDatedDaysBeforeNow(90)],
      NOW,
      DEFAULT_MAX_DEVIATION_AGE_DAYS,
    );
    expect(result.ok).toBe(true);
  });

  it("expires a deviation at 91 days — one day past the boundary", () => {
    const result = findExpiredDeviations(
      [deviationDatedDaysBeforeNow(91)],
      NOW,
      DEFAULT_MAX_DEVIATION_AGE_DAYS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toContain("ghost");
  });

  it("ignores non-'bekannt-abweichend' entries entirely", () => {
    const result = findExpiredDeviations(
      [entry("GET /api/v1/fine/:id", { category: "nicht anwendbar" })],
      NOW,
      DEFAULT_MAX_DEVIATION_AGE_DAYS,
    );
    expect(result.ok).toBe(true);
  });
});
