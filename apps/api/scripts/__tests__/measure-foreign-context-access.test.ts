/**
 * Phase 100b Plan 01 (T-100B-02) — non-vacuity proof for measure-foreign-context-access.ts.
 *
 * A measurement that counts nothing also exits 0 (#229). These tests prove three things by
 * construction rather than by reading the script: (1) a genuine cross-context call is reported,
 * (2) the SAME call commented out is not, (3) a `services/clock/` call to its OWN model
 * (`timeEntry`) is NOT reported — the entry-F reading D-04 corrected. Fixture trees are real
 * directories under `os.tmpdir()`, written and torn down per test, because `scanSrcTree` does
 * real file I/O by design (mirrors the fixture-on-disk approach `check-import-targets.test.ts`
 * and `lint-tenant-scoping.test.ts` use for their own walkers, unlike the purely in-memory
 * `measure-context-coverage.test.ts`, whose target function never touches a filesystem at all).
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MODEL_OWNER,
  OWNER_AREAS,
  UnmappedAreaError,
  areaForRelPath,
  computeWorkload,
  extractCallsFromContent,
  isExcepted,
  isForeign,
  isReadOp,
  isWriteOp,
  scanFileContent,
  scanSrcTree,
  summaryLine,
  validateExceptionsDocument,
  type Access,
  type ExceptionsDocument,
} from "../measure-foreign-context-access";

// ── Fixture helpers ──────────────────────────────────────────────────────────────────────────

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "measure-foreign-context-access-fixture-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function writeFixture(relPath: string, content: string): void {
  const abs = join(tmpRoot, relPath);
  mkdirSync(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

// ── Model-ownership table exhaustiveness ─────────────────────────────────────────────────────

describe("MODEL_OWNER", () => {
  it("assigns exactly 41 models, every owner one of the five OWNER_AREAS", () => {
    const models = Object.keys(MODEL_OWNER);
    expect(models).toHaveLength(41);
    for (const owner of Object.values(MODEL_OWNER)) {
      expect(OWNER_AREAS).toContain(owner);
    }
  });

  it("matches the measurement authority's per-owner model count (13/6/9/5/8)", () => {
    const counts: Record<string, number> = {};
    for (const owner of Object.values(MODEL_OWNER)) {
      counts[owner] = (counts[owner] ?? 0) + 1;
    }
    expect(counts).toEqual({
      platform: 13,
      "time-tracking": 6,
      absence: 9,
      "working-time-account": 5,
      scheduling: 8,
    });
  });
});

// ── areaForRelPath — entry F ──────────────────────────────────────────────────────────────────

describe("areaForRelPath (ADR 0001 entry F)", () => {
  it("assigns services/clock/** to time-tracking, services/phorest/** to scheduling", () => {
    expect(areaForRelPath("services/clock/resolver.ts")).toBe("time-tracking");
    expect(areaForRelPath("services/phorest/sync-shifts.ts")).toBe("scheduling");
  });

  it("assigns contexts/<x>/** to <x>, composition/** to composition", () => {
    expect(areaForRelPath("contexts/absence/api/leave.ts")).toBe("absence");
    expect(areaForRelPath("contexts/working-time-account/overtime.ts")).toBe(
      "working-time-account",
    );
    expect(areaForRelPath("composition/dashboard.ts")).toBe("composition");
  });

  it("returns null for a path outside the three walked trees", () => {
    expect(areaForRelPath("app.ts")).toBeNull();
    expect(areaForRelPath("routes/foo.ts")).toBeNull();
  });

  it("throws UnmappedAreaError for a services/* subtree that is neither clock nor phorest", () => {
    expect(() => areaForRelPath("services/mystery/foo.ts")).toThrow(UnmappedAreaError);
  });
});

// ── extractCallsFromContent — the receiver-agnostic pattern and comment skipping ─────────────

describe("extractCallsFromContent", () => {
  it("matches app.prisma, tx, and a bare prisma receiver alike (receiver-agnostic, rule 2)", () => {
    const content = [
      "await app.prisma.leaveRequest.findMany({ where: {} });",
      "await tx.overtimeAccount.update({ where: {}, data: {} });",
      "await prisma.absence.deleteMany({ where: {} });",
    ].join("\n");
    const calls = extractCallsFromContent(content);
    expect(calls).toEqual([
      { line: 1, receiver: "app.prisma", model: "leaveRequest", op: "findMany" },
      { line: 2, receiver: "tx", model: "overtimeAccount", op: "update" },
      { line: 3, receiver: "prisma", model: "absence", op: "deleteMany" },
    ]);
  });

  it("skips a line whose trimmed form starts with // (rule 3)", () => {
    const content = "  // app.prisma.leaveRequest.findMany({ where: {} });";
    expect(extractCallsFromContent(content)).toEqual([]);
  });

  it("skips a line whose trimmed form starts with * or /* (block-comment rule 3)", () => {
    const content = [
      " * app.prisma.leaveRequest.findMany({ where: {} });",
      "/* app.prisma.absence.deleteMany({ where: {} }); */",
    ].join("\n");
    expect(extractCallsFromContent(content)).toEqual([]);
  });

  it("does not match an unrelated method name that merely contains a model word", () => {
    const content = "await app.prisma.leaveRequestSomethingElse.findMany({});";
    expect(extractCallsFromContent(content)).toEqual([]);
  });
});

