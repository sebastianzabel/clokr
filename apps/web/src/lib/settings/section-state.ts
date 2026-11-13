// Issue #854 (D-854-04, #878) - pure helpers of the settings pages' per-section SaveBar.
//
// A settings section keeps two plain objects in the page's own `$state`: `snapshot` (what was last
// loaded from or saved to the server) and `values` (what the form currently shows). The section's
// SaveBar is fed by these helpers:
//
//   <SaveBar changes={countChanges(snapshot, values, KEYS)} errors={sectionErrors(errors)} ... />
//
// - discard copies the snapshot back into `values`;
// - save sends `pickSection(values, KEYS)` - exactly the section's own fields, never a spread of a
//   load-time copy of the whole record, so a section cannot overwrite what another section changed
//   (#878);
// - a successful save replaces the snapshot with the server answer;
// - the page sums the counts of its sections into ONE `markUnsaved(pageId, ...)` call (a second
//   registration of the same id would let one section's cleanup disarm the guard of the others).
//
// No runes and no `$app` imports on purpose: the module is a plain unit under test.

/** Equality of two setting values: primitives by value, null and undefined equal, arrays element-wise, plain objects key-wise. */
export function sameSettingValue(a: unknown, b: unknown): boolean {
  if (a == null || b == null) return a == null && b == null;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => sameSettingValue(item, b[i]));
  }
  if (typeof a === "object" || typeof b === "object") {
    if (typeof a !== "object" || typeof b !== "object") return false;
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of keys) {
      if (!sameSettingValue(left[key], right[key])) return false;
    }
    return true;
  }
  return Object.is(a, b);
}

/** The number of `keys` whose value in `values` differs from `snapshot` (the SaveBar's "N Änderungen"). */
export function countChanges<T extends Record<string, unknown>>(
  snapshot: T,
  values: T,
  keys: readonly (keyof T & string)[],
): number {
  let changes = 0;
  for (const key of keys) {
    if (!sameSettingValue(snapshot[key], values[key])) changes += 1;
  }
  return changes;
}

/** A new object holding exactly `keys` of `values` - the own-fields payload of one section. */
export function pickSection<T extends Record<string, unknown>, K extends keyof T & string>(
  values: T,
  keys: readonly K[],
): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const key of keys) out[key] = values[key];
  return out;
}

/** The number of non-empty error strings (the SaveBar's "N Fehler"). */
export function sectionErrors(errors: Readonly<Record<string, string | null | undefined>>): number {
  return Object.values(errors).filter((message) => typeof message === "string" && message !== "")
    .length;
}
