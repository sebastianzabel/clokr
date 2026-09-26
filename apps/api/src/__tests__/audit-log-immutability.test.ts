/**
 * Issue #78, D-12 — the AuditLog is mutated (never just created) only at two named, justified
 * sites: the DSGVO Art. 17 anonymization (`contexts/platform/anonymize.ts`, CLAUDE.md "DSGVO
 * Employee Deletion") and the 90-day purge of `purgeable` presence-only events
 * (`composition/data-retention.ts`, DSGVO Art. 5(1)(e)). § 147 AO / § 16 Abs. 2 ArbZG require a
 * log application code cannot quietly rewrite — a new `auditLog.update` anywhere must turn CI red,
 * not wait for a reviewer.
 *
 * Why FILE + CALL COUNT, never line number: a line-pinned allow-list goes stale through an
 * unrelated edit in the SAME file — measured twice on this exact codebase
 * (`lint-tenant-scoping-exceptions.json`, `lint-t100-09-routes.json`, memory "disjoint files ≠
 * disjoint effects", issues #309/#310). Pinning by file + count survives an unrelated edit to a
 * DIFFERENT part of the same file; it only breaks when the mutation count in an allowed file
 * itself changes, which is exactly the signal this guard exists to catch.
 *
 * How to add an exception: add an entry to `ALLOWED_MUTATION_SITES` below with a reason
 * (>= 20 characters) explaining the legal/technical justification, reviewed like code — never
 * added just to make CI green.
 *
 * Named blind spots (stated so nobody over-trusts this guard):
 *   - `apps/api/scripts/**` and `packages/db/**` are OUT OF SCOPE (operator tools and seed data,
 *     not the running application) — the same carve-out other source-scanning guards in this repo
 *     make (e.g. the #69 day-lookup guard).
 *   - A delegate reached through a computed property name that is not a string literal (e.g.
 *     `db[someVariable]`) is not detected — a token scan cannot see through that indirection.
 *   - The database-level `ON DELETE SET NULL` on `AuditLog.userId` (migration 0_init) is not a
 *     code call and is invisible to a source scan. It only fires on a hard User delete, which the
 *     application never performs (the DSGVO path anonymizes instead — see CLAUDE.md).
 * Comments are DELIBERATELY NOT exempt from the delegate-use / raw-SQL rules below: naming a
 * forbidden call in a comment turns this guard red too, mirroring
 * `holiday-resolution-boundary.test.ts`'s own rule.
 *
 * Modelled on `apps/api/src/__tests__/holiday-resolution-boundary.test.ts` — same walk, same
 * anti-vacuity-safe measured-floor + known-file proof (`lint-guard-vacuity.ts` requires a walking
 * assertion to prove its input was non-empty to classify as `guard` rather than `vacuous`).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { describe, it, expect } from "vitest";

// __dirname is apps/api/src/__tests__ — four levels up is the repo root.
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const SCAN_ROOT = "apps/api/src";

// Measured 2026-09-26 (Phase 78b Plan 03, issue #78, re-measured at HEAD @ 2de5ccf0): 180
// non-test .ts files under apps/api/src (outside __tests__, excluding *.test.ts). ~85% of that
// (150) tolerates ordinary churn without masking a scan-root regression (an emptied or renamed
// root would report far fewer).
const MIN_SCANNED_FILES = 150;

// A file this scan MUST see, as a positive control that the walk actually reached deep into the
// tree (not just its top level).
const KNOWN_FILE = "apps/api/src/contexts/working-time-account/close-employee-month.ts";

// FILE + CALL COUNT allow-list (D-12) — never by line number. Each entry's `count` is the exact
// number of MUTATION_RE matches expected in that file; any other count, a missing file, or an
// extra file not listed here fails the guard.
const ALLOWED_MUTATION_SITES: Record<string, { count: number; reason: string }> = {
  "apps/api/src/contexts/platform/anonymize.ts": {
    count: 2,
    reason:
      "DSGVO Art. 17 anonymization required by CLAUDE.md: userId → null on the person's " +
      "AuditLog rows, and redaction of Employee/User JSON in oldValue/newValue. The rows " +
      "themselves stay — only personal data is redacted, never the log entry itself.",
  },
  "apps/api/src/composition/data-retention.ts": {
    count: 1,
    reason:
      "DSGVO Art. 5(1)(e) storage limitation: purgeable presence-only events (no stamp " +
      "created, e.g. attendance-checker pings) are deleted after the configured retention " +
      "window (default 90 days, floor 7 days). Rows that document an actual mutation are " +
      "never marked purgeable and are therefore never deleted here.",
  },
};

function repoRel(absPath: string): string {
  return relative(REPO_ROOT, absPath).split("\\").join("/");
}

function collectFiles(): string[] {
  const out: string[] = [];
  function walk(absDir: string) {
    for (const entry of readdirSync(absDir)) {
      if (entry === "__tests__" || entry === "node_modules") continue;
      const abs = join(absDir, entry);
      const stat = statSync(abs);
      if (stat.isDirectory()) {
        walk(abs);
      } else if (extname(entry) === ".ts" && !entry.endsWith(".test.ts")) {
        out.push(abs);
      }
    }
  }
  walk(join(REPO_ROOT, SCAN_ROOT));
  return out;
}

// Matches auditLog.update(, .updateMany(, .delete(, .deleteMany(, .upsert( — regardless of
// whether the delegate is reached via `tx.auditLog` or `app.prisma.auditLog`.
const MUTATION_RE = /\bauditLog\s*\.\s*(update|updateMany|delete|deleteMany|upsert)\s*\(/g;

// Any bare `auditLog` occurrence is expected to be followed by one of these read/append methods,
// or by one of the allow-listed mutation methods above. Anything else (an alias, a bracket-access
// indirection with a string literal, an unrecognized method) is an offender. Deliberately no
// trailing `\(` requirement: a descriptive comment naming "auditLog.create" without invocation
// syntax (e.g. "not a direct auditLog.create)") is still a legitimate reference to a known method,
// not an offender — only an occurrence NOT followed by any recognized method name is flagged. The
// `g` flag is load-bearing here: `String.prototype.match()` without it returns only the first
// match plus capture groups, silently under-counting every subsequent occurrence in the file.
const READ_OR_APPEND_METHODS =
  "create|createMany|findFirst|findFirstOrThrow|findUnique|findUniqueOrThrow|findMany|count|aggregate|groupBy";
const MUTATION_METHODS = "update|updateMany|delete|deleteMany|upsert";
const KNOWN_FOLLOWED_RE = new RegExp(
  `\\bauditLog\\s*\\.\\s*(?:${READ_OR_APPEND_METHODS}|${MUTATION_METHODS})\\b`,
  "g",
);
// Every standalone `auditLog` word-boundary occurrence, for the "is it always followed by a known
// method" check.
const BARE_AUDITLOG_RE = /\bauditLog\b/g;

// Raw SQL against the AuditLog table — case-insensitive, tolerates an optional double-quote around
// the table name (Postgres identifier quoting). Deliberately NOT global: a global regex's
// stateful `lastIndex` would corrupt repeated `.test()` calls across different file contents in
// the loop below (a match in an earlier, longer file could leave `lastIndex` past the length of a
// later, shorter file, silently skipping a real match in that file).
const RAW_SQL_RE = /\b(?:UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?)\s+"?AuditLog\b/i;

describe("Issue #78 (D-12) — AuditLog rows are mutated only at two justified, file+count-pinned sites", () => {
  it("scan sees the tree (a silently-empty or shallow walk would pass forever)", () => {
    const files = collectFiles();
    expect(files.length, "no production file scanned under apps/api/src at all").toBeGreaterThan(0);
    expect(
      files.length,
      "fewer production files scanned than the measured floor — the scan root moved, emptied, or an exclusion widened",
    ).toBeGreaterThanOrEqual(MIN_SCANNED_FILES);
    const knownAbs = join(REPO_ROOT, KNOWN_FILE);
    expect(
      files,
      `the known deep file ${KNOWN_FILE} was not reached — the walk is shallower than expected`,
    ).toContain(knownAbs);
  });

  it("every allow-list entry carries a non-empty, substantive reason", () => {
    for (const [file, entry] of Object.entries(ALLOWED_MUTATION_SITES)) {
      expect(
        entry.reason.length,
        `${file}: allow-list reason must be at least 20 characters, describing the legal/technical justification`,
      ).toBeGreaterThanOrEqual(20);
    }
  });

  it("AuditLog mutation sites are exactly the justified ones, pinned by file and count — not by line", () => {
    const files = collectFiles();
    const counts: Record<string, number> = {};
    for (const abs of files) {
      const source = readFileSync(abs, "utf8");
      const matches = source.match(MUTATION_RE);
      if (matches && matches.length > 0) {
        counts[repoRel(abs)] = matches.length;
      }
    }

    const expected: Record<string, number> = {};
    for (const [file, entry] of Object.entries(ALLOWED_MUTATION_SITES)) {
      expected[file] = entry.count;
    }

    expect(
      counts,
      `AuditLog mutation sites must be pinned by file and count, not by line (line-pinned lists go stale through unrelated edits in the same file, #309/#310). Found: ${JSON.stringify(counts)}, expected: ${JSON.stringify(expected)}`,
    ).toEqual(expected);
  });

  it("every other use of the auditLog delegate is a known read or append method", () => {
    const files = collectFiles();
    const offenders: string[] = [];
    for (const abs of files) {
      const source = readFileSync(abs, "utf8");
      const bareCount = (source.match(BARE_AUDITLOG_RE) ?? []).length;
      if (bareCount === 0) continue;
      const knownFollowedCount = (source.match(KNOWN_FOLLOWED_RE) ?? []).length;
      if (knownFollowedCount !== bareCount) {
        offenders.push(repoRel(abs));
      }
    }
    expect(
      offenders.sort(),
      `auditLog delegate used without a recognized read/append/allowlisted-mutation method (aliasing, bracket access, or an unrecognized method) — offending files:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("no raw SQL mutates the AuditLog table", () => {
    const files = collectFiles();
    const offenders = files
      .filter((abs) => RAW_SQL_RE.test(readFileSync(abs, "utf8")))
      .map(repoRel)
      .sort();
    expect(
      offenders,
      `raw SQL UPDATE/DELETE/TRUNCATE against "AuditLog" found outside the Prisma delegate — offending files:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

// The mutation-site rule above already covers every route handler in every route file (a mutating
// call inside audit-logs.ts would be caught there too), but issue #78's acceptance criteria states
// the audit-log API's read-only status explicitly — this block adds that direct, named assertion.
const AUDIT_LOGS_ROUTE_FILE = "apps/api/src/contexts/platform/api/audit-logs.ts";
// Measured 2026-09-26 (Phase 78b Plan 03): exactly 2 `app.get(` registrations, 0 of any other
// HTTP-method registration.
const EXPECTED_GET_REGISTRATIONS = 2;
const WRITE_METHOD_RE = /\bapp\s*\.\s*(post|put|patch|delete|route)\s*\(/g;
const GET_METHOD_RE = /\bapp\s*\.\s*get\s*\(/g;

describe("no API endpoint changes or deletes AuditLog rows (issue #78)", () => {
  it("audit-logs.ts registers GET routes only", () => {
    const abs = join(REPO_ROOT, AUDIT_LOGS_ROUTE_FILE);
    // A missing file must fail this test, not silently pass with an empty match count — readFileSync
    // throws ENOENT on its own, which vitest reports as a failure, satisfying that requirement.
    const source = readFileSync(abs, "utf8");

    const writeCount = (source.match(WRITE_METHOD_RE) ?? []).length;
    expect(
      writeCount,
      `${AUDIT_LOGS_ROUTE_FILE} must register zero POST/PUT/PATCH/DELETE/generic route() handlers — found ${writeCount}`,
    ).toBe(0);

    // Positive control: if this count is 0 too, either the file was not actually read (a silent
    // no-op) or the registration idiom changed (a rename or a different Fastify call style) — either
    // way the test must fail instead of vacuously passing on an empty match.
    const getCount = (source.match(GET_METHOD_RE) ?? []).length;
    expect(
      getCount,
      `expected exactly ${EXPECTED_GET_REGISTRATIONS} app.get( registrations in ${AUDIT_LOGS_ROUTE_FILE} — found ${getCount} (0 would mean the read/registration idiom did not match at all, not that the file is read-only)`,
    ).toBe(EXPECTED_GET_REGISTRATIONS);
  });
});
