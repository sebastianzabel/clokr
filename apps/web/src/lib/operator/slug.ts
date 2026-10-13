// Kurzname (tenant slug) helpers of the create-tenant dialog (Issue #89, D-07a). The API's strict
// schema stays authoritative; `isValidSlug` only mirrors it so the form can tell the operator early.

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SLUG_MIN = 3;
export const SLUG_MAX = 63;

const TRANSLITERATION: Record<string, string> = {
  ä: "ae",
  ö: "oe",
  ü: "ue",
  ß: "ss",
};

/**
 * Suggests a Kurzname from a tenant name: lower case, German umlauts and ß transliterated, every
 * other run of non-alphanumeric characters one hyphen, no leading or trailing hyphen, at most 63
 * characters. The result can still be too short (< 3) - the form then asks for a manual edit.
 */
export function suggestSlug(name: string): string {
  const transliterated = name
    .toLowerCase()
    .replace(/[äöüß]/g, (char) => TRANSLITERATION[char] ?? char);
  // Strip other diacritics (é -> e) after the German rules have claimed theirs.
  const plain = transliterated.normalize("NFD").replace(/[̀-ͯ]/g, "");
  const hyphenated = trimHyphens(plain.replace(/[^a-z0-9]+/g, "-"));
  // Cutting at 63 can leave a trailing hyphen.
  return trimHyphens(hyphenated.slice(0, SLUG_MAX), { leading: false });
}

/** Plain scan instead of an alternation of anchored quantifiers, which backtracks super-linearly. */
function trimHyphens(value: string, { leading = true }: { leading?: boolean } = {}): string {
  let start = 0;
  let end = value.length;
  while (leading && start < end && value[start] === "-") start += 1;
  while (end > start && value[end - 1] === "-") end -= 1;
  return value.slice(start, end);
}

/** Mirrors the API: 3-63 characters of the hyphenated lower-case pattern. */
export function isValidSlug(slug: string): boolean {
  return slug.length >= SLUG_MIN && slug.length <= SLUG_MAX && SLUG_PATTERN.test(slug);
}
