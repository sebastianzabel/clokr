/**
 * Phase 98b (T3b, Option A, D-03) — the gate that keeps the requested/imposed vocabulary split
 * machine-checkable against the schema.
 *
 * Replaces `absence-type-mapping-guard.test.ts` (deleted in 98b-04): that file's subject — keeping
 * two separate enums, `AbsenceType` and `LeaveTypeCode`, in written correspondence — no longer
 * exists after the merge. There is now ONE enum, `LeaveTypeCode`, and the question this file
 * answers instead is: does it still split cleanly into a requested half and an imposed half?
 *
 * This is a DELIBERATELY separate file from `leave-type-identity-guard.test.ts` (Phase 97), not an
 * extension of it. That guard answers "does a German display literal act as a control value
 * anywhere", scanning source text against an `ALLOWED` exception list. This gate answers "are
 * REQUESTABLE_CODES and IMPOSED_ONLY_CODES still disjoint, complete, and correctly wired". Folding
 * them together would make one red test ambiguous.
 *
 * **Ground truth is the parsed schema text, not a local tuple (the Phase 98 gate design note).**
 * `98-01-SUMMARY.md`, "Gate design note", records that a gate specified to compare two LOCAL
 * structures against each other (the tuple vs. a local mirror) fails to catch a SYNCHRONISED
 * mutation — a value removed from both structures in the same edit leaves them consistent with
 * EACH OTHER while silently drifting from the schema. `as const satisfies readonly
 * LeaveTypeCode[]` only proves each tuple's members are valid `LeaveTypeCode` values; it does NOT
 * require the union of the two tuples to cover the whole enum. A twelfth member added to the
 * Prisma schema and to neither tuple still compiles today — G2 below is what turns that red.
 *
 * This file lives in `__tests__`, which `leave-type-identity-guard.test.ts`'s own scan excludes by
 * construction (`EXCLUDE_DIRS`) — so this file may freely contain the literals and code-identifiers
 * it searches for without triggering that other gate.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { describe, it, expect } from "vitest";
import type { LeaveTypeCode } from "@clokr/db";
import {
  REQUESTABLE_CODES,
  IMPOSED_ONLY_CODES,
  DISPLAY_NAME,
} from "../contexts/absence/leave-type";

// __dirname is apps/api/src/__tests__ — four levels up is the repo root, same as
// leave-type-identity-guard.test.ts.
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const SCHEMA_PATH = join(REPO_ROOT, "packages/db/prisma/schema.prisma");

/** Parses one `enum Name { ... }` block from the raw schema text into its member identifiers,
 *  stripping `//` trailing comments. Copied verbatim from the deleted
 *  `absence-type-mapping-guard.test.ts` — was private there too, and duplicating this ~10-line
 *  helper for its one remaining consumer is the ADR-rule-5-consistent choice over extracting a
 *  shared module for a single caller. */
function parseEnumMembers(schemaText: string, enumName: string): string[] {
  const re = new RegExp(`enum\\s+${enumName}\\s*\\{([^}]*)\\}`, "m");
  const match = schemaText.match(re);
  if (!match) throw new Error(`enum ${enumName} not found in schema.prisma`);
  return match[1]
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "").trim())
    .filter((line) => line.length > 0);
}

// ── G1 — the two tuples are disjoint ─────────────────────────────────────────
describe("G1 — REQUESTABLE_CODES and IMPOSED_ONLY_CODES are disjoint", () => {
  it('no code is both requestable and imposed — an imposed absence that becomes requestable is the regression Option A exists to prevent ("Berufsschule beantragen" is factually wrong)', () => {
    const overlap = REQUESTABLE_CODES.filter((c) =>
      (IMPOSED_ONLY_CODES as readonly string[]).includes(c),
    );
    expect(overlap).toEqual([]);
  });
});

