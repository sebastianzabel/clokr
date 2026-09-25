/**
 * Phase 69b (Issue #69) — exactly one function asks "which time entries does employee X have on
 * day D": `findEntriesOfDay()` in `contexts/time-tracking/day-entries.ts`.
 *
 * Why: the assumption "one entry per employee and day" lives in the partial unique index
 * `TimeEntry_employeeId_date_unique_not_deleted` AND used to be spread over eleven hand-written
 * day lookups. If several entries per day ever arrive (#70), the index is cheap to drop — the
 * scattered lookups are what is expensive. This gate keeps them from coming back.
 *
 * What it flags: a call `<anything>.timeEntry.<find*>` in `apps/api/src/**` (tests excluded) whose
 * LITERAL `where` object filters on `employeeId` AND on `date` with day meaning:
 *   (a) `date` is not an object literal (equality, incl. the shorthand `{ employeeId, date }`),
 *   (b) `date: { equals: … }`,
 *   (c) a one-day window: lower bound (`gte`/`gt`) and upper bound (`lte`/`lt`) that reference the
 *       same identifier set (the former `{ gte: new Date(d), lte: new Date(d + "T23:59:59.999Z") }`),
 * plus any `employeeId_date` compound-unique key. A range such as `{ gte: from, lte: to }` is a
 * range list, not a day lookup, and is not flagged; neither is a lookup by `id`.
 *
 * Blind spots, stated so nobody over-trusts it: a `where` built in a variable or via spread is not
 * inspected; `apps/api/scripts/**` is out of scope on purpose (operator tools, Issue #69 "Nicht Teil
 * davon").
 *
 * It also pins two things the issue asks to stay true: `checkOneEntryPerDay` reads through
 * `findEntriesOfDay`, and the `// MULTI-ENTRY: <reason>` markers are complete (REQUIRED_MARKERS is
 * the full list — a marker anywhere else, or a missing one, turns this red).
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, extname } from "node:path";
import ts from "typescript";
import { describe, it, expect } from "vitest";

// __dirname is apps/api/src/__tests__ — four levels up is the repo root.
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const SCAN_ROOT = "apps/api/src";
const DAY_ENTRIES_FILE = "apps/api/src/contexts/time-tracking/day-entries.ts";
const FIND_METHODS = new Set([
  "findFirst",
  "findFirstOrThrow",
  "findUnique",
  "findUniqueOrThrow",
  "findMany",
]);

// Floor for the number of timeEntry find calls the walk must see. Measured 2026-09-24:
// 35 before the conversion; 25 after (eleven day lookups disappear, one appears in day-entries.ts).
const MIN_TIME_ENTRY_FIND_CALLS = 20;

// The complete list of files carrying `// MULTI-ENTRY: <reason>` and the minimum number of marked
// lines in each. Every place that would have to compute differently with several entries per day.
const REQUIRED_MARKERS: Record<string, number> = {
  "apps/api/src/contexts/time-tracking/day-entries.ts": 1,
  "apps/api/src/contexts/time-tracking/arbzg.ts": 4,
  "apps/api/src/contexts/time-tracking/entry-invariants.ts": 1,
  "apps/api/src/contexts/time-tracking/api/presence.ts": 3,
  "apps/api/src/contexts/time-tracking/api/time-entries.ts": 1,
  "apps/api/src/services/clock/resolver.ts": 3,
  "apps/api/src/services/clock/consolidate.ts": 1,
  "apps/api/src/contexts/platform/facade/holiday-resolution.ts": 1,
};
const MARKER_RE = /\/\/ MULTI-ENTRY: .{10,}/;

function collectFiles(): string[] {
  const out: string[] = [];
  function walk(absDir: string) {
    for (const entry of readdirSync(absDir)) {
      if (entry === "__tests__" || entry === "node_modules") continue;
      const abs = join(absDir, entry);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (extname(entry) === ".ts" && !entry.endsWith(".test.ts")) out.push(abs);
    }
  }
  walk(join(REPO_ROOT, SCAN_ROOT));
  return out;
}

function repoRel(absPath: string): string {
  return relative(REPO_ROOT, absPath).split("\\").join("/");
}

function propName(p: ts.ObjectLiteralElementLike): string | undefined {
  if (!p.name) return undefined;
  if (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) return p.name.text;
  return undefined;
}

function identifiersIn(node: ts.Node): Set<string> {
  const ids = new Set<string>();
  const visit = (n: ts.Node) => {
    if (ts.isIdentifier(n) && n.text !== "Date") ids.add(n.text);
    ts.forEachChild(n, visit);
  };
  visit(node);
  return ids;
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/** True when a `date` property value has single-day meaning (cases a/b/c in the header). */
function isDayPredicate(prop: ts.ObjectLiteralElementLike): boolean {
  if (ts.isShorthandPropertyAssignment(prop)) return true;
  if (!ts.isPropertyAssignment(prop)) return false;
  const v = prop.initializer;
  if (!ts.isObjectLiteralExpression(v)) return true;
  const byName = new Map<string, ts.Expression>();
  for (const p of v.properties) {
    const n = propName(p);
    if (n && ts.isPropertyAssignment(p)) byName.set(n, p.initializer);
  }
  if (byName.has("equals")) return true;
  const lower = byName.get("gte") ?? byName.get("gt");
  const upper = byName.get("lte") ?? byName.get("lt");
  if (lower && upper) return sameSet(identifiersIn(lower), identifiersIn(upper));
  return false;
}

