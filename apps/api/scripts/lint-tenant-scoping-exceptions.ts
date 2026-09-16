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
 * ── The counting unit is the HANDLER, not the call site (D-17 checkpoint, coordinator decision) ──
 * The first real run's triage found that the overwhelming majority of findings are NOT 51
 * independent unsafe sites — they are ~15-18 HANDLERS in which one tenant-validating call (an
 * inline `tenantId` check or a fetch-then-compare) protects several LATER calls on a different
 * model that has no `tenantId` of its own (D-16 "Shape 7": chained validation across model
 * boundaries). `employees.ts`'s hard-delete handler is the clearest case: ONE validation at its
 * top, EIGHT deleteMany/findFirst calls below it, all reusing the same validated identifier. An
 * exception PER CALL SITE double-, triple-, or octuple-counts what is really one human decision —
 * "per call site" is the wrong counting unit for this shape, not a reason to weaken the check.
 *
 * One exception entry may therefore cover MULTIPLE calls, but ONLY the calls it lists EXPLICITLY
 * in `calls` — never "every call in this handler". A new Prisma call added later to the same
 * handler is NOT silently covered: it is a NEW finding until someone reads it and adds it to
 * `calls` by name. This is the one property that keeps this from being the "pauschal per
 * Verzeichnis ausgeblendet" AC3 explicitly forbids: the entry's own diff is the audit trail for
 * every claim it makes, and an entry answers exactly the calls it names, not a directory or a
 * handler in the abstract.
 *
 * `validatedAt` is the file:line where the shared identifier is tenant-checked — usually an
 * inline `where.tenantId` or a fetch-then-compare. It is `null` ONLY for the small set of cases
 * that have no such line at all (pre-authentication flows, where no `req.user` exists to check
 * against; an env-gated test-only surface with a wholly different authorization model). Every
 * `null`-validatedAt entry's `reason` must say explicitly why no tenant check applies, not just
 * that none was found.
 *
 * ── How a developer adds a justified exception ────────────────────────────────────────────────
 * 1. Run `pnpm --filter @clokr/api exec tsx scripts/lint-tenant-scoping.ts --json` and find the
 *    finding's `file`, `call` (`<model>.<method>`) and `line`.
 * 2. Read the surrounding handler. If ANOTHER call in the SAME handler is already covered by an
 *    exception whose `validatedAt` also protects this new call (same shared identifier, same
 *    validating line), add `{ call, line }` to that entry's `calls` array — do not create a
 *    second entry for the same handler. Otherwise, decide WHY the call is tenant-safe for a
 *    reason the checker cannot see (D-16 chained validation, a model with `ModelTenancy: none`, a
 *    pre-authentication flow, ...). Per D-08, a finding on a clean tree is a FINDING first — only
 *    except it once you have actually understood why it is safe, never to make the run go green.
 * 3. Append (or extend) an object in `apps/api/scripts/lint-tenant-scoping-exceptions.json`:
 *    ```json
 *    {
 *      "file": "apps/api/src/routes/....ts",
 *      "handler": "DELETE /:id/hard-delete",
 *      "validatedAt": 1108,
 *      "calls": [{ "call": "model.method", "line": 123 }],
 *      "reason": "<a full sentence explaining why this exact identifier is tenant-safe here>"
 *    }
 *    ```
 * 4. Re-run the gate. A reasonless, whitespace-only, or under-30-character reason fails the run —
 *    this is machine-enforced here, not a code-review convention (D-06). A `calls` entry that no
 *    longer matches any current finding fails as STALE, so the list cannot rot into a blanket
 *    allow once the code it names has moved or been fixed.
 *
 * This module has no `main()`, no CLI, and no side effects on import — the CLI entry point and its
 * report belong to `lint-tenant-scoping.ts` (this same plan, Task 2).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { PrismaCall } from "./lint-tenant-scoping-types";

/** Repo-relative path to the exception list, exported so the CLI entry and tests share one constant. */
export const EXCEPTIONS_FILE = "apps/api/scripts/lint-tenant-scoping-exceptions.json";

/** One call this entry excepts, named explicitly — see the module header on why. */
export type TenantScopingExceptionCall = {
  /** "<model>.<method>", e.g. "break.deleteMany" — matches PrismaCall's own vocabulary. */
  call: string;
  /** 1-based line of this specific call. */
  line: number;
};

/**
 * One named, reasoned exception, covering one or more call sites protected by the SAME tenant
 * validation. See the module header ("The counting unit is the HANDLER, not the call site") for
 * why an entry may list more than one call, and why it must still name each one.
 */
