/**
 * The before/after table of one Protokoll entry (Issue #583, D-854-10).
 *
 * `auditFieldRows()` turns the stored old and new values of an audit row into display rows: the German
 * field label from the shared vocabulary (`labels.ts`, unknown fields read the neutral fallback), the
 * value as text and whether it changed. Values are always TEXT - the page renders them without `{@html}`,
 * and a stored free text appears as stored (its redaction happened at anonymisation time, #512). Pure
 * module: no store, no `$app`, no network.
 */
import { sameSettingValue } from "$lib/settings/section-state";

import { actionLabel, entityLabel, fieldLabel } from "./labels";

export interface AuditFieldRow {
  /** The stored key (a control value; the label is display only). */
  key: string;
  label: string;
  before: string;
  after: string;
  changed: boolean;
}

/** What an absent or null value reads as. */
export const EMPTY_VALUE = "—";

/** Keys that describe the writer, not the changed record (the `actor` stamp of operator and system rows). */
const OMITTED_KEYS: ReadonlySet<string> = new Set(["actor"]);

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function germanDateTime(date: Date): string {
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}, ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/** One stored value as display text. */
export function auditValueText(value: unknown): string {
  if (value === null || value === undefined) return EMPTY_VALUE;
  if (typeof value === "boolean") return value ? "Ja" : "Nein";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    if (ISO_TIMESTAMP.test(value)) {
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) return germanDateTime(date);
    }
    if (ISO_DAY.test(value)) {
      const [y, m, d] = value.split("-");
      return `${d}.${m}.${y}`;
    }
    return value;
  }
  // Objects and arrays: one compact line, never a pretty-printed block.
  try {
    return JSON.stringify(value);
  } catch {
    return EMPTY_VALUE;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * One row per field that appears in the old or the new value (new keys first in stored order, then the keys
 * only the old value had). A side that is not an object (a missing or scalar value) contributes no fields.
 */
export function auditFieldRows(
  entity: string,
  oldValue: unknown,
  newValue: unknown,
): AuditFieldRow[] {
  const before = asRecord(oldValue) ?? {};
  const after = asRecord(newValue) ?? {};
  const keys: string[] = [];
  for (const key of [...Object.keys(after), ...Object.keys(before)]) {
    if (!OMITTED_KEYS.has(key) && !keys.includes(key)) keys.push(key);
  }
  return keys.map((key) => ({
    key,
    label: fieldLabel(entity, key),
    before: auditValueText(before[key]),
    after: auditValueText(after[key]),
    changed: !sameSettingValue(before[key], after[key]),
  }));
}

/**
 * The heading of one entry, composed from the two labels, never from a code: „Zeiteintrag geändert“. An
 * action label that already names the object („Abwesenheit korrigiert“) stands alone; a label of several
 * words that does not („Anmeldung fehlgeschlagen“) reads „<Objekt>: <Aktion>“.
 */
export function auditEntryTitle(action: string, entity: string): string {
  const what = actionLabel(action);
  const object = entityLabel(entity);
  if (what.includes(object)) return what;
  if (/\s/.test(what)) return `${object}: ${what}`;
  return `${object} ${what.charAt(0).toLowerCase()}${what.slice(1)}`;
}