// ── isForeign / read-write classification ────────────────────────────────────────────────────

describe("isForeign (measurement authority rule 6)", () => {
  it("is false when the owner is platform, regardless of area", () => {
    expect(isForeign("platform", "absence")).toBe(false);
    expect(isForeign("platform", "composition")).toBe(false);
  });

  it("is false when the owner equals the area (own-context access)", () => {
    expect(isForeign("absence", "absence")).toBe(false);
  });

  it("is true when the owner is a non-platform context different from the area", () => {
    expect(isForeign("absence", "scheduling")).toBe(true);
    expect(isForeign("scheduling", "composition")).toBe(true);
  });
});

describe("isReadOp / isWriteOp", () => {
  it("classifies every op as exactly one of read or write", () => {
    for (const op of ["findMany", "findFirst", "count", "groupBy", "aggregate"]) {
      expect(isReadOp(op)).toBe(true);
      expect(isWriteOp(op)).toBe(false);
    }
    for (const op of ["create", "update", "deleteMany", "upsert"]) {
      expect(isWriteOp(op)).toBe(true);
      expect(isReadOp(op)).toBe(false);
    }
  });
});

// ── Non-vacuity (T-100B-02): the three fixture-tree proofs ───────────────────────────────────

describe("scanSrcTree — non-vacuity", () => {
  it("reports a genuine cross-context call (contexts/absence -> shift, owned by scheduling)", () => {
    writeFixture(
      "contexts/absence/api/leave.ts",
      "export async function poisonCall(app: FastifyInstance) {\n" +
        "  return app.prisma.shift.findMany({ where: { tenantId: 'x' } });\n" +
        "}\n",
    );
    const accesses = scanSrcTree(tmpRoot);
    const found = accesses.find((a) => a.model === "shift" && a.op === "findMany");
    expect(found).toBeDefined();
    expect(found?.owner).toBe("scheduling");
    expect(found?.area).toBe("absence");
    expect(found?.foreign).toBe(true);
  });

  it("does NOT report the same call once commented out", () => {
    writeFixture(
      "contexts/absence/api/leave.ts",
      "export async function noLongerAPoison(app: FastifyInstance) {\n" +
        "  // return app.prisma.shift.findMany({ where: { tenantId: 'x' } });\n" +
        "  return null;\n" +
        "}\n",
    );
    const accesses = scanSrcTree(tmpRoot);
    expect(accesses.find((a) => a.model === "shift")).toBeUndefined();
  });

  it("does NOT report a services/clock/** call to its OWN model (entry F, D-04)", () => {
    writeFixture(
      "services/clock/resolver.ts",
      "export async function resolve(tx: Prisma.TransactionClient) {\n" +
        "  return tx.timeEntry.update({ where: { id: 'x' }, data: {} });\n" +
        "}\n",
    );
    const accesses = scanSrcTree(tmpRoot);
    const found = accesses.find((a) => a.model === "timeEntry");
    expect(found).toBeDefined();
    expect(found?.area).toBe("time-tracking");
    expect(found?.owner).toBe("time-tracking");
    expect(found?.foreign).toBe(false);
  });

  it("DOES report a services/phorest/** call into a foreign context (absence's leaveRequest)", () => {
    writeFixture(
      "services/phorest/sync-shifts.ts",
      "export async function sync(app: FastifyInstance) {\n" +
        "  return app.prisma.leaveRequest.findMany({ where: {} });\n" +
        "}\n",
    );
    const accesses = scanSrcTree(tmpRoot);
    const found = accesses.find((a) => a.model === "leaveRequest");
    expect(found?.area).toBe("scheduling");
    expect(found?.owner).toBe("absence");
    expect(found?.foreign).toBe(true);
  });

  it("skips __tests__ subdirectories and *.test.ts files", () => {
    writeFixture("contexts/absence/api/__tests__/leave.test.ts", "app.prisma.shift.findMany({});");
    writeFixture("contexts/absence/api/leave.test.ts", "app.prisma.shift.findMany({});");
    const accesses = scanSrcTree(tmpRoot);
    expect(accesses).toEqual([]);
  });

  it("scanFileContent returns [] for a path outside the recognized areas", () => {
    expect(scanFileContent("app.ts", "app.prisma.shift.findMany({});")).toEqual([]);
  });
});

