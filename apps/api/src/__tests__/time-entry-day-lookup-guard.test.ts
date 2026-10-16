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
 * It also pins two things the issue asks to stay true: the one-per-day function stays gone, and no
 * `// MULTI-ENTRY: <reason>` marker is left in production source (since Phase 70b-06 the list of
 * places that had to compute differently with several entries per day is empty).
 *
 * Amendment 2026-10-16 (Issue #70, Phase 70b-02): the rule "at most one entry per employee and day"
 * left the code. `checkOneEntryPerDay` and its call sites are deleted, so the two files whose
 * markers described that rule (`entry-invariants.ts`, `api/time-entries.ts`) leave REQUIRED_MARKERS
 * and the AST case that pinned the function's read path now pins its ABSENCE (same case count). The
 * remaining markers stay: each still names a place that must compute differently once several
 * entries per day exist, and is resolved by a later 70b plan.
 *
 * Amendment 2026-10-16 (Issue #70, Phase 70b-03): the clock resolved its markers — `resolver.ts`
 * (a different explicit salon starts a new entry, every START checks month lock and overlap),
 * `day-entries.ts` (the selectors `openEntryOf` / `latestEndingClosed`) and `api/presence.ts`
 * (WIFI keeps never starting a second salon) left REQUIRED_MARKERS in the task that removed their
 * markers; `consolidate.ts` (never merges across salons, D-03) left in the following task. Case
 * count unchanged; "nowhere else" is still enforced.
 *
 * Amendment 2026-10-16 (Issue #70, Phase 70b-04): the day rules were swept — `arbzg.ts` (the day-break
 * kernel already reads every row; the rest-period rules select by latest end / earliest start) and
 * `platform/facade/holiday-resolution.ts` (the salon of the earliest entry of the day is the final
 * work-location rule, owner decision 2026-10-16) became decision comments and left REQUIRED_MARKERS in
 * the task that rewrote them. Only `clock-salon-choice.ts` was left.
 *
 * Amendment 2026-10-16 (Issue #70, Phase 70b-06): `clock-salon-choice.ts` resolved its marker (a
 * finished day offers a second salon, D-02/D-11) and REQUIRED_MARKERS is gone. The case "markers are
 * complete and nowhere else" became "no MULTI-ENTRY marker remains" over the same source walk, with an
 * explicit non-empty floor. Case count unchanged.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
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

// Floor for the number of production source files the marker walk must see. Measured 2026-10-16
// (Phase 70b-06): 249 files under apps/api/src outside __tests__ and *.test.ts; floor rounded down to
// the next ten. A moved or emptied source tree must turn the case red, never pass having checked nothing.
const MIN_WALKED_SOURCE_FILES = 240;

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

  it("the one-per-day function is gone: no declaration or call of checkOneEntryPerDay in production source", () => {
    const files = collectFiles();
    // Anti-vacuity: the walk must have seen the source tree (entry-invariants.ts is part of it).
    expect(files.length, "the source walk found no files").toBeGreaterThan(50);
    expect(files.map(repoRel), "entry-invariants.ts must be inside the walked set").toContain(
      "apps/api/src/contexts/time-tracking/entry-invariants.ts",
    );
    const offenders = files
      .filter((abs) => /\bcheckOneEntryPerDay\b/.test(readFileSync(abs, "utf8")))
      .map(repoRel)
      .sort();
    expect(
      offenders,
      `the one-entry-per-day rule left the code with Issue #70 — remove:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("no MULTI-ENTRY marker remains in production source (every place now handles several entries per day)", () => {
    const files = collectFiles();
    // Anti-vacuity: the walk must have seen the production source tree.
    expect(
      files.length,
      `the marker walk saw only ${files.length} files — the source tree moved or emptied`,
    ).toBeGreaterThanOrEqual(MIN_WALKED_SOURCE_FILES);
    const markedFiles = files
      .filter((abs) => readFileSync(abs, "utf8").includes("MULTI-ENTRY:"))
      .map(repoRel)
      .sort();
    expect(markedFiles, "a MULTI-ENTRY marker is left — resolve it as a decision comment").toEqual(
      [],
    );
  });
});
