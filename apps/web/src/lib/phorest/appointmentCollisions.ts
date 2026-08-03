// Phase 87 — appointment-collision pre-check helper (frontend orchestration).
//
// Consumes Plan 01's read-only endpoint
//   GET /api/v1/integrations/phorest/appointment-collisions
// (the web api client already prefixes BASE_URL "/api/v1", so the call path
// here is "/integrations/phorest/appointment-collisions" — NOT "/phorest/...").
//
// The endpoint answers "does this employee already have Phorest customer
// appointments booked in this window?" as a DSGVO-minimized count summary. This
// helper is a warn-only pre-check: it MUST FAIL OPEN. A Phorest/endpoint outage
// or any error returns null so the caller proceeds with its mutation — a
// pre-check must NEVER block a legitimate leave/shift operation (T-87-06).

import { api } from "$api/client";

/**
 * PII-free collision summary. Mirrors the Plan-01 response contract exactly:
 * dates + counts only — never customer names, service types, or appointment ids.
 */
export interface CollisionSummary {
  total: number;
  collisions: { date: string; count: number }[];
  deepLink: string | null;
}

/** Range shape (leave/sick/absence window) XOR shift shape (single day). */
export type CollisionInput = { employeeId: string; from: string; to: string } | { shiftId: string };

/**
 * Pre-check for booked Phorest appointments. Returns the summary on success, or
 * `null` on ANY error (FAIL-OPEN — the caller then proceeds with its mutation).
 */
export async function checkAppointmentCollisions(
  input: CollisionInput,
): Promise<CollisionSummary | null> {
  try {
    const params = new URLSearchParams();
    if ("shiftId" in input) {
      params.set("shiftId", input.shiftId);
    } else {
      params.set("employeeId", input.employeeId);
      params.set("from", input.from);
      params.set("to", input.to);
    }
    return await api.get<CollisionSummary>(
      `/integrations/phorest/appointment-collisions?${params.toString()}`,
    );
  } catch {
    // FAIL-OPEN: never let a pre-check error block a legitimate mutation.
    return null;
  }
}

// ── PII-free German presentation helpers (shared by CollisionWarnBody) ────────

/** Format a "YYYY-MM-DD" collision date as de-DE with a weekday prefix. */
export function formatCollisionDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("de-DE", {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

/** Singular/plural-aware per-date count label ("1 Termin" / "N Termine"). */
export function collisionCountLabel(count: number): string {
  return count === 1 ? "1 Termin" : `${count} Termine`;
}

/**
 * Singular/plural-aware warn intro line. `variant`:
 *  - "range": leave create / approve / on-behalf ("… trotzdem fortfahren?")
 *  - "shift": dated-shift delete ("… Schicht trotzdem entfernen?")
 */
export function collisionIntro(total: number, variant: "range" | "shift"): string {
  if (variant === "shift") {
    return total === 1
      ? "⚠ An diesem Tag ist 1 Kundentermin gebucht — Schicht trotzdem entfernen?"
      : `⚠ An diesem Tag sind ${total} Kundentermine gebucht — Schicht trotzdem entfernen?`;
  }
  return total === 1
    ? "⚠ Im Zeitraum ist 1 Kundentermin gebucht — trotzdem fortfahren?"
    : `⚠ Im Zeitraum sind ${total} Kundentermine gebucht — trotzdem fortfahren?`;
}

/** Non-blocking notice copy for the fail-open path (UI-SPEC copywriting contract). */
export const COLLISION_UNAVAILABLE_TOAST =
  "Terminprüfung derzeit nicht verfügbar — Aktion wurde ohne Prüfung ausgeführt.";
