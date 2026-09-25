/**
 * Phase 259 Plan 03 (Issue #259, D-03b/D-03c/D-07) — the behavioral half of the T-100-09 checker.
 * Plan 259-02 built the completeness half (`apps/api/scripts/lint-t100-09-routes.ts` +
 * `lint-t100-09-routes.json`): every route with a path parameter must carry a checked-in
 * classification. This file answers the other question: does every route classified `probe`
 * actually BEHAVE the way T-100-09 requires — a foreign tenant's real entity and an id that exists
 * nowhere must be indistinguishable to the caller?
 *
 * ── Why this file re-derives the route set instead of importing the script's version ────────────
 * `apps/api/tsconfig.json` sets `rootDir: "./src"` — a file under `src/__tests__/` that imports
 * from `apps/api/scripts/` breaks `pnpm --filter @clokr/api typecheck`. This file therefore does
 * its OWN small source-text walk (mirroring `readdirSync`/`readFileSync` over
 * `apps/api/src/contexts/*\/api/**\/*.ts`, then `app.ts`'s import bindings + `app.register(...)`
 * calls for the prefix map), then asserts its own derived set equals the register's route set in
 * BOTH directions. Two independent implementations anchored to the same checked-in register mean a
 * bug in one cannot mask itself in the other — see `absence-vocabulary-guard.test.ts`'s own G2 for
 * the same "ground truth is the parsed source, not a local mirror" argument (98-01-SUMMARY.md).
 *
 * ── D-03c — this file's own anti-vacuity proof ────────────────────────────────────────────────────
 * `derivedPathParamRoutes.length > 0` is asserted before anything else. That is both the proof this
 * probe's own walked set is non-empty AND the exact shape (`readdirSync`-derived binding, chained
 * through `.filter`, checked with `expect(x.length).toBeGreaterThan(0)`) `lint-guard-vacuity.ts`'s
 * classifier recognises as `input-proof:length` — see `absence-vocabulary-guard.test.ts:208` and
 * `leave-type-identity-guard.test.ts:57` for the same idiom, both already classified `guard` today.
 *
 * On today's tree this checker finds nothing to fix: all 30 `probe` routes already conform (259-01
 * closed the first gap, in `avatars.ts`'s POST handler; a quick task closed the remaining two,
 * Issues #309/#310, folding their fixtures into this same describe block's `beforeAll`). Its only
 * functional proof beyond that is the rollback demonstration recorded in 259-03-SUMMARY.md plus
 * the two reverts recorded for #309/#310 — this file has no red-proof mechanism of its own beyond
 * those recorded, once-performed observations (D-03c).
 *
 * ── D-07 — a mutual non-404 is a failure, never a pass ────────────────────────────────────────────
 * `PATCH /leave/requests/:id/review` (`leave.ts:983`, classified `bekannt-abweichend`, Issue #309)
 * is the measured case that motivated this rule: its body schema is validated BEFORE the tenant
 * check, so a bodyless probe gets a mutual 400 on both arms — byte-identical, and a checker that
 * only compares bytes would call that "conform" without the guard ever running. The sweep below
 * requires BOTH arms to be exactly 404 with byte-equal bodies; any other agreeing status is reported
 * as AMBIGUOUS, naming the route, both statuses, and both bodies.
 *
 * ── Issue #333 — the same sweep, with an API-key bearer instead of a JWT ─────────────────────────
 * Before #333's fix, an API-key caller's `apikey:<id>` subject failed the AuditLog.userId foreign
 * key on the very `CROSS_TENANT_ACCESS_DENIED` audit write this probe's tenant guard makes, turning
 * an otherwise-identical 404 into a 500 — a tenant-membership oracle the original JWT-only sweep
 * could not see. `runOracleSweep()` below is the JWT sweep's own loop body, extracted so it can run
 * unchanged a second time against `tenantA`'s admin-scoped API key. Both sweeps hit the SAME
 * fixtures; that is safe only because a conformant tenant guard rejects before any mutation runs
 * (proven by the "fixture integrity after the sweep" tests further down), so two passes against the
 * same foreign-tenant rows cannot compound state.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";
import { DEFAULT_SALON_OPENING_HOURS } from "../contexts/platform/facade/salons";
import { normalizeRolePermissions, roleNameKey } from "../contexts/platform";
import type { FastifyInstance } from "fastify";

// A narrower union than fastify's own `HTTPMethods` (which also includes "trace") — this probe
// only ever sends the five verbs the register's routes are classified under, and `app.inject`'s
// own `InjectOptions["method"]` type (from `light-my-request`) is not identical to fastify's
// route-registration `HTTPMethods`, so a local, exact-fit type avoids reconciling the two.
type ProbeMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

// __dirname is apps/api/src/__tests__ — four levels up is the repo root, same resolution as
// absence-vocabulary-guard.test.ts and leave-type-identity-guard.test.ts.
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const REGISTER_PATH = join(REPO_ROOT, "apps/api/scripts/lint-t100-09-routes.json");
const APP_TS_PATH = join(REPO_ROOT, "apps/api/src/app.ts");
const CONTEXTS_DIR = join(REPO_ROOT, "apps/api/src/contexts");

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

// ── This probe's own, independent route derivation ─────────────────────────────────────────────
// Deliberately NOT imported from lint-t100-09-routes-validate.ts (see module docblock). Named
// `function` declarations throughout (not arrow constants) — readdirSync calls must sit inside a
// named function for the classifications below to hold, the same house convention
// lint-t100-09-routes.ts's own docblock states for the same reason.

/** Recursively collects every `.ts` route file under `dir`, skipping `__tests__` directories and
 * `*.test.ts` files. */
function walkApiTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__") continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkApiTsFiles(abs));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(abs);
    }
  }
  return out;
}

/** Every `apps/api/src/contexts/<context>/api/` directory that exists. */
function discoverRouteFiles(): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(CONTEXTS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const apiDir = join(CONTEXTS_DIR, entry.name, "api");
    if (!existsSync(apiDir)) continue;
    out.push(...walkApiTsFiles(apiDir));
  }
  return out.sort();
}

interface RouteDeclaration {
  method: string;
  path: string;
  fn: string;
}