// ── G2 — completeness, against the SCHEMA, not against the tuples ────────────
describe("G2 — the two tuples together cover the LeaveTypeCode enum exactly", () => {
  const schemaText = readFileSync(SCHEMA_PATH, "utf-8");

  // Ground truth is the parsed schema text on purpose. Comparing the two tuples against each
  // other, or against a third local list, cannot catch a SYNCHRONISED mutation — a value removed
  // from a tuple AND from a table in one edit leaves both local structures consistent. Phase 98
  // found exactly this (98-01-SUMMARY.md, "Gate design note") and it is the reason this gate
  // reads a file instead of an import.
  it("REQUESTABLE_CODES union IMPOSED_ONLY_CODES equals the enum declared in schema.prisma — a twelfth member added to neither tuple still compiles, and this is what stops it", () => {
    const schemaMembers = new Set(parseEnumMembers(schemaText, "LeaveTypeCode"));
    expect(schemaMembers.size).toBe(11);
    expect(new Set([...REQUESTABLE_CODES, ...IMPOSED_ONLY_CODES])).toEqual(schemaMembers);
  });

  it("DISPLAY_NAME has exactly one entry per schema-declared member — the display table cannot silently lag the enum either", () => {
    const schemaMembers = new Set(parseEnumMembers(schemaText, "LeaveTypeCode"));
    expect(new Set(Object.keys(DISPLAY_NAME))).toEqual(schemaMembers);
  });

  it("the AbsenceType enum is gone from the schema — one vocabulary, not two (Issue #98's acceptance criterion)", () => {
    expect(schemaText).not.toMatch(/enum\s+AbsenceType\s*\{/);
  });
});

// ── G3 — the tuple behind z.enum() is the REQUESTABLE one ────────────────────
describe("G3 — both request-body validators are bound to REQUESTABLE_CODES", () => {
  const LEAVE_ROUTE = join(REPO_ROOT, "apps/api/src/contexts/absence/api/leave.ts");

  // A text scan, deliberately: Zod's compiled schema is not introspectable at the
  // object-identity level, and "which symbol is actually used here" is exactly the question the
  // sibling guard already answers this way. The danger is a widened or inlined tuple reaching
  // z.enum() with no compile error.
  it("routes/leave.ts imports REQUESTABLE_CODES under the local alias, and every z.enum() there fed a leave-type tuple is bound to it by name — never a redeclared literal array", () => {
    const src = readFileSync(LEAVE_ROUTE, "utf-8");
    expect(src).toMatch(/REQUESTABLE_CODES as TYPE_CODES/);
    const args = [...src.matchAll(/z\.enum\(([^)]*)\)/g)].map((m) => m[1].trim());
    const typeCodeArgs = args.filter((a) => a.includes("TYPE_CODES"));
    expect(typeCodeArgs.length).toBeGreaterThanOrEqual(2);
    for (const a of typeCodeArgs) expect(a).toBe("TYPE_CODES");
  });

  it("no imposed code appears as a request-side literal in routes/leave.ts", () => {
    const src = readFileSync(LEAVE_ROUTE, "utf-8");
    for (const imposed of IMPOSED_ONLY_CODES) {
      expect(src).not.toMatch(new RegExp(`z\\.enum\\([^)]*${imposed}`));
    }
  });
});

// ── G4 — the OTHER anti-removal pin ──────────────────────────────────────────
describe("G4 — LeaveTypeCode.OTHER anti-removal pin", () => {
  it("OTHER has NO writer in production code, which makes it look like a dead enum value — it is not. 15 production rows across 13 employees (hand-inserted pre-tracking bridges, 2026-01-01..2026-05-26) depend on it; their days = 0.00 is misleading because the Soll credit comes from the DATE RANGE. Removing or renaming it changes those employees' saldo across five months, violating Issue #98's own criterion. This assertion is the phase's defence against its own trap — a future cleanup PR meets a red test with the reason attached", () => {
    expect(IMPOSED_ONLY_CODES as readonly string[]).toContain("OTHER");
    expect(Object.keys(DISPLAY_NAME)).toContain("OTHER");
    const schemaText = readFileSync(SCHEMA_PATH, "utf-8");
    expect(parseEnumMembers(schemaText, "LeaveTypeCode")).toContain("OTHER");
  });
});

