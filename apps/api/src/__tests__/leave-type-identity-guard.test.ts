/**
 * Phase 97 (T2) — the gate that keeps the phase from decaying.
 *
 * ADR 0001 / CLAUDE.md: "Never use a new display string as a control value." Phase 96 enforced
 * the equivalent rule through grep sweeps written into plan acceptance criteria — those run once,
 * at the moment of the change. This test runs on every CI build.
 *
 * It fails when a German leave-type display name appears anywhere outside the single mapping in
 * utils/leave-type.ts, when the removed `?? "VACATION"` fallback returns, or when the
 * backfill-only name->code direction is called from a runtime path it does not belong to.
 *
 * Adding an entry to ALLOWED below is a deliberate act — every entry needs a reason in its
 * comment, and a display name that is merely RENDERED does not need one (the check targets
 * comparisons and collections, not template interpolation — see `isControlUse` below).
 *
 * Scan scope deliberately includes `apps/api/scripts/**` even though `apps/api/tsconfig.json`
 * does not type-check it — that gap (CI not covering scripts/**) is a finding from 96-REVIEW.md
 * this gate is built to not repeat.
 *
 * This file's own `__tests__` directory is excluded from the scan by construction (see
 * `EXCLUDE_DIRS` below) — it has to be, since this file itself must contain all eleven literals,
 * the removed `?? "VACATION"` fallback string, `LEGACY_ALIASES`, and `leaveTypeCodeForName` as
 * search patterns in order to search for them. That same `__tests__` exclusion also covers the
 * three additional assertions below (`?? "VACATION"`, the alias-location check, and the
 * `leaveTypeCodeForName`-location check) — do not "clean up" this exclusion; without it the gate
 * would fail on its own source on every run.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { describe, it, expect } from "vitest";

// ── Scan scope ────────────────────────────────────────────────────────────────
// __dirname is apps/api/src/__tests__ — four levels up is the repo root.
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const SCAN_ROOTS = ["apps/api/src", "apps/web/src", "apps/api/scripts"];
const EXCLUDE_DIRS = new Set(["__tests__", "node_modules", "build", ".svelte-kit", "dist"]);
const SCAN_EXTS = new Set([".ts", ".svelte"]);

/** All eleven literals: the nine canonical LeaveType display names plus the two legacy aliases. */
const LITERALS = [
  "Urlaub",
  "Überstundenausgleich",
  "Sonderurlaub",
  "Unbezahlter Urlaub",
  "Krankmeldung",
  "Kinderkrank",
  "Bildungsurlaub",
  "Mutterschutz",
  "Elternzeit",
  "Jahresurlaub",
  "Urlaub (Jahresurlaub)",
] as const;

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
  for (const root of SCAN_ROOTS) walk(join(REPO_ROOT, root));
  return out;
}

function repoRel(absPath: string): string {
  return relative(REPO_ROOT, absPath).split("\\").join("/");
}

/** True when one of the last `lookback` lines up to and including `idx` opens a Prisma `where:`
 *  block — the signal that a nearby `name:`/`code:` field is an identity filter, not a display
 *  map entry (this is what tells `leaveType: { name: "Urlaub" }` inside a `where` apart from
 *  `{ code: "VACATION", label: "Urlaub" }` in a plain array literal). */
function isNearWhere(lines: string[], idx: number, lookback = 8): boolean {
  for (let i = Math.max(0, idx - lookback); i <= idx; i++) {
    if (/\bwhere\s*:/.test(lines[i])) return true;
  }
  return false;
}

/**
 * A hit counts as a control-value use when the line also carries one of the steering markers
 * (`===`, `!==`, `.includes(`, `.has(`, a `where`-adjacent `: {`/field, an array literal `[`, or
 * `case `) — EXCEPT when the literal is only the value of a `label:`/`name:` display field with no
 * `where:` nearby, which is rendering, not a comparison. A `name:`/`code:` field WITHIN a `where`
 * block is a database identity filter and is always control use, regardless of the key's name.
 */
