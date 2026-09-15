/**
 * Phase 204 Plan 04 — the named, reasoned exception list for the `lint:tenant-scoping` gate
 * (GitHub Issue #204, D-06/D-07/D-08).
 *
 * ── Why a hash baseline was deliberately rejected (D-06) ──────────────────────────────────────
 * `scripts/lint-comment-language-baseline.json` (Issue #131) is the nearest-relative precedent in
 * this codebase, and its shape is EXPLICITLY not the model here: it keys entries as
 * `file::hash::index` and carries zero reasons — correct for its own problem (224 pre-existing
 * German comments nobody is asking a machine to justify one-by-one), wrong for this one. This
 * gate's own AC is worded literally: "Die bestehenden, bewusst ausgenommenen Stellen sind
 * namentlich mit Begründung gelistet — nicht pauschal per Verzeichnis ausgeblendet." A hash carries
 * no decision; this list's value IS the decision. `lint-comment-language-baseline.json` stays
 * exactly as it is — it is not being retrofitted with reasons, and this module does not touch it.
 *
 * ── How a developer adds a justified exception ────────────────────────────────────────────────
 * 1. Run `pnpm --filter @clokr/api exec tsx scripts/lint-tenant-scoping.ts --json` and find the
 *    finding's `file`, `call` (`<model>.<method>`) and `line`.
 * 2. Read the surrounding handler and decide WHY the call is tenant-safe for a reason the checker
 *    cannot see (D-16 chained validation, a model with `ModelTenancy: none`, a pre-authentication
 *    flow, ...). Per D-08, a finding on a clean tree is a FINDING first — only except it once you
 *    have actually understood why it is safe, never to make the run go green.
 * 3. Append one object to `apps/api/scripts/lint-tenant-scoping-exceptions.json`:
 *    `{ "file": "apps/api/src/routes/....ts", "call": "model.method", "line": 123,
 *       "reason": "<a full sentence explaining why this exact call is tenant-safe>" }`
 * 4. Re-run the gate. A reasonless, whitespace-only, or under-30-character reason fails the run —
 *    this is machine-enforced here, not a code-review convention (D-06). An entry that no longer
 *    matches any current finding fails as STALE, so the list cannot rot into a blanket allow once
 *    the code it names has moved or been fixed.
 *
 * This module has no `main()`, no CLI, and no side effects on import — the CLI entry point and its
 * report belong to `lint-tenant-scoping.ts` (this same plan, Task 2).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { PrismaCall } from "./lint-tenant-scoping-types";

/** Repo-relative path to the exception list, exported so the CLI entry and tests share one constant. */
export const EXCEPTIONS_FILE = "apps/api/scripts/lint-tenant-scoping-exceptions.json";

/**
 * One named, reasoned exception for a call site the gate would otherwise flag as NOT scoped.
 * `call` is `"<model>.<method>"`, matching `PrismaCall`'s own model/method vocabulary so a reader
 * can grep the same string in both the finding report and this file.
 */
export type TenantScopingException = {
  /** Repo-relative path, e.g. "apps/api/src/routes/auth.ts" */
  file: string;
  /** "<model>.<method>", e.g. "otpToken.findFirst" */
  call: string;
  /** 1-based line of the call */
  line: number;
  /**
   * WHY this site is tenant-safe, in prose. Mandatory, enforced here rather than in code review
   * (D-06). This field is the whole point of the list: "Die Ausnahmeliste ist dabei kein Makel,
   * sondern der eigentliche Wert: sie macht die Entscheidung sichtbar, statt sie im Schweigen zu
   * lassen." (Issue #204)
   */
  reason: string;
};

/**
 * Minimum trimmed `reason` length. "A reason must be a sentence, not a word" (plan 04 <behavior>):
 * every reason written while triaging this gate's first real run reads as at least a short clause
 * naming a mechanism ("pre-authentication, req.user does not exist yet" is 44 characters) — a
 * single word or two ("safe", "pre-auth") sits far under this and would tell a reviewer nothing
 * they could check against the code. 30 is picked as comfortably below the shortest genuine reason
 * measured and comfortably above a bare label, so it rejects the failure mode without rejecting
 * real prose.
 */
export const MIN_REASON_LENGTH = 30;

function callKey(call: Pick<PrismaCall, "model" | "method">): string {
  return `${call.model}.${call.method}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeEntry(entry: unknown, index: number): string {
  if (isRecord(entry) && typeof entry.file === "string" && typeof entry.call === "string") {
    return `entry #${index} (${entry.file}:${String(entry.line ?? "?")} ${entry.call})`;
  }
  return `entry #${index}`;
}

