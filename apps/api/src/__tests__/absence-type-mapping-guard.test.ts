/**
 * Phase 98 (T3, Option D) — the gate that keeps the AbsenceType<->LeaveTypeCode correspondence
 * honest.
 *
 * This is a DELIBERATELY separate file from `leave-type-identity-guard.test.ts` (Phase 97), not
 * an extension of it. That guard answers "does a German display literal act as a control value
 * anywhere", scanning source text against an `ALLOWED` exception list. This gate answers "are the
 * two enums and the written correspondence in `absence-type.ts` still in agreement", reading the
 * Prisma schema and one module. Different input, different question, different failure meaning.
 * Folding them together would make one red test ambiguous and would make this gate inherit an
 * exception list it has no use for.
 *
 * It fails the moment:
 * - either `AbsenceType` or `LeaveTypeCode` gains or loses a value without `absence-type.ts` being
 *   updated to state its correspondence (G1),
 * - a correspondence entry's counterpart does not exist in the other enum, or a non-correspondence
 *   entry's reason is a placeholder (G2, G3),
 * - a correspondence is one-sided (G4),
 * - `AbsenceType.OTHER` is demoted from its `absence_only` pin (G5),
 * - a fourth declaration of the absence vocabulary appears anywhere in the repo (G6),
 * - a demo seed script (`packages/db/src/*.ts`) writes an `Absence` row with one of the four
 *   ADR-requested-only types again (G7 — see 98-02-PLAN.md).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { describe, it, expect } from "vitest";
import {
  ABSENCE_TYPES,
  ABSENCE_TYPE_CORRESPONDENCE,
  LEAVE_TYPE_CODE_CORRESPONDENCE,
  ADR_REQUESTED_ONLY_ABSENCE_TYPES,
} from "../utils/absence-type";
import { LEAVE_TYPE_CODES } from "../utils/leave-type";

// __dirname is apps/api/src/__tests__ — four levels up is the repo root, same as
// leave-type-identity-guard.test.ts.
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const SCHEMA_PATH = join(REPO_ROOT, "packages/db/prisma/schema.prisma");

/** Parses one `enum Name { ... }` block from the raw schema text into its member identifiers,
 *  stripping `//` trailing comments. */
function parseEnumMembers(schemaText: string, enumName: string): string[] {
  const re = new RegExp(`enum\\s+${enumName}\\s*\\{([^}]*)\\}`, "m");
  const match = schemaText.match(re);
  if (!match) throw new Error(`enum ${enumName} not found in schema.prisma`);
  return match[1]
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "").trim())
    .filter((line) => line.length > 0);
}

// ── G1 — schema parity ──────────────────────────────────────────────────────────────────
describe("G1 — schema enum parity", () => {
  const schemaText = readFileSync(SCHEMA_PATH, "utf-8");

  it("the parsed AbsenceType enum equals ABSENCE_TYPES exactly (8 members)", () => {
    const schemaMembers = new Set(parseEnumMembers(schemaText, "AbsenceType"));
    expect(schemaMembers.size).toBe(8);
    expect(schemaMembers).toEqual(new Set(ABSENCE_TYPES));
  });

  it("the parsed LeaveTypeCode enum equals LEAVE_TYPE_CODES exactly (9 members)", () => {
    const schemaMembers = new Set(parseEnumMembers(schemaText, "LeaveTypeCode"));
    expect(schemaMembers.size).toBe(9);
    expect(schemaMembers).toEqual(new Set(LEAVE_TYPE_CODES));
  });
});