function isControlUse(lines: string[], idx: number): boolean {
  const line = lines[idx];
  const nearWhere = isNearWhere(lines, idx);
  if (nearWhere && /(name|code)\s*:\s*["']/.test(line)) return true;
  if (/(label|name)\s*:\s*["']/.test(line)) return false;
  return (
    line.includes("===") ||
    line.includes("!==") ||
    line.includes(".includes(") ||
    line.includes(".has(") ||
    line.includes(": {") ||
    line.includes("[") ||
    /\bcase\s/.test(line)
  );
}

interface LiteralHit {
  file: string; // repo-relative
  line: number; // 1-based
  literal: string;
  text: string;
}

function findLiteralHits(files: string[]): { control: LiteralHit[]; display: LiteralHit[] } {
  const control: LiteralHit[] = [];
  const display: LiteralHit[] = [];
  for (const abs of files) {
    const content = readFileSync(abs, "utf-8");
    const lines = content.split("\n");
    const file = repoRel(abs);
    lines.forEach((line, i) => {
      for (const lit of LITERALS) {
        if (line.includes(`"${lit}"`) || line.includes(`'${lit}'`)) {
          const hit: LiteralHit = { file, line: i + 1, literal: lit, text: line.trim() };
          (isControlUse(lines, i) ? control : display).push(hit);
        }
      }
    });
  }
  return { control, display };
}

// ── ALLOWED — every entry is a deliberate act, every entry has a reason ────────
//
// `pattern: null` allows the WHOLE file (the file's entire purpose is to hold these literals).
// `pattern: RegExp` scopes the exception to lines matching it — everything else in that file is
// still gated.
interface AllowedEntry {
  file: string;
  pattern: RegExp | null;
  reason: string;
}

const ALLOWED: AllowedEntry[] = [
  // ── Designed exceptions (the vocabulary legitimately lives or is displayed here) ──

  // leave-type.ts: the one canonical Code<->name mapping (D-04) — every literal is expected here.
  {
    file: "apps/api/src/utils/leave-type.ts",
    pattern: null,
    reason:
      "The one canonical Code<->name mapping (D-04) — every one of the nine names, both legacy " +
      "aliases, and the docblock's own quoted list of the two sickness names are expected here " +
      "by design; this is the single place the vocabulary is allowed to be closed over.",
  },
  // leave/+page.svelte: TYPE_OPTIONS is a pure code->label display map, not a comparison.
  {
    file: "apps/web/src/routes/(app)/leave/+page.svelte",
    pattern: null,
    reason:
      "TYPE_OPTIONS — a pure code->label display map for the leave form dropdown/legend. Every " +
      "entry pairs a stable code with its label; nothing here compares a literal.",
  },
  // team/leave/+page.svelte: same TYPE_OPTIONS display map, team variant.
  {
    file: "apps/web/src/routes/(app)/team/leave/+page.svelte",
    pattern: null,
    reason: "Same TYPE_OPTIONS code->label display map as leave/+page.svelte, team variant.",
  },
  // inbox/+page.svelte: TYPE_LABELS is the same display-map pattern, inbox variant.
  {
    file: "apps/web/src/routes/(app)/inbox/+page.svelte",
    pattern: null,
    reason: "TYPE_LABELS — the same code->label display map pattern, inbox variant.",
  },
  // special-leave.ts: Swagger/OpenAPI documentation tag, never read back by code.
  {
    file: "apps/api/src/routes/special-leave.ts",
    pattern: /tags:\s*\["Sonderurlaub"\]/,
    reason:
      "Swagger/OpenAPI documentation tag for grouping routes in the /docs UI (the same German-tag " +
      'convention as tags: ["Mitarbeiter"] elsewhere in the codebase) — never read back by any ' +
      "code path, not a runtime comparison.",
  },
  // MyWeekView.svelte: icon/label keyed off the stable absenceType code, not the literal.
  {
    file: "apps/web/src/lib/components/dashboard/MyWeekView.svelte",
    pattern: /day\.absenceType === "(SICK_CHILD|MATERNITY)"/,
    reason:
      "Icon/label selection keyed off the stable absenceType field, not the literal itself — the " +
      "literal is only the ternary's display-text branch.",
  },

  // ── Tracked technical debt — genuine findings from the completeness probe, reported per the ──
  // ── plan's "melden, nicht fixen" instruction (same methodology as this plan's own Task 2)   ──
  // ── for a Nebenbefund outside the current plan's files_modified. See Issue #205.            ──

  // attendance-checker.ts: checkVacationExpiry() resolves VACATION by name inside a `where`.
  {
    file: "apps/api/src/plugins/attendance-checker.ts",
    pattern: /leaveType:\s*\{\s*name:\s*"Urlaub"\s*\}/,
    reason:
      "GENUINE FINDING, not a design decision (Issue #205): checkVacationExpiry() (§ 7 BUrlG " +
      "expiry-reminder cron) resolves the VACATION LeaveType by name inside a `where` filter. A " +
      "tenant rename silently stops the legally-required reminder for that tenant. Outside this " +
      "plan's files_modified (only the guard test, docs/migrations.md, docs/adr/0001-abweichungen" +
      ".md) — not fixed here, same reasoning as D-17 for Issue #196 (mixing an unrelated fix into " +
      "this plan makes both harder to review). Tracked, not silently accepted.",
  },
  // employees.ts: the exit pro-rata vacation warning resolves VACATION by name.
  {
    file: "apps/api/src/routes/employees.ts",
    pattern: /where:\s*\{\s*tenantId:\s*req\.user\.tenantId,\s*name:\s*"Urlaub"\s*\}/,
    reason:
      "GENUINE FINDING, not a design decision (Issue #205): the pro-rata vacation warning shown " +
      "when an employee's exitDate is set resolves the VACATION LeaveType by name. Same class of " +
      "bug and same reasoning for not fixing inline as attendance-checker.ts above.",
  },
  // dashboard/+page.svelte: day.reason (= LeaveType.name for APPROVED leave) is compared directly.
  {
    file: "apps/web/src/routes/(app)/dashboard/+page.svelte",
    pattern: /day\.reason === "(Krankmeldung|Kinderkrank|Mutterschutz|Elternzeit)"/,
    reason:
      "GENUINE FINDING, not a design decision (Issue #205): day.reason is leave.leaveTypeName " +
      "(LeaveType.name) for an APPROVED leave, per resolvePresenceState() in " +
      "apps/api/src/utils/presence.ts — comparing it directly against these four literals is " +
      "exactly the defect class this phase removes elsewhere. A tenant rename makes the icon " +
      "silently fall back to the vacation/umbrella branch. Display-only impact (no data " +
      "integrity issue), but a proper fix needs a new leaveTypeCode field threaded through the " +
      "/dashboard API response — out of this plan's scope. Not fixed here; tracked in Issue #205.",
  },
];

function isAllowed(hit: LiteralHit): boolean {
  return ALLOWED.some((a) => {
    if (a.file !== hit.file) return false;
    if (a.pattern === null) return true;
    return a.pattern.test(hit.text);
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Phase 97 (T2) — leave-type identity guard", () => {
  it("sanity: the file collector actually walks all three scan roots (a silently-empty scan would pass forever)", () => {
    const files = collectFiles();
    expect(files.length).toBeGreaterThan(200);
    expect(files.some((f) => repoRel(f).startsWith("apps/api/scripts/"))).toBe(true);
    expect(files.some((f) => repoRel(f).startsWith("apps/web/src/"))).toBe(true);
    expect(files.every((f) => !repoRel(f).includes("/__tests__/"))).toBe(true);
  });

  it("no German LeaveType display-name literal is used as a control value outside the documented ALLOWED exceptions", () => {
    const files = collectFiles();
    const { control } = findLiteralHits(files);
    const violations = control.filter((h) => !isAllowed(h));
    const report = violations.map((h) => `${h.file}:${h.line}: [${h.literal}] ${h.text}`);
    expect(report).toEqual([]);
  });

  it('`?? "VACATION"` does not return as a silent type-code fallback in apps/api/src', () => {
    const files = collectFiles().filter((f) => repoRel(f).startsWith("apps/api/src/"));
    const violations: string[] = [];
    for (const abs of files) {
      const content = readFileSync(abs, "utf-8");
      const lines = content.split("\n");
      lines.forEach((line, i) => {
        if (line.includes('?? "VACATION"')) {
          violations.push(`${repoRel(abs)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(violations).toEqual([]);
  });

  it("LEGACY_ALIASES / LEAVE_TYPE_LEGACY_ALIASES is referenced only by the backfill script, the ensureLeaveType() self-heal, and its own definition", () => {
    const permitted = new Set([
      "apps/api/src/utils/leave-type.ts",
      "apps/api/src/routes/leave.ts",
      "apps/api/scripts/backfill-leave-type-code.ts",
    ]);
    const files = collectFiles();
    const violations: string[] = [];
    for (const abs of files) {
      const file = repoRel(abs);
      if (permitted.has(file)) continue;
      const content = readFileSync(abs, "utf-8");
      const lines = content.split("\n");
      lines.forEach((line, i) => {
        if (/\b(LEAVE_TYPE_)?LEGACY_ALIASES\b/.test(line)) {
          violations.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(violations).toEqual([]);
  });

  it("leaveTypeCodeForName (the name -> code direction) is called only by the backfill script, the ensureLeaveType() self-heal, and its own definition", () => {
    const permitted = new Set([
      "apps/api/src/utils/leave-type.ts",
      "apps/api/src/routes/leave.ts",
      "apps/api/scripts/backfill-leave-type-code.ts",
    ]);
    const files = collectFiles();
    const violations: string[] = [];
    for (const abs of files) {
      const file = repoRel(abs);
      if (permitted.has(file)) continue;
      const content = readFileSync(abs, "utf-8");
      const lines = content.split("\n");
      lines.forEach((line, i) => {
        if (/\bleaveTypeCodeForName\b/.test(line)) {
          violations.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(violations).toEqual([]);
  });
});
