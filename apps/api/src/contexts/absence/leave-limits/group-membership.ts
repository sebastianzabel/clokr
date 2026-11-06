/**
 * Issue #836 (D-836-05) — which groups a person belongs to on a day. Pure, no I/O.
 *
 * Neither `Employee.classification` nor `RoleAssignment` stores a history or a validity window, and
 * the issue forbids changing either model. Membership is therefore judged from what is stored NOW;
 * the `day` parameter is unused today and is the seam where a later history model plugs in without
 * touching a reader. The limit (no history) is recorded in the ADR Nachtrag.
 */
import type { EmployeeClassification } from "@clokr/db";

export type GroupMemberFacts = {
  classification: EmployeeClassification;
  /** Ids of every stored role assignment of the person, any scope (#539: stored rows only). */
  accessRoleIds: ReadonlySet<string>;
};

/** Always `ALL`, plus the classification group, plus one `ACCESS_ROLE:<id>` per role. */
export function groupMembershipOn(person: GroupMemberFacts, day: string): string[] {
  void day; // seam for a later history model, see header
  const keys = ["ALL", `CLASSIFICATION:${person.classification}`];
  for (const id of person.accessRoleIds) keys.push(`ACCESS_ROLE:${id}`);
  return keys;
}