// ── G5 — no production or seed code writes an Absence with a requestable-only code ────
//
// Carried forward from the deleted guard's G7, re-aimed at the post-merge spellings. This is a
// TEXT scan, deliberately, not a runtime assertion. `packages/db/src/*.ts` are standalone scripts
// run against a database with `tsx`, not importable test subjects — there is no function here a
// test could call and inspect. The defect this prevents is someone writing the literal
// `type: "SICK"` (or one of its three siblings) back onto a `prisma.absence.create` call; a text
// scan catches that the moment it is written, rather than the next time somebody actually runs the
// seed against a database and notices the wrong row show up.
//
// **Scope covers PRODUCTION code, not only the seeds (Phase 98b review, WR-01).** The version of
// this gate that shipped with 98b-05 scanned `packages/db/src` alone — but the seeds hold exactly
// ONE `absence.create` call, and the other two live in production API code
// (`apps/api/src/utils/vocational-school-generator.ts`, `apps/api/src/routes/vocational-school.ts`).
// A gate aimed only at the demo seed would have watched the least important of the three writers.
// `apps/api/src` is therefore a scan root too, `__tests__` excluded.
//
// Note what this does NOT do: it is still a text scan, so it does not make `Absence.type`
// structurally unable to hold a requestable code. Before the merge the `AbsenceType` enum made
// `absence.create({ type: "VACATION" })` impossible at the DB level; after it, `Absence.type` is
// `LeaveTypeCode` and all eleven codes are type-valid. Closing that structurally (an `AbsenceCode`
// subtype threaded through the three call sites) is an open design question, not something this
// gate claims to have solved. Detection is what is here.
//
// Deliberately NOT repo-wide. Three e2e fixtures (`apps/e2e/tests/leave-flow.spec.ts`,
// `apps/e2e/tests/overtime-saldo-flow.spec.ts`, `apps/e2e/fixtures/visual-seed.ts`) legitimately
// contain the literal `type: "SICK"` as a `LeaveTypeCode` in a `POST /api/v1/leave/requests`
// body, as do many `apps/api/src/__tests__` files — a scan that reached them would flag correct
// code, and a gate that flags correct code gets an exception list, which is the failure mode this
// phase is avoiding.
//
// Two limits of a text scan, stated rather than papered over (kept verbatim from the deleted
// guard):
//
//  1. It reaches LITERAL writes only. `type: sickType` or a spread of a prepared object defeats
//     it completely, and no amount of regex fixes that — catching those needs the type-level check
//     named above, which this gate does not attempt. The pattern below is quote- and
//     whitespace-tolerant so the SPELLING of a literal cannot slip past (`type : "SICK"`,
//     `type:'SICK'`, `type: "SICK" satisfies LeaveTypeCode` all match); an indirection through a
//     variable remains out of reach, by construction.
//
//  2. It is MODEL-BLIND: it does not know which prisma model the matched literal belongs to, so it
//     would also fire on some future non-Absence model whose `type` field happened to take one of
//     these four values. That is accepted deliberately, because the obvious narrowing is worse:
//     restricting the scan to files that also contain `absence.create` would, measured today, stop
//     scanning `packages/db/src/reset-demo.ts` altogether. A gate that silently stops looking at
//     the file it was written for is worse than one that occasionally asks a human to look at a
//     line. If this ever fires on a genuinely unrelated model, narrow it to that model — do not
//     delete the assertion.
describe("G5 — no production or seed code writes an Absence with a requestable-only code", () => {
  const SCAN_ROOTS = ["packages/db/src", "apps/api/src"];
  const EXCLUDE_DIRS = new Set(["__tests__", "node_modules", "dist", "build", "generated"]);
  // The three `absence.create()` call sites in the repo, measured 2026-09-15. Asserted below to be
  // inside the scanned set: a walk that silently stops reaching them would leave `violations`
  // empty and report success on a scan that looked at nothing relevant.
  const KNOWN_ABSENCE_WRITERS = [
    "packages/db/src/seed-demo.ts",
    "apps/api/src/contexts/absence/vocational-school-generator.ts",
    "apps/api/src/contexts/absence/api/vocational-school.ts",
  ];
  // The four ADR-requested-only codes, post-merge spellings (the `_LEAVE` suffix no longer
  // exists — SPECIAL_LEAVE/UNPAID_LEAVE were retyped to SPECIAL/UNPAID by 98b-04's migration).
  //
  // The `satisfies` anchor is load-bearing, not decoration (Phase 98b review, IN-02). The deleted
  // guard carried it on the equivalent tuple; without it a misspelling (`"SICK_CHLID"`) compiles,
  // the generated regex never matches anything, and the gate silently stops checking that code —
  // a gate that passes no matter what, which is the failure mode this whole file argues against.
  // What it still does NOT pin is the tuple's MEMBERSHIP: nothing fails if a future edit drops
  // `"UNPAID"` from the list, only if it misspells one.
  const REQUESTED_ONLY_FOR_ABSENCE = [
    "SICK",
    "SICK_CHILD",
    "SPECIAL",
    "UNPAID",
  ] as const satisfies readonly LeaveTypeCode[];

  function scannedFiles(): string[] {
    const out: string[] = [];
    function walk(absDir: string) {
      for (const entry of readdirSync(absDir)) {
        if (EXCLUDE_DIRS.has(entry)) continue;
        const abs = join(absDir, entry);
        if (statSync(abs).isDirectory()) walk(abs);
        else if (extname(entry) === ".ts") out.push(abs);
      }
    }
    for (const root of SCAN_ROOTS) {
      const absRoot = join(REPO_ROOT, root);
      // Same deliberate no-catch as G6: only a missing root is skipped, every other walk error
      // propagates rather than truncating the scan into a vacuous pass.
      if (!existsSync(absRoot)) continue;
      walk(absRoot);
    }
    return out;
  }

  it("the scan actually reaches all three absence.create() call sites — a gate that stops looking at the files it was written for passes no matter what", () => {
    const scanned = new Set(scannedFiles().map((abs) => relative(REPO_ROOT, abs)));
    for (const writer of KNOWN_ABSENCE_WRITERS) expect([...scanned]).toContain(writer);
  });

  it('`type: "<requestable-only code>"` occurs in zero scanned production or seed files', () => {
    const violations: string[] = [];
    for (const abs of scannedFiles()) {
      const lines = readFileSync(abs, "utf-8").split("\n");
      for (const code of REQUESTED_ONLY_FOR_ABSENCE) {
        // `\btype` is case-sensitive on purpose: it must match the `type:` property and not
        // `leaveType:` / `sickType:`, which name something else entirely.
        const re = new RegExp(`\\btype\\s*:\\s*["']${code}["']`);
        lines.forEach((line, i) => {
          if (!re.test(line)) return;
          violations.push(
            `${relative(REPO_ROOT, abs)}:${i + 1}: ${line.trim()}\n` +
              `  found a literal type: "${code}". ADR 0001 assigns SICK, SICK_CHILD, SPECIAL ` +
              `and UNPAID to LeaveRequest, not Absence — write it as a LeaveRequest with the ` +
              `matching LeaveType.code, not as an Absence. See REQUESTABLE_CODES / ` +
              `IMPOSED_ONLY_CODES in apps/api/src/utils/leave-type.ts for the split. If this ` +
              `line belongs to a model other than Absence, see limit 2 in this block's docblock ` +
              `before touching the assertion.`,
          );
        });
      }
    }
    expect(violations.join("\n")).toBe("");
  });
});

