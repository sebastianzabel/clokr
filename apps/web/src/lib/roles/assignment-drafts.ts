/**
 * Issue #580 (D-580-03) — posting the create dialog's role drafts once the person exists, through
 * the existing assignment API and its checks (package gate #624, duplicate 409, reference 404).
 * The person is never rolled back: a refused draft is reported and the admin is handed over to the
 * person's tab „Berechtigungen“.
 */
import { ApiError } from "$api/client";
import { createRoleAssignment, type AccessRole, type AssignmentDraft } from "$lib/api/roles";
import { assignmentLabel, type AssignmentLabelContext } from "$lib/roles/assignment-label";

export interface DraftFailure {
  draft: AssignmentDraft;
  message: string;
}

type Poster = typeof createRoleAssignment;

/**
 * Posts every draft in order, one after the other, and keeps going after a refusal (each
 * assignment is independent and the API decides each). Returns the refused drafts.
 */
export async function postAssignmentDrafts(
  userId: string,
  drafts: AssignmentDraft[],
  post: Poster = createRoleAssignment,
): Promise<DraftFailure[]> {
  const failures: DraftFailure[] = [];
  for (const draft of drafts) {
    try {
      await post({ userId, accessRoleId: draft.accessRoleId, scope: draft.scope });
    } catch (err) {
      failures.push({
        draft,
        message:
          err instanceof ApiError
            ? err.message
            : "Die Anfrage ist fehlgeschlagen. Bitte versuch es noch einmal.",
      });
    }
  }
  return failures;
}

/** A draft on one line, worded like a stored assignment. */
export function draftLabel(
  draft: AssignmentDraft,
  roles: AccessRole[],
  ctx: AssignmentLabelContext,
): string {
  const roleName = roles.find((r) => r.id === draft.accessRoleId)?.name ?? "";
  return assignmentLabel({ roleName, scope: draft.scope }, ctx);
}

/** One message for every refused draft. */
export function draftFailureMessage(items: { label: string; message: string }[]): string {
  const parts = items.map((item) => `${item.label} (${item.message})`);
  return items.length === 1
    ? `Die Person ist angelegt. Diese Rolle wurde nicht zugewiesen: ${parts[0]}`
    : `Die Person ist angelegt. Diese Rollen wurden nicht zugewiesen: ${parts.join("; ")}`;
}

export function draftsSavedMessage(count: number): string {
  return count === 1 ? "Rolle zugewiesen" : "Rollen zugewiesen";
}

/**
 * The person's tab „Zugang“ (roles, account, deletion; the former „Berechtigungen“, Issue #854).
 * The detail page restores its tab from the URL hash (checked against employeeDetailTabs, the old
 * id `#berechtigungen` is an alias) and reads no query parameter.
 */
export function berechtigungenTabHref(employeeId: string): string {
  return `/admin/employees/${encodeURIComponent(employeeId)}#zugang`;
}
