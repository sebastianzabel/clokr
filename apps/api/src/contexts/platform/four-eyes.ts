/**
 * Phase 78b (Issue #78) — the four-eyes combination, defined ONCE.
 *
 * A single role that can both change its own holder's own time entries ("eigene Zeiten
 * ändern") AND approve time corrections of other employees ("Zeiten genehmigen") could
 * undermine time recording: the same person records and approves, with separation of duties
 * resting entirely on the runtime self-approval locks (`retro-entry-requests.ts`, `leave.ts`,
 * deliberately NOT permissions — see `permission-catalog.ts`). This module is the ONE place the
 * combination is defined; the role API (`api/roles.ts`) wires a 409 confirmation gate around it,
 * `system-roles.test.ts` checks every system role against it, and any future time-related
 * approval joining half B is added here and nowhere else. No generalized rule engine
 * (ADR 0002, Entscheidung 2) — this is a single, named, closed predicate.
 *
 * The runtime self-approval locks are unaffected by this module: they hold for every role
 * regardless of composition and are tested separately (Phase 78b plan 04).
 */
import type { PermissionKey } from "./permission-catalog";

/**
 * The two halves of the combination. `changeOwnTimes` ("eigene Zeiten ändern"): a role holding
 * either key can create or update its own holder's own time entries. `approveTimes` ("Zeiten
 * genehmigen"): today the only foreign time-related approval. A role "holds the combination" iff
 * it holds at least one key of each half.
 */
export const FOUR_EYES_COMBINATION = {
  changeOwnTimes: ["time-entry:create:EIGENE", "time-entry:update:EIGENE"] as const,
  approveTimes: ["retro-request:approve:ZUGEWIESEN"] as const,
} satisfies Record<string, readonly PermissionKey[]>;

/** True iff `permissions` holds at least one key of each half of the combination. */
export function holdsFourEyesCombination(permissions: readonly string[]): boolean {
  const hasHalfA = FOUR_EYES_COMBINATION.changeOwnTimes.some((key) => permissions.includes(key));
  const hasHalfB = FOUR_EYES_COMBINATION.approveTimes.some((key) => permissions.includes(key));
  return hasHalfA && hasHalfB;
}

/**
 * True iff a save from `before` to `after` newly creates the combination — the transition rule
 * every combination-creating-save guard in `api/roles.ts` evaluates against (D-04). A role that
 * already held the combination, or a save whose result does not hold it, is never a creation.
 */
export function createsFourEyesCombination(
  before: readonly string[],
  after: readonly string[],
): boolean {
  return holdsFourEyesCombination(after) && !holdsFourEyesCombination(before);
}

/** The control value of the 409 body — callers branch on this code, never on the message. */
export const FOUR_EYES_CONFIRMATION_REQUIRED = "FOUR_EYES_CONFIRMATION_REQUIRED" as const;

/** The German user-facing message naming both rights and the consequence (D-05). */
export const FOUR_EYES_CONFIRMATION_MESSAGE =
  "Diese Rolle enthält zugleich „Eigene Zeiten ändern“ (eigene Zeiteinträge anlegen oder ändern) " +
  "und „Zeiten genehmigen“ (Zeitnachträge anderer genehmigen). Wer beides hat, erfasst und " +
  "genehmigt Arbeitszeiten mit derselben Rolle – die Trennung hängt dann allein an der Sperre " +
  "gegen Selbstgenehmigung. Bitte bestätigen Sie diese Zusammenstellung ausdrücklich.";

/**
 * Thrown inside a role-mutation transaction when a save would newly create the combination
 * without `confirm: true`. Throwing rolls back the write and its audit row (D-05). Callers
 * branch on `instanceof FourEyesConfirmationRequiredError`, never on the message text.
 */
export class FourEyesConfirmationRequiredError extends Error {
  constructor() {
    super("Four-eyes confirmation required: this save would newly create the combination");
    this.name = "FourEyesConfirmationRequiredError";
  }
}
