/**
 * Phase 75b (Issue #75, D-20, AC-75-10) — the route set of the permission neutrality matrix,
 * derived from source text.
 *
 * The matrix proves that the switch from `requireRole` to permissions changes no access decision.
 * That proof is only as wide as its route set: a route the matrix does not know is a route whose
 * behaviour may change unseen. So the set is not a hand-kept list; it is parsed from the route
 * files and joined with `app.ts`'s registration prefixes, and the matrix test compares it with its
 * checked-in config in BOTH directions (a derived route without a spec or exclusion, and a spec or
 * exclusion without a derived route, both turn it red).
 *
 * ── Why an independent copy of the T-100-09 probe's parser ─────────────────────────────────────
 * `apps/api/tsconfig.json` sets `rootDir: "./src"`: a file under `src/` cannot import from
 * `apps/api/scripts/`, so `lint-t100-09-routes-validate.ts`'s parser is out of reach. The probe
 * (`t100-09-oracle-probe.test.ts`) keeps its own copy inside a test file, where it cannot be
 * imported either. This module is the same parser family (nearest preceding
 * `export async function` owns an `app.<method>(` call; `app.ts` import bindings joined with
 * `app.register(fn, { prefix })`), implemented once more. Two implementations anchored to the same
 * source text mean a bug in one cannot hide itself in the other.
 *
 * ── Why `composition/` is walked too ────────────────────────────────────────────────────────────
 * The probe walks only `contexts/*\/api/`. `composition/activity.ts`, `composition/dashboard.ts` and
 * `composition/reports.ts` register routes as well, and they hold three of the handler role checks
 * (the activity feed branches, the open-items manager count, the monthly PDF). A matrix without
 * them would miss exactly the places where the switch is least mechanical.
 *
 * ── Anti-vacuity ────────────────────────────────────────────────────────────────────────────────
 * The walk throws when the walked file set is empty and when the derived route set is empty, and
 * an exported route function without a resolvable prefix throws instead of dropping its routes —
 * a moved directory can never make the matrix compare nothing and pass.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// __dirname is apps/api/src/__tests__/neutrality — five levels up is the repo root.
const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..");
const API_SRC = join(REPO_ROOT, "apps", "api", "src");
const APP_TS_PATH = join(API_SRC, "app.ts");
const CONTEXTS_DIR = join(API_SRC, "contexts");
const COMPOSITION_DIR = join(API_SRC, "composition");

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

/** Every `.ts` source file under `dir`, skipping `__tests__` directories and `*.test.ts` files. */
function walkSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__") continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkSourceFiles(abs));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(abs);
    }
  }
  return out;
}

/** The route source files: every `contexts/<context>/api/**` file plus every `composition/*.ts`. */
export function discoverRouteSourceFiles(): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(CONTEXTS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const apiDir = join(CONTEXTS_DIR, entry.name, "api");
    if (!existsSync(apiDir)) continue;
    out.push(...walkSourceFiles(apiDir));
  }
  out.push(...walkSourceFiles(COMPOSITION_DIR));
  if (out.length === 0) {
    throw new Error(
      `route-derivation: no route source file found under ${CONTEXTS_DIR}/*/api or ${COMPOSITION_DIR}`,
    );
  }
  return out.sort();
}

interface RouteDeclaration {
  method: string;
  path: string;
  fn: string;
}

/** Every `app.<method>("<path>"` call in a file (newline-tolerant before the quote), attributed to
 * the nearest PRECEDING `export async function <name>(` — offset bucketing, no brace counting. */
function declarationsInFile(absPath: string): RouteDeclaration[] {
  const text = readFileSync(absPath, "utf8");
  const fnStarts: { name: string; at: number }[] = [];
  const fnDeclPattern = /export\s+async\s+function\s+([A-Za-z0-9_]+)\s*\(/g;
  let fnMatch: RegExpExecArray | null;
  while ((fnMatch = fnDeclPattern.exec(text))) {
    fnStarts.push({ name: fnMatch[1], at: fnMatch.index });
  }
  const routeCallPattern = new RegExp(
    `app\\.(${HTTP_METHODS.join("|")})\\(\\s*\\n?\\s*["'\`]([^"'\`]+)["'\`]`,
    "g",
  );
  const out: RouteDeclaration[] = [];
  let routeMatch: RegExpExecArray | null;
  while ((routeMatch = routeCallPattern.exec(text))) {
    let owner = "";
    for (const fn of fnStarts) {
      if (fn.at < routeMatch.index) owner = fn.name;
    }
    out.push({ method: routeMatch[1].toUpperCase(), path: routeMatch[2], fn: owner });
  }
  return out;
}

/** Export name of every route function → its `app.register(…, { prefix })` prefix in `app.ts`,
 * joined through the (alias-aware, multi-line) named-import bindings. */
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
    const prefixMatch = registerMatch[2].match(/prefix:\s*["']([^"']+)["']/);
    if (!prefixMatch) continue;
    const binding = registerMatch[1];
    prefixMap.set(bindingToExportName.get(binding) ?? binding, prefixMatch[1]);
  }
  return prefixMap;
}

/**
 * The sorted `"<METHOD> <url>"` set of every route declared in a route source file. Throws when a
 * route belongs to a function without a registration prefix, and when the result is empty.
 */
export function deriveMatrixRoutes(): string[] {
  const files = discoverRouteSourceFiles();
  const prefixMap = derivePrefixMap();
  const routes = new Set<string>();
  const unresolved = new Set<string>();
  for (const file of files) {
    for (const decl of declarationsInFile(file)) {
      const prefix = prefixMap.get(decl.fn);
      if (prefix === undefined) {
        unresolved.add(`${decl.fn || "<module level>"} (${file.slice(API_SRC.length + 1)})`);
        continue;
      }
      routes.add(`${decl.method} ${decl.path === "/" ? prefix : `${prefix}${decl.path}`}`);
    }
  }
  if (unresolved.size > 0) {
    throw new Error(
      `route-derivation: no registration prefix for route function(s): ${[...unresolved].sort().join(", ")}`,
    );
  }
  if (routes.size === 0) {
    throw new Error(`route-derivation: ${files.length} file(s) walked but no route derived`);
  }
  return [...routes].sort();
}

/** The `:param` names of a `"<METHOD> <url>"` route, in path order. */
export function pathParams(route: string): string[] {
  const url = route.split(" ")[1] ?? "";
  return url
    .split("/")
    .filter((segment) => segment.startsWith(":"))
    .map((segment) => segment.slice(1));
}

/** Whether a `"<METHOD> <url>"` route has at least one path parameter. */
export function hasPathParameter(route: string): boolean {
  return pathParams(route).length > 0;
}
