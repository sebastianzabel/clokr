/**
 * Issue #512 - the ONE place the free text inside the AuditLog old/new values of an anonymized
 * person is redacted (DSGVO Art. 17 against Revisionssicherheit; decision: issue #512, comment
 * "Entscheidung (autonom, im Auftrag des Owners)", ADR 0001-abweichungen Nachtrag Issue #512).
 *
 * Rule: the trail stays complete in WHO (actor stamp, ids), WHEN (createdAt), WHAT (action, entity,
 * entityId, every number, date, id and UPPER_SNAKE control value). Only person-authored free text
 * (an `auditReason`, a note, a correction or cancellation reason) is replaced by "[ausgeblendet]",
 * decided by TYPE through `redactSupportAuditValue()` - never by a key-name deny-list, so the next
 * free-text field somebody audits is covered without a code change. "HH:MM" strings are kept (a
 * clock time is a booking figure). Rows are updated in place, never deleted; a row whose redaction
 * changes nothing is not written.
 *
 * Which rows: (a) rows AUTHORED by the anonymized user (`userId`, so this must run BEFORE the
 * userId -> null step) and (b) rows ABOUT the person whose payload names the employee
 * (`employeeId` at the top level of old/new value - the shape of every audited booking row).
 * The Employee/User rows are already replaced wholesale (COMP-V1814-01) and are skipped here.
 * Known residue: a row about the person that neither carries `employeeId` nor was authored by the
 * person's user keeps its text; `audit-388-anonymized-leftovers.ts` cannot find those either.
 *
 * Counts only, never text: the caller puts `rowsRedacted` into the ANONYMIZE audit.
 */
import type { Prisma } from "@clokr/db";
import { redactSupportAuditValue } from "./support-audit-redaction";

const PAGE = 500;

export interface AuditRedactionResult {
  /** Rows the selection reached. */
  rowsScanned: number;
  /** Rows whose old/new value actually changed and were written. */
  rowsRedacted: number;
}

/** Entities whose rows the anonymization already replaces wholesale. */
const SKIPPED_ENTITIES = ["Employee", "User"];

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export async function redactAuditFreeTextOfPerson(
  tx: Prisma.TransactionClient,
  opts: { employeeId: string; userId: string | null },
): Promise<AuditRedactionResult> {
  const { employeeId, userId } = opts;
  const selectors: Prisma.AuditLogWhereInput[] = [
    { newValue: { path: ["employeeId"], equals: employeeId } },
    { oldValue: { path: ["employeeId"], equals: employeeId } },
  ];
  if (userId) selectors.push({ userId });

  const result: AuditRedactionResult = { rowsScanned: 0, rowsRedacted: 0 };
  let cursor: string | undefined;
  for (;;) {
    const rows = await tx.auditLog.findMany({
      where: { OR: selectors, entity: { notIn: SKIPPED_ENTITIES } },
      select: { id: true, oldValue: true, newValue: true },
      orderBy: { id: "asc" },
      take: PAGE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (rows.length === 0) break;
    for (const row of rows) {
      result.rowsScanned += 1;
      const data: Prisma.AuditLogUpdateInput = {};
      for (const field of ["oldValue", "newValue"] as const) {
        const stored = row[field];
        if (stored === null) continue;
        const redacted = redactSupportAuditValue(stored, { keepTimeOfDay: true });
        if (!sameJson(stored, redacted)) data[field] = redacted as Prisma.InputJsonValue;
      }
      if (Object.keys(data).length > 0) {
        await tx.auditLog.update({ where: { id: row.id }, data });
        result.rowsRedacted += 1;
      }
    }
    cursor = rows[rows.length - 1].id;
    if (rows.length < PAGE) break;
  }
  return result;
}