/**
 * Structurally and semantically validates a raw (untyped) exceptions payload against the current
 * finding set. Both structural validation (missing/malformed fields, reasonless/whitespace/short
 * reasons, `__tests__` paths) AND staleness (does this entry still match a current finding?) are
 * checked here — an entry can be well-formed and still invalid because the call it names has moved
 * or been fixed, and a stale entry left in place is exactly the "blanket allow waiting to happen"
 * this module exists to prevent.
 */
export function validateExceptions(
  entries: unknown,
  findings: readonly PrismaCall[],
): { ok: true; entries: TenantScopingException[] } | { ok: false; errors: string[] } {
  if (!Array.isArray(entries)) {
    return {
      ok: false,
      errors: [`${EXCEPTIONS_FILE} must contain a JSON array of exception entries`],
    };
  }

  const errors: string[] = [];
  const valid: TenantScopingException[] = [];

  entries.forEach((raw, index) => {
    const label = describeEntry(raw, index);

    if (!isRecord(raw)) {
      errors.push(`${label}: entry is not an object`);
      return;
    }

    const { file, call, line, reason } = raw;

    if (typeof file !== "string" || file.length === 0) {
      errors.push(`${label}: missing or invalid 'file' (repo-relative path expected)`);
      return;
    }
    if (typeof call !== "string" || call.length === 0) {
      errors.push(`${label}: missing or invalid 'call' (expected "<model>.<method>")`);
      return;
    }
    if (typeof line !== "number" || !Number.isInteger(line) || line < 1) {
      errors.push(`${label}: missing or invalid 'line' (expected a positive integer)`);
      return;
    }
    if (typeof reason !== "string" || reason.trim().length === 0) {
      errors.push(
        `${label}: missing 'reason' — every exception MUST name WHY the site is tenant-safe (D-06); ` +
          `see the header of lint-tenant-scoping-exceptions.ts for how to write one`,
      );
      return;
    }
    if (reason.trim().length < MIN_REASON_LENGTH) {
      errors.push(
        `${label}: 'reason' is only ${reason.trim().length} character(s) — must read as a sentence, ` +
          `not a label (minimum ${MIN_REASON_LENGTH})`,
      );
      return;
    }
    if (file.includes("__tests__")) {
      errors.push(
        `${label}: 'file' is under __tests__ — a test-fixture exception means the directory ` +
          `scoping (D-15) is wrong, not that the fixture needs excepting`,
      );
      return;
    }

    const entry: TenantScopingException = { file, call, line, reason: reason.trim() };

    const stillFinding = findings.some(
      (f) => f.file === entry.file && callKey(f) === entry.call && f.line === entry.line,
    );
    if (!stillFinding) {
      errors.push(
        `${label}: STALE — no current finding matches this file+call+line; the call may have ` +
          `moved (check for a near-miss at a different line) or been fixed. Update or remove it — ` +
          `a stale entry is a blanket allow waiting to happen`,
      );
      return;
    }

    valid.push(entry);
  });

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, entries: valid };
}

/**
 * Does `call` match a named exception? Matches on `file` + `call` + `line` exactly. When no exact
 * match exists but an entry shares `file` + `call` at a DIFFERENT line, that is reported as a near
 * miss rather than `null` — the common case of ordinary code movement (the excepted call shifted a
 * few lines) should read as "update the line number in the exception entry", not as an unexplained
 * finding that looks like a brand-new gap.
 */
export function matchException(
  call: PrismaCall,
  entries: readonly TenantScopingException[],
): { matched: TenantScopingException } | { nearMiss: TenantScopingException } | null {
  const key = callKey(call);
  const exact = entries.find((e) => e.file === call.file && e.call === key && e.line === call.line);
  if (exact) return { matched: exact };

  const near = entries.find((e) => e.file === call.file && e.call === key);
  if (near) return { nearMiss: near };

  return null;
}

/**
 * Reads and JSON-parses the exceptions file from disk. Returns `[]` when the file does not exist
 * yet (the empty-array seed state before the first real run's triage, D-07). A malformed JSON file
 * fails LOUDLY, naming the file — never silently falling back to an empty list, which would let a
 * corrupted exceptions file quietly disable every exception it used to grant.
 *
 * This function does NOT validate entry shape or staleness — that is `validateExceptions`'s job,
 * once the current finding set is known. Callers MUST run the result through `validateExceptions`
 * before trusting it.
 */
export function loadExceptions(repoRoot: string): TenantScopingException[] {
  const abs = path.join(repoRoot, EXCEPTIONS_FILE);
  if (!fs.existsSync(abs)) return [];

  const text = fs.readFileSync(abs, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `failed to parse ${EXCEPTIONS_FILE}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${EXCEPTIONS_FILE} must contain a JSON array, found ${typeof parsed}`);
  }
  return parsed as TenantScopingException[];
}
