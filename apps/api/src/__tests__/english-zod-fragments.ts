/**
 * Issue #573 (D-13) — fragments of Zod's English default messages (v3 and v4 wording). A validation
 * answer of the API must contain none of them; shared by the unit and the route guard.
 */
export const ENGLISH_ZOD_FRAGMENTS = [
  "Invalid",
  "Expected",
  "expected",
  "Required",
  "Too small",
  "Too big",
  "received",
  "must be",
  "must contain",
  "Unrecognized",
  "characters",
  "String must",
  "Number must",
  "Array must",
] as const;

/** The fragments `text` contains (empty = German only). */
export function englishZodFragmentsIn(text: string): string[] {
  return ENGLISH_ZOD_FRAGMENTS.filter((fragment) => text.includes(fragment));
}
