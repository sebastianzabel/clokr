// Issue #854 (D-854-09, AC-2, T-854-45) - the bulk changes of the Personen list. The web adds no
// bulk endpoint: a bulk change is the existing per-person request run one person after the other, so
// every person keeps the reach check, the audit row and the package gate of its own request, and a
// refusal of one person never stops the rest. This module is pure (no store, no request of its
// own): the page hands in the action and the display names.
import { ApiError } from "$api/client";
import type { AssignmentScope } from "$lib/api/roles";

export interface PerPersonFailure {
  id: string;
  /** The server's text (German), or a neutral fallback when the request did not reach the server. */
  message: string;
}

export interface PerPersonResult {
  ok: string[];
  failed: PerPersonFailure[];
}

export type BulkKind = "invitation" | "role";

const FALLBACK_MESSAGE = "Die Anfrage ist fehlgeschlagen.";

function failureMessage(err: unknown): string {
  if (err instanceof ApiError && err.message) return err.message;
  if (err instanceof Error && err.message) return err.message;
  return FALLBACK_MESSAGE;
}

/**
 * Runs `action` for every id, strictly one after the other (the order of the preview), and keeps
 * going after a refusal. Never throws; an empty list does nothing.
 */
export async function runPerPerson(
  ids: readonly string[],
  action: (id: string) => Promise<unknown>,
): Promise<PerPersonResult> {
  const result: PerPersonResult = { ok: [], failed: [] };
  for (const id of ids) {
    try {
      await action(id);
      result.ok.push(id);
    } catch (err) {
      result.failed.push({ id, message: failureMessage(err) });
    }
  }
  return result;
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? `1 ${one}` : `${count} ${many}`;
}

function failureList(result: PerPersonResult, nameOf: (id: string) => string): string {
  return result.failed.map((f) => `${nameOf(f.id)} (${f.message})`).join("; ");
}

/**
 * One German sentence for the one summary toast: what worked, and which persons did not with the
 * server's reason. „3 Einladungen gesendet, 1 nicht: Muster, Max (Text)."
 */
export function bulkSummaryText(
  kind: BulkKind,
  result: PerPersonResult,
  nameOf: (id: string) => string,
): string {
  const done = result.ok.length;
  const failed = result.failed.length;
  if (done === 0 && failed === 0) return "Keine Person ausgewählt.";

  const doneText =
    kind === "invitation"
      ? `${plural(done, "Einladung", "Einladungen")} gesendet`
      : `Rolle bei ${plural(done, "Person", "Personen")} zugewiesen`;

  if (failed === 0) return `${doneText}.`;
  if (done === 0) {
    const none =
      kind === "invitation" ? "Keine Einladung gesendet" : "Die Rolle wurde niemandem zugewiesen";
    return `${none}: ${failureList(result, nameOf)}.`;
  }
  return `${doneText}, ${failed} nicht: ${failureList(result, nameOf)}.`;
}

/** True when the same scope is meant (salon and person lists compare as sets). */
export function sameScope(a: AssignmentScope, b: AssignmentScope): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "TENANT" || b.type === "TENANT") return true;
  const left = a.type === "SALONS" ? a.salonIds : a.employeeIds;
  const right = b.type === "SALONS" ? b.salonIds : b.employeeIds;
  const set = new Set(left);
  return left.length === right.length && right.every((id) => set.has(id));
}

/** True when the person already holds exactly this role with exactly this scope. */
export function alreadyHoldsAssignment(
  held: readonly { accessRoleId: string; scope: AssignmentScope }[],
  choice: { accessRoleId: string; scope: AssignmentScope },
): boolean {
  return held.some(
    (h) => h.accessRoleId === choice.accessRoleId && sameScope(h.scope, choice.scope),
  );
}