/** Finds every `app.<method>("<path>"` call (newline-tolerant between the open-paren and the
 * opening quote — the shape `company-shutdowns.ts:183` uses) and attributes it to the nearest
 * PRECEDING `export async function <name>(` declaration in the same file — a start-offset
 * bucketing, immune to `{`/`}` characters inside regex literals or zod schema bodies ahead of the
 * route function, because it never counts braces at all. */
function declarationsInFile(absPath: string): RouteDeclaration[] {
  const text = readFileSync(absPath, "utf8");

  const fnStarts: { name: string; at: number }[] = [];
  const fnDeclPattern = /export\s+async\s+function\s+([A-Za-z0-9_]+)\s*\(/g;
  let fnMatch: RegExpExecArray | null;
  while ((fnMatch = fnDeclPattern.exec(text))) {
    fnStarts.push({ name: fnMatch[1], at: fnMatch.index });
  }

  const methodAlternation = HTTP_METHODS.join("|");
  const routeCallPattern = new RegExp(
    `app\\.(${methodAlternation})\\(\\s*\\n?\\s*["'\`]([^"'\`]+)["'\`]`,
    "g",
  );
  const declarations: RouteDeclaration[] = [];
  let routeMatch: RegExpExecArray | null;
  while ((routeMatch = routeCallPattern.exec(text))) {
    let owner = "";
    for (const fn of fnStarts) {
      if (fn.at < routeMatch.index) owner = fn.name;
    }
    declarations.push({
      method: routeMatch[1].toUpperCase(),
      path: routeMatch[2],
      fn: owner,
    });
  }
  return declarations;
}

/** Resolves every exported route-function name to its registration prefix in `app.ts`, reading
 * BOTH the named-import statements (multi-line-tolerant, alias-aware — `shift-patterns.ts`'s two
 * functions imported in one multi-line block) AND the `app.register(<fn>, { prefix: "…" })` calls,
 * joined through the import binding so a renamed local identifier still resolves to the route
 * file's own export name. */
function derivePrefixMap(): Map<string, string> {
  const appText = readFileSync(APP_TS_PATH, "utf8");

  const bindingToExportName = new Map<string, string>();
  const importPattern = /import\s*\{([\s\S]*?)\}\s*from\s*["'][^"']+["']/g;
  let importMatch: RegExpExecArray | null;
  while ((importMatch = importPattern.exec(appText))) {
    for (const rawItem of importMatch[1].split(",")) {
      const item = rawItem.trim();
      if (!item) continue;
      const aliasMatch = item.match(/^([A-Za-z0-9_]+)\s+as\s+([A-Za-z0-9_]+)$/);
      if (aliasMatch) {
        bindingToExportName.set(aliasMatch[2], aliasMatch[1]);
      } else if (/^[A-Za-z0-9_]+$/.test(item)) {
        bindingToExportName.set(item, item);
      }
    }
  }

  const prefixMap = new Map<string, string>();
  const registerCallPattern = /app\.register\(\s*([A-Za-z0-9_]+)\s*,\s*\{([\s\S]*?)\}\s*\)/g;
  let registerMatch: RegExpExecArray | null;
  while ((registerMatch = registerCallPattern.exec(appText))) {
    const binding = registerMatch[1];
    const prefixMatch = registerMatch[2].match(/prefix:\s*["']([^"']+)["']/);
    if (!prefixMatch) continue;
    const exportName = bindingToExportName.get(binding) ?? binding;
    prefixMap.set(exportName, prefixMatch[1]);
  }
  return prefixMap;
}

/** Joins the two derivations above into the full `"<METHOD> <url>"` set. An exported route
 * function with no resolvable prefix is an ERROR — never a silently dropped route (mirrors
 * lint-t100-09-routes-validate.ts's `joinRoutes`, independently implemented here). */
function deriveAllRoutes(): string[] {
  const prefixMap = derivePrefixMap();
  const routes = new Set<string>();
  const unresolved = new Set<string>();

  for (const file of discoverRouteFiles()) {
    for (const decl of declarationsInFile(file)) {
      const prefix = prefixMap.get(decl.fn);
      if (prefix === undefined) {
        unresolved.add(decl.fn || "<module-level, no enclosing exported function>");
        continue;
      }
      const url = decl.path === "/" ? prefix : `${prefix}${decl.path}`;
      routes.add(`${decl.method} ${url}`);
    }
  }

  if (unresolved.size > 0) {
    throw new Error(
      `t100-09-oracle-probe: could not resolve a registration prefix for exported route ` +
        `function(s): ${[...unresolved].sort().join(", ")}`,
    );
  }

  return [...routes].sort();
}

/** A URL segment beginning with `:` — the same membership rule D-05 fixes for the register. */
function hasPathParameter(route: string): boolean {
  const url = route.split(" ")[1] ?? "";
  return url.split("/").some((segment) => segment.startsWith(":"));
}

const derivedAllRoutes = deriveAllRoutes();
const derivedPathParamRoutes = derivedAllRoutes.filter(hasPathParameter);

// ── The checked-in register (259-02's output) ───────────────────────────────────────────────────

interface RegisterEntry {
  route: string;
  file: string;
  category: "probe" | "nicht anwendbar" | "bekannt-abweichend";
  params: Record<string, string> | null;
  minimalBody: Record<string, unknown> | null;
  reason: string;
  ticket: number | null;
  validatedAt: string | null;
}

interface RegisterDocument {
  registerSource: string;
  entries: RegisterEntry[];
}

const registerDoc = JSON.parse(readFileSync(REGISTER_PATH, "utf8")) as RegisterDocument;
const registerRoutes = registerDoc.entries.map((e) => e.route).sort();
const probeEntries = registerDoc.entries.filter((e) => e.category === "probe");

// GET /overtime/month-saldo/:employeeId requires `year`/`month` query params on BOTH arms —
// otherwise its own required-query z.coerce.number() schema (overtime.ts:1854-1859) 400s before
// the tenant guard ever runs, the same D-07 failure shape on the query channel instead of the
// body. minimalBody in the register is null for this route (it is a GET with no body at all), so
// this is handled here, not through the register's minimalBody field.
const MONTH_SALDO_ROUTE = "GET /api/v1/overtime/month-saldo/:employeeId";

/** Any DELETE, or any route whose path names a hard-delete step, runs LAST — after every
 * read-shaped route — so a genuinely broken guard damages only this probe's own disposable
 * fixture employee and the earlier, read-only results stay trustworthy. */
function isDestructiveRoute(route: string): boolean {
  return route.startsWith("DELETE ") || route.includes("hard-delete");
}

const orderedProbeEntries = [...probeEntries].sort((a, b) => {
  const destructiveA = isDestructiveRoute(a.route) ? 1 : 0;
  const destructiveB = isDestructiveRoute(b.route) ? 1 : 0;
  return destructiveA - destructiveB;
});

type FixtureBundle = Awaited<ReturnType<typeof seedTestData>>;

// ── Fixture rows the base `seedTestData` bundle does not carry (Issue #309/#310) ───────────────
// `seedTestData` (setup.ts) is shared by ~277 test files; adding a LeaveRequest/TimeEntry row to
// it would change row counts under list-endpoint assertions across the whole suite. Both rows are
// created locally in the `behavioral sweep` describe's own `beforeAll` below instead, and their
// ids are stashed here so `fixtureValueFor` (which only ever resolves keys for tenantB, the sole
// foreign-tenant bundle passed into it by the sweep) can hand them out.
let tenantBLeaveRequestId: string | undefined;
let tenantBTimeEntryId: string | undefined;
// Phase 64b Plan 02 (Issue #64, Pitfall 4): a real Salon for tenantB, same local-fixture idiom as
// the two above. `seedTestData` now creates its own active default salon (Phase 67b Plan 03,
// D-24), but this SECOND, dedicated salon is still created here — the register's `salon` fixture
// key needs an id independent of that default (e.g. WR-04's activate/deactivate probes act on it
// directly, and tenantB now has TWO active salons, which strengthens rather than weakens that
// reasoning: see t100-09 fixture-integrity check below).
let tenantBSalonId: string | undefined;
// Phase 64b review (WR-04): an INACTIVE Salon for tenantB, the target of POST /:id/activate — an
// active target could never be flipped by activate (ALREADY_ACTIVE), so the integrity check below
// could not see a guard that answers 404 while still activating.
let tenantBInactiveSalonId: string | undefined;
let tenantBInactiveSalonDeactivatedAt: Date | undefined;

// Phase 73b Plan 02 (Issue #73): a real tenantB customer AccessRole, so the three /roles/:id
// probe entries have a foreign-tenant row to sweep against — system roles (tenantId null) are
// visible to every tenant by design and would not exercise the tenant guard at all.
let tenantBCustomRoleId: string | undefined;

// Phase 74b Plan 02 (Issue #74): a real tenantB RoleAssignment, so the three
// /role-assignments/:id probe entries have a foreign-tenant row to sweep against.
let tenantBRoleAssignmentId: string | undefined;

// Phase 67b Plan 02 (Issue #67, D-19): a real tenantB EmployeeSalonAssignment for the two-param
// `end` route. A DEPLOYMENT, never HOME (D-05's HOME_SALON_IN_USE rule, plan 05, could otherwise
// mask a broken deactivate guard against a HOME row of the same shape).
let tenantBSalonAssignmentId: string | undefined;

/** Resolves a register `params` fixture key to the foreign tenant's real entity id. `null` means
 * the key is unrecognised — the caller must fail loudly, never silently skip the route (D-03).
 * Today's vocabulary is exactly these NINE keys: `employee`/`leaveType` from the shared
 * `seedTestData` bundle, `leaveRequest`/`timeEntry`/`salon`/`salonInactive`/`customRole`/
 * `roleAssignment`/`salonAssignment` from the locally created fixtures (Issue #309/#310, Phase
 * 64b, Issue #73, Issue #74, Phase 67b Plan 02) — a register entry naming a tenth one this probe
 * does not implement is exactly the failure this function surfaces. */
function fixtureValueFor(bundle: FixtureBundle, fixtureKey: string): string | null {
  if (fixtureKey === "employee") return bundle.employee.id;
  if (fixtureKey === "leaveType") return bundle.vacationType.id;
  if (fixtureKey === "leaveRequest") return tenantBLeaveRequestId ?? null;
  if (fixtureKey === "timeEntry") return tenantBTimeEntryId ?? null;
  if (fixtureKey === "salon") return tenantBSalonId ?? null;
  if (fixtureKey === "salonInactive") return tenantBInactiveSalonId ?? null;
  if (fixtureKey === "customRole") return tenantBCustomRoleId ?? null;
  if (fixtureKey === "roleAssignment") return tenantBRoleAssignmentId ?? null;
  if (fixtureKey === "salonAssignment") return tenantBSalonAssignmentId ?? null;
  return null;
}

async function sendProbe(
  app: FastifyInstance,
  method: ProbeMethod,
  url: string,
  token: string,
  minimalBody: Record<string, unknown> | null,
) {
  if (minimalBody === null) {
    return app.inject({ method, url, headers: { authorization: `Bearer ${token}` } });
  }
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    payload: JSON.stringify(minimalBody),
  });
}