// ── G2 — correspondence completeness, Absence side ──────────────────────────────────────
describe("G2 — ABSENCE_TYPE_CORRESPONDENCE completeness", () => {
  const schemaText = readFileSync(SCHEMA_PATH, "utf-8");

  // Deliberately checked against the SCHEMA directly, not against ABSENCE_TYPES — a mutation
  // that removes an entry from both ABSENCE_TYPE_CORRESPONDENCE and the ABSENCE_TYPES tuple in
  // lockstep must still be caught here, independently of G1's own ABSENCE_TYPES<->schema check.
  it("has exactly one entry per AbsenceType value declared in the schema", () => {
    const schemaMembers = new Set(parseEnumMembers(schemaText, "AbsenceType"));
    expect(new Set(Object.keys(ABSENCE_TYPE_CORRESPONDENCE))).toEqual(schemaMembers);
  });

  it("every corresponds entry's code exists in LEAVE_TYPE_CODES", () => {
    for (const type of ABSENCE_TYPES) {
      const entry = ABSENCE_TYPE_CORRESPONDENCE[type];
      if (entry.kind === "corresponds") {
        expect(LEAVE_TYPE_CODES as readonly string[]).toContain(entry.code);
      }
    }
  });

  it("every absence_only entry's why is a real reason, not a placeholder (>= 40 chars)", () => {
    for (const type of ABSENCE_TYPES) {
      const entry = ABSENCE_TYPE_CORRESPONDENCE[type];
      if (entry.kind === "absence_only") {
        expect(entry.why.length).toBeGreaterThanOrEqual(40);
      }
    }
  });
});

// ── G3 — correspondence completeness, leave side ────────────────────────────────────────
describe("G3 — LEAVE_TYPE_CODE_CORRESPONDENCE completeness", () => {
  const schemaText = readFileSync(SCHEMA_PATH, "utf-8");

  // Mirror of G2's design note: checked against the SCHEMA directly, not against
  // LEAVE_TYPE_CODES, for the same independence reason.
  it("has exactly one entry per LeaveTypeCode value declared in the schema", () => {
    const schemaMembers = new Set(parseEnumMembers(schemaText, "LeaveTypeCode"));
    expect(new Set(Object.keys(LEAVE_TYPE_CODE_CORRESPONDENCE))).toEqual(schemaMembers);
  });

  it("every corresponds entry's type exists in ABSENCE_TYPES", () => {
    for (const code of LEAVE_TYPE_CODES) {
      const entry = LEAVE_TYPE_CODE_CORRESPONDENCE[code];
      if (entry.kind === "corresponds") {
        expect(ABSENCE_TYPES as readonly string[]).toContain(entry.type);
      }
    }
  });

  it("every leave_only entry's why is a real reason, not a placeholder (>= 40 chars)", () => {
    for (const code of LEAVE_TYPE_CODES) {
      const entry = LEAVE_TYPE_CODE_CORRESPONDENCE[code];
      if (entry.kind === "leave_only") {
        expect(entry.why.length).toBeGreaterThanOrEqual(40);
      }
    }
  });
});

// ── G4 — round-trip ──────────────────────────────────────────────────────────────────────
describe("G4 — every corresponds pair round-trips in both directions", () => {
  it("AbsenceType -> LeaveTypeCode -> AbsenceType returns the original value", () => {
    for (const type of ABSENCE_TYPES) {
      const entry = ABSENCE_TYPE_CORRESPONDENCE[type];
      if (entry.kind !== "corresponds") continue;
      const mirror = LEAVE_TYPE_CODE_CORRESPONDENCE[entry.code];
      expect(mirror.kind).toBe("corresponds");
      expect(mirror.kind === "corresponds" ? mirror.type : null).toBe(type);
    }
  });

  it("LeaveTypeCode -> AbsenceType -> LeaveTypeCode returns the original value", () => {
    for (const code of LEAVE_TYPE_CODES) {
      const entry = LEAVE_TYPE_CODE_CORRESPONDENCE[code];
      if (entry.kind !== "corresponds") continue;
      const mirror = ABSENCE_TYPE_CORRESPONDENCE[entry.type];
      expect(mirror.kind).toBe("corresponds");
      expect(mirror.kind === "corresponds" ? mirror.code : null).toBe(code);
    }
  });
});

