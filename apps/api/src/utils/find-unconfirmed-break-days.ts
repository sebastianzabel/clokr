/**
 * find-unconfirmed-break-days.ts
 *
 * Single source of truth for the "unconfirmed Pflichtpause" detector (BREAK-05).
 *
 * A TimeEntry carries `breakStatus="AUTO"` when Phase 91 auto-inserted a mandatory
 * break (>6h/>9h, § 4 ArbZG) that the employee has not yet confirmed or waived
 * ("durchgearbeitet"). This module is the ONE place that defines "unconfirmed" so
 * the Monatsabschluss status listing, the manual-close 409 block, the auto-close
 * defer (plan 04), and the nudge cron (plan 05) can never drift — mirrors the
 * single-source-of-truth structure established by find-missing-workdays.ts.
 *
 * MASTER GATE (BREAK-05 "Gesamt-Opt-in" / CLAUDE.md no-silent-behavior-change):
 * Phase 91 writes breakStatus="AUTO" UNCONDITIONALLY on every Pflichtpause,
 * regardless of whether a tenant has opted into break confirmation. Without an
 * explicit gate here, every Phase-92 consumer would activate the moment this
 * ships for EVERY tenant. `enforceBreakConfirmation === false` is therefore the
 * FIRST check in every export below — an un-opted tenant always observes `[]`.
 *
 * Exclusions (all three exports):
 *   - isLocked entries are NEVER listed (Pitfall 1) — a closed month is
 *     immutable and un-actionable; surfacing it would be a dead-end nudge and
 *     a completeness check that can never pass.
 *   - MONTHLY_HOURS / FLEXTIME schedules return [] (RESOLVED Q1 — only
 *     daily-target schedules are checked for unconfirmed breaks).
 */

import type { PrismaClient } from "@clokr/db";
import { dateStrInTz } from "./timezone";

// ── Public types ──────────────────────────────────────────────────────────────

/** Minimal shape of a bulk-fetched entry row (close-month-data.ts entriesByEmp). */
export type UnconfirmedBreakEntryRow = {
  date: Date;
  breakStatus?: string | null;
  isLocked?: boolean | null;
};

export type UnconfirmedBreakEntry = {
  id: string;
  date: string; // "YYYY-MM-DD" in tenant TZ
};

export type FindUnconfirmedBreakOpts = {
  employeeId: string;
  monthFirstDay: Date;
  monthLastDay: Date;
  tz: string;
  scheduleType: string;
  enforceBreakConfirmation: boolean;
};

// ── Implementation ────────────────────────────────────────────────────────────

/**
 * Pure funnel — no DB calls, no async.
 *
 * Maps a pre-fetched entriesByEmp row set (now carrying breakStatus + isLocked,
 * per close-month-data.ts Q2) to the sorted, unique list of unconfirmed AUTO
 * days. Used by the status endpoint (N+1-free — reuses the already-bulk-fetched
 * `entries` array).
 */
export function unconfirmedDaysFromEntries(
  entries: UnconfirmedBreakEntryRow[],
  tz: string,
  scheduleType: string,
  enforceBreakConfirmation: boolean,
): string[] {
  // MASTER gate — un-opted tenants see nothing, even with AUTO entries present.
  if (enforceBreakConfirmation === false) return [];

  // RESOLVED Q1 — flexible schedules have no daily Pflichtpause gate.
  if (scheduleType === "MONTHLY_HOURS" || scheduleType === "FLEXTIME") return [];

  const days = new Set<string>();
  for (const e of entries) {
    if (e.breakStatus !== "AUTO") continue;
    if (e.isLocked === true) continue; // Pitfall 1 — closed months are un-actionable
    days.add(dateStrInTz(e.date, tz));
  }

  return Array.from(days).sort((a, b) => a.localeCompare(b));
}

/**
 * DB-aware — the canonical AUTO-entry query. This is the ONLY place the
 * `breakStatus="AUTO" AND isLocked=false` WHERE clause lives. Returns rows
 * carrying `id` (needed downstream for the nudge cron's `relatedId`, plan 05).
 *
 * Used by the manual-close 409 block (single employee, one cheap query — not
 * N+1) and by findUnconfirmedBreakDays below.
 */
export async function findUnconfirmedBreakEntries(
  prisma: PrismaClient,
  opts: FindUnconfirmedBreakOpts,
): Promise<UnconfirmedBreakEntry[]> {
  const { employeeId, monthFirstDay, monthLastDay, tz, scheduleType, enforceBreakConfirmation } =
    opts;

  // MASTER gate — un-opted tenants see nothing, even with AUTO entries present.
  if (enforceBreakConfirmation === false) return [];

  // RESOLVED Q1 — flexible schedules have no daily Pflichtpause gate.
  if (scheduleType === "MONTHLY_HOURS" || scheduleType === "FLEXTIME") return [];

  const rows = await prisma.timeEntry.findMany({
    where: {
      employeeId,
      deletedAt: null,
      isLocked: false, // Pitfall 1 — closed months are un-actionable
      type: "WORK",
      breakStatus: "AUTO",
      date: { gte: monthFirstDay, lte: monthLastDay },
    },
    select: { id: true, date: true },
  });

  return rows
    .map((r) => ({ id: r.id, date: dateStrInTz(r.date, tz) }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * DB-aware convenience — string[] of unconfirmed AUTO days. Inherits the master
 * gate + exclusions from findUnconfirmedBreakEntries with zero duplication.
 * Used by the manual-close 409 block (task 3) and the auto-close defer (plan 04).
 */
export async function findUnconfirmedBreakDays(
  prisma: PrismaClient,
  opts: FindUnconfirmedBreakOpts,
): Promise<string[]> {
  const entries = await findUnconfirmedBreakEntries(prisma, opts);
  return entries.map((e) => e.date);
}