describe("T-100-09 oracle probe — every `probe`-classified route, twice, byte-compared (Issue #259, D-03b/D-07)", () => {
  it("the source-parsed derivation finds a non-empty path-parameter route set before anything else is asserted (D-03c) — this is the proof lint-guard-vacuity classifies as `guard` via input-proof:length", () => {
    expect(derivedPathParamRoutes.length).toBeGreaterThan(0);
  });

  it("the derived route set and the checked-in register are identical in both directions (D-03a) — a route this parser finds with no register entry, or a stale entry for a route that no longer exists, is a defect to fix, never a silent mismatch", () => {
    const derivedSet = new Set(derivedPathParamRoutes);
    const registerSet = new Set(registerRoutes);
    const missingFromRegister = derivedPathParamRoutes.filter((r) => !registerSet.has(r));
    const staleInRegister = registerRoutes.filter((r) => !derivedSet.has(r));
    expect({ missingFromRegister, staleInRegister }).toEqual({
      missingFromRegister: [],
      staleInRegister: [],
    });
  });

  it("at least one route is classified `probe` in the register — a register in which nothing is probed is a failure, not a quiet pass", () => {
    expect(probeEntries.length).toBeGreaterThan(0);
  });

  describe("behavioral sweep — foreign-tenant id vs. unknown id, byte-compared", () => {
    let app: FastifyInstance;
    let tenantA: FixtureBundle;
    let tenantB: FixtureBundle;
    // Issue #333: an admin-scoped API key for tenantA, so the sweep below can run a second time
    // with a `clk_` bearer instead of a JWT — same permission reach as tenantA.adminToken
    // (request-permissions.ts maps the "admin" scope to the ADMIN system role), but a subject
    // shaped `apikey:<id>` rather than a User.id.
    let tenantAApiKeyToken: string;

    beforeAll(async () => {
      app = await getTestApp();
      tenantA = await seedTestData(app, "t10009-a");
      tenantB = await seedTestData(app, "t10009-b");

      const rawApiKey = `clk_${randomBytes(24).toString("hex")}`;
      await app.prisma.apiKey.create({
        data: {
          tenantId: tenantA.tenant.id,
          name: "t10009-api-key",
          keyHash: createHash("sha256").update(rawApiKey).digest("hex"),
          keyPrefix: rawApiKey.slice(0, 8),
          scopes: ["admin"],
          createdBy: tenantA.adminUser.id,
        },
      });
      tenantAApiKeyToken = rawApiKey;

      // Issue #309 fixture: a real, PENDING LeaveRequest owned by tenantB's employee. Fixed
      // dates (not `toISOString().slice(0,10)`-relative — this project's known time-bomb fixture
      // shape) are safe here because both probe arms return from the tenant guard before any
      // date-dependent code path runs; the row's only job is to EXIST as a foreign-tenant entity.
      const leaveRequest = await app.prisma.leaveRequest.create({
        data: {
          employeeId: tenantB.employee.id,
          leaveTypeId: tenantB.vacationType.id,
          status: "PENDING",
          days: 1,
          startDate: new Date("2026-01-05"),
          endDate: new Date("2026-01-05"),
        },
      });
      tenantBLeaveRequestId = leaveRequest.id;

      // Issue #310 fixture: a real, closed TimeEntry owned by tenantB's employee (same
      // direct-create idiom as tenant-isolation.test.ts's cross-tenant clock-out fixture).
      const timeEntry = await app.prisma.timeEntry.create({
        data: {
          employeeId: tenantB.employee.id,
          date: new Date("2026-01-05"),
          startTime: new Date("2026-01-05T08:00:00.000Z"),
          endTime: new Date("2026-01-05T16:00:00.000Z"),
          salonId: tenantB.salonId, // Phase 68b (issue #68)
        },
      });
      tenantBTimeEntryId = timeEntry.id;

      // Phase 64b Plan 02 (Issue #64) fixture: a real, active Salon owned by tenantB, the target
      // of GET, PATCH and POST /:id/deactivate.
      const salon = await app.prisma.salon.create({
        data: {
          tenantId: tenantB.tenant.id,
          name: "T-100-09 Salon",
          openingHours: DEFAULT_SALON_OPENING_HOURS,
          isActive: true,
        },
      });
      tenantBSalonId = salon.id;

      // Phase 64b review (WR-04): with only one active salon, a deactivate that bypassed the
      // tenant guard would still stop at LAST_ACTIVE_SALON and never change a row, so the integrity
      // check could not go red. Both tenants get a second active salon, so the last-salon rule
      // lets the deactivation through whichever tenant a broken guard counts against — the
      // caller's (tenantA) or the salon owner's (tenantB).
      const salon2 = await app.prisma.salon.create({
        data: {
          tenantId: tenantB.tenant.id,
          name: "T-100-09 Salon 2",
          openingHours: DEFAULT_SALON_OPENING_HOURS,
          isActive: true,
        },
      });

      // Phase 67b Plan 02 (Issue #67, D-19): a real tenantB DEPLOYMENT assignment (never HOME —
      // plan 05's HOME_SALON_IN_USE rule could otherwise mask a broken deactivate guard), the
      // target of the two-param `end` route.
      const salonAssignment = await app.prisma.employeeSalonAssignment.create({
        data: {
          tenantId: tenantB.tenant.id,
          employeeId: tenantB.employee.id,
          salonId: salon2.id,
          kind: "DEPLOYMENT",
          validFrom: new Date("2026-01-05"),
          validUntil: null,
          weekdays: [0],
        },
      });
      tenantBSalonAssignmentId = salonAssignment.id;
      for (const name of ["T-100-09 Salon A1", "T-100-09 Salon A2"]) {
        await app.prisma.salon.create({
          data: {
            tenantId: tenantA.tenant.id,
            name,
            openingHours: DEFAULT_SALON_OPENING_HOURS,
            isActive: true,
          },
        });
      }

      // Phase 64b review (WR-04): the target of POST /:id/activate — see tenantBInactiveSalonId.
      tenantBInactiveSalonDeactivatedAt = new Date("2026-01-05T12:00:00.000Z");
      const inactiveSalon = await app.prisma.salon.create({
        data: {
          tenantId: tenantB.tenant.id,
          name: "T-100-09 Salon inaktiv",
          openingHours: DEFAULT_SALON_OPENING_HOURS,
          isActive: false,
          deactivatedAt: tenantBInactiveSalonDeactivatedAt,
        },
      });
      tenantBInactiveSalonId = inactiveSalon.id;
      // Issue #73 fixture: a real tenantB customer AccessRole (Phase 73b Plan 02).
      const customRole = await app.prisma.accessRole.create({
        data: {
          tenantId: tenantB.tenant.id,
          name: "T10009 Probe-Rolle",
          nameKey: "t10009 probe-rolle",
          permissions: ["role:read:ZUGEWIESEN"],
        },
      });
      tenantBCustomRoleId = customRole.id;

      // Issue #74 fixture: a real tenantB RoleAssignment (Phase 74b Plan 02), reusing the
      // customRole fixture above — no new AccessRole needed.
      const roleAssignment = await app.prisma.roleAssignment.create({
        data: {
          tenantId: tenantB.tenant.id,
          userId: tenantB.adminUser.id,
          accessRoleId: tenantBCustomRoleId,
          scopeType: "TENANT",
          salonIds: [],
          employeeIds: [],
        },
      });
      tenantBRoleAssignmentId = roleAssignment.id;

      // Phase 65b Plan 03 (Issue #65, D-16) fixture: a real PHOREST coupling on tenantB's active
      // Salon — the target of DELETE /phorest/couplings/:salonId. Reuses the "salon" fixture key
      // (tenantBSalonId) — the eight-key vocabulary does not grow.
      await app.prisma.salonCoupling.create({
        data: {
          tenantId: tenantB.tenant.id,
          salonId: tenantBSalonId!,
          provider: "PHOREST",
          externalBranchId: "t10009-branch",
        },
      });
    });

    afterAll(async () => {
      try {
        await cleanupTestData(app, tenantA.tenant.id);
      } catch (err) {
        console.error("Cleanup tenantA failed:", err);
      }
      try {
        await cleanupTestData(app, tenantB.tenant.id);
      } catch (err) {
        console.error("Cleanup tenantB failed:", err);
      }
    });

    /** The sweep body shared by the JWT run and the API-key run (Issue #333): every `probe` route,
     * foreign-tenant id vs. unknown id, byte-compared. `token` is the only thing that varies. */
    async function runOracleSweep(token: string): Promise<string[]> {
      const failures: string[] = [];
      let unknownCounter = 0;

      for (const entry of orderedProbeEntries) {
        const [method, urlTemplate] = entry.route.split(" ");
        const params = entry.params ?? {};
        const paramNames = Object.keys(params);

        if (paramNames.length === 0) {
          failures.push(
            `${entry.route}: classified 'probe' but carries no 'params' in the register — cannot ` +
              `build a request.`,
          );
          continue;
        }

        let foreignUrl = urlTemplate;
        let unknownUrl = urlTemplate;
        let badFixtureKey: string | null = null;

        for (const paramName of paramNames) {
          const fixtureKey = params[paramName];
          const foreignValue = fixtureValueFor(tenantB, fixtureKey);
          if (foreignValue === null) {
            badFixtureKey = fixtureKey;
            break;
          }
          unknownCounter += 1;
          // One distinct literal per parameter position, so two path parameters in one URL
          // cannot collide on the same unknown id. Shaped as a version-4/variant-8 UUID
          // (`4`/`8` in the fixed positions) rather than the all-zero family sec-08/sec-09 use
          // for their single-param routes: employees.ts's idParamSchema = z.string().uuid()
          // only special-cases the two literal all-zero/all-f UUIDs, and 400s any other string
          // that is not version/variant-correct — a mutual 400 on that schema mismatch alone
          // would masquerade as an "ambiguous" T-100-09 finding for a reason that has nothing to
          // do with tenant isolation. A real-shaped-but-nonexistent UUID reaches the guard on
          // every probed route, strict-schema or not (Prisma's own findUnique does not care
          // about UUID format either way, so this is a strict superset of what the all-zero
          // family already covered).
          const unknownValue = `00000000-0000-4000-8000-${String(unknownCounter).padStart(12, "0")}`;
          foreignUrl = foreignUrl.replace(`:${paramName}`, foreignValue);
          unknownUrl = unknownUrl.replace(`:${paramName}`, unknownValue);
        }

        if (badFixtureKey !== null) {
          failures.push(
            `${entry.route}: unrecognised fixture key '${badFixtureKey}' in the register's ` +
              `'params' — this probe does not know how to produce a foreign-tenant instance for ` +
              `it. An unrecognised fixture key is its own failure, never a silently skipped route ` +
              `(D-03).`,
          );
          continue;
        }

        const query = entry.route === MONTH_SALDO_ROUTE ? "?year=2026&month=1" : "";

        const [foreignRes, unknownRes] = await Promise.all([
          sendProbe(app, method as ProbeMethod, foreignUrl + query, token, entry.minimalBody),
          sendProbe(app, method as ProbeMethod, unknownUrl + query, token, entry.minimalBody),
        ]);

        const bothNotFound = foreignRes.statusCode === 404 && unknownRes.statusCode === 404;
        const bytesEqual = foreignRes.body === unknownRes.body;

        if (!bothNotFound || !bytesEqual) {
          const sameStatusButNotFound =
            foreignRes.statusCode === unknownRes.statusCode && !bothNotFound;
          failures.push(
            `${entry.route}: ${
              sameStatusButNotFound
                ? "AMBIGUOUS — both arms answered with the same non-404 status, which looks like a " +
                  "pass but proves nothing about tenant isolation (D-07); a mutual 400 from " +
                  "body-schema validation running before the tenant check is exactly this shape"
                : "MISMATCH — the two arms are distinguishable"
            }. foreign (${foreignUrl}) -> ${foreignRes.statusCode} ${foreignRes.body}; unknown ` +
              `(${unknownUrl}) -> ${unknownRes.statusCode} ${unknownRes.body}. Fix: classify this ` +
              `route explicitly in lint-t100-09-routes.json — 'probe' with a corrected ` +
              `minimalBody, or 'nicht anwendbar' with a measured reason. Do not accept this result.`,
          );
        }
      }

      return failures;
    }

    it(`sweeps all ${probeEntries.length} probe route(s) against a foreign-tenant id and an unknown id with tenantA's ADMIN token — destructive routes run last so a broken guard only ever damages this probe's own disposable fixture (D-03b/D-07); every mismatch or ambiguity accumulates and is reported together so one non-conformant route does not hide the rest`, async () => {
      const failures = await runOracleSweep(tenantA.adminToken);
      expect(failures.join("\n\n")).toBe("");
    });

    it(`sweeps all ${probeEntries.length} probe route(s) a second time with tenantA's admin-scoped API key instead of a JWT (Issue #333) — before the fix, the CROSS_TENANT_ACCESS_DENIED audit write on a foreign-tenant hit failed the AuditLog.userId foreign key (apikey:<id> is not a User.id), turning the 404 into a distinguishable 500; same fixtures, same guard, only the caller's subject shape differs`, async () => {
      const failures = await runOracleSweep(tenantAApiKeyToken);
      expect(failures.join("\n\n")).toBe("");
    });

    it("fixture integrity after the sweep: tenantB's employee still exists, was never anonymized (soft-deleted), and its avatarPath is unchanged — a guard that answers 404 while still performing the mutation would otherwise pass the byte comparison", async () => {
      const after = await app.prisma.employee.findUnique({ where: { id: tenantB.employee.id } });
      expect(after).not.toBeNull();
      expect(after?.firstName).not.toBe("Gelöscht");
      expect(after?.avatarPath).toBeNull();
    });

    it("fixture integrity after the sweep: tenantB's LeaveRequest (Issue #309) is still PENDING with unchanged dates and note — a guard that answers 404 while still performing the PATCH would otherwise pass the byte comparison", async () => {
      const after = await app.prisma.leaveRequest.findUnique({
        where: { id: tenantBLeaveRequestId },
      });
      expect(after).not.toBeNull();
      expect(after?.status).toBe("PENDING");
      expect(after?.startDate.toISOString().slice(0, 10)).toBe("2026-01-05");
      expect(after?.endDate.toISOString().slice(0, 10)).toBe("2026-01-05");
      expect(after?.note).toBeNull();
    });

    it("fixture integrity after the sweep: tenantB's TimeEntry (Issue #310) still has zero Break rows, breakMinutes 0, and an unchanged breakStatus — a guard that answers 404 while still performing the POST would otherwise pass the byte comparison", async () => {
      const after = await app.prisma.timeEntry.findUnique({ where: { id: tenantBTimeEntryId } });
      expect(after).not.toBeNull();
      expect(after?.breakMinutes).toBe(0);
      expect(after?.breakStatus).toBe("CONFIRMED");
      const breakCount = await app.prisma.break.count({
        where: { timeEntryId: tenantBTimeEntryId },
      });
      expect(breakCount).toBe(0);
    });

    it("fixture integrity after the sweep: tenantB's active Salon (Phase 64b) still has name 'T-100-09 Salon', isActive true, and deactivatedAt null — a guard that answers 404 while still performing the PATCH or the deactivate would otherwise pass the byte comparison (tenantB and tenantA each have a second active salon, so a bypassed deactivate is not stopped by the last-salon rule)", async () => {
      const after = await app.prisma.salon.findUnique({ where: { id: tenantBSalonId } });
      expect(after).not.toBeNull();
      expect(after?.name).toBe("T-100-09 Salon");
      expect(after?.isActive).toBe(true);
      expect(after?.deactivatedAt).toBeNull();
    });

    it("fixture integrity after the sweep: tenantB's inactive Salon (Phase 64b review, WR-04) is still inactive with its original deactivatedAt — a guard that answers 404 while still performing the activate would otherwise pass the byte comparison", async () => {
      const after = await app.prisma.salon.findUnique({ where: { id: tenantBInactiveSalonId } });
      expect(after).not.toBeNull();
      expect(after?.isActive).toBe(false);
      expect(after?.deactivatedAt?.toISOString()).toBe(
        tenantBInactiveSalonDeactivatedAt?.toISOString(),
      );
    });

    it("fixture integrity after the sweep: tenantB's AccessRole (Issue #73) still exists with unchanged name, nameKey and permissions, and tenantA has zero AccessRole rows of its own from this sweep — a guard that answers 404 while still performing the PATCH, DELETE or copy would otherwise pass the byte comparison", async () => {
      const after = await app.prisma.accessRole.findUnique({ where: { id: tenantBCustomRoleId } });
      expect(after).not.toBeNull();
      expect(after?.name).toBe("T10009 Probe-Rolle");
      expect(after?.nameKey).toBe("t10009 probe-rolle");
      expect(after?.permissions).toEqual(["role:read:ZUGEWIESEN"]);

      const tenantARoleCount = await app.prisma.accessRole.count({
        where: { tenantId: tenantA.tenant.id },
      });
      expect(tenantARoleCount).toBe(0);
    });

    it("fixture integrity after the sweep: tenantB's RoleAssignment (Issue #74) still exists with unchanged accessRoleId and scopeType TENANT and empty arrays, and tenantA has zero RoleAssignment rows of its own from this sweep — a guard that answers 404 while still performing the PATCH or DELETE would otherwise pass the byte comparison", async () => {
      const after = await app.prisma.roleAssignment.findUnique({
        where: { id: tenantBRoleAssignmentId },
      });
      expect(after).not.toBeNull();
      expect(after?.accessRoleId).toBe(tenantBCustomRoleId);
      expect(after?.scopeType).toBe("TENANT");
      expect(after?.salonIds).toEqual([]);
      expect(after?.employeeIds).toEqual([]);

      const tenantARoleAssignmentCount = await app.prisma.roleAssignment.count({
        where: { tenantId: tenantA.tenant.id },
      });
      expect(tenantARoleAssignmentCount).toBe(0);
    });

    it("fixture integrity after the sweep: tenantB's PHOREST coupling (Phase 65b, Issue #65) still exists with externalBranchId 't10009-branch' — a guard that answers 404 while still deleting the coupling would otherwise pass the byte comparison", async () => {
      const after = await app.prisma.salonCoupling.findUnique({
        where: { salonId: tenantBSalonId },
      });
      expect(after).not.toBeNull();
      expect(after?.externalBranchId).toBe("t10009-branch");
      expect(after?.provider).toBe("PHOREST");
    });

    it("fixture integrity after the sweep: tenantB's employee still has exactly its one fixture EmployeeSalonAssignment (Phase 67b Plan 02), with validUntil still null — a guard that answers 404 while still performing the end would otherwise pass the byte comparison", async () => {
      const after = await app.prisma.employeeSalonAssignment.findUnique({
        where: { id: tenantBSalonAssignmentId },
      });
      expect(after).not.toBeNull();
      expect(after?.validUntil).toBeNull();

      const count = await app.prisma.employeeSalonAssignment.count({
        where: { employeeId: tenantB.employee.id },
      });
      expect(count).toBe(1);
    });
  });

  // ── Phase 91b Plan 10 (Issue #91), D-16 — the scope-variant sweep ────────────────────────────
  //
  // Every `probe` route whose entity belongs to an employee (identified here by the SAME register
  // `params` vocabulary the sweep above uses: a fixture key of "employee", "timeEntry" or
  // "salonAssignment" — all three ultimately resolve to one employee's own row) gets a SECOND
  // sweep dimension: a SALONS-scoped actor querying a REAL employee within their OWN tenant who is
  // outside their scope must get the SAME status and byte-identical body as querying a nonexistent
  // id — the same T-100-09 discipline, one level down (salon/person, not tenant).
  //
  // Two of the register's employee-owned entries are deliberately EXCLUDED, with the reason
  // recorded here rather than silently skipped:
  //   - `PATCH /api/v1/leave/requests/:id` (fixture key "leaveRequest") is EIGENE-only
  //     (`existing.employeeId !== req.user.employeeId` → 403) — no ZUGEWIESEN path exists at all,
  //     so a manager can never reach another employee's request through this route regardless of
  //     scope. There is nothing for a scope check to narrow.
  //   - `GET /api/v1/avatars/:employeeId` carries no permission gate beyond `requireAuth` at all
  //     (any authenticated tenant member may view any tenant member's avatar, by design — a
  //     directory-style read, not a managed-employee-data one). Scope narrowing does not apply.
  describe("scope-variant sweep — a SALONS-scoped actor vs. an in-tenant, out-of-scope employee (D-16)", () => {
    const EXCLUDED_ROUTES = new Set([
      "PATCH /api/v1/leave/requests/:id",
      "GET /api/v1/avatars/:employeeId",
    ]);
    const EMPLOYEE_OWNING_KEYS = new Set(["employee", "timeEntry", "salonAssignment"]);

    const scopeSweepEntries = orderedProbeEntries.filter((e) => {
      if (EXCLUDED_ROUTES.has(e.route)) return false;
      const params = e.params ?? {};
      return Object.values(params).some((key) => EMPLOYEE_OWNING_KEYS.has(key));
    });

    let scopeApp: FastifyInstance;
    let scopeTenant: FixtureBundle;
    let salonInScope: { id: string };
    let salonOutOfScope: { id: string };
    let outOfScopeEmployeeId: string;
    let outOfScopeTimeEntryId: string;
    let outOfScopeDeploymentAssignmentId: string;
    let scopedActorToken: string;

    const SCOPE_SWEEP_PASSWORD = "test1234";

    beforeAll(async () => {
      scopeApp = await getTestApp();
      scopeTenant = await seedTestData(scopeApp, "t10009-scope");

      salonInScope = await scopeApp.prisma.salon.create({
        data: {
          tenantId: scopeTenant.tenant.id,
          name: "T-100-09-Scope In",
          openingHours: DEFAULT_SALON_OPENING_HOURS,
          isActive: true,
        },
      });
      salonOutOfScope = await scopeApp.prisma.salon.create({
        data: {
          tenantId: scopeTenant.tenant.id,
          name: "T-100-09-Scope Out",
          openingHours: DEFAULT_SALON_OPENING_HOURS,
          isActive: true,
        },
      });

      // The out-of-scope employee: Stammsalon = salonOutOfScope, never salonInScope.
      const passwordHash = await bcrypt.hash(SCOPE_SWEEP_PASSWORD, 10);
      const outOfScopeUser = await scopeApp.prisma.user.create({
        data: {
          email: `t10009-scope-target-${randomBytes(4).toString("hex")}@test.de`,
          passwordHash,
          role: "EMPLOYEE",
          isActive: true,
        },
      });
      const outOfScopeEmployee = await scopeApp.prisma.employee.create({
        data: {
          tenantId: scopeTenant.tenant.id,
          userId: outOfScopeUser.id,
          employeeNumber: `T10009SC${randomBytes(2).toString("hex")}`.slice(0, 20),
          firstName: "ScopeTarget",
          lastName: "T10009",
          hireDate: new Date("2020-01-01"),
        },
      });
      outOfScopeEmployeeId = outOfScopeEmployee.id;
      await scopeApp.prisma.employeeSalonAssignment.create({
        data: {
          tenantId: scopeTenant.tenant.id,
          employeeId: outOfScopeEmployeeId,
          salonId: salonOutOfScope.id,
          kind: "HOME",
          validFrom: new Date("2020-01-01"),
          validUntil: null,
          weekdays: [],
        },
      });
      // A second, DEPLOYMENT assignment (never HOME — D-19's own WR-04 precedent above: a HOME
      // row cannot be the target of the "end" route without also being its own successor logic)
      // for POST /:id/salon-assignments/:assignmentId/end's `salonAssignment` fixture key.
      const deployment = await scopeApp.prisma.employeeSalonAssignment.create({
        data: {
          tenantId: scopeTenant.tenant.id,
          employeeId: outOfScopeEmployeeId,
          salonId: salonOutOfScope.id,
          kind: "DEPLOYMENT",
          validFrom: new Date("2020-06-01"),
          validUntil: null,
          weekdays: [],
        },
      });
      outOfScopeDeploymentAssignmentId = deployment.id;

      // An OvertimeAccount row — GET /overtime/:employeeId 404s BEFORE the scope check when none
      // exists, which would make the byte-comparison pass for the wrong (vacuous) reason.
      await scopeApp.prisma.overtimeAccount.create({
        data: { employeeId: outOfScopeEmployeeId, balanceHours: 0 },
      });

      // A closed TimeEntry — POST /time-entries/:id/breaks's `timeEntry` fixture key.
      const timeEntry = await scopeApp.prisma.timeEntry.create({
        data: {
          employeeId: outOfScopeEmployeeId,
          date: new Date("2026-01-05"),
          startTime: new Date("2026-01-05T08:00:00.000Z"),
          endTime: new Date("2026-01-05T16:00:00.000Z"),
          salonId: salonOutOfScope.id,
        },
      });
      outOfScopeTimeEntryId = timeEntry.id;

      // The scoped actor: a SALONS-scope assignment on salonInScope ONLY — the out-of-scope
      // employee's Stammsalon/DEPLOYMENT is salonOutOfScope, never salonInScope, so every D-10/D-12
      // check above must reject them. One role carries every permission this sweep's routes need.
      const actorUser = await scopeApp.prisma.user.create({
        data: {
          email: `t10009-scope-actor-${randomBytes(4).toString("hex")}@test.de`,
          passwordHash,
          role: "EMPLOYEE",
          isActive: true,
        },
      });
      await scopeApp.prisma.employee.create({
        data: {
          tenantId: scopeTenant.tenant.id,
          userId: actorUser.id,
          employeeNumber: `T10009SA${randomBytes(2).toString("hex")}`.slice(0, 20),
          firstName: "ScopeActor",
          lastName: "T10009",
          hireDate: new Date("2020-01-01"),
        },
      });
      const roleName = `T10009 Scope-Actor ${randomBytes(3).toString("hex")}`;
      const scopedRole = await scopeApp.prisma.accessRole.create({
        data: {
          tenantId: scopeTenant.tenant.id,
          name: roleName,
          nameKey: roleNameKey(roleName),
          permissions: normalizeRolePermissions([
            "employee:read:ZUGEWIESEN",
            "employee:update:ZUGEWIESEN",
            "employee:manage-access:ZUGEWIESEN",
            "employee:anonymize:ZUGEWIESEN",
            "employee:update-avatar:ZUGEWIESEN",
            "availability:read:ZUGEWIESEN",
            "availability:update:ZUGEWIESEN",
            "shift-pattern:read:ZUGEWIESEN",
            "shift-pattern:update:ZUGEWIESEN",
            "vocational-school:read:ZUGEWIESEN",
            "vocational-school:manage:ZUGEWIESEN",
            "contract:read:ZUGEWIESEN",
            "contract:update:ZUGEWIESEN",
            "leave-entitlement:read:ZUGEWIESEN",
            "leave-entitlement:update:ZUGEWIESEN",
            "overtime:read:ZUGEWIESEN",
            "time-entry:update:ZUGEWIESEN",
          ]),
        },
      });
      await scopeApp.prisma.roleAssignment.create({
        data: {
          tenantId: scopeTenant.tenant.id,
          userId: actorUser.id,
          accessRoleId: scopedRole.id,
          scopeType: "SALONS",
          salonIds: [salonInScope.id],
          employeeIds: [],
        },
      });

      const loginRes = await scopeApp.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: actorUser.email, password: SCOPE_SWEEP_PASSWORD },
      });
      expect(loginRes.statusCode).toBe(200);
      scopedActorToken = (JSON.parse(loginRes.body) as { accessToken: string }).accessToken;
    });

    afterAll(async () => {
      try {
        await cleanupTestData(scopeApp, scopeTenant.tenant.id);
      } catch (err) {
        console.error("Cleanup scopeTenant failed:", err);
      }
    });

    it("the scope-owning subset is non-empty (D-03c-style anti-vacuity: a sweep over zero routes proves nothing)", () => {
      expect(scopeSweepEntries.length).toBeGreaterThan(0);
    });

    it(`sweeps ${scopeSweepEntries.length} employee-owned probe route(s): the scoped actor's out-of-scope-but-real employee and a nonexistent id are byte-identical`, async () => {
      const failures: string[] = [];
      let unknownCounter = 0;

      function scopeFixtureValue(fixtureKey: string): string | null {
        if (fixtureKey === "employee") return outOfScopeEmployeeId;
        if (fixtureKey === "timeEntry") return outOfScopeTimeEntryId;
        if (fixtureKey === "salonAssignment") return outOfScopeDeploymentAssignmentId;
        return null;
      }

      for (const entry of scopeSweepEntries) {
        const [method, urlTemplate] = entry.route.split(" ");
        const params = entry.params ?? {};
        const paramNames = Object.keys(params);

        let realUrl = urlTemplate;
        let unknownUrl = urlTemplate;
        let badFixtureKey: string | null = null;

        for (const paramName of paramNames) {
          const fixtureKey = params[paramName];
          const realValue = scopeFixtureValue(fixtureKey);
          if (realValue === null) {
            badFixtureKey = fixtureKey;
            break;
          }
          unknownCounter += 1;
          const unknownValue = `00000000-0000-4000-9000-${String(unknownCounter).padStart(12, "0")}`;
          realUrl = realUrl.replace(`:${paramName}`, realValue);
          unknownUrl = unknownUrl.replace(`:${paramName}`, unknownValue);
        }

        if (badFixtureKey !== null) {
          failures.push(
            `${entry.route}: unrecognised fixture key '${badFixtureKey}' for the scope sweep — ` +
              `EMPLOYEE_OWNING_KEYS filtering should have excluded this route already (D-03).`,
          );
          continue;
        }

        const query = entry.route === MONTH_SALDO_ROUTE ? "?year=2026&month=1" : "";

        const [realRes, unknownRes] = await Promise.all([
          sendProbe(
            scopeApp,
            method as ProbeMethod,
            realUrl + query,
            scopedActorToken,
            entry.minimalBody,
          ),
          sendProbe(
            scopeApp,
            method as ProbeMethod,
            unknownUrl + query,
            scopedActorToken,
            entry.minimalBody,
          ),
        ]);

        const bothNotFound = realRes.statusCode === 404 && unknownRes.statusCode === 404;
        const bytesEqual = realRes.body === unknownRes.body;

        if (!bothNotFound || !bytesEqual) {
          const sameStatusButNotFound =
            realRes.statusCode === unknownRes.statusCode && !bothNotFound;
          failures.push(
            `${entry.route}: ${
              sameStatusButNotFound
                ? "AMBIGUOUS — both arms answered with the same non-404 status, which proves " +
                  "nothing about scope isolation"
                : "MISMATCH — the two arms are distinguishable"
            }. real (${realUrl}) -> ${realRes.statusCode} ${realRes.body}; unknown (${unknownUrl}) ` +
              `-> ${unknownRes.statusCode} ${unknownRes.body}.`,
          );
        }
      }

      expect(failures.join("\n\n")).toBe("");
    });

    it("fixture integrity after the sweep: the out-of-scope employee still exists, unanonymized, and its DEPLOYMENT assignment is unended — a guard that answers 404 while still performing the mutation would otherwise pass the byte comparison", async () => {
      const employee = await scopeApp.prisma.employee.findUnique({
        where: { id: outOfScopeEmployeeId },
      });
      expect(employee).not.toBeNull();
      expect(employee?.firstName).not.toBe("Gelöscht");

      const assignment = await scopeApp.prisma.employeeSalonAssignment.findUnique({
        where: { id: outOfScopeDeploymentAssignmentId },
      });
      expect(assignment).not.toBeNull();
      expect(assignment?.validUntil).toBeNull();
    });
  });
});
