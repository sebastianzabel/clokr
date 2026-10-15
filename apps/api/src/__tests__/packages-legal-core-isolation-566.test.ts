/**
 * Issue #566 (AC-5, D-11, D-07) — no legally required function is bound to a booked package.
 *
 * Booked modules and the salon quota only decide whether something NEW may be set up (a salon, a
 * key, a terminal, a presence source, a coupling) and whether the per-kind evaluation is shown.
 * Time recording, absences, the working-time account, the clock services, the Phorest sync, the
 * scheduler, authentication, permission resolution, anonymisation, data retention, reports, PDFs,
 * the dashboard and the audit log must never read a package: a cancelled module or a lowered quota
 * could otherwise stop a statutory function (§ 16 Abs. 2 ArbZG, DSGVO Art. 17, retention).
 *
 * Mirrors `activity-kind-saldo-isolation-81.test.ts` (never imported or edited — its constants are
 * module-private and it runs `describe` on import; the constants below are restated). Differences:
 *   - a per-file allowlist for the three Zeiterfassung set-up sites (terminals, presence sources,
 *     the activity evaluation in `/summary`) and for the two Schichtplanung files that create a
 *     coupling, instead of "no allowlist anywhere";
 *   - the scan keeps node positions, because the `/summary` rule is positional (every reference
 *     lies inside the callback of `app.get("/summary", …)`);
 *   - a second half that proves the opposite direction: each of the nine set-up sites calls its
 *     gate BEFORE its create call, and no third file creates a coupling, key, terminal or source.
 *
 * The scan parses each file with the TypeScript compiler. A forbidden NAME counts as an identifier
 * (member access, import name, object key, type name) or as a string literal / bracket access; a
 * module specifier counts when an import/export/dynamic import names `tenant-packages`. Comments
 * are not scanned: prose may explain why a file does not read a package.
 *
 * Named blind spot: a legal-core file that reaches the package state through a NEW helper with an
 * unrelated name, living in a module outside the walked trees and the single-file list, is not
 * seen here. (The helper itself would have to import `tenant-packages` or select the columns, and
 * the bypass half below watches the create sites; neither is a proof for an arbitrary new module.)
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { describe, it, expect } from "vitest";
import * as ts from "typescript";

// __dirname is apps/api/src/__tests__ — four levels up is the repo root.
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const SRC = "apps/api/src";

/** Identifiers (and string literals) no legally required path may carry. */
const FORBIDDEN_NAMES = new Set([
  "TenantModule",
  "bookedModules",
  "salonQuota",
  "salonLimit",
  "GRUNDVERSION",
  "TENANT_MODULES",
  "TENANT_MODULE_LABEL_DE",
  "TENANT_PACKAGES_SELECT",
  "normalizeStoredPackages",
  "moduleBookedIn",
  "readTenantPackages",
  "isModuleBooked",
  "packagesForDisplay",
  "assertModuleBooked",
  "assertSalonActivationAllowed",
  "lockTenantForPackages",
  "changeTenantPackages",
  "PackageRefusalError",
  "SalonQuotaReachedError",
  "ModuleNotBookedError",
  "MODULE_NOT_BOOKED",
  "SALON_QUOTA_REACHED",
]);

/** Module specifier of the decider: `tenant-packages` (relative, absolute or with a `.js` suffix). */
const FORBIDDEN_SPECIFIER = /(?:^|\/)tenant-packages(?:\.js)?$/;

/** Roots walked with NO allowlist: nothing in them may reference a package. */
const CLEAN_ROOTS = {
  absence: `${SRC}/contexts/absence`,
  "working-time-account": `${SRC}/contexts/working-time-account`,
  "services/clock": `${SRC}/services/clock`,
  "services/phorest": `${SRC}/services/phorest`,
} as const;

/** Zeiterfassung: walked with a per-file allowlist (the three named set-up sites). */
const TT_ROOT = `${SRC}/contexts/time-tracking`;
interface TtAllowance {
  names: ReadonlySet<string>;
  /** Every non-import reference must lie inside the callback of `app.get("/summary", …)`. */
  summaryCallbackOnly: boolean;
}
const TT_ALLOWLIST: Record<string, TtAllowance> = {
  [`${TT_ROOT}/api/terminals.ts`]: {
    names: new Set(["assertModuleBooked"]),
    summaryCallbackOnly: false,
  },
  [`${TT_ROOT}/api/admin-presence-sources.ts`]: {
    names: new Set(["assertModuleBooked"]),
    summaryCallbackOnly: false,
  },
  // The gate and the reason literal of the withheld figure — both inside the `/summary` callback.
  [`${TT_ROOT}/api/time-entries.ts`]: {
    names: new Set(["isModuleBooked", "MODULE_NOT_BOOKED"]),
    summaryCallbackOnly: true,
  },
};

/**
 * Schichtplanung: the whole tree is walked (the Grundversion includes the Schichtplan); only the
 * two files that create a coupling may name a package.
 */
const SCHEDULING_ROOT = `${SRC}/contexts/scheduling`;
const SCHEDULING_ALLOWLIST = [
  `${SCHEDULING_ROOT}/facade/couplings.ts`,
  `${SCHEDULING_ROOT}/api/integrations.ts`,
];

