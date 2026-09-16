/**
 * Issue #241 (fifth site + the gate) — non-vacuity proof for lint-saldo-lock-derivation.ts.
 *
 * The whole point of this file is Issue #240's lesson applied to a SET of five historically real
 * bugs: a gate whose test fixture matrix covers only ONE of the five known-bad shapes and calls
 * that "proven" is exactly the vacuous-test failure mode #241 itself exists because of (three
 * private test helpers that happened to agree with three separately-buggy production helpers).
 * `PRE_FIX_FIXTURES` below therefore has one entry per real historical site (three route-level
 * gates fixed together in `8326859d`, the generator fixed in `840d9976`, this shift-cleanup
 * helper fixed in the SAME commit as this gate) plus the two newly-discovered ones this gate's own
 * first real run against the live tree found (see `lint-saldo-lock-derivation-exceptions.json`),
 * each reproduced as a MINIMAL, self-contained snippet of the shape that site actually had BEFORE
 * its fix — driven through `analyzeSource` exactly like `lint-facade-signatures.test.ts` drives
 * `analyzeSource` against fixture text, never the live tree, for this exact reason.
 *
 * `POST_FIX_FIXTURES` mirrors the SAME five/seven sites in their current, fixed shape and asserts
 * "safe" — proving the gate does not just flag everything with `periodStart` in it (a gate that
 * cannot also say "safe" is not a gate, it is a grep that always fails).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MIN_REASON_LENGTH,
  analyzeFile,
  analyzeSource,
  computeFindings,
  discoverSourceFiles,
  formatSummary,
  validateExceptionsDocument,
  type Candidate,
  type SaldoLockException,
} from "../lint-saldo-lock-derivation";

const API_ROOT = join(__dirname, "..", "..");
const REPO_ROOT = join(API_ROOT, "..", "..");

// ── PRE_FIX_FIXTURES — one per real historical (or gate-discovered) site, ALL must be "unsafe" ──
//
// Issue #240's lesson, applied: this is the SET. Every entry gets its own `it()` below so a
// regression in any ONE detection path shows up as its own named failure, not as "some test in a
// loop failed".

const PRE_FIX_FIXTURES: Record<string, string> = {
  // Sites 1+2 — vocational-school.ts (fixed in 8326859d): a naive per-file monthStartUtc()
  // helper, called directly, its result used bare as the periodStart value.
  "site-1-2-vocational-school": `
    function monthStartUtc(d: Date): Date {
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
    }
    async function handler(app: any, dateUtc: Date, employeeId: string) {
      const monthStart = monthStartUtc(dateUtc);
      const snapshot = await app.prisma.saldoSnapshot.findFirst({
        where: { employeeId, periodType: "MONTHLY", periodStart: monthStart, superseded: false },
      });
    }
  `,
  // Site 3 — shifts.ts (fixed in 8326859d): the naive Date.UTC(...) construction inlined directly
  // at the call site, no intermediate helper function at all.
  "site-3-shifts-restore": `
    async function handler(app: any, shift: { date: Date; employeeId: string }) {
      const monthStart = new Date(
        Date.UTC(shift.date.getUTCFullYear(), shift.date.getUTCMonth(), 1),
      );
      const lock = await app.prisma.saldoSnapshot.findFirst({
        where: {
          employeeId: shift.employeeId,
          periodType: "MONTHLY",
          periodStart: monthStart,
          superseded: false,
        },
      });
    }
  `,
  // Site 4 — vocational-school-generator.ts (fixed in 840d9976): a naive monthStartUtc() used as
  // BOTH ends of a gte/lte bulk-fetch range.
  "site-4-generator-bulk-fetch": `
    function monthStartUtc(d: Date): Date {
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
    }
    async function bulkFetch(prisma: any, employeeIds: string[], windowStart: Date, windowEnd: Date) {
      return prisma.saldoSnapshot.findMany({
        where: {
          employeeId: { in: employeeIds },
          periodType: "MONTHLY",
          periodStart: { gte: monthStartUtc(windowStart), lte: monthStartUtc(windowEnd) },
          superseded: false,
        },
      });
    }
  `,
  // Site 5 — shift-cleanup.ts (fixed in the same commit as this gate): the naive helper reached
  // through Array.prototype.map + a Set dedup, the actual shape that made the earlier "just
  // recurse into monthStartUtc's own body" design insufficient on its own (see the module
  // header's .map()/new Set() handling) — this fixture is what forced that design.
  "site-5-shift-cleanup-map-set": `
    function monthStartUtc(d: Date): Date {
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
    }
    async function lockedMonths(prisma: any, employeeId: string, shifts: Array<{ date: Date }>) {
      const monthStartIsos = [...new Set(shifts.map((s) => monthStartUtc(s.date).toISOString()))];
      const monthStarts = monthStartIsos.map((iso) => new Date(iso));
      return prisma.saldoSnapshot.findMany({
        where: {
          employeeId,
          periodType: "MONTHLY",
          periodStart: { in: monthStarts },
          superseded: false,
        },
      });
    }
  `,
  // Newly discovered by this gate's own first real run (deferred as Issue #242, see the
  // exceptions file) — a naive UTC year boundary used as a MONTHLY range bound, structurally the
  // same defect at the YEAR granularity rather than an exact month lock.
  "gate-discovery-year-boundary": `
    async function checkAllMonthsClosed(prisma: any, employeeId: string, year: number) {
      const yearStart = new Date(\`\${year}-01-01T00:00:00Z\`);
      const yearEnd = new Date(\`\${year}-12-31T23:59:59Z\`);
      return prisma.saldoSnapshot.findMany({
        where: {
          employeeId,
          periodType: "MONTHLY",
          periodStart: { gte: yearStart, lte: yearEnd },
          superseded: false,
        },
      });
    }
  `,
};

const POST_FIX_FIXTURES: Record<string, string> = {
  // Sites 1+2 fixed shape: destructure `.start` directly off a real monthRangeUtc() call.
  "site-1-2-fixed": `
    async function handler(app: any, dateUtc: Date, tenantTz: string, employeeId: string) {
      const { start: monthStart } = monthRangeUtc(
        dateUtc.getUTCFullYear(),
        dateUtc.getUTCMonth() + 1,
        tenantTz,
      );
      const snapshot = await app.prisma.saldoSnapshot.findFirst({
        where: { employeeId, periodType: "MONTHLY", periodStart: monthStart, superseded: false },
      });
    }
  `,
  // Site 4 fixed shape: a LOCAL helper (monthLockBoundUtc) that itself calls monthRangeUtc,
  // called directly inline in both the gte and lte positions.
  "site-4-fixed": `
    function monthLockBoundUtc(d: Date, tz: string): Date {
      return monthRangeUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, tz).start;
    }
    async function bulkFetch(prisma: any, employeeIds: string[], windowStart: Date, windowEnd: Date, tz: string) {
      return prisma.saldoSnapshot.findMany({
        where: {
          employeeId: { in: employeeIds },
          periodType: "MONTHLY",
          periodStart: {
            gte: monthLockBoundUtc(windowStart, tz),
            lte: monthLockBoundUtc(windowEnd, tz),
          },
          superseded: false,
        },
      });
    }
  `,
  // Site 5 fixed shape: the SAME map+Set chain as the pre-fix fixture above, but the inner helper
  // now calls monthRangeUtc — this is the fixture that proves the gate does not just blanket-flag
  // every "new Date(...)" it sees (new Date(iso) still appears in the fixed code, round-tripping
  // an already-safe .toISOString() string).
  "site-5-fixed": `
    function monthLockBoundUtc(d: Date, tz: string): Date {
      return monthRangeUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, tz).start;
    }
    async function lockedMonths(prisma: any, employeeId: string, shifts: Array<{ date: Date }>, tenantTz: string) {
      const monthStartIsos = [
        ...new Set(shifts.map((s) => monthLockBoundUtc(s.date, tenantTz).toISOString())),
      ];
      const monthStarts = monthStartIsos.map((iso) => new Date(iso));
      return prisma.saldoSnapshot.findMany({
        where: {
          employeeId,
          periodType: "MONTHLY",
          periodStart: { in: monthStarts },
          superseded: false,
        },
      });
    }
  `,
  // periodStartWindow() relay (snapshot-period.ts's own convention-robust helper): safety is
  // exactly its argument's safety — monthStart is derived LOCALLY, in the same function, via a
  // real monthRangeUtc() destructure, mirroring overtime.ts's/leave.ts's actual call shape.
  "relay-period-start-window": `
    async function handler(prisma: any, employeeId: string, year: number, month: number, tz: string) {
      const { start: monthStart } = monthRangeUtc(year, month, tz);
      return prisma.saldoSnapshot.findFirst({
        where: {
          employeeId,
          periodType: "MONTHLY",
          periodStart: periodStartWindow(monthStart),
          superseded: false,
        },
      });
    }
  `,
  // Reading an already-stored periodStart off another fetched row (recalculate-snapshots.ts's
  // own shape) — a different, unrelated correctness question, not the #241 defect class.
  "read-stored-period-start": `
    async function handler(prisma: any, employeeId: string, snapshots: Array<{ periodStart: Date }>) {
      return prisma.saldoSnapshot.findFirst({
        where: {
          employeeId,
          periodType: "MONTHLY",
          periodStart: { lt: snapshots[0].periodStart },
          superseded: false,
        },
      });
    }
  `,
};

describe("analyzeSource — PRE_FIX_FIXTURES all report 'unsafe' (Issue #240: the whole set, not one member)", () => {
  for (const [name, src] of Object.entries(PRE_FIX_FIXTURES)) {
    it(`${name}`, () => {
      const candidates = analyzeSource(src, `fixture-${name}.ts`);
      expect(candidates.length).toBeGreaterThan(0);
      for (const c of candidates) {
        expect(c.verdict).toBe("unsafe");
      }
    });
  }
});

describe("analyzeSource — POST_FIX_FIXTURES all report 'safe'", () => {
  for (const [name, src] of Object.entries(POST_FIX_FIXTURES)) {
    it(`${name}`, () => {
      const candidates = analyzeSource(src, `fixture-${name}.ts`);
      expect(candidates.length).toBeGreaterThan(0);
      for (const c of candidates) {
        expect(c.verdict).toBe("safe");
      }
    });
  }
});

describe('analyzeSource — scoping (periodType:"MONTHLY" sibling + where-only)', () => {
  it("does NOT flag a data: (write) fragment even with an identical naive Date.UTC shape", () => {
    const src = `
      async function close(prisma: any, employeeId: string, monthStart: Date) {
        return prisma.saldoSnapshot.create({
          data: { employeeId, periodType: "MONTHLY", periodStart: monthStart, periodEnd: monthStart },
        });
      }
    `;
    expect(analyzeSource(src, "fixture.ts")).toEqual([]);
  });

  it("does NOT flag a YEARLY where-comparison using the SAME naive Date.UTC shape — YEARLY is a deliberately different, self-consistent convention", () => {
    const src = `
      async function handler(prisma: any, employeeId: string, year: number) {
        return prisma.saldoSnapshot.findFirst({
          where: {
            employeeId,
            periodType: "YEARLY",
            periodStart: { gte: new Date(\`\${year}-01-01\`), lte: new Date(\`\${year}-01-02\`) },
            superseded: false,
          },
        });
      }
    `;
    expect(analyzeSource(src, "fixture.ts")).toEqual([]);
  });

  it("reports 'unknown' (not a finding) for a periodStart value crossing a function-parameter boundary", () => {
    const src = `
      async function handler(prisma: any, employeeId: string, fromDate: Date) {
        return prisma.saldoSnapshot.findMany({
          where: { employeeId, periodType: "MONTHLY", periodStart: { gte: fromDate }, superseded: false },
        });
      }
    `;
    const [c] = analyzeSource(src, "fixture.ts");
    expect(c.verdict).toBe("unknown");
  });
});

// ── discoverSourceFiles — the #229 zero-file guard's precondition ──────────────────────────────

describe("discoverSourceFiles", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "lint-saldo-lock-derivation-fixture-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("returns [] when apps/api/src does not exist at all (the precondition for the #229 guard)", () => {
    expect(discoverSourceFiles(tmpRoot)).toEqual([]);
  });

  it("finds a .ts file, skips __tests__ and .test.ts/.d.ts", () => {
    const srcDir = join(tmpRoot, "apps/api/src/contexts/foo");
    mkdirSync(srcDir, { recursive: true });
    mkdirSync(join(srcDir, "__tests__"), { recursive: true });
    writeFileSync(join(srcDir, "real.ts"), "export const x = 1;");
    writeFileSync(join(srcDir, "real.test.ts"), "export const y = 1;");
    writeFileSync(join(srcDir, "real.d.ts"), "export declare const z: number;");
    writeFileSync(join(srcDir, "__tests__", "hidden.ts"), "export const w = 1;");

    const found = discoverSourceFiles(tmpRoot);
    expect(found).toEqual(["apps/api/src/contexts/foo/real.ts"]);
  });
});

// ── validateExceptionsDocument ───────────────────────────────────────────────────────────────────

describe("validateExceptionsDocument", () => {
  const unsafeCandidate: Candidate = {
    file: "apps/api/src/fixture.ts",
    line: 10,
    snippet: "periodStart: monthStart",
    verdict: "unsafe",
  };
  const safeCandidate: Candidate = {
    file: "apps/api/src/fixture.ts",
    line: 20,
    snippet: "periodStart: monthStart",
    verdict: "safe",
  };

  const validSafeEntry = {
    file: "apps/api/src/fixture.ts",
    line: 10,
    disposition: "safe",
    reason: "This is a fully genuine, understood, sentence-length safety reason.",
  };
  const validDeferredEntry = {
    file: "apps/api/src/fixture.ts",
    line: 10,
    disposition: "deferred",
    trackedIssue: "#999",
    reason: "This is a fully genuine, confirmed-bug, sentence-length deferral reason.",
  };

  it("accepts a valid 'safe' entry matching an unsafe candidate", () => {
    const result = validateExceptionsDocument([validSafeEntry], [unsafeCandidate]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entries).toHaveLength(1);
  });

  it("accepts a valid 'deferred' entry with a trackedIssue", () => {
    const result = validateExceptionsDocument([validDeferredEntry], [unsafeCandidate]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entries[0].trackedIssue).toBe("#999");
  });

  it("rejects a 'deferred' entry with no trackedIssue", () => {
    const result = validateExceptionsDocument(
      [{ ...validDeferredEntry, trackedIssue: undefined }],
      [unsafeCandidate],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatch(/trackedIssue/);
  });

  it("rejects an invalid disposition value", () => {
    const result = validateExceptionsDocument(
      [{ ...validSafeEntry, disposition: "maybe" }],
      [unsafeCandidate],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatch(/disposition/);
  });

  it("rejects a reason shorter than MIN_REASON_LENGTH", () => {
    const result = validateExceptionsDocument(
      [{ ...validSafeEntry, reason: "too short" }],
      [unsafeCandidate],
    );
    expect(result.ok).toBe(false);
    expect("too short".length).toBeLessThan(MIN_REASON_LENGTH);
    if (!result.ok) expect(result.errors[0]).toMatch(/character/);
  });

  it("rejects a STALE entry — no candidate at that file:line any more", () => {
    const result = validateExceptionsDocument(
      [{ ...validSafeEntry, line: 999 }],
      [unsafeCandidate],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatch(/STALE/);
  });

  it("rejects a STALE entry — the candidate at that line is no longer 'unsafe'", () => {
    const result = validateExceptionsDocument([{ ...validSafeEntry, line: 20 }], [safeCandidate]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatch(/STALE/);
  });

  it("rejects a __tests__ file entry", () => {
    const result = validateExceptionsDocument(
      [{ ...validSafeEntry, file: "apps/api/src/__tests__/fixture.ts" }],
      [unsafeCandidate],
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a non-array document", () => {
    const result = validateExceptionsDocument({ not: "an array" }, [unsafeCandidate]);
    expect(result.ok).toBe(false);
  });
});

// ── computeFindings / formatSummary ─────────────────────────────────────────────────────────────

describe("computeFindings / formatSummary", () => {
  const candidates: Candidate[] = [
    { file: "a.ts", line: 1, snippet: "periodStart: x", verdict: "unsafe" },
    { file: "a.ts", line: 2, snippet: "periodStart: y", verdict: "safe" },
    { file: "a.ts", line: 3, snippet: "periodStart: z", verdict: "unknown" },
  ];

  it("an unsafe candidate with no matching exception IS a finding", () => {
    expect(computeFindings(candidates, [])).toEqual([
      { file: "a.ts", line: 1, snippet: "periodStart: x" },
    ]);
  });

  it("an unsafe candidate covered by an exception (any disposition) is NOT a finding", () => {
    const exceptions: SaldoLockException[] = [
      { file: "a.ts", line: 1, disposition: "safe", reason: "x".repeat(MIN_REASON_LENGTH) },
    ];
    expect(computeFindings(candidates, exceptions)).toEqual([]);
  });

  it("formatSummary reports safe/unsafe/unknown counts and splits exceptions by disposition", () => {
    const exceptions: SaldoLockException[] = [
      {
        file: "a.ts",
        line: 1,
        disposition: "deferred",
        trackedIssue: "#1",
        reason: "x".repeat(MIN_REASON_LENGTH),
      },
    ];
    const summary = formatSummary(candidates, exceptions, 0);
    expect(summary).toContain("3 candidate(s)");
    expect(summary).toContain("1 safe / 1 unsafe / 1 unknown");
    expect(summary).toContain("1 exception(s) applied (0 verified-safe / 1 deferred-known-bug");
    expect(summary).toContain("0 finding(s)");
  });
});

// ── live tree — the real scan against the real exceptions file ─────────────────────────────────

describe("live tree — real scan, real exceptions file", () => {
  it("finds at least one real candidate (sanity: the #229 guard's precondition holds today)", () => {
    const files = discoverSourceFiles(REPO_ROOT);
    expect(files.length).toBeGreaterThan(0);
    const candidates = files.flatMap((f) => analyzeFile(join(REPO_ROOT, f), f));
    expect(candidates.length).toBeGreaterThan(0);
  });

  it("the real exceptions file validates cleanly against the real candidate set", () => {
    const exceptionsPath = join(API_ROOT, "scripts/lint-saldo-lock-derivation-exceptions.json");
    expect(existsSync(exceptionsPath)).toBe(true);
    const raw = JSON.parse(readFileSync(exceptionsPath, "utf8"));
    const files = discoverSourceFiles(REPO_ROOT);
    const candidates = files.flatMap((f) => analyzeFile(join(REPO_ROOT, f), f));
    const result = validateExceptionsDocument(raw, candidates);
    expect(result.ok).toBe(true);
  });

  it("the real live-tree scan reports 0 findings (every real 'unsafe' candidate is a named, reasoned exception)", () => {
    const exceptionsPath = join(API_ROOT, "scripts/lint-saldo-lock-derivation-exceptions.json");
    const raw = JSON.parse(readFileSync(exceptionsPath, "utf8"));
    const files = discoverSourceFiles(REPO_ROOT);
    const candidates = files.flatMap((f) => analyzeFile(join(REPO_ROOT, f), f));
    const validated = validateExceptionsDocument(raw, candidates);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(computeFindings(candidates, validated.entries)).toEqual([]);
  });

  it("the fifth site (shift-cleanup.ts) itself resolves 'safe' on the live tree", () => {
    const relFile = "apps/api/src/contexts/scheduling/shift-cleanup.ts";
    const candidates = analyzeFile(join(REPO_ROOT, relFile), relFile);
    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) expect(c.verdict).toBe("safe");
  });
});