// ── G5 — the OTHER anti-removal pin ─────────────────────────────────────────────────────
describe("G5 — AbsenceType.OTHER anti-removal pin", () => {
  it("OTHER has NO writer in production code, which makes it look like a dead enum value — it is not. 15 production rows (13 employees, 2026-01-01..2026-05-26) depend on it (98-RESEARCH.md §2.6); removing it would change their Soll. This assertion is the phase's defence against its own trap — a future cleanup PR meets a red test with the reason attached", () => {
    expect(ABSENCE_TYPES as readonly string[]).toContain("OTHER");
    expect(ABSENCE_TYPE_CORRESPONDENCE.OTHER.kind).toBe("absence_only");
  });
});

// ── G6 — no redeclaration ────────────────────────────────────────────────────────────────
describe("G6 — no redeclaration of the absence vocabulary", () => {
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
      // A scan root may not exist for every workspace layout — skip rather than throw.
      try {
        walk(absRoot);
      } catch {
        // root does not exist, ignore
      }
    }
    return out;
  }

  it("declares the absence vocabulary exactly once — the Prisma enum aside", () => {
    const files = collectFiles();
    const violations: string[] = [];
    for (const abs of files) {
      const content = readFileSync(abs, "utf-8");
      const lines = content.split("\n");
      lines.forEach((line, i) => {
        if (/type\s+AbsenceType\s*=/.test(line)) {
          violations.push(`${relative(REPO_ROOT, abs)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    const report =
      violations.length > 0
        ? violations.join("\n") +
          "\n\nThe absence vocabulary has exactly one declaration, the Prisma enum; import " +
          'the type from "@clokr/db".'
        : "";
    expect(report).toBe("");
  });
});

// ── G7 — no seed writes an ADR-requested-only type onto the Absence side ────────────────
//
// This is a TEXT scan, deliberately, not a runtime assertion. `packages/db/src/*.ts` are
// standalone scripts run against a database with `tsx`, not importable test subjects — there is
// no function here a test could call and inspect. The defect this prevents is someone writing the
// literal `type: "SICK"` (or one of its three siblings) back onto a `prisma.absence.create` call;
// a text scan catches that the moment it is written, rather than the next time somebody actually
// runs the seed against a database and notices the wrong row show up.
//
// Deliberately scoped to the seed files only, not the whole repo. Three e2e fixtures
// (`apps/e2e/tests/leave-flow.spec.ts`, `apps/e2e/tests/overtime-saldo-flow.spec.ts`,
// `apps/e2e/fixtures/visual-seed.ts`) legitimately contain the literal `type: "SICK"` as a
// `LeaveTypeCode` in a `POST /api/v1/leave/requests` body — a repo-wide scan would flag correct
// code, and a gate that flags correct code gets an exception list, which is the failure mode this
// phase is avoiding (98-RESEARCH.md §3.4, 98-02-PLAN.md <measured_baseline>).
describe("G7 — no demo seed creates an Absence row with an ADR-requested-only type", () => {
  const SEED_DIR = join(REPO_ROOT, "packages/db/src");

  function seedFiles(): string[] {
    return readdirSync(SEED_DIR)
      .filter((entry) => extname(entry) === ".ts")
      .map((entry) => join(SEED_DIR, entry));
  }

  it('`type: "<ADR-requested-only type>"` occurs in zero packages/db/src/*.ts files', () => {
    const violations: string[] = [];
    for (const abs of seedFiles()) {
      const content = readFileSync(abs, "utf-8");
      for (const type of ADR_REQUESTED_ONLY_ABSENCE_TYPES) {
        if (content.includes(`type: "${type}"`)) {
          violations.push(
            `${relative(REPO_ROOT, abs)}: found literal type: "${type}". ADR 0001 assigns ` +
              `SICK, SICK_CHILD, SPECIAL_LEAVE and UNPAID_LEAVE to LeaveRequest, not Absence — ` +
              `seed it as an APPROVED LeaveRequest with the matching LeaveType.code, not as an ` +
              `Absence. See ABSENCE_TYPE_CORRESPONDENCE in apps/api/src/utils/absence-type.ts ` +
              `for the code to use.`,
          );
        }
      }
    }
    expect(violations.join("\n")).toBe("");
  });
});