/** Single files that must be reached AND clean. */
const SINGLE_FILES = [
  `${SCHEDULING_ROOT}/plugins/scheduler.ts`,
  `${TT_ROOT}/api/presence.ts`,
  `${SRC}/middleware/auth.ts`,
  `${SRC}/contexts/platform/request-permissions.ts`,
  `${SRC}/contexts/platform/anonymize.ts`,
  `${SRC}/contexts/platform/api/employees.ts`, // DSGVO delete / anonymise route
  `${SRC}/composition/data-retention.ts`,
  `${SRC}/composition/reports.ts`,
  `${SRC}/composition/pdf.ts`,
  `${SRC}/composition/dashboard.ts`,
  `${SRC}/contexts/platform/api/audit-logs.ts`,
  // D-07: extended roles and role assignments stay ungated in this phase.
  `${SRC}/contexts/platform/api/roles.ts`,
  `${SRC}/contexts/platform/api/role-assignments.ts`,
];

/**
 * Walked-file floors: the number measured on 2026-10-15 minus one, so a moved or emptied root
 * turns the guard red instead of letting it report success on an empty set.
 * Measured: absence 47, working-time-account 30, time-tracking 40, services/clock 6,
 * services/phorest 5, scheduling 19, apps/api/src 236 (non-test `.ts`).
 */
const FLOORS = {
  absence: 46,
  "working-time-account": 29,
  "time-tracking": 39,
  "services/clock": 5,
  "services/phorest": 4,
  scheduling: 18,
  "api-src": 235,
} as const;

/** The decider and the salon facade — the control run must find the names there. */
const DECIDER = `${SRC}/contexts/platform/tenant-packages.ts`;
const SALON_FACADE = `${SRC}/contexts/platform/facade/salons.ts`;

function repoRel(absPath: string): string {
  return relative(REPO_ROOT, absPath).split("\\").join("/");
}

function walkTs(absDir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(absDir)) {
    if (entry === "__tests__" || entry === "node_modules") continue;
    const abs = join(absDir, entry);
    if (statSync(abs).isDirectory()) walkTs(abs, out);
    else if (extname(entry) === ".ts" && !entry.endsWith(".test.ts")) out.push(abs);
  }
  return out;
}

function parse(fileName: string, source: string): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
}

function parseRepoFile(file: string): ts.SourceFile {
  return parse(file, readFileSync(join(REPO_ROOT, file), "utf8"));
}

// ── The detector ──────────────────────────────────────────────────────────────────────────────────

interface Hit {
  /** The forbidden name, or the module specifier text. */
  name: string;
  node: ts.Node;
}

function hasAncestor(node: ts.Node, pred: (n: ts.Node) => boolean): boolean {
  for (let p = node.parent; p; p = p.parent) if (pred(p)) return true;
  return false;
}

/** Every forbidden reference of a parsed file, with its node (comments are never scanned). */
function scan(sf: ts.SourceFile): Hit[] {
  const hits: Hit[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && FORBIDDEN_NAMES.has(node.text)) {
      hits.push({ name: node.text, node });
    }
    if (ts.isStringLiteralLike(node)) {
      if (FORBIDDEN_NAMES.has(node.text)) hits.push({ name: node.text, node });
      const parent = node.parent;
      const isModuleReference =
        parent !== undefined &&
        (ts.isImportDeclaration(parent) ||
          ts.isExportDeclaration(parent) ||
          // import("…") and require("…")
          (ts.isCallExpression(parent) &&
            (parent.expression.kind === ts.SyntaxKind.ImportKeyword ||
              (ts.isIdentifier(parent.expression) && parent.expression.text === "require"))) ||
          // import type X = import("…")
          ts.isLiteralTypeNode(parent));
      if (isModuleReference && FORBIDDEN_SPECIFIER.test(node.text)) {
        hits.push({ name: node.text, node });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

function forbiddenReferences(fileName: string, source: string): string[] {
  return [...new Set(scan(parse(fileName, source)).map((h) => h.name))].sort((a, b) =>
    a.localeCompare(b),
  );
}

function referencesOf(file: string): string[] {
  return forbiddenReferences(file, readFileSync(join(REPO_ROOT, file), "utf8"));
}

// ── AST helpers for the set-up-site half ───────────────────────────────────────────────────────────

/** `a.b["c"].d` -> "a.b.c.d"; "" when the callee is anything else (call result, parenthesised …). */
function calleePath(expr: ts.Expression): string {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) {
    const left = calleePath(expr.expression);
    return left ? `${left}.${expr.name.text}` : "";
  }
  if (ts.isElementAccessExpression(expr) && ts.isStringLiteralLike(expr.argumentExpression)) {
    const left = calleePath(expr.expression);
    return left ? `${left}.${expr.argumentExpression.text}` : "";
  }
  if (ts.isNonNullExpression(expr) || ts.isParenthesizedExpression(expr)) {
    return calleePath(expr.expression);
  }
  return "";
}

function callsIn(root: ts.Node, pred: (call: ts.CallExpression) => boolean): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && pred(node)) out.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return out.sort((a, b) => a.getStart() - b.getStart());
}

