/**
 * Issue #587 (D-587-1, D-587-5) - a person's day status is resolved by ONE function.
 *
 * `resolveDayStatus()` (`contexts/time-tracking/presence.ts`) is the only place the obligation
 * (`isObligatedWorkday`), the due time (`isDayDue`) and the state (`resolvePresenceState`) are
 * combined. Before #587 `GET /dashboard/team-week` and `GET /dashboard/today-attendance` each held
 * their own copy of the chain and contradicted each other for the same person and day. This guard
 * keeps a further copy from coming back.
 *
 * What it checks (AST, comments and strings excluded; every non-test `.ts` file under
 * `apps/api/src`):
 *   1. `resolvePresenceState` is called in `presence.ts` (inside `resolveDayStatus`) and nowhere else.
 *   2. The calls of `isDayDue` / `isObligatedWorkday` outside `presence.ts` are exactly the
 *      register below - the MEASURED known copies (file, route or function, callee), each with a
 *      reason. A new call site, or a register entry that no longer matches one, turns the test red.
 *   3. The `/team-week`, `/today-attendance`, `/my-week` and `/open-items` handlers of
 *      `composition/dashboard.ts` each call `resolveDayStatus` and none of the three primitives.
 *
 * The register ended empty with Issue #670 (D-587-5): it is not a list of accepted debt to be
 * extended, a new entry is a finding to report.
 *
 * Stated blind spot: a primitive imported under another name, or called through a variable, is not
 * seen. Review has to catch a creative workaround.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";
import ts from "typescript";
import { describe, it, expect } from "vitest";

// __dirname is apps/api/src/__tests__.
const SRC_ROOT = join(__dirname, "..");
// The kernel lives in the presence module: a module of its own would join the measured import cycle
// (gate `measure-context-boundary-imports --cycles`, ADR Eintrag P, Nachtrag Phase 587).
const KERNEL = "contexts/time-tracking/presence.ts";
const DASHBOARD = "composition/dashboard.ts";
// Floor for the walked file count (measured 257 non-test files on 2026-10-17).
const MIN_WALKED_FILES = 150;

const PRIMITIVES = ["resolvePresenceState", "isDayDue", "isObligatedWorkday"] as const;
type Primitive = (typeof PRIMITIVES)[number];

interface CallSite {
  file: string;
  region: string;
  callee: Primitive | "resolveDayStatus";
}

interface KnownCopy {
  file: string;
  /** `get /my-week` for a route, `function name` for a function declaration. */
  region: string;
  callee: Primitive;
  reason: string;
  /** The follow-up issue (D-587-5) that removes this entry. */
  followUp: number;
}

// Issue #670 emptied the register: /my-week and /open-items resolve through `resolveDayStatus`, and
// the Monatsabschluss gap detector reads the obligation alone through `obligationOfDay` (a
// delegate in the kernel, not a status chain). A new entry here is a finding to report.
const KNOWN_COPIES: readonly KnownCopy[] = [];

function walk(absDir: string, out: string[]): void {
  for (const entry of readdirSync(absDir)) {
    if (entry === "__tests__" || entry === "node_modules") continue;
    const abs = join(absDir, entry);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else if (extname(entry) === ".ts" && !entry.endsWith(".test.ts") && !entry.endsWith(".d.ts")) {
      out.push(abs);
    }
  }
}

function rel(abs: string): string {
  return relative(SRC_ROOT, abs).split("\\").join("/");
}

/** `get /path` when the node sits inside `app.get("/path", ...)`, else the enclosing function. */
function regionOf(node: ts.Node): string {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      ["get", "post", "put", "patch", "delete"].includes(n.expression.name.text) &&
      n.arguments.length > 0 &&
      ts.isStringLiteralLike(n.arguments[0])
    ) {
      return `${n.expression.name.text} ${n.arguments[0].text}`;
    }
    if (ts.isFunctionDeclaration(n) && n.name) return `function ${n.name.text}`;
  }
  return "<module>";
}

const WATCHED = new Set<string>([...PRIMITIVES, "resolveDayStatus"]);

function callSitesOf(source: string, file: string): CallSite[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const sites: CallSite[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : null;
      if (name !== null && WATCHED.has(name)) {
        sites.push({ file, region: regionOf(n), callee: name as CallSite["callee"] });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return sites;
}

function measure(): { files: string[]; sites: CallSite[] } {
  const abs: string[] = [];
  walk(SRC_ROOT, abs);
  const files = abs.map(rel);
  const sites: CallSite[] = [];
  for (const a of abs) sites.push(...callSitesOf(readFileSync(a, "utf8"), rel(a)));
  return { files, sites };
}

const key = (s: { file: string; region: string; callee: string }) =>
  `${s.file} | ${s.region} | ${s.callee}`;
const sortedKeys = (list: Array<{ file: string; region: string; callee: string }>) =>
  [...new Set(list.map(key))].sort((a, b) => a.localeCompare(b));

describe("Issue #587 - the day status is resolved by one function", () => {
  const { files, sites } = measure();

  it("walks a non-empty set that contains the kernel and the dashboard", () => {
    expect(files.length).toBeGreaterThanOrEqual(MIN_WALKED_FILES);
    expect(files).toContain(KERNEL);
    expect(files).toContain(DASHBOARD);
  });

  it("resolvePresenceState is called in the kernel and nowhere else", () => {
    const calls = sites.filter((s) => s.callee === "resolvePresenceState");
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter((s) => s.file !== KERNEL)).toEqual([]);
  });

  it("isDayDue / isObligatedWorkday outside the kernel are exactly the register of known copies", () => {
    const outside = sites.filter(
      (s) => s.file !== KERNEL && (s.callee === "isDayDue" || s.callee === "isObligatedWorkday"),
    );
    expect(sortedKeys(outside)).toEqual(sortedKeys([...KNOWN_COPIES]));
  });

  it("the register is empty (Issue #670) and every entry, should one return, names a reason and a follow-up", () => {
    expect(KNOWN_COPIES).toEqual([]);
    for (const c of KNOWN_COPIES) {
      expect(c.reason.length, key(c)).toBeGreaterThan(20);
      expect(Number.isInteger(c.followUp) && c.followUp > 0, key(c)).toBe(true);
    }
  });

  it("every person-day reader resolves through resolveDayStatus and calls no primitive", () => {
    // Issue #670: /my-week and /open-items joined the team week and the attendance list.
    for (const region of [
      "get /team-week",
      "get /today-attendance",
      "get /my-week",
      "get /open-items",
    ]) {
      const inRegion = sites.filter((s) => s.file === DASHBOARD && s.region === region);
      expect(
        inRegion.filter((s) => s.callee === "resolveDayStatus").length,
        `${region} calls resolveDayStatus`,
      ).toBeGreaterThan(0);
      expect(
        inRegion.filter((s) => s.callee !== "resolveDayStatus").map(key),
        `${region} calls no status primitive`,
      ).toEqual([]);
    }
  });
});
