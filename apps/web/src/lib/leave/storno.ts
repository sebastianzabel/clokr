// Quick 260824-ef6 — Storno-Button für die Team-Anträge-Tabelle. Pure, dependency-free
// module (no imports from $api, $stores, svelte, or any component) so the status ×
// isOwn decision matrix and the German dialog/toast copy are unit-testable without
// mounting a component — same convention as
// apps/web/src/lib/components/vocational-school/retroactive.ts.
//
// Drives `DELETE /api/v1/leave/requests/:id` (apps/api/src/routes/leave.ts). That
// endpoint already authorizes ADMIN/MANAGER for any request in their tenant and
// already demands an audited Begründung (quick 260824-cjd) — this module only decides
// WHEN the button appears and WHAT it says. The server remains the sole authority;
// see the plan's threat_model T-EF6-01.
//
// ── Why each branch of the matrix is what it is ────────────────────────────────────
//
// APPROVED (either isOwn) → "request-cancellation":
//   leave.ts transitions APPROVED → CANCELLATION_REQUESTED, never straight to
//   CANCELLED. That transition only *requests* a cancellation — a DIFFERENT manager
//   still has to approve it (leave.ts:711-719 blocks self-approval, :723-726 blocks
//   approval by the person who requested the cancellation). Because of that four-eyes
//   gate, allowing a manager to request cancellation of their OWN approved leave is
//   not a self-approval loophole and not a dead end — it just starts the same
//   two-person flow an employee would trigger on themselves.
//
// PENDING + isOwn → "withdraw":
//   A manager's own PENDING leave request has no other working action today: the
//   existing "Prüfen" (review/approve) flow always 403s on self-approval
//   (leave.ts:711-719), and the review-approval modal already renders that dead end
//   (team/leave/+page.svelte's `leave-approval-modal-self-block`). Offering
//   "Zurückziehen" here mirrors the employee view exactly and closes that gap.
//
// PENDING + foreign → null (no button):
//   A manager killing someone else's pending request should use "Ablehnen" (via the
//   existing "Prüfen" flow), which sets REJECTED + a reviewNote. Storno instead
//   produces CANCELLED, which specifically means "withdrawn by the requester
//   themselves". Offering both here would blur two semantically and legally distinct
//   audit outcomes for the same row.
//
// CANCELLATION_REQUESTED (either isOwn) → null:
//   The API's status guard only accepts PENDING|APPROVED and otherwise returns 409.
//   "Stornierung prüfen" (the existing approval flow for the cancellation itself)
//   already covers this row.
//
// CANCELLED, REJECTED (either isOwn) → null:
//   Terminal states — the API would 409.

export type LeaveStatus =
  | "PENDING"
  | "APPROVED"
  | "REJECTED"
  | "CANCELLED"
  | "CANCELLATION_REQUESTED";

/** "withdraw" → API returns 204 (status → CANCELLED).
 *  "request-cancellation" → API returns 200 (status → CANCELLATION_REQUESTED). */
export type StornoKind = "withdraw" | "request-cancellation";

/** null = no Storno button for this row. See the module doc comment for the full
 * reasoning behind every branch of this matrix. */
export function resolveStornoAction(status: LeaveStatus, isOwn: boolean): StornoKind | null {
  if (status === "APPROVED") return "request-cancellation";
  if (status === "PENDING" && isOwn) return "withdraw";
  return null;
}

export function stornoDialogCopy(kind: StornoKind): {
  buttonLabel: string;
  title: string;
  description: string;
  confirmLabel: string;
} {
  if (kind === "withdraw") {
    return {
      buttonLabel: "Zurückziehen",
      title: "Antrag zurückziehen?",
      description: "Der Antrag wird sofort und endgültig storniert.",
      confirmLabel: "Zurückziehen",
    };
  }
  return {
    buttonLabel: "Stornieren",
    title: "Stornierung beantragen?",
    description:
      "Die Stornierung muss von einer anderen Führungskraft freigegeben werden. Bis dahin " +
      "bleibt der Antrag aktiv — er erscheint weiterhin im Kalender und blockiert die " +
      "Zeiterfassung.",
    confirmLabel: "Stornierung beantragen",
  };
}

export function stornoSuccessToast(kind: StornoKind): string {
  return kind === "withdraw" ? "Antrag zurückgezogen" : "Stornierung beantragt";
}
