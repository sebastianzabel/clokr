/**
 * Issue #595 (D-03) - the browser never names the month of a stored snapshot.
 *
 * `SaldoSnapshot.periodStart` is a stored date in one of two conventions (the last day of the
 * previous month for a tenant-time-zone-converted row, the 1st of the month for a legacy row).
 * Two browser derivations used to turn it into a month: local getters on the stored date (the
 * browser's zone, not the tenant's) and a date-string slice. Both name every converted row one
 * month early. The server names the month (`snapshotMonthOf`) and serves it as `year`/`month`
 * fields, so no web file has a reason to read the stored date at all.
 *
 * The guard walks every non-test `.ts` / `.svelte` file under `apps/web/src` and fails on a
 * property read of `periodStart`. A local variable or a URL parameter of that name elsewhere
 * (for example a future period filter) is not a read of a snapshot and stays allowed. The
 * walked set is asserted non-empty first: a guard that checked nothing must never report success.
 *
 * Named blind spot: a value copied out of a snapshot object under another name is not seen; the
 * guard is a tripwire against the former shapes, not a proof of absence.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// vitest runs with apps/web as the working directory; a different cwd makes the walked set empty,
// which the floor below turns into a red test.
const SRC_ROOT = resolve(process.cwd(), "src");

/** A property access (`row.periodStart`, `row?.periodStart`, `row["periodStart"]`). */
const MEMBER_READ = /[\w$)\]]\s*\??\.\s*periodStart\b|\[\s*["']periodStart["']\s*\]/;
/** A destructuring assignment that pulls the member out of an object. */
const DESTRUCTURING_READ = /\{[^{}]*\bperiodStart\b[^{}]*\}\s*=[^=>]/;

function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("<!--");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === "__tests__" || name === "node_modules" || name.startsWith(".")) continue;
      walk(full, out);
    } else if (/\.(ts|svelte)$/.test(name) && !/\.test\.ts$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

/** Lines that read a `periodStart` member, as `path:line`. */
export function periodStartReads(file: string, source: string): string[] {
  const hits: string[] = [];
  source.split("\n").forEach((line, i) => {
    if (isCommentLine(line)) return;
    if (MEMBER_READ.test(line) || DESTRUCTURING_READ.test(line)) {
      hits.push(`${file}:${i + 1}: ${line.trim()}`);
    }
  });
  return hits;
}

describe("the web never reads a snapshot's periodStart (Issue #595, D-03)", () => {
  const files = walk(SRC_ROOT);

  it("walks a non-empty set of source files", () => {
    // Measured on 2026-10-17 with this walk: see the 595-03 SUMMARY. The floor keeps a margin for
    // normal deletions and turns red when the walk silently covers a fraction of the tree.
    expect(files.length).toBeGreaterThan(50);
  });

  it("no non-test web file reads a periodStart member", () => {
    const hits = files.flatMap((f) =>
      periodStartReads(relative(SRC_ROOT, f).replaceAll("\\", "/"), readFileSync(f, "utf8")),
    );
    expect(
      hits,
      "Issue #595 D-03 - months of stored snapshots are named by the server; read its " +
        "`year`/`month` fields instead of the stored date:\n" +
        hits.join("\n"),
    ).toEqual([]);
  });

  it("recognises the shapes it exists to catch", () => {
    expect(periodStartReads("x.ts", "const m = row.periodStart.slice(0, 7);")).toHaveLength(1);
    expect(periodStartReads("x.ts", "new Date(r?.periodStart).getMonth()")).toHaveLength(1);
    expect(periodStartReads("x.ts", "const { periodStart } = snap;")).toHaveLength(1);
    expect(periodStartReads("x.ts", 'const v = row["periodStart"];')).toHaveLength(1);
    // Allowed: a local of that name, a URL parameter, a comment.
    expect(periodStartReads("x.ts", "let periodStart = $state('');")).toHaveLength(0);
    expect(periodStartReads("x.ts", "params.set('periodStart', value);")).toHaveLength(0);
    expect(periodStartReads("x.ts", "// the row.periodStart is never read")).toHaveLength(0);
  });
});
