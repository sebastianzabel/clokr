/**
 * Phase 99 (OB-04) — Migration: move each documented opening balance out of an
 * unexplained `SaldoSnapshot.carryOver` jump and into its own `OpeningBalance` row.
 *
 * DRY-RUN IS THE DEFAULT. `--apply` is an explicit opt-in write.
 *
 * Deliberate contrast with `audit-saldo-chain-integrity.ts` (Phase 98), where `--apply`
 * is forbidden outright: there the tool is a pure detector and must never write. HERE
 * writing is the entire purpose of the script, so the flag exists — but it must never be
 * the default, and it must never run without `--actor-id`. Do not "harmonise" the two
 * scripts later; the asymmetry is intentional.
 *
 * THE SCRIPT WRITES ONLY `OpeningBalance` AND `AuditLog` ROWS. Never a `SaldoSnapshot`.
 * It does not re-close a month, does not recompute a balance, does not supersede a
 * snapshot. Seeding the chain head changes exactly ONE input to the carry-over chain
 * identity (see the zero-drift argument above `classifyCandidate` below); every other
 * link's stored value, and therefore its delta, is left completely untouched. This file's
 * own invariant: a grep for `saldoSnapshot.(update|create|delete|updateMany|deleteMany)`
 * in this file must return nothing.
 *
 * ANY employee classified `needs_review` aborts the ENTIRE run — nothing is written, for
 * nobody, not even the employees who ARE eligible. A migration that writes past something
 * it does not understand is exactly the failure this milestone exists to end (99-CONTEXT.md,
 * locked decision D-01).
 *
 * Run:
 *   DATABASE_URL=... pnpm --filter @clokr/api exec tsx scripts/migrate-opening-balances.ts \
 *     --tenant-id <uuid> | --all-tenants \
 *     [--apply --actor-id <uuid>]
 *
 * Exit codes:
 *   0 — nothing to migrate, or every eligible candidate applied successfully
 *   1 — argv/DATABASE_URL/DB failure
 *   2 — one or more employees classified needs_review — nothing written
 */
import type { ChainLink } from "../src/utils/saldo-chain-integrity";
import { matchDeliberateReason } from "../src/utils/saldo-chain-classification";

// ── Part A: exported pure helpers (DB-free, unit-testable) ────────────────────

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_NEEDS_REVIEW = 2;

/** Truncated, non-identifying id for output. NEVER print names or employee numbers (DSGVO). */
export function truncId(id: string): string {
  return id.slice(0, 8);
}

export type OpeningBalanceSourceValue = "MIGRATED_FROM_SNAPSHOT" | "RECONSTRUCTED";

export type NeedsReviewBlocker =
  | "delta_not_at_chain_head"
  | "multiple_deltas"
  | "duplicate_month_links";

export type EligibleCandidate = {
  status: "eligible";
  headRowId: string;
  headPeriodStart: Date;
  monthLabel: string;
  minutes: number;
  reason: string;
  source: OpeningBalanceSourceValue;
  /** The verbatim AuditLog reason string that matched the allowlist, or null if RECONSTRUCTED. */
  matchedAuditReason: string | null;
  /** No ticket/document reference is recoverable from the AuditLog reason strings on record
   *  today — always null. Kept as a field (not omitted) so the OpeningBalance.evidenceRef
   *  column has an explicit, honest source rather than being silently forgotten. */
  evidenceRef: string | null;
  /** true when the head link is a bridge row: recalculateSnapshots()'s getCarryOverBase()
   *  skips bridge rows before the OpeningBalance seed is even consulted, so the bridge
   *  snapshot stays the effective carrier and this OpeningBalance row is documentation
   *  only. Still zero-drift — the operator must be told, not quietly given a row that
   *  does nothing. */
  carrierRemainsBridgeSnapshot: boolean;
};

export type NeedsReviewCandidate = {
  status: "needs_review";
  blocker: NeedsReviewBlocker;
  message: string;
};

export type NotACandidate = { status: "not_a_candidate" };

export type ClassifyCandidateResult = EligibleCandidate | NeedsReviewCandidate | NotACandidate;

/**
 * THE ZERO-DRIFT ARGUMENT — this is the entire safety case for this migration, and it
 * must not live only in a plan file.
 *
 * `walkSaldoChain` (Phase 98, apps/api/src/utils/saldo-chain-integrity.ts) computes each
 * link's `delta` from STORED values only, threading the PREVIOUS row's STORED `carryOver`
 * forward as the next link's `carryOverIn`. Seeding the chain head with an `OpeningBalance`
 * of `M` changes exactly ONE input anywhere in the chain: the head link's `carryOverIn`,
 * from `0` to `M` (via `getCarryOverBase()`, apps/api/src/utils/carry-over-base.ts). That
 * reduces the head link's delta by exactly `M` and leaves every OTHER link's delta
 * completely untouched, because every other link's `carryOverIn` is threaded from a STORED
 * value that this migration never writes.
 *
 * Therefore: "after inserting the opening balance, every link's delta is 0" is true IF AND
 * ONLY IF the head link's delta is exactly `M` and every other link's delta is ALREADY 0.
 * That reduces the zero-drift assertion to a purely structural check over the already-
 * computed `ChainLink[]`: exactly one non-zero delta, and it sits on the first link.
 * No database write, no recompute, no simulation is needed to prove it — the walk itself
 * is the proof.
 */