/** The call's callee path equals `path` or ends with `.path` (`app.prisma.apiKey.create`). */
function calleeIs(call: ts.CallExpression, path: string): boolean {
  const got = calleePath(call.expression);
  return got === path || got.endsWith(`.${path}`);
}

function isFunctionLike(node: ts.Node): boolean {
  return (
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node)
  );
}

function nearestFunction(node: ts.Node): ts.Node | undefined {
  for (let p = node.parent; p; p = p.parent) if (isFunctionLike(p)) return p;
  return undefined;
}

function functionNamed(sf: ts.SourceFile, name: string): ts.FunctionDeclaration | undefined {
  const found = sf.statements.filter(
    (s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name,
  );
  return found.length === 1 ? found[0] : undefined;
}

/** The single `app.<method>("<path>", …)` call of a file. */
function routeCall(sf: ts.SourceFile, method: string, path: string): ts.CallExpression | undefined {
  const found = callsIn(
    sf,
    (c) =>
      calleePath(c.expression) === `app.${method}` &&
      c.arguments.length > 0 &&
      ts.isStringLiteralLike(c.arguments[0]) &&
      c.arguments[0].text === path,
  );
  return found.length === 1 ? found[0] : undefined;
}

/** The string literal passed as argument `index` of a call, or undefined. */
function stringArg(call: ts.CallExpression, index: number): string | undefined {
  const arg = call.arguments[index];
  return arg && ts.isStringLiteralLike(arg) ? arg.text : undefined;
}

/** True when the node lies inside the callback (not the path) of an `app.get("/summary", …)` call. */
function inSummaryCallback(node: ts.Node): boolean {
  return hasAncestor(node, (p) => {
    if (!ts.isCallExpression(p) || calleePath(p.expression) !== "app.get") return false;
    const [path] = p.arguments;
    return (
      path !== undefined &&
      ts.isStringLiteralLike(path) &&
      path.text === "/summary" &&
      node.getStart() >= path.end
    );
  });
}

/** The offenders of one Zeiterfassung file against its allowance (undefined = no allowance). */
function ttOffenders(rel: string, sf: ts.SourceFile, allowance: TtAllowance | undefined): string[] {
  const offenders: string[] = [];
  for (const hit of scan(sf)) {
    if (!allowance) {
      offenders.push(`${rel}: ${hit.name}`);
    } else if (!allowance.names.has(hit.name)) {
      offenders.push(
        `${rel}: ${hit.name} (only ${[...allowance.names].join(", ")} is allowed here)`,
      );
    } else if (hasAncestor(hit.node, ts.isImportDeclaration)) {
      // The import statement itself is not a use.
    } else if (allowance.summaryCallbackOnly && !inSummaryCallback(hit.node)) {
      offenders.push(`${rel}: ${hit.name} outside the app.get("/summary", …) callback`);
    }
  }
  return offenders;
}

// ── Set-up sites (gate -> create) ──────────────────────────────────────────────────────────────────

interface Site {
  id: string;
  file: string;
  /** Returns the problems found in the parsed file; empty = the gate is in place and ordered. */
  check: (sf: ts.SourceFile) => string[];
}

/** One gate call, one create call, same function, gate first, gate names the expected module. */
function simpleSite(opts: {
  id: string;
  file: string;
  scope: (sf: ts.SourceFile) => ts.Node | undefined;
  gate: string;
  /** Module the gate must be called with (third argument), when the gate takes one. */
  module?: string;
  create: string;
}): Site {
  return {
    id: opts.id,
    file: opts.file,
    check(sf) {
      const scope = opts.scope(sf);
      if (!scope) return [`${opts.id}: the enclosing function / route was not found`];
      const problems: string[] = [];
      const gates = callsIn(scope, (c) => calleeIs(c, opts.gate));
      const creates = callsIn(scope, (c) => calleeIs(c, opts.create));
      if (gates.length !== 1) {
        problems.push(`${opts.id}: expected exactly one ${opts.gate}( call, found ${gates.length}`);
      }
      if (creates.length !== 1) {
        problems.push(
          `${opts.id}: expected exactly one ${opts.create} call, found ${creates.length}`,
        );
      }
      if (gates.length === 1 && creates.length === 1) {
        const [gate] = gates;
        const [create] = creates;
        if (nearestFunction(gate) !== nearestFunction(create)) {
          problems.push(`${opts.id}: the gate and the create call are in different functions`);
        }
        if (gate.getStart() >= create.getStart()) {
          problems.push(`${opts.id}: the gate does not precede the ${opts.create} call`);
        }
        if (opts.module !== undefined && stringArg(gate, 2) !== opts.module) {
          problems.push(`${opts.id}: the gate is not called with module ${opts.module}`);
        }
      }
      return problems;
    },
  };
}

const CPL = `${SCHEDULING_ROOT}/facade/couplings.ts`;

const SITES: Site[] = [
  simpleSite({
    id: "createSalon",
    file: SALON_FACADE,
    scope: (sf) => functionNamed(sf, "createSalon"),
    gate: "assertSalonActivationAllowed",
    create: "salon.create",
  }),
  simpleSite({
    id: "activateSalon",
    file: SALON_FACADE,
    scope: (sf) => functionNamed(sf, "activateSalon"),
    gate: "assertSalonActivationAllowed",
    create: "salon.update",
  }),
  simpleSite({
    id: "POST /api-keys",
    file: `${SRC}/contexts/platform/api/api-keys.ts`,
    scope: (sf) => routeCall(sf, "post", "/"),
    gate: "assertModuleBooked",
    module: "INTEGRATIONS",
    create: "apiKey.create",
  }),
  simpleSite({
    id: "POST /terminals",
    file: `${TT_ROOT}/api/terminals.ts`,
    scope: (sf) => routeCall(sf, "post", "/"),
    gate: "assertModuleBooked",
    module: "HARDWARE_CLOCK",
    create: "terminalApiKey.create",
  }),
  simpleSite({
    id: "POST /admin/presence-sources",
    file: `${TT_ROOT}/api/admin-presence-sources.ts`,
    scope: (sf) => routeCall(sf, "post", "/"),
    gate: "assertModuleBooked",
    module: "HARDWARE_CLOCK",
    create: "presenceSource.create",
  }),
  simpleSite({
    id: "createSalonCoupling",
    file: CPL,
    scope: (sf) => functionNamed(sf, "createSalonCoupling"),
    gate: "assertModuleBooked",
    module: "INTEGRATIONS",
    create: "insertCoupling",
  }),
  {
    id: "setSalonCoupling",
    file: CPL,
    check(sf) {
      const id = "setSalonCoupling";
      const scope = functionNamed(sf, "setSalonCoupling");
      if (!scope) return [`${id}: the function was not found`];
      const problems: string[] = [];
      const gates = callsIn(scope, (c) => calleeIs(c, "assertModuleBooked"));
      const inserts = callsIn(scope, (c) => calleeIs(c, "insertCoupling"));
      // A new coupling (no existing row) and the REPLACED branch: two insert calls, one gate.
      if (gates.length !== 1) {
        problems.push(
          `${id}: expected exactly one assertModuleBooked( call, found ${gates.length}`,
        );
      }
      if (inserts.length !== 2) {
        problems.push(`${id}: expected exactly two insertCoupling( calls, found ${inserts.length}`);
      }
      const noExisting = findIfs(scope, "!existing");
      if (noExisting.length !== 1) {
        problems.push(
          `${id}: expected exactly one if (!existing) block, found ${noExisting.length}`,
        );
      }
      if (gates.length === 1 && inserts.length === 2 && noExisting.length === 1) {
        const [gate] = gates;
        const block = noExisting[0].thenStatement;
        const within = (n: ts.Node) => n.getStart() >= block.getStart() && n.end <= block.end;
        if (stringArg(gate, 2) !== "INTEGRATIONS") {
          problems.push(`${id}: the gate is not called with module INTEGRATIONS`);
        }
        if (!within(gate) || !within(inserts[0])) {
          problems.push(
            `${id}: the gate and the first insert do not share the if (!existing) block`,
          );
        }
        if (gate.getStart() >= inserts[0].getStart()) {
          problems.push(`${id}: the gate does not precede the first insertCoupling( call`);
        }
        if (within(inserts[1])) {
          problems.push(
            `${id}: the REPLACED branch sits inside the if (!existing) block — replacing an existing coupling must stay free`,
          );
        }
      }
      return problems;
    },
  },
  simpleSite({
    id: "PUT /integrations/phorest/config",
    file: `${SRC}/contexts/scheduling/api/integrations.ts`,
    scope: (sf) => routeCall(sf, "put", "/phorest/config"),
    gate: "assertModuleBooked",
    module: "INTEGRATIONS",
    create: "salonCoupling.create",
  }),
  {
    id: "GET /time-entries/summary",
    file: `${TT_ROOT}/api/time-entries.ts`,
    check(sf) {
      const id = "GET /time-entries/summary";
      const scope = routeCall(sf, "get", "/summary");
      if (!scope) return [`${id}: the route was not found`];
      const problems: string[] = [];
      const gates = callsIn(scope, (c) => calleeIs(c, "isModuleBooked"));
      if (gates.length !== 1) {
        return [`${id}: expected exactly one isModuleBooked( call, found ${gates.length}`];
      }
      const [gate] = gates;
      if (stringArg(gate, 2) !== "ANALYTICS") {
        problems.push(`${id}: the gate is not called with module ANALYTICS`);
      }
      // The returned object literal that carries the withheld figure.
      const returns: ts.ReturnStatement[] = [];
      const visit = (node: ts.Node): void => {
        if (
          ts.isReturnStatement(node) &&
          node.expression &&
          carriesProperty(node, "activityMinutes")
        ) {
          returns.push(node);
        }
        ts.forEachChild(node, visit);
      };
      visit(scope);
      if (returns.length !== 1) {
        return [
          ...problems,
          `${id}: expected exactly one return that carries activityMinutes, found ${returns.length}`,
        ];
      }
      const [ret] = returns;
      if (nearestFunction(gate) !== nearestFunction(ret)) {
        problems.push(`${id}: the gate and the return are in different functions`);
      }
      if (gate.getStart() >= ret.getStart()) {
        problems.push(`${id}: the gate does not precede the returned figure`);
      }
      // The gate's result must decide the figure: it is stored in a variable the return reads.
      const decl = ts.findAncestor(gate, ts.isVariableDeclaration);
      const variable = decl && ts.isIdentifier(decl.name) ? decl.name.text : undefined;
      if (!variable) {
        problems.push(`${id}: the isModuleBooked( result is not stored in a variable`);
      } else {
        const used = new Set<string>();
        const collect = (n: ts.Node): void => {
          if (ts.isIdentifier(n)) used.add(n.text);
          ts.forEachChild(n, collect);
        };
        collect(ret);
        if (!used.has(variable)) {
          problems.push(`${id}: the returned figure does not depend on ${variable}`);
        }
      }
      return problems;
    },
  },
];

/** `if (<condition>)` statements of a node whose condition text equals `condition`. */
function findIfs(root: ts.Node, condition: string): ts.IfStatement[] {
  const out: ts.IfStatement[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIfStatement(node) && node.expression.getText() === condition) out.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return out;
}

/** True when the subtree has a property assignment / shorthand named `name`. */
function carriesProperty(root: ts.Node, name: string): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (
      (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
      node.name.getText() === name
    ) {
      found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

// ── Bypass half: who creates what ─────────────────────────────────────────────────────────────────

const WRITE_METHODS = new Set(["create", "createMany", "upsert"]);

/** Every non-test `apps/api/src` file, once (parsing ~700 files is the cost of the bypass half). */
let allSrcCache: { rel: string; sf: ts.SourceFile }[] | undefined;
function allSrc(): { rel: string; sf: ts.SourceFile }[] {
  allSrcCache ??= walkTs(join(REPO_ROOT, SRC)).map((abs) => ({
    rel: repoRel(abs),
    sf: parse(abs, readFileSync(abs, "utf8")),
  }));
  return allSrcCache;
}

/** Files with a `<model>.create | createMany | upsert` call (property or bracket access). */
function filesWritingModel(model: string): string[] {
  const files: string[] = [];
  for (const { rel, sf } of allSrc()) {
    const calls = callsIn(sf, (c) => {
      const path = calleePath(c.expression).split(".");
      return (
        path.length >= 2 &&
        WRITE_METHODS.has(path[path.length - 1]) &&
        path[path.length - 2] === model
      );
    });
    if (calls.length > 0) files.push(rel);
  }
  return files.sort((a, b) => a.localeCompare(b));
}

// ── The tests ──────────────────────────────────────────────────────────────────────────────────────

describe("Issue #566 (AC-5, D-11) — no legally required path is bound to a package", () => {
  const walkedByRoot = Object.fromEntries(
    Object.entries(CLEAN_ROOTS).map(([name, root]) => [name, walkTs(join(REPO_ROOT, root))]),
  ) as Record<keyof typeof CLEAN_ROOTS, string[]>;
  const ttWalked = walkTs(join(REPO_ROOT, TT_ROOT));
  const schedulingWalked = walkTs(join(REPO_ROOT, SCHEDULING_ROOT));
  const singleReached = SINGLE_FILES.filter((f) => existsSync(join(REPO_ROOT, f)));

  it("the walk sees every tree (a silently-empty walk would pass forever)", () => {
    const counts: [string, string[], number][] = [
      ["absence", walkedByRoot.absence, FLOORS.absence],
      [
        "working-time-account",
        walkedByRoot["working-time-account"],
        FLOORS["working-time-account"],
      ],
      ["time-tracking", ttWalked, FLOORS["time-tracking"]],
      ["services/clock", walkedByRoot["services/clock"], FLOORS["services/clock"]],
      ["services/phorest", walkedByRoot["services/phorest"], FLOORS["services/phorest"]],
      ["scheduling", schedulingWalked, FLOORS.scheduling],
    ];
    for (const [name, files, floor] of counts) {
      expect(files.length, `no file walked under ${name} at all`).toBeGreaterThan(0);
      expect(
        files.length,
        `fewer files walked under ${name} than the measured floor (${floor}) — the scan root moved or emptied`,
      ).toBeGreaterThanOrEqual(floor);
    }

    // One named file per root proves the walk reaches into the tree, not just its top level.
    expect(walkedByRoot.absence.map(repoRel)).toContain(`${CLEAN_ROOTS.absence}/api/leave.ts`);
    expect(walkedByRoot["working-time-account"].map(repoRel)).toContain(
      `${CLEAN_ROOTS["working-time-account"]}/close-employee-month.ts`,
    );
    expect(ttWalked.map(repoRel)).toContain(`${TT_ROOT}/api/time-entries.ts`);
    expect(walkedByRoot["services/clock"].map(repoRel)).toContain(
      `${CLEAN_ROOTS["services/clock"]}/resolver.ts`,
    );
    expect(walkedByRoot["services/phorest"].map(repoRel)).toContain(
      `${CLEAN_ROOTS["services/phorest"]}/sync-tenant.ts`,
    );
    const schedulingRel = schedulingWalked.map(repoRel);
    for (const file of SCHEDULING_ALLOWLIST) {
      expect(schedulingRel, `the walk did not reach ${file}`).toContain(file);
    }
    for (const file of Object.keys(TT_ALLOWLIST)) {
      expect(ttWalked.map(repoRel), `the walk did not reach ${file}`).toContain(file);
    }

    // Every single file must exist and be reached.
    for (const file of SINGLE_FILES) {
      expect(singleReached, `the single file ${file} does not exist (moved or renamed)`).toContain(
        file,
      );
    }
    expect(singleReached.length, "no single file reached at all").toBeGreaterThan(0);
  });

  it("positive control: the detector flags every forbidden shape", () => {
    expect(forbiddenReferences("x.ts", `const q = tenant.salonQuota;`), "member access").toEqual([
      "salonQuota",
    ]);
    expect(forbiddenReferences("x.ts", `const g = GRUNDVERSION;`), "identifier").toEqual([
      "GRUNDVERSION",
    ]);
    expect(
      forbiddenReferences("x.ts", `import { isModuleBooked } from "../platform";`),
      "import name",
    ).toEqual(["isModuleBooked"]);
    expect(
      forbiddenReferences("x.ts", `const data = { bookedModules: [] };`),
      "object key",
    ).toEqual(["bookedModules"]);
    expect(forbiddenReferences("x.ts", `const c = "MODULE_NOT_BOOKED";`), "string literal").toEqual(
      ["MODULE_NOT_BOOKED"],
    );
    expect(forbiddenReferences("x.ts", `const q = row["salonQuota"];`), "bracket access").toEqual([
      "salonQuota",
    ]);
    expect(forbiddenReferences("x.ts", `let m: TenantModule | undefined;`), "type name").toEqual([
      "TenantModule",
    ]);
    expect(
      forbiddenReferences("x.ts", `import { x } from "../platform/tenant-packages";`),
      "module specifier",
    ).toEqual(["../platform/tenant-packages"]);
    expect(
      forbiddenReferences("x.ts", `export { y } from "./tenant-packages.js";`),
      "re-export specifier",
    ).toEqual(["./tenant-packages.js"]);
    expect(
      forbiddenReferences("x.ts", `const m = await import("../tenant-packages");`),
      "dynamic import specifier",
    ).toEqual(["../tenant-packages"]);
    expect(
      forbiddenReferences(
        "x.ts",
        `// bookedModules, salonQuota and tenant-packages only in a comment\n/* isModuleBooked */`,
      ),
      "comments are deliberately not scanned",
    ).toEqual([]);
    expect(
      forbiddenReferences("x.ts", `import { y } from "./tenant-packages-other-thing";`),
      "an unrelated specifier that merely starts like the decider is not flagged",
    ).toEqual([]);
  });

  it("control run: the decider and the salon facade carry the names (the guard watches live names)", () => {
    // Measured 2026-10-15: the decider carries ALL 22 forbidden names (the two error-code literals
    // are spelled in its error classes). Asserted as the full set, so a rename in the decider makes
    // this red instead of silently shrinking what the guard watches.
    const decider = referencesOf(DECIDER);
    const expected = [...FORBIDDEN_NAMES].sort((a, b) => a.localeCompare(b));
    expect(
      decider.filter((n) => FORBIDDEN_NAMES.has(n)),
      `the decider no longer carries every forbidden name — the list went stale (missing: ${expected
        .filter((n) => !decider.includes(n))
        .join(", ")})`,
    ).toEqual(expected);
    expect(expected.length, "the forbidden list shrank").toBe(22);

    const facade = referencesOf(SALON_FACADE);
    expect(facade, "the salon facade lost its quota gate").toContain(
      "assertSalonActivationAllowed",
    );
    expect(facade, "the salon facade lost the tenant lock").toContain("lockTenantForPackages");
  });

  it("no file of absence, working-time-account, services/clock or services/phorest references a package (no allowlist)", () => {
    const offenders: string[] = [];
    for (const files of Object.values(walkedByRoot)) {
      for (const abs of files) {
        const refs = forbiddenReferences(abs, readFileSync(abs, "utf8"));
        if (refs.length > 0) offenders.push(`${repoRel(abs)}: ${refs.join(", ")}`);
      }
    }
    expect(
      offenders,
      `a package decision leaked into a legally required path:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("no single legal-core file references a package (scheduler, presence ingest, auth, permissions, anonymisation, retention, reports, PDF, dashboard, audit log, roles, DSGVO delete)", () => {
    for (const file of singleReached) {
      expect(referencesOf(file), `${file} references a package`).toEqual([]);
    }
  });

  it("the Schichtplan tree is clean except the two coupling files", () => {
    const offenders = schedulingWalked
      .map(repoRel)
      .filter((rel) => !SCHEDULING_ALLOWLIST.includes(rel))
      .map((rel) => [rel, referencesOf(rel)] as const)
      .filter(([, refs]) => refs.length > 0)
      .map(([rel, refs]) => `${rel}: ${refs.join(", ")}`);
    expect(
      offenders,
      `a package decision leaked into the Schichtplan:\n${offenders.join("\n")}`,
    ).toEqual([]);
    // The allowlisted files really carry the gate (the allowlist is not a free pass for a dead file).
    for (const file of SCHEDULING_ALLOWLIST) {
      expect(referencesOf(file), `${file} no longer names the gate`).toContain(
        "assertModuleBooked",
      );
    }
  });

  it("Zeiterfassung is clean except the three set-up sites, which carry only their gate, and the summary gate sits inside the /summary callback", () => {
    const offenders: string[] = [];
    for (const abs of ttWalked) {
      const rel = repoRel(abs);
      offenders.push(...ttOffenders(rel, parse(abs, readFileSync(abs, "utf8")), TT_ALLOWLIST[rel]));
    }
    expect(
      offenders,
      `a package decision leaked into Zeiterfassung:\n${offenders.join("\n")}`,
    ).toEqual([]);

    // Each allowlisted file really uses its gate (an allowlist for a name nobody uses is dead).
    expect(referencesOf(`${TT_ROOT}/api/terminals.ts`)).toContain("assertModuleBooked");
    expect(referencesOf(`${TT_ROOT}/api/admin-presence-sources.ts`)).toContain(
      "assertModuleBooked",
    );
    expect(referencesOf(`${TT_ROOT}/api/time-entries.ts`)).toContain("isModuleBooked");
  });

  it("the allowlist rule is itself non-vacuous: a gate outside /summary, an extra name or an unlisted file is reported", () => {
    const summaryOnly: TtAllowance = {
      names: new Set(["isModuleBooked"]),
      summaryCallbackOnly: true,
    };
    const gateOnly: TtAllowance = {
      names: new Set(["assertModuleBooked"]),
      summaryCallbackOnly: false,
    };
    const inside = parse(
      "x.ts",
      `import { isModuleBooked } from "../../platform";
       app.get("/summary", { handler: async () => { await isModuleBooked(); } });`,
    );
    expect(ttOffenders("x.ts", inside, summaryOnly), "import + use inside /summary").toEqual([]);

    const outside = parse(
      "x.ts",
      `app.get("/summary", { handler: async () => { await isModuleBooked(); } });
       app.get("/other", { handler: async () => { await isModuleBooked(); } });`,
    );
    expect(ttOffenders("x.ts", outside, summaryOnly)).toEqual([
      'x.ts: isModuleBooked outside the app.get("/summary", …) callback',
    ]);

    const extraName = parse("x.ts", `await assertModuleBooked(); const q = t.salonQuota;`);
    expect(ttOffenders("x.ts", extraName, gateOnly)).toEqual([
      "x.ts: salonQuota (only assertModuleBooked is allowed here)",
    ]);

    const unlisted = parse("x.ts", `await assertModuleBooked();`);
    expect(ttOffenders("x.ts", unlisted, undefined)).toEqual(["x.ts: assertModuleBooked"]);
  });
});

describe("Issue #566 (D-03, D-05, D-11) — every set-up site calls its gate before its create call", () => {
  it("the sites table covers all nine set-up sites", () => {
    expect(SITES.map((s) => s.id).sort((a, b) => a.localeCompare(b))).toEqual(
      [
        "GET /time-entries/summary",
        "POST /admin/presence-sources",
        "POST /api-keys",
        "POST /terminals",
        "PUT /integrations/phorest/config",
        "activateSalon",
        "createSalon",
        "createSalonCoupling",
        "setSalonCoupling",
      ].sort((a, b) => a.localeCompare(b)),
    );
  });

  it.each(SITES.map((s) => [s.id, s] as const))("%s", (_id, site) => {
    expect(existsSync(join(REPO_ROOT, site.file)), `${site.file} does not exist`).toBe(true);
    expect(site.check(parseRepoFile(site.file))).toEqual([]);
  });

  it("positive control: the site checker reports a gate after the create, a missing gate and a wrong module", () => {
    const terminals = SITES.find((s) => s.id === "POST /terminals")!;
    const ok = `
      export async function terminalRoutes(app) {
        app.post("/", { handler: async (req) => {
          await assertModuleBooked(app.prisma, req.user.tenantId, "HARDWARE_CLOCK");
          const key = await app.prisma.terminalApiKey.create({ data: {} });
        } });
      }`;
    expect(terminals.check(parse("t.ts", ok))).toEqual([]);

    const gateAfter = `
      export async function terminalRoutes(app) {
        app.post("/", { handler: async (req) => {
          const key = await app.prisma.terminalApiKey.create({ data: {} });
          await assertModuleBooked(app.prisma, req.user.tenantId, "HARDWARE_CLOCK");
        } });
      }`;
    expect(terminals.check(parse("t.ts", gateAfter)).join("\n")).toContain("does not precede");

    const gateMissing = `
      export async function terminalRoutes(app) {
        app.post("/", { handler: async (req) => {
          const key = await app.prisma.terminalApiKey.create({ data: {} });
        } });
      }`;
    expect(terminals.check(parse("t.ts", gateMissing)).join("\n")).toContain(
      "expected exactly one assertModuleBooked( call, found 0",
    );

    const wrongModule = ok.replace("HARDWARE_CLOCK", "INTEGRATIONS");
    expect(terminals.check(parse("t.ts", wrongModule)).join("\n")).toContain(
      "not called with module HARDWARE_CLOCK",
    );

    const gateInOtherFunction = `
      export async function terminalRoutes(app) {
        app.post("/", { handler: async (req) => {
          const guard = async () => { await assertModuleBooked(app.prisma, req.user.tenantId, "HARDWARE_CLOCK"); };
          const key = await app.prisma.terminalApiKey.create({ data: {} });
        } });
      }`;
    expect(terminals.check(parse("t.ts", gateInOtherFunction)).join("\n")).toContain(
      "different functions",
    );

    // setSalonCoupling: the gate moved out of the if (!existing) block.
    const setSite = SITES.find((s) => s.id === "setSalonCoupling")!;
    const setOk = `
      export async function setSalonCoupling(db, tenantId, salon, branch) {
        const existing = await db.salonCoupling.findFirst({});
        if (!existing) {
          await assertModuleBooked(db, tenantId, "INTEGRATIONS");
          const coupling = await insertCoupling(db, tenantId, salon.id, branch);
          return coupling;
        }
        const created = await insertCoupling(db, tenantId, salon.id, branch);
        return created;
      }`;
    expect(setSite.check(parse("c.ts", setOk))).toEqual([]);
    const setNoGate = setOk.replace('await assertModuleBooked(db, tenantId, "INTEGRATIONS");', "");
    expect(setSite.check(parse("c.ts", setNoGate)).join("\n")).toContain(
      "expected exactly one assertModuleBooked( call, found 0",
    );
    const setReplaceGated = setOk.replace(
      "const created = await insertCoupling",
      'await assertModuleBooked(db, tenantId, "INTEGRATIONS"); const created = await insertCoupling',
    );
    expect(setSite.check(parse("c.ts", setReplaceGated)).join("\n")).toContain(
      "expected exactly one assertModuleBooked( call, found 2",
    );
  });
});

describe("Issue #566 (D-03, D-05) — no third file creates a coupling, key, terminal, source or salon", () => {
  it("the bypass walk sees the whole source tree", () => {
    const files = allSrc();
    expect(files.length, "no file walked under apps/api/src at all").toBeGreaterThan(0);
    expect(
      files.length,
      `fewer files walked under apps/api/src than the measured floor (${FLOORS["api-src"]})`,
    ).toBeGreaterThanOrEqual(FLOORS["api-src"]);
  }, 60_000);

  it("positive control: the create finder sees property and bracket access and ignores reads", () => {
    const find = (src: string, model: string) => {
      const sf = parse("x.ts", src);
      return callsIn(sf, (c) => {
        const path = calleePath(c.expression).split(".");
        return (
          path.length >= 2 &&
          WRITE_METHODS.has(path[path.length - 1]) &&
          path[path.length - 2] === model
        );
      }).length;
    };
    expect(find(`await app.prisma.salonCoupling.create({});`, "salonCoupling")).toBe(1);
    expect(find(`await tx["salonCoupling"].createMany({});`, "salonCoupling")).toBe(1);
    expect(find(`await db.salonCoupling.upsert({});`, "salonCoupling")).toBe(1);
    expect(find(`await db.salonCoupling.findMany({});`, "salonCoupling")).toBe(0);
    expect(find(`await db.salon.create({});`, "salonCoupling")).toBe(0);
  });

  it("control run: the finder reaches the known create sites", () => {
    expect(filesWritingModel("salonCoupling")).not.toEqual([]);
  }, 60_000);

  it("salonCoupling is created only by the coupling facade and the Phorest config route", () => {
    expect(filesWritingModel("salonCoupling")).toEqual(
      [CPL, `${SRC}/contexts/scheduling/api/integrations.ts`].sort((a, b) => a.localeCompare(b)),
    );
  }, 60_000);

  it("salon is created only by the salon facade", () => {
    expect(filesWritingModel("salon")).toEqual([SALON_FACADE]);
  }, 60_000);

  it("apiKey and presenceSource are created only by their gated route files", () => {
    expect(filesWritingModel("apiKey")).toEqual([`${SRC}/contexts/platform/api/api-keys.ts`]);
    expect(filesWritingModel("presenceSource")).toEqual([
      `${TT_ROOT}/api/admin-presence-sources.ts`,
    ]);
  }, 60_000);

  it("terminalApiKey is created only by the gated route and the test-only bootstrap route", () => {
    // `api/test-bootstrap.ts` is the documented test-only route behind ALLOW_TEST_BOOTSTRAP: it
    // provisions e2e tenants (which book every module itself) and is not registered in production.
    expect(filesWritingModel("terminalApiKey")).toEqual(
      [`${TT_ROOT}/api/terminals.ts`, `${SRC}/contexts/platform/api/test-bootstrap.ts`].sort(
        (a, b) => a.localeCompare(b),
      ),
    );
  }, 60_000);
});