// ── Exceptions document validation (T-100B-01) ───────────────────────────────────────────────

const FOREIGN_ACCESS: Access = {
  file: "apps/api/src/contexts/platform/api/test-bootstrap.ts",
  line: 10,
  model: "shift",
  op: "deleteMany",
  receiver: "prisma",
  owner: "scheduling",
  area: "platform",
  foreign: true,
};

describe("validateExceptionsDocument", () => {
  it("accepts a well-formed document whose calls match a current foreign access", () => {
    const doc = {
      convertedModels: [],
      exceptions: [
        {
          file: FOREIGN_ACCESS.file,
          calls: [{ call: "shift.deleteMany", line: 10 }],
          reason: "This is a long enough reason to pass the minimum length check, by design.",
        },
      ],
    };
    const result = validateExceptionsDocument(doc, [FOREIGN_ACCESS]);
    expect(result.ok).toBe(true);
  });

  it("rejects a STALE call — named but matching no current foreign access", () => {
    const doc = {
      convertedModels: [],
      exceptions: [
        {
          file: FOREIGN_ACCESS.file,
          calls: [{ call: "shift.deleteMany", line: 999 }],
          reason: "This is a long enough reason to pass the minimum length check, by design.",
        },
      ],
    };
    const result = validateExceptionsDocument(doc, [FOREIGN_ACCESS]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("STALE"))).toBe(true);
    }
  });

  it("rejects a missing reason", () => {
    const doc = {
      convertedModels: [],
      exceptions: [{ file: FOREIGN_ACCESS.file, calls: [{ call: "shift.deleteMany", line: 10 }] }],
    };
    const result = validateExceptionsDocument(doc, [FOREIGN_ACCESS]);
    expect(result.ok).toBe(false);
  });

  it("rejects a reason shorter than MIN_REASON_LENGTH", () => {
    const doc = {
      convertedModels: [],
      exceptions: [
        {
          file: FOREIGN_ACCESS.file,
          calls: [{ call: "shift.deleteMany", line: 10 }],
          reason: "too short",
        },
      ],
    };
    const result = validateExceptionsDocument(doc, [FOREIGN_ACCESS]);
    expect(result.ok).toBe(false);
  });

  it("rejects convertedModels listing a model that still has workload remaining", () => {
    const doc = {
      convertedModels: ["shift"],
      exceptions: [],
    };
    const result = validateExceptionsDocument(doc, [FOREIGN_ACCESS]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("convertedModels"))).toBe(true);
    }
  });

  it("accepts convertedModels listing a model with zero remaining workload (fully excepted)", () => {
    const doc = {
      convertedModels: ["shift"],
      exceptions: [
        {
          file: FOREIGN_ACCESS.file,
          calls: [{ call: "shift.deleteMany", line: 10 }],
          reason: "This is a long enough reason to pass the minimum length check, by design.",
        },
      ],
    };
    const result = validateExceptionsDocument(doc, [FOREIGN_ACCESS]);
    expect(result.ok).toBe(true);
  });
});

describe("computeWorkload / isExcepted / summaryLine", () => {
  it("excludes an excepted access from workload and reports it in excepted", () => {
    const doc: ExceptionsDocument = {
      convertedModels: [],
      exceptions: [
        {
          file: FOREIGN_ACCESS.file,
          calls: [{ call: "shift.deleteMany", line: 10 }],
          reason: "irrelevant here",
        },
      ],
    };
    expect(isExcepted(FOREIGN_ACCESS, doc)).toBe(true);
    const result = computeWorkload([FOREIGN_ACCESS], doc);
    expect(result.workload).toEqual([]);
    expect(result.excepted).toEqual([FOREIGN_ACCESS]);
  });

  it("keeps a non-excepted foreign access in workload", () => {
    const doc: ExceptionsDocument = { convertedModels: [], exceptions: [] };
    const result = computeWorkload([FOREIGN_ACCESS], doc);
    expect(result.workload).toEqual([FOREIGN_ACCESS]);
    expect(result.excepted).toEqual([]);
  });

  it("summaryLine matches the exact format the plan specifies", () => {
    const doc: ExceptionsDocument = { convertedModels: [], exceptions: [] };
    const result = computeWorkload([FOREIGN_ACCESS], doc);
    expect(summaryLine(result)).toBe(
      "[measure:context-access] 1 foreign access(es) in 1 file(s) — 0 read / 1 write; 0 excepted.",
    );
  });
});

// ── Seeded exceptions file sanity (the real, committed file) ─────────────────────────────────

describe("the real repo exceptions file", () => {
  it("exists on disk", () => {
    expect(existsSync(join(__dirname, "..", "foreign-context-access-exceptions.json"))).toBe(true);
  });
});
