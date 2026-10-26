/**
 * Audit before/after projection for settings writes (Issue #285, #286, #287).
 *
 * A settings route used to name the audited fields by hand, so every field added to the writable
 * set silently fell out of `oldValue`. Here the writable set is the key set of the value the route
 * is about to write (derived from its Zod schema, never listed again), and only the keys whose
 * value actually changes are recorded, each with its before and its after value - small and fully
 * reconstructable.
 *
 * Secrets never appear in clear text: a masked key records the constant {@link MASKED_VALUE} on
 * both sides plus `<key>Changed: true`, so the trail shows THAT a secret changed, not what it was.
 */
export const MASKED_VALUE = "***";

type DecimalLike = { toNumber(): number };

function isDecimalLike(v: unknown): v is DecimalLike {
  return typeof v === "object" && v !== null && typeof (v as DecimalLike).toNumber === "function";
}

/** Plain JSON-comparable form: Decimal -> number, Date -> ISO string, undefined -> null. */
function plain(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (isDecimalLike(v)) return v.toNumber();
  if (v instanceof Date) return v.toISOString();
  return v;
}

function sameValue(before: unknown, after: unknown): boolean {
  const b = plain(before);
  const a = plain(after);
  if (isDecimalLike(before) && a !== null) return b === Number(a);
  return JSON.stringify(b) === JSON.stringify(a);
}

export interface AuditDiff {
  oldValue: Record<string, unknown>;
  newValue: Record<string, unknown>;
}

/**
 * Diff of `after` (the fields a write sets) against `before` (the stored row, or null when none
 * existed). Keys of `after` with an `undefined` value are not written and therefore not compared.
 */
export function changedFieldsAudit(
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
  options: { maskedKeys?: readonly string[] } = {},
): AuditDiff {
  const masked = new Set(options.maskedKeys ?? []);
  const oldValue: Record<string, unknown> = {};
  const newValue: Record<string, unknown> = {};
  for (const key of Object.keys(after)) {
    if (after[key] === undefined) continue;
    const prev = before ? before[key] : undefined;
    if (sameValue(prev, after[key])) continue;
    if (masked.has(key)) {
      oldValue[key] = MASKED_VALUE;
      newValue[key] = MASKED_VALUE;
      oldValue[`${key}Changed`] = true;
      newValue[`${key}Changed`] = true;
    } else {
      oldValue[key] = plain(prev);
      newValue[key] = plain(after[key]);
    }
  }
  return { oldValue, newValue };
}
