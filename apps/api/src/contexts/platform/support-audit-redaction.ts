/**
 * Issue #93 (Phase 93b-05, D-17) — the ONE function that decides what of a stored `AuditLog` old/new
 * value an operator may see under a support access.
 *
 * A TYPE allow-list, deliberately not a key deny-list: a deny-list would silently leak the next new
 * free-text field somebody adds to an audited payload (Art. 5 (1)(c) data minimisation, Art. 9 DSGVO —
 * a note or a waived-break reason can carry health data). Kept as stored: numbers, booleans, `null`,
 * numeric strings, ISO dates, ISO timestamps, UUIDs and UPPER_SNAKE control values (enums, codes,
 * action names), plus the whole structure (keys, arrays). Every other string becomes
 * {@link SUPPORT_AUDIT_REDACTED}. The top-level `actor` object of a value (the stamp of an operator or
 * script row) is returned exactly as stored.
 *
 * Numeric strings count as numbers because Prisma serialises Decimal columns as strings. A time-of-day
 * string ("08:00") is NOT on the allow-list and is redacted. Known residue, accepted: an all-caps
 * single-word free text is indistinguishable from an enum value and passes.
 *
 * Leaf module: no runtime imports, so the composition layer can use it through `contexts/platform`.
 */

/** What replaces every string that is not on the allow-list. */
export const SUPPORT_AUDIT_REDACTED = "[ausgeblendet]";

const NUMERIC_STRING = /^-?\d+(?:\.\d+)?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const UPPER_SNAKE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;

const isNumericString = (value: string): boolean => NUMERIC_STRING.test(value);
const isIsoDate = (value: string): boolean => ISO_DATE.test(value);
const isIsoTimestamp = (value: string): boolean => ISO_TIMESTAMP.test(value);
const isUuid = (value: string): boolean => UUID.test(value);
const isUpperSnake = (value: string): boolean => UPPER_SNAKE.test(value);

const TIME_OF_DAY = /^\d{2}:\d{2}(?::\d{2})?$/;

/** Options of {@link redactSupportAuditValue}. */
export interface RedactAuditValueOptions {
  /**
   * Keep "HH:MM" / "HH:MM:SS" strings. Off for the support view (D-17, unchanged); on for the
   * anonymization redaction (Issue #512), where a clock time is a figure of the booking, not text.
   */
  keepTimeOfDay?: boolean;
}

function isAllowedString(value: string, opts: RedactAuditValueOptions): boolean {
  return (
    (opts.keepTimeOfDay === true && TIME_OF_DAY.test(value)) ||
    isNumericString(value) ||
    isIsoDate(value) ||
    isIsoTimestamp(value) ||
    isUuid(value) ||
    isUpperSnake(value)
  );
}

function redactNode(node: unknown, opts: RedactAuditValueOptions): unknown {
  if (typeof node === "string") return isAllowedString(node, opts) ? node : SUPPORT_AUDIT_REDACTED;
  if (Array.isArray(node)) return node.map((child) => redactNode(child, opts));
  if (node !== null && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      out[key] = redactNode(child, opts);
    }
    return out;
  }
  // number, boolean, null, undefined (inside a structure) and anything else JSON cannot hold
  return node;
}

/**
 * Redacts one stored old/new value by type (D-17). Returns a new value; the input is never mutated.
 * `undefined` stays `undefined`. An `actor` object at the top level of `value` is kept as stored.
 */
export function redactSupportAuditValue(
  value: unknown,
  opts: RedactAuditValueOptions = {},
): unknown {
  if (value === undefined) return undefined;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = key === "actor" ? child : redactNode(child, opts);
    }
    return out;
  }
  return redactNode(value, opts);
}