function hasCompoundDayKey(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (
      (ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) &&
      propName(n) === "employeeId_date"
    )
      found = true;
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

interface FindCall {
  file: string;
  line: number;
  method: string;
  isDayLookup: boolean;
}

function scanSource(file: string, text: string): FindCall[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const calls: FindCall[] = [];
  const visit = (n: ts.Node) => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      FIND_METHODS.has(n.expression.name.text) &&
      ts.isPropertyAccessExpression(n.expression.expression) &&
      n.expression.expression.name.text === "timeEntry"
    ) {
      let isDayLookup = false;
      const arg = n.arguments[0];
      if (arg && ts.isObjectLiteralExpression(arg)) {
        const where = arg.properties.find((p) => propName(p) === "where");
        if (
          where &&
          ts.isPropertyAssignment(where) &&
          ts.isObjectLiteralExpression(where.initializer)
        ) {
          const props = where.initializer.properties;
          const hasEmployee = props.some((p) => propName(p) === "employeeId");
          const dateProp = props.find((p) => propName(p) === "date");
          isDayLookup =
            (hasEmployee && dateProp !== undefined && isDayPredicate(dateProp)) ||
            hasCompoundDayKey(where.initializer);
        }
      }
      calls.push({
        file,
        line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
        method: n.expression.name.text,
        isDayLookup,
      });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return calls;
}

function scanTree(): { files: string[]; calls: FindCall[] } {
  const files = collectFiles();
  const calls = files.flatMap((abs) => scanSource(repoRel(abs), readFileSync(abs, "utf8")));
  return { files, calls };
}

describe("Phase 69b — time-entry day lookups go through findEntriesOfDay", () => {
  it("scan sees the tree (a silently-empty walk would pass forever)", () => {
    const files = collectFiles();
    expect(
      files.length,
      "no file scanned under apps/api/src — the scan root moved or emptied",
    ).toBeGreaterThan(0);
    const { calls } = scanTree();
    expect(
      calls.length,
      "fewer timeEntry find calls than the measured floor — the detector no longer recognises them",
    ).toBeGreaterThanOrEqual(MIN_TIME_ENTRY_FIND_CALLS);
  });

  it("detector self-test: flags day predicates, ignores ranges and id lookups", () => {
    const src = `
      async function f(db, employeeId, date, d, from, to, id) {
        await db.timeEntry.findFirst({ where: { employeeId, date } });                          // P1
        await db.timeEntry.findFirst({ where: { employeeId: x, date: day } });                  // P2
        await db.timeEntry.findMany({ where: { employeeId, date: { equals: day } } });          // P3
        await db.timeEntry.findFirst({ where: { employeeId, date: { gte: new Date(d), lte: new Date(d + "T23:59:59.999Z") } } }); // P4
        await db.timeEntry.findUnique({ where: { employeeId_date: { employeeId, date } } });   // P5
        await db.timeEntry.findMany({ where: { employeeId, date: { gte: from, lte: to } } });  // N1
        await db.timeEntry.findFirst({ where: { id } });                                       // N2
        await db.timeEntry.findFirst({ where: { employeeId, deletedAt: null } });              // N3
        await db.timeEntry.findFirst({ where: { date } });                                     // N4
        await db.timeEntry.findFirst({ where: { employeeId, OR: [{ endTime: null, date }] } }); // N5
      }`;
    const calls = scanSource("fixture.ts", src);
    expect(calls).toHaveLength(10);
    expect(calls.map((c) => c.isDayLookup)).toEqual([
      true,
      true,
      true,
      true,
      true,
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it("no timeEntry day lookup outside day-entries.ts", () => {
    const { calls } = scanTree();
    const violations = calls
      .filter((c) => c.isDayLookup && c.file !== DAY_ENTRIES_FILE)
      .map((c) => `${c.file}:${c.line} timeEntry.${c.method}`)
      .sort();
    expect(
      violations,
      `day lookup(s) outside findEntriesOfDay — route them through contexts/time-tracking/day-entries.ts:\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("positive control: day-entries.ts holds exactly one day lookup", () => {
    const { calls } = scanTree();
    const inside = calls.filter((c) => c.isDayLookup && c.file === DAY_ENTRIES_FILE);
    expect(inside, "day-entries.ts must contain exactly one timeEntry day lookup").toHaveLength(1);
  });

  it("checkOneEntryPerDay reads through findEntriesOfDay and touches no timeEntry delegate itself", () => {
    const file = join(REPO_ROOT, "apps/api/src/contexts/time-tracking/entry-invariants.ts");
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const fn = sf.statements.find(
      (s): s is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(s) && s.name?.text === "checkOneEntryPerDay",
    );
    expect(fn?.body, "checkOneEntryPerDay not found in entry-invariants.ts").toBeDefined();
    const body = fn!.body!.getText(sf);
    expect(body, "checkOneEntryPerDay must call findEntriesOfDay").toMatch(/\bfindEntriesOfDay\(/);
    expect(body, "checkOneEntryPerDay must not query timeEntry directly").not.toMatch(
      /\.timeEntry\b/,
    );
  });

  it("MULTI-ENTRY markers are complete and nowhere else", () => {
    const missing: string[] = [];
    for (const [rel, min] of Object.entries(REQUIRED_MARKERS)) {
      const abs = join(REPO_ROOT, rel);
      const count = existsSync(abs)
        ? readFileSync(abs, "utf8")
            .split("\n")
            .filter((l) => MARKER_RE.test(l)).length
        : 0;
      if (count < min) missing.push(`${rel} has ${count} marker line(s), needs ${min}`);
    }
    expect(missing, `missing MULTI-ENTRY markers:\n${missing.join("\n")}`).toEqual([]);
    const markedFiles = collectFiles()
      .filter((abs) => readFileSync(abs, "utf8").includes("MULTI-ENTRY:"))
      .map(repoRel)
      .sort();
    expect(
      markedFiles,
      "a MULTI-ENTRY marker outside REQUIRED_MARKERS — add the file to the table",
    ).toEqual(Object.keys(REQUIRED_MARKERS).sort());
  });
});