export function classifyCandidate(
  links: readonly ChainLink[],
  auditReasonsByRowId: ReadonlyMap<string, readonly string[]>,
): ClassifyCandidateResult {
  if (links.length === 0) return { status: "not_a_candidate" };

  // An unwalkable chain (two active rows for one month) cannot be proven zero-drift by
  // construction — it fails BEFORE the delta count is even considered.
  if (links.some((l) => l.kind === "duplicate_month")) {
    return {
      status: "needs_review",
      blocker: "duplicate_month_links",
      message:
        "Die Kette enthält mehrere aktive Zeilen für denselben Monat und ist daher nicht " +
        "durchlaufbar. Zuerst scripts/cleanup-tz-duplicate-snapshots.ts (dry-run) ausführen, " +
        "danach diese Migration erneut versuchen.",
    };
  }

  const nonZero = links.filter((l) => l.delta !== 0);

  if (nonZero.length === 0) {
    // Already zero-drift end to end — nothing to migrate. Not an error.
    return { status: "not_a_candidate" };
  }

  if (nonZero.length > 1) {
    return {
      status: "needs_review",
      blocker: "multiple_deltas",
      message:
        `Die Kette enthält ${nonZero.length} nicht erklärte Abweichungen statt genau einer ` +
        "am Kettenanfang. Ein einzelner Eröffnungssaldo kann diese Kette nicht sicher " +
        "reproduzieren — manuelle Prüfung erforderlich.",
    };
  }

  const [only] = nonZero;

  if (!only.isFirstLink) {
    return {
      status: "needs_review",
      blocker: "delta_not_at_chain_head",
      message:
        `Die einzige nicht erklärte Abweichung liegt in Monat ${only.monthLabel}, nicht am ` +
        "Kettenanfang. Ein am Kettenanfang gesetzter Eröffnungssaldo würde jeden früheren " +
        "Monat verschieben und kann diese Abweichung nicht reproduzieren.",
    };
  }

  // ── Zero-drift head case: eligible. Provenance is reconstructed from AuditLog, ──────
  // including superseded predecessors (the caller passes lineage-wide reasons keyed to
  // this row id — see the CLI wiring in Part B).
  const reasons = auditReasonsByRowId.get(only.rowId) ?? [];
  let matchedReason: string | null = null;
  for (const reason of reasons) {
    if (matchDeliberateReason(reason) !== null) {
      matchedReason = reason;
      break;
    }
  }

  const carrierRemainsBridgeSnapshot = only.kind === "bridge";

  if (matchedReason !== null) {
    return {
      status: "eligible",
      headRowId: only.rowId,
      headPeriodStart: only.periodStart,
      monthLabel: only.monthLabel,
      minutes: only.delta,
      // Carried onto the row VERBATIM — the operator-authored reason as it was written,
      // not a paraphrase and not the allowlist entry that matched it.
      reason: matchedReason,
      source: "MIGRATED_FROM_SNAPSHOT",
      matchedAuditReason: matchedReason,
      evidenceRef: null,
      carrierRemainsBridgeSnapshot,
    };
  }

  // Nothing recoverable. Honest, per-candidate reconstruction — NEVER a blanket reason
  // shared across employees (99-CONTEXT.md, locked decision). The row id, month and amount
  // make every RECONSTRUCTED reason distinguishable from every other one.
  return {
    status: "eligible",
    headRowId: only.rowId,
    headPeriodStart: only.periodStart,
    monthLabel: only.monthLabel,
    minutes: only.delta,
    reason:
      `Eröffnungssaldo aus dem Alt-System, übernommen aus SaldoSnapshot ${truncId(only.rowId)} ` +
      `(Monat ${only.monthLabel}, ${only.delta} Min.). Die ursprüngliche Begründung konnte im ` +
      "AuditLog nicht rekonstruiert werden — der Wert ist real, seine Herkunft ist jedoch nur " +
      "unvollständig dokumentiert.",
    source: "RECONSTRUCTED",
    matchedAuditReason: null,
    evidenceRef: null,
    carrierRemainsBridgeSnapshot,
  };
}

/** One printable report line per employee, Phase 98 style. */
export function formatCandidateLine(employeeId: string, result: ClassifyCandidateResult): string {
  const emp = truncId(employeeId);
  if (result.status === "not_a_candidate") {
    return `[skip        ] emp=${emp} — chain already zero-drift, nothing to migrate`;
  }
  if (result.status === "needs_review") {
    return `[NEEDS REVIEW] emp=${emp} blocker=${result.blocker} — ${result.message}`;
  }
  const bridgeFlag = result.carrierRemainsBridgeSnapshot
    ? " carrierRemainsBridgeSnapshot=true"
    : "";
  return (
    `[eligible    ] emp=${emp} month=${result.monthLabel} row=${truncId(result.headRowId)} ` +
    `minutes=${result.minutes} source=${result.source} reason="${result.reason}"${bridgeFlag}`
  );
}

/** 0 nothing to do / all applied; 2 one or more employees need review (nothing written). */
export function exitCodeFor(counts: { needsReview: number }): number {
  return counts.needsReview > 0 ? EXIT_NEEDS_REVIEW : EXIT_OK;
}
