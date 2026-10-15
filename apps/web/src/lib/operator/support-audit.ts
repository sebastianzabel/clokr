// Pure helpers of the support protocol view (Issue #93, D-05(4), D-17, T-93b-39): the window the
// client mirrors from the API, the query values of the page, the flattening of a redacted old/new
// value into key/value rows and the actor label of a row. The server stays the authority for every
// one of them; the client only saves a doomed request and styles what the server already redacted.
import { auditActorLabel, type AuditActorLabel } from "$lib/audit/actor-label";

/** The longest window in calendar days, both ends included (mirror of the API constant). */
export const AUDIT_MAX_WINDOW_DAYS = 92;

/** The default window: this many days back from today. */
const AUDIT_DEFAULT_BACK_DAYS = 30;

/**
 * The constant the API puts in place of every string that is not on its type allow-list (D-17). It is
 * compared only to decide how a value is DRAWN (muted, with a screen-reader hint) - never to decide
 * what the operator may see: that happened on the server.
 */
export const AUDIT_REDACTED_MARKER = "[ausgeblendet]";

const MS_PER_DAY = 86_400_000;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/** `YYYY-MM-DD` of the instant in the browser's zone. */
function localDay(date: Date): string {
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1, 2)}-${pad(date.getDate(), 2)}`;
}

/** The last 30 days up to today, in the browser's zone. */
export function defaultAuditWindow(now: Date = new Date()): { from: string; to: string } {
  const back = new Date(now.getFullYear(), now.getMonth(), now.getDate() - AUDIT_DEFAULT_BACK_DAYS);
  return { from: localDay(back), to: localDay(now) };
}

/** The value when it names a real calendar day (`2026-02-30` does not), otherwise null. */
export function dayFromQuery(value: string | null): string | null {
  if (value === null || !DAY_PATTERN.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return null;
  return value;
}

/** A positive whole page number from the query, otherwise the first page. */
export function pageFromQuery(value: string | null): number {
  if (value === null || !/^[1-9]\d{0,5}$/.test(value)) return 1;
  return Number(value);
}

/**
 * The number of calendar days from `from` to `to`, both ends included; negative when the end lies
 * before the beginning. Null when either end is not a real calendar day.
 */
export function windowLength(from: string, to: string): number | null {
  const start = dayFromQuery(from);
  const end = dayFromQuery(to);
  if (start === null || end === null) return null;
  const diff =
    (new Date(`${end}T00:00:00.000Z`).getTime() - new Date(`${start}T00:00:00.000Z`).getTime()) /
    MS_PER_DAY;
  return diff + 1;
}

/** The sentence that refuses a window before any request, or null when the window may be asked. */
export function windowError(from: string, to: string): string | null {
  const days = windowLength(from, to);
  if (days === null) return "Bitte Beginn und Ende des Zeitraums angeben.";
  if (days < 1) return "Das Ende liegt vor dem Beginn.";
  if (days > AUDIT_MAX_WINDOW_DAYS) {
    return `Der Zeitraum darf höchstens ${AUDIT_MAX_WINDOW_DAYS} Tage umfassen.`;
  }
  return null;
}

/** One line of a flattened old/new value. */
export interface AuditValueRow {
  /** `key`, `key.child`, `list[0]`; empty for a top-level primitive. */
  path: string;
  text: string;
  /** True when the value is the server's redaction marker. */
  redacted: boolean;
}

function primitiveRow(path: string, value: unknown): AuditValueRow {
  if (value === null || value === undefined) return { path, text: "–", redacted: false };
  if (typeof value === "boolean") return { path, text: value ? "Ja" : "Nein", redacted: false };
  if (typeof value === "string") {
    return { path, text: value, redacted: value === AUDIT_REDACTED_MARKER };
  }
  return { path, text: String(value), redacted: false };
}

function collect(path: string, node: unknown, out: AuditValueRow[]): void {
  if (Array.isArray(node)) {
    if (node.length === 0) out.push({ path, text: "leer", redacted: false });
    node.forEach((child, index) => collect(`${path}[${index}]`, child, out));
    return;
  }
  if (node !== null && typeof node === "object") {
    const entries = Object.entries(node as Record<string, unknown>);
    if (entries.length === 0) out.push({ path, text: "leer", redacted: false });
    for (const [key, child] of entries) collect(path === "" ? key : `${path}.${key}`, child, out);
    return;
  }
  out.push(primitiveRow(path, node));
}

/** A stored (already redacted) old or new value as key/value rows; a missing value has none. */
export function flattenAuditValue(value: unknown): AuditValueRow[] {
  if (value === null || value === undefined) return [];
  const out: AuditValueRow[] = [];
  collect("", value, out);
  return out;
}

/**
 * Who a row is shown as. The label is decided by codes: a user id, or the `OPERATOR` type of the
 * stamp the API keeps as stored (D-17). The shared pure helper of the tenant audit view does the
 * operator/system split; the row carries no e-mail, so a user is shown by the word.
 */
export function auditActor(row: { userId: string | null; newValue: unknown }): AuditActorLabel {
  if (row.userId !== null) return { kind: "user", text: "Benutzer" };
  return auditActorLabel({ user: null, newValue: row.newValue });
}