export type TenantScopingException = {
  /** Repo-relative path, e.g. "apps/api/src/routes/employees.ts" */
  file: string;
  /** Human-readable route + method, e.g. "DELETE /:id/hard-delete" — for audit readability only,
   * never used for matching (matching is always by exact file+call+line, see matchException). */
  handler: string;
  /**
   * file:line (within `file`) where the shared identifier is tenant-checked — an inline
   * `where.tenantId`/relation filter, or a fetch-then-compare against `req.user.tenantId`. `null`
   * ONLY when no such line exists at all (pre-authentication, or a wholly different authorization
   * model) — the `reason` must then say so explicitly.
   */
  validatedAt: number | null;
  /** Every call this entry covers, each named explicitly — NEVER "every call in this handler". */
  calls: TenantScopingExceptionCall[];
  /**
   * WHY the calls above are tenant-safe, in prose, referencing `validatedAt` when it is set.
   * Mandatory, enforced here rather than in code review (D-06). This field is the whole point of
   * the list: "Die Ausnahmeliste ist dabei kein Makel, sondern der eigentliche Wert: sie macht die
   * Entscheidung sichtbar, statt sie im Schweigen zu lassen." (Issue #204)
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
  if (isRecord(entry) && typeof entry.file === "string" && typeof entry.handler === "string") {
    return `entry #${index} (${entry.file} — ${entry.handler})`;
  }
  return `entry #${index}`;
}

function describeCall(c: TenantScopingExceptionCall): string {
  return `${c.call}:${c.line}`;
}

/**
 * Structurally and semantically validates a raw (untyped) exceptions payload against the current
 * finding set. Both structural validation (missing/malformed fields, reasonless/whitespace/short
 * reasons, `__tests__` paths) AND staleness (does EVERY listed call still match a current finding?)
 * are checked here — an entry can be well-formed and still invalid because one of the calls it
 * names has moved or been fixed, and a stale call left in place is exactly the "blanket allow
 * waiting to happen" this module exists to prevent.
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

    const { file, handler, validatedAt, calls, reason } = raw;

    if (typeof file !== "string" || file.length === 0) {
      errors.push(`${label}: missing or invalid 'file' (repo-relative path expected)`);
      return;
    }
    if (file.includes("__tests__")) {
      errors.push(
        `${label}: 'file' is under __tests__ — a test-fixture exception means the directory ` +
          `scoping (D-15) is wrong, not that the fixture needs excepting`,
      );
      return;
    }
    if (typeof handler !== "string" || handler.trim().length === 0) {
      errors.push(
        `${label}: missing or invalid 'handler' (expected a human-readable route + method, ` +
          `e.g. "DELETE /:id/hard-delete")`,
      );
      return;
    }
    if (
      validatedAt !== null &&
      (typeof validatedAt !== "number" || !Number.isInteger(validatedAt) || validatedAt < 1)
    ) {
      errors.push(
        `${label}: 'validatedAt' must be a positive integer line number, or null when no tenant ` +
          `check applies at all (e.g. pre-authentication) — see the module header`,
      );
      return;
    }
    if (!Array.isArray(calls) || calls.length === 0) {
      errors.push(
        `${label}: 'calls' must be a non-empty array — every excepted call site MUST be named ` +
          `explicitly, not implied by directory or handler (AC3)`,
      );
      return;
    }

    const parsedCalls: TenantScopingExceptionCall[] = [];
    let callsInvalid = false;
    calls.forEach((c: unknown, callIndex: number) => {
      if (
        !isRecord(c) ||
        typeof c.call !== "string" ||
        c.call.length === 0 ||
        typeof c.line !== "number" ||
        !Number.isInteger(c.line) ||
        c.line < 1
      ) {
        errors.push(
          `${label}: calls[${callIndex}] must be { call: "<model>.<method>", line: <positive integer> }`,
        );
        callsInvalid = true;
        return;
      }
      parsedCalls.push({ call: c.call, line: c.line });
    });
    if (callsInvalid) return;

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

    const staleCalls = parsedCalls.filter(
      (c) => !findings.some((f) => f.file === file && callKey(f) === c.call && f.line === c.line),
    );
    if (staleCalls.length > 0) {
      errors.push(
        `${label}: STALE — ${staleCalls.map(describeCall).join(", ")} no longer match(es) a ` +
          `current finding; the call may have moved (check for a near-miss at a different line) ` +
          `or been fixed. Update or remove it from 'calls' — a stale entry is a blanket allow ` +
          `waiting to happen`,
      );
      return;
    }

    valid.push({
      file,
      handler: handler.trim(),
      validatedAt: validatedAt as number | null,
      calls: parsedCalls,
      reason: reason.trim(),
    });
  });

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, entries: valid };
}

/**
 * Does `call` match a named exception? Matches on `file` + `call` + `line` exactly against any
 * entry's `calls` list. When no exact match exists but an entry lists the SAME `file` + `call` at
 * a DIFFERENT line, that is reported as a near miss rather than `null` — the common case of
 * ordinary code movement (the excepted call shifted a few lines) should read as "update the line
 * number in the exception entry", not as an unexplained finding that looks like a brand-new gap.
 */
export function matchException(
  call: PrismaCall,
  entries: readonly TenantScopingException[],
): { matched: TenantScopingException } | { nearMiss: TenantScopingException } | null {
  const key = callKey(call);

  for (const entry of entries) {
    if (entry.file !== call.file) continue;
    if (entry.calls.some((c) => c.call === key && c.line === call.line)) {
      return { matched: entry };
    }
  }

  for (const entry of entries) {
    if (entry.file !== call.file) continue;
    if (entry.calls.some((c) => c.call === key)) {
      return { nearMiss: entry };
    }
  }

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
