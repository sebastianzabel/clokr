/**
 * Saldo chain-link classification — Phase 98 (AUDIT-CHAIN-02).
 *
 * Decide, in code, whether a detected carry-over delta (see
 * `apps/api/src/utils/saldo-chain-integrity.ts`) is a deliberate, documented
 * injection or an unexplained loss.
 *
 * WHY AN ALLOWLIST, NOT "AN AUDITLOG ENTRY EXISTS": mere audit-row presence
 * cannot discriminate. BOTH classes write full, well-formed AuditLog rows
 * with `oldValue`/`newValue`:
 *   - the deliberate injection (`apps/api/scripts/set-opening-balance.ts`,
 *     `action: "UPDATE"`, `newValue.reason: "opening balance from old
 *     time-tracking system"`)
 *   - the destructive paths (`recalculateSnapshots()`'s `"retroactive
 *     recalculation"` SUPERSEDE, and the one-off `SALDO_RECALC_AFTER_SOLL_FIX`
 *     migration script) — both log just as thoroughly as the deliberate act.
 * Presence of a row is not a discriminator; the free-text `reason` is the
 * only usable signal.
 *
 * THE ACCEPTED CONSEQUENCE: a new legitimate injection reason that is not
 * on the list WILL be reported as unexplained until someone adds it here.
 * Noisy-but-safe is deliberate (98-CONTEXT.md, owner-locked) — a denylist
 * fails silent, which is the exact failure mode this phase exists to
 * eliminate.
 *
 * `userId` AND `userAgent` ARE NOT USABLE SIGNALS EITHER: script-driven
 * injections and script-driven destruction both wrote `userId=NULL` in the
 * 2026-08-17 prod forensics.
 *
 * This module performs NO I/O: no Prisma import, nothing async, no database
 * access. Callers fetch the `AuditLog` rows for a chain link's full row-id
 * lineage and pass the extracted reason strings in.
 */
import type { ChainLinkKind } from "./saldo-chain-integrity";

/**
 * ── THE ALLOWLIST ────────────────────────────────────────────────────────────
 * The ONLY AuditLog `newValue.reason` fragments that count as a deliberate,
 * documented carry-over injection. Matching is case-insensitive SUBSTRING.
 * Everything not matched here is reported as UNEXPLAINED — by design.
 *
 * ADDING AN ENTRY: only add reasons written by a human-initiated, deliberate
 * opening-balance/correction action. NEVER add a reason emitted by an automated
 * recompute or a one-off migration script. Known-mechanical reasons that MUST
 * NOT be added (they all changed carryOver values on prod):
 *   - "retroactive recalculation"                              (recalculate-snapshots.ts)
 *   - "v1.8.4 Ø-Methode migration (BAG 9 AZR 406/17)"           (recalculate-snapshots-after-soll-fix.ts)
 *   - "v1.8.9 SHIFT_BASED netto migration (...)"                (recalculate-snapshots-after-shift-netto-fix.ts)
 *   - "v1.8.16 SHIFT_BASED Model B Soll (...)"                  (recalculate-snapshots-after-shift-soll-fix.ts)
 *   - "v1.8.27 Azubi Berufsschultag Monats-Soll double-count fix (single-count)"
 *   - "TZ-duplicate cleanup — 2026-06-08 prod investigation"    (saldo-snapshot-cleanup.ts)
 *   - "bulk fix: bogus pre-tracking reset snapshots leaking carryOver into live saldo"
 */
export const DELIBERATE_CARRYOVER_REASONS: readonly string[] = [
  // apps/api/scripts/set-opening-balance.ts:129 — the canonical operator tool.
  "opening balance from old time-tracking system",
  // Prod ad-hoc restore observed 2026-05-07 (Vor-Tracking-Leistung +100h restore).
  // Deliberately a PREFIX so future amount variants still match.
  "Vor-Tracking-Leistung",
];

export type Classification = "documented" | "unexplained";

export type ClassificationResult = {
  classification: Classification;
  /** "bridge-at-chain-start" | `allowlist:${entry}` | "none" */
  rule: string;
  /** The full AuditLog reason string that matched, or null. */
  matchedReason: string | null;
};

/**
 * Returns the FIRST `DELIBERATE_CARRYOVER_REASONS` entry whose lowercased
 * value is a substring of the lowercased `reason`, or `null` if none match
 * (including for `null`/`undefined`/empty input).
 */
export function matchDeliberateReason(reason: string | null | undefined): string | null {
  if (!reason) return null;
  const lowered = reason.toLowerCase();
  for (const entry of DELIBERATE_CARRYOVER_REASONS) {
    if (lowered.includes(entry.toLowerCase())) return entry;
  }
  return null;
}

/**
 * Extracts `newValue.reason` from each row, preserving input order.
 * Only non-deduplicated, non-empty STRING reasons are kept — the caller
 * reports how many audit rows were seen, so dropping duplicates here would
 * hide corroborating/eroding evidence (see the GT-98w hard case).
 *
 * Every writer in this codebase puts `reason` in `newValue`, never
 * `oldValue` — only `newValue` is inspected.
 */
export function extractAuditReasons(rows: ReadonlyArray<{ newValue: unknown }>): string[] {
  const reasons: string[] = [];
  for (const row of rows) {
    const newValue = row.newValue;
    if (newValue === null || typeof newValue !== "object" || Array.isArray(newValue)) continue;
    const reason = (newValue as Record<string, unknown>).reason;
    if (typeof reason === "string" && reason.length > 0) reasons.push(reason);
  }
  return reasons;
}

/**
 * Classify a chain link's carry-over delta, in this precedence order:
 *
 * 1. A bridge row at the HEAD of a chain is documented by its own shape —
 *    no AuditLog lookup needed. `worked = expected = balance = 0` means it
 *    contributes nothing itself, so its non-zero `carryOver` is by
 *    construction an injected pre-tracking opening value. A bridge NOT at
 *    the head still needs the AuditLog check (below).
 * 2. Otherwise, the first `auditReasons` entry that matches the allowlist
 *    (in input order) wins.
 * 3. Otherwise unexplained.
 */
export function classifyChainLink(
  link: { kind: ChainLinkKind; isFirstLink: boolean },
  auditReasons: readonly string[],
): ClassificationResult {
  if (link.kind === "bridge" && link.isFirstLink === true) {
    return { classification: "documented", rule: "bridge-at-chain-start", matchedReason: null };
  }

  for (const reason of auditReasons) {
    const entry = matchDeliberateReason(reason);
    if (entry !== null) {
      return { classification: "documented", rule: `allowlist:${entry}`, matchedReason: reason };
    }
  }

  return { classification: "unexplained", rule: "none", matchedReason: null };
}
