/**
 * Phase 204 Plan 04 — tests for the exception mechanism (`lint-tenant-scoping-exceptions.ts`,
 * Task 1) and the CLI entry (`lint-tenant-scoping.ts`, Task 2).
 *
 * DB-free for the exception tests: `validateExceptions`/`matchException` take plain data, no AST,
 * no Prisma. The `runLint` tests below drive it against a TEMPORARY fixture tree written to a
 * per-test tmpdir so exit codes are asserted without depending on the real tree's current (and
 * constantly evolving) finding set.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  loadExceptions,
  validateExceptions,
  matchException,
  EXCEPTIONS_FILE,
  type TenantScopingException,
} from "../lint-tenant-scoping-exceptions";
import type { PrismaCall } from "../lint-tenant-scoping-types";
import { runLint, formatFinding } from "../lint-tenant-scoping";

function call(overrides: Partial<PrismaCall> = {}): PrismaCall {
  return {
    file: "apps/api/src/routes/x.ts",
    line: 1,
    model: "x",
    method: "findFirst",
    callId: "apps/api/src/routes/x.ts:x.findFirst:1#1",
    ...overrides,
  };
}

const REASON = "This model has no tenant relevance at all, confirmed against the DMMF graph.";

// ── Task 1: exception mechanism (handler-grouped entries, coordinator decision on 204-04) ──────

describe("exception validation (D-06)", () => {
  it("exception: rejects an entry missing a reason, naming the entry", () => {
    const findings = [call()];
    const result = validateExceptions(
      [
        {
          file: call().file,
          handler: "GET /:id",
          validatedAt: 1,
          calls: [{ call: "x.findFirst", line: 1 }],
        },
      ],
      findings,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("reason"))).toBe(true);
      expect(result.errors.some((e) => e.includes("#0"))).toBe(true);
    }
  });

  it("exception: rejects an entry whose reason is empty", () => {
    const findings = [call()];
    const result = validateExceptions(
      [
        {
          file: call().file,
          handler: "GET /:id",
          validatedAt: 1,
          calls: [{ call: "x.findFirst", line: 1 }],
          reason: "",
        },
      ],
      findings,
    );
    expect(result.ok).toBe(false);
  });

  it("exception: rejects an entry whose reason is only whitespace", () => {
    const findings = [call()];
    const result = validateExceptions(
      [
        {
          file: call().file,
          handler: "GET /:id",
          validatedAt: 1,
          calls: [{ call: "x.findFirst", line: 1 }],
          reason: "   \n\t ",
        },
      ],
      findings,
    );
    expect(result.ok).toBe(false);
  });

  it("exception: rejects an entry whose reason is shorter than 30 characters", () => {
    const findings = [call()];
    const result = validateExceptions(
      [
        {
          file: call().file,
          handler: "GET /:id",
          validatedAt: 1,
          calls: [{ call: "x.findFirst", line: 1 }],
          reason: "too short",
        },
      ],
      findings,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("30"))).toBe(true);
    }
  });

  it("exception: accepts an entry with a substantive reason matching a current finding", () => {
    const findings = [call()];
    const result = validateExceptions(
      [
        {
          file: call().file,
          handler: "GET /:id",
          validatedAt: 1,
          calls: [{ call: "x.findFirst", line: 1 }],
          reason: REASON,
        },
      ],
      findings,
    );
    expect(result.ok).toBe(true);
  });

  it("exception: one entry covers MULTIPLE explicitly-named calls (the handler-grouping decision)", () => {
    const findings = [
      call({ line: 10, model: "break", method: "deleteMany" }),
      call({ line: 12, model: "timeEntry", method: "deleteMany" }),
      call({ line: 14, model: "leaveRequest", method: "deleteMany" }),
    ];
    const result = validateExceptions(
      [
        {
          file: call().file,
          handler: "DELETE /:id/hard-delete",
          validatedAt: 1,
          calls: [
            { call: "break.deleteMany", line: 10 },
            { call: "timeEntry.deleteMany", line: 12 },
            { call: "leaveRequest.deleteMany", line: 14 },
          ],
          reason:
            "employeeId was tenant-validated at line 1; all three deleteMany calls reuse it in the same hard-delete transaction.",
        },
      ],
      findings,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entries[0].calls).toHaveLength(3);
    }
  });

  it("exception: a NEW, unlisted call in the same handler is NOT silently covered (AC3)", () => {
    // Two findings exist in the same file; the entry names only ONE of them. The other must
    // remain reportable — an entry answers exactly the calls it names, never a whole handler.
    const findings = [
      call({ line: 10, model: "break", method: "deleteMany" }),
      call({ line: 12, model: "timeEntry", method: "deleteMany" }),
    ];
    const result = validateExceptions(
      [
        {
          file: call().file,
          handler: "DELETE /:id/hard-delete",
          validatedAt: 1,
          calls: [{ call: "break.deleteMany", line: 10 }],
          reason: REASON,
        },
      ],
      findings,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const uncovered = call({ line: 12, model: "timeEntry", method: "deleteMany" });
      expect(matchException(uncovered, result.entries)).toBeNull();
    }
  });

  it("exception: rejects an entry missing file/handler/calls", () => {
    const findings = [call()];
    const missingFile = validateExceptions(
      [
        {
          handler: "GET /:id",
          validatedAt: 1,
          calls: [{ call: "x.findFirst", line: 1 }],
          reason: REASON,
        },
      ],
      findings,
    );
    expect(missingFile.ok).toBe(false);

    const missingHandler = validateExceptions(
      [{ file: "a.ts", validatedAt: 1, calls: [{ call: "x.findFirst", line: 1 }], reason: REASON }],
      findings,
    );
    expect(missingHandler.ok).toBe(false);

    const missingCalls = validateExceptions(
      [{ file: "a.ts", handler: "GET /:id", validatedAt: 1, reason: REASON }],
      findings,
    );
    expect(missingCalls.ok).toBe(false);

    const emptyCalls = validateExceptions(
      [{ file: "a.ts", handler: "GET /:id", validatedAt: 1, calls: [], reason: REASON }],
      findings,
    );
    expect(emptyCalls.ok).toBe(false);
  });

  it("exception: accepts validatedAt: null for a pre-authentication / no-tenant-check case", () => {
    const findings = [call()];
    const result = validateExceptions(
      [
        {
          file: call().file,
          handler: "POST /login",
          validatedAt: null,
          calls: [{ call: "x.findFirst", line: 1 }],
          reason:
            "Pre-authentication flow — req.user does not exist yet, so no tenant check applies.",
        },
      ],
      findings,
    );
    expect(result.ok).toBe(true);
  });

  it("exception: rejects a non-null, non-integer, or non-positive validatedAt", () => {
    const findings = [call()];
    for (const bad of ["not-a-number", 0, -1, 1.5]) {
      const result = validateExceptions(
        [
          {
            file: call().file,
            handler: "GET /:id",
            validatedAt: bad,
            calls: [{ call: "x.findFirst", line: 1 }],
            reason: REASON,
          },
        ],
        findings,
      );
      expect(result.ok).toBe(false);
    }
  });

  it("exception: rejects malformed JSON payloads (not an array), never returning a silent empty list", () => {
    const result = validateExceptions({ not: "an array" }, [call()]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it("exception: rejects an entry that matches no current finding (STALE)", () => {
    const findings: PrismaCall[] = []; // nothing found any more
    const result = validateExceptions(
      [
        {
          file: "apps/api/src/routes/x.ts",
          handler: "GET /:id",
          validatedAt: 1,
          calls: [{ call: "x.findFirst", line: 1 }],
          reason: "This was tenant-safe once, but the call has since been removed from the tree.",
        },
      ],
      findings,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => /stale/i.test(e))).toBe(true);
    }
  });

  it("exception: STALE fires when only ONE of several listed calls stops matching", () => {
    const findings = [call({ line: 10, model: "break", method: "deleteMany" })]; // timeEntry.deleteMany:12 gone
    const result = validateExceptions(
      [
        {
          file: call().file,
          handler: "DELETE /:id/hard-delete",
          validatedAt: 1,
          calls: [
            { call: "break.deleteMany", line: 10 },
            { call: "timeEntry.deleteMany", line: 12 },
          ],
          reason: REASON,
        },
      ],
      findings,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((e) => /stale/i.test(e) && e.includes("timeEntry.deleteMany:12")),
      ).toBe(true);
    }
  });

  it("exception: rejects an entry whose file is under __tests__", () => {
    const findings = [call({ file: "apps/api/src/routes/__tests__/x.test.ts" })];
    const result = validateExceptions(
      [
        {
          file: "apps/api/src/routes/__tests__/x.test.ts",
          handler: "GET /:id",
          validatedAt: 1,
          calls: [{ call: "x.findFirst", line: 1 }],
          reason:
            "A test fixture constructs its own literal identifier, so this is not client input.",
        },
      ],
      findings,
    );
    expect(result.ok).toBe(false);
  });

  it("exception: loadExceptions returns [] when the file does not exist", () => {
    const emptyRepo = fs.mkdtempSync(path.join(os.tmpdir(), "lint-tenant-scoping-"));
    try {
      expect(loadExceptions(emptyRepo)).toEqual([]);
    } finally {
      fs.rmSync(emptyRepo, { recursive: true, force: true });
    }
  });

  it("exception: loadExceptions throws naming the file on malformed JSON", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "lint-tenant-scoping-"));
    try {
      const dir = path.dirname(path.join(repo, EXCEPTIONS_FILE));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(repo, EXCEPTIONS_FILE), "{ this is not valid json ");
      expect(() => loadExceptions(repo)).toThrowError(
        new RegExp(EXCEPTIONS_FILE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("exception: loadExceptions throws naming the file when the JSON is not an array", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "lint-tenant-scoping-"));
    try {
      const dir = path.dirname(path.join(repo, EXCEPTIONS_FILE));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(repo, EXCEPTIONS_FILE), JSON.stringify({ not: "an array" }));
      expect(() => loadExceptions(repo)).toThrow();
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("matchException (exception near-miss)", () => {
  const entries: TenantScopingException[] = [
    {
      file: "apps/api/src/routes/x.ts",
      handler: "GET /:id",
      validatedAt: 1,
      calls: [{ call: "x.findFirst", line: 10 }],
      reason: REASON,
    },
  ];

  it("exception: matches exactly on file+call+line", () => {
    const result = matchException(call({ line: 10 }), entries);
    expect(result).toEqual({ matched: entries[0] });
  });

  it("exception: reports a near-miss on file+call at a different line, not null", () => {
    const result = matchException(call({ line: 11 }), entries);
    expect(result && "nearMiss" in result).toBe(true);
  });

  it("exception: returns null for an unrelated call", () => {
    const result = matchException(
      call({ model: "y", callId: "apps/api/src/routes/x.ts:y.findFirst:10#1" }),
      entries,
    );
    expect(result).toBeNull();
  });
});

// ── Task 2: CLI entry (`runLint`, `formatFinding`) ──────────────────────────────────────────

function writeFixtureTree(repoRoot: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(repoRoot, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

const SCOPED_ROUTE = "apps/api/src/contexts/working-time-account/api/widgets.ts";

const SCOPED_HANDLER = `
export async function widgetRoutes(app) {
  app.get("/widgets/:id", async (req, reply) => {
    const { id } = req.params;
    const widget = await prisma.widget.findFirst({ where: { id, tenantId: req.user.tenantId } });
    return widget;
  });
}
`;

const UNSCOPED_HANDLER = `
export async function widgetRoutes(app) {
  app.get("/widgets/:id", async (req, reply) => {
    const { id } = req.params;
    const widget = await prisma.widget.findFirst({ where: { id } });
    return widget;
  });
}
`;

function writeExceptions(repoRoot: string, entries: unknown): void {
  const abs = path.join(repoRoot, EXCEPTIONS_FILE);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(entries));
}

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lint-tenant-scoping-cli-"));
  // #229 Guard A: listScopedFiles now hard-errors when a SCOPED_DIRS entry does not exist on
  // disk. The real repo always has "apps/api/src/services", "apps/api/src/composition" (since
  // Phase 99b Plan 02), "apps/api/src/contexts/scheduling/api" (since Phase 99b Plan 04),
  // "apps/api/src/contexts/platform/api" (since Phase 99b Plan 05),
  // "apps/api/src/contexts/time-tracking/api" (since Phase 99b Plan 06's predecessor),
  // "apps/api/src/contexts/absence/api" (since Phase 99b Plan 06), "apps/api/src/contexts/
  // working-time-account/api" (Phase 99b Plan 07, final shape — the former monolithic route
  // directory is gone), "apps/api/src/contexts/platform/facade" (Phase 100B Plan 04, D-10/G1,
  // the eighth and first FACADE entry) and "apps/api/src/contexts/scheduling/facade" (Phase
  // 100B Plan 05, the ninth) — so every fixture tree below provisions all nine up front —
  // individual tests still only WRITE files under the one they care about, matching production
  // shape rather than working around the guard.
  fs.mkdirSync(path.join(tmpRoot, "apps/api/src/services"), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, "apps/api/src/composition"), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, "apps/api/src/contexts/scheduling/api"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(tmpRoot, "apps/api/src/contexts/platform/api"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(tmpRoot, "apps/api/src/contexts/platform/facade"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(tmpRoot, "apps/api/src/contexts/scheduling/facade"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(tmpRoot, "apps/api/src/contexts/time-tracking/api"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(tmpRoot, "apps/api/src/contexts/absence/api"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(tmpRoot, "apps/api/src/contexts/working-time-account/api"), {
    recursive: true,
  });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("runLint", () => {
  it("returns exit code 0 and a counted report on a tree with zero unscoped findings", () => {
    writeFixtureTree(tmpRoot, { [SCOPED_ROUTE]: SCOPED_HANDLER });

    const result = runLint({ repoRoot: tmpRoot });

    expect(result.exitCode).toBe(0);
    expect(result.findings).toHaveLength(0);
    expect(result.counts.inScope).toBeGreaterThanOrEqual(1);
    expect(result.counts.candidates).toBeGreaterThanOrEqual(1);
    expect(result.errors).toEqual([]);
  });

  it("returns exit code 1 and one finding on a tree with an unscoped call", () => {
    writeFixtureTree(tmpRoot, { [SCOPED_ROUTE]: UNSCOPED_HANDLER });

    const result = runLint({ repoRoot: tmpRoot });

    expect(result.exitCode).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].call.model).toBe("widget");
    expect(result.findings[0].detail).toMatch(/no tenant scoping found/);
  });

  it("formats a finding as <file>:<line> — <model>.<method> — <detail>", () => {
    writeFixtureTree(tmpRoot, { [SCOPED_ROUTE]: UNSCOPED_HANDLER });
    const result = runLint({ repoRoot: tmpRoot });
    const line = formatFinding(result.findings[0].call, {
      scoped: false,
      detail: result.findings[0].detail,
    });
    expect(line).toBe(
      `${result.findings[0].call.file}:${result.findings[0].call.line} — widget.findFirst — ${result.findings[0].detail}`,
    );
  });

  it("returns exit code 0 when the finding is covered by a valid, matching exception", () => {
    writeFixtureTree(tmpRoot, { [SCOPED_ROUTE]: UNSCOPED_HANDLER });
    const probe = runLint({ repoRoot: tmpRoot });
    const finding = probe.findings[0].call;

    writeExceptions(tmpRoot, [
      {
        file: finding.file,
        handler: "GET /widgets/:id",
        validatedAt: null,
        calls: [{ call: `${finding.model}.${finding.method}`, line: finding.line }],
        reason: "This fixture models a deliberately excepted call for the runLint test itself.",
      },
    ]);

    const result = runLint({ repoRoot: tmpRoot });
    expect(result.exitCode).toBe(0);
    expect(result.counts.excepted).toBe(1);
    expect(result.findings).toHaveLength(0);
  });

  it("returns exit code 1 when the exceptions file has an invalid entry, even with zero findings", () => {
    writeFixtureTree(tmpRoot, { [SCOPED_ROUTE]: SCOPED_HANDLER });
    writeExceptions(tmpRoot, [
      {
        file: "a.ts",
        handler: "GET /:id",
        validatedAt: 1,
        calls: [{ call: "x.findFirst", line: 1 }],
        reason: "",
      },
    ]);

    const result = runLint({ repoRoot: tmpRoot });
    expect(result.exitCode).toBe(1);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("returns exit code 1 when an exception no longer matches any finding (STALE)", () => {
    writeFixtureTree(tmpRoot, { [SCOPED_ROUTE]: SCOPED_HANDLER }); // clean tree, nothing unscoped
    writeExceptions(tmpRoot, [
      {
        file: SCOPED_ROUTE,
        handler: "GET /widgets/:id",
        validatedAt: null,
        calls: [{ call: "widget.findFirst", line: 999 }],
        reason: "This entry deliberately points at a line that no longer has any finding on it.",
      },
    ]);

    const result = runLint({ repoRoot: tmpRoot });
    expect(result.exitCode).toBe(1);
    expect(result.errors.some((e) => /stale/i.test(e))).toBe(true);
  });

  it("LINT_TENANT_SCOPING_SOFT=1 yields exit code 0 while still reporting every finding", () => {
    writeFixtureTree(tmpRoot, { [SCOPED_ROUTE]: UNSCOPED_HANDLER });
    const previous = process.env.LINT_TENANT_SCOPING_SOFT;
    process.env.LINT_TENANT_SCOPING_SOFT = "1";
    try {
      const result = runLint({ repoRoot: tmpRoot });
      expect(result.exitCode).toBe(0);
      expect(result.findings).toHaveLength(1);
    } finally {
      if (previous === undefined) delete process.env.LINT_TENANT_SCOPING_SOFT;
      else process.env.LINT_TENANT_SCOPING_SOFT = previous;
    }
  });

  // ── #229 Guard B: zero in-scope calls is a defect, never "all clean" — and is NOT softened ───

  it("#229 Guard B: a tree with zero relevant calls returns exitCode 1 with an '0 in-scope' error", () => {
    // Both SCOPED_DIRS exist and contain a .ts file, but it has no relevant Prisma call at all —
    // this is the "detection found nothing because there is nothing to find" case Guard B targets,
    // distinct from Guard A's "the directory itself does not exist" case.
    writeFixtureTree(tmpRoot, {
      [SCOPED_ROUTE]: "export function widgetRoutes() {}\n",
      "apps/api/src/services/placeholder.ts": "export const noop = 1;\n",
    });

    const result = runLint({ repoRoot: tmpRoot });

    expect(result.exitCode).toBe(1);
    expect(result.counts.inScope).toBe(0);
    expect(result.errors.some((e) => e.includes("0 in-scope"))).toBe(true);
  });

  it("#229 Guard B: stays exitCode 1 under LINT_TENANT_SCOPING_SOFT=1 (never softened)", () => {
    writeFixtureTree(tmpRoot, {
      [SCOPED_ROUTE]: "export function widgetRoutes() {}\n",
      "apps/api/src/services/placeholder.ts": "export const noop = 1;\n",
    });

    const previous = process.env.LINT_TENANT_SCOPING_SOFT;
    process.env.LINT_TENANT_SCOPING_SOFT = "1";
    try {
      const result = runLint({ repoRoot: tmpRoot });
      expect(result.exitCode).toBe(1);
      expect(result.errors.some((e) => e.includes("0 in-scope"))).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.LINT_TENANT_SCOPING_SOFT;
      else process.env.LINT_TENANT_SCOPING_SOFT = previous;
    }
  });

  it("importing the module constructs nothing and scans nothing (Issue #203)", async () => {
    // Re-import in isolation to prove no scan runs merely from module evaluation. If `main()`
    // ran unguarded at import time it would need a real repoRoot and would throw or scan the
    // actual repository — neither of which this bare dynamic import triggers.
    const mod = await import("../lint-tenant-scoping");
    expect(typeof mod.runLint).toBe("function");
    expect(typeof mod.formatFinding).toBe("function");
  });
});