// ── G6 — no redeclaration of the vocabulary ──────────────────────────────────
describe("G6 — no redeclaration of the LeaveTypeCode vocabulary", () => {
  const SCAN_ROOTS = ["apps/api/src", "apps/web/src", "packages/types/src", "packages/db/src"];
  const EXCLUDE_DIRS = new Set([
    "__tests__",
    "node_modules",
    "dist",
    "build",
    ".svelte-kit",
    "generated",
  ]);
  const SCAN_EXTS = new Set([".ts", ".svelte"]);

  function collectFiles(): string[] {
    const out: string[] = [];
    function walk(absDir: string) {
      for (const entry of readdirSync(absDir)) {
        if (EXCLUDE_DIRS.has(entry)) continue;
        const abs = join(absDir, entry);
        const st = statSync(abs);
        if (st.isDirectory()) walk(abs);
        else if (SCAN_EXTS.has(extname(entry))) out.push(abs);
      }
    }
    for (const root of SCAN_ROOTS) {
      const absRoot = join(REPO_ROOT, root);
      // A scan root may not exist for every workspace layout — skip THAT case, and only that
      // case. Every other error (a broken symlink hitting statSync, EACCES on a subdirectory, a
      // directory removed mid-walk) must propagate: swallowing it would drop every remaining file
      // in that root and leave `violations` empty, so the assertion below would report success on
      // a truncated — possibly empty — scan. A gate that passes no matter what is the exact
      // failure this design avoids; the Phase-97 sibling (leave-type-identity-guard.test.ts)
      // deliberately has no catch here either.
      if (!existsSync(absRoot)) continue;
      walk(absRoot);
    }
    return out;
  }

  it("declares the LeaveTypeCode vocabulary exactly once — the Prisma enum aside", () => {
    const files = collectFiles();
    // 235-BEFUND-B.md #1: G6's collectFiles() is a SEPARATE walk from G5's scannedFiles() above
    // — G5's own "contains" proof (this file's own reference idiom, D-06) covers only its own
    // walked set, not this one. Without this, an emptied apps/api/src / apps/web/src /
    // packages/types/src / packages/db/src would leave `violations` at [] and this test green.
    expect(
      files.length,
      "no file scanned under apps/api/src, apps/web/src, packages/types/src or packages/db/src — one of the four roots moved or emptied",
    ).toBeGreaterThan(0);
    const violations: string[] = [];
    for (const abs of files) {
      const content = readFileSync(abs, "utf-8");
      const lines = content.split("\n");
      lines.forEach((line, i) => {
        if (/type\s+LeaveTypeCode\s*=/.test(line)) {
          violations.push(`${relative(REPO_ROOT, abs)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    const report =
      violations.length > 0
        ? violations.join("\n") +
          "\n\nThe vocabulary has exactly one declaration, the Prisma enum; import " +
          'the type from "@clokr/db".'
        : "";
    expect(report).toBe("");
  });
});
