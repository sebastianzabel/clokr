import auditLabels from "@clokr/types/audit-labels.json";
import { formatInTimeZone } from "date-fns-tz";
import { CSV_BOM, csvCell } from "../../utils/csv-cell";
import type { AffectedEmployee } from "./audit-log-read";

/**
 * Issue #583 (Phase 854, D-854-11, D-854-23) - the Protokoll as a spreadsheet file.
 *
 * Pure serialisation, no Prisma and no clock: the rows arrive already filtered by the one list
 * assembly (`audit-log-read.ts`), so the file holds exactly what the list shows. Every coded column
 * is stable: the CODE next to its German LABEL, the label read from the same JSON file the web
 * list uses (`packages/types/audit-labels.json`), so both print identical words. Old and new values
 * are NOT exported (the list does not show them either, and they may carry free text, #512).
 *
 * Format as the period report CSV: UTF-8 with BOM, `;` separated, CRLF, every text cell through the
 * shared formula-injection guard (`utils/csv-cell.ts`).
 */

type Dictionary = Readonly<Record<string, string>>;

const data = auditLabels as {
  fallback: string;
  actors: Dictionary;
  actions: Dictionary;
  entities: Dictionary;
};

/** An own entry of the dictionary, never something inherited from `Object.prototype`. */
function lookup(dictionary: Dictionary, code: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(dictionary, code) ? dictionary[code] : undefined;
}

/** The German word of an action code; an unknown code reads the shared fallback. */
export function auditActionLabel(code: string): string {
  return lookup(data.actions, code) ?? data.fallback;
}

/** The German word of an entity code; an unknown code reads the shared fallback. */
export function auditEntityLabel(code: string): string {
  return lookup(data.entities, code) ?? data.fallback;
}

/** The two actors that are not a signed-in user. */
export function auditActorKindLabel(kind: "operator" | "system"): string {
  return data.actors[kind];
}

/** Largest number of rows one export may hold; a larger set must be narrowed by the period. */
export const AUDIT_CSV_MAX_ROWS = 10_000;

/** The nine column titles, in file order. */
export const AUDIT_CSV_HEADER = [
  "Zeitpunkt",
  "Aktion",
  "Aktion (Code)",
  "Objekt",
  "Objekt (Code)",
  "Objekt-ID",
  "Betroffene Person",
  "Personalnummer",
  "Ausgeführt von",
].join(";");

/** `protokoll-<from>-<to>.csv` for `YYYY-MM-DD` bounds. */
export function auditCsvFilename(from: string, to: string): string {
  return `protokoll-${from}-${to}.csv`;
}

/** The subset of a list row the file reads. */
export type AuditCsvRow = {
  createdAt: Date;
  action: string;
  entity: string;
  entityId: string | null;
  user: { email: string } | null;
  newValue: unknown;
  affectedEmployee: AffectedEmployee | null;
};

/** The `type` code of the actor stamp an operator-written row carries; null if there is none. */
function actorType(newValue: unknown): string | null {
  if (typeof newValue !== "object" || newValue === null) return null;
  const actor = (newValue as { actor?: unknown }).actor;
  if (typeof actor !== "object" || actor === null) return null;
  const type = (actor as { type?: unknown }).type;
  return typeof type === "string" ? type : null;
}

/** Who did it: the user's e-mail, else the operator or system word decided by the actor type code. */
function actorText(row: AuditCsvRow): string {
  if (row.user?.email) return row.user.email;
  return auditActorKindLabel(actorType(row.newValue) === "OPERATOR" ? "operator" : "system");
}

/** The CSV file (BOM + header + one line per row, CRLF) for the rows in the given order. */
export function auditLogCsv(rows: readonly AuditCsvRow[], tz: string): Buffer {
  const lines = [AUDIT_CSV_HEADER];
  for (const row of rows) {
    const person = row.affectedEmployee;
    lines.push(
      [
        formatInTimeZone(row.createdAt, tz, "dd.MM.yyyy HH:mm"),
        csvCell(auditActionLabel(row.action)),
        csvCell(row.action),
        csvCell(auditEntityLabel(row.entity)),
        csvCell(row.entity),
        csvCell(row.entityId ?? ""),
        csvCell(person ? `${person.firstName} ${person.lastName}` : ""),
        csvCell(person?.employeeNumber ?? ""),
        csvCell(actorText(row)),
      ].join(";"),
    );
  }
  return Buffer.concat([CSV_BOM, Buffer.from(`${lines.join("\r\n")}\r\n`, "utf8")]);
}
