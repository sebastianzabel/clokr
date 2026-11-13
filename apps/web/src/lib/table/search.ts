// Issue #843 (D-843-01 blocks 6/7) - the ONE search normaliser. The Combobox filters through it
// and the table toolbar (block 6) reuses it, so "Ärztin" is found by "ärztin" in both places.

/** Trims the query and folds it to lower case with German rules. */
export function normaliseSearch(value: string): string {
  return value.trim().toLocaleLowerCase("de");
}

/** True when the haystack contains the query; an empty (or blank) query matches everything. */
export function matchesSearch(haystack: string, query: string): boolean {
  const needle = normaliseSearch(query);
  if (needle === "") return true;
  return normaliseSearch(haystack).includes(needle);
}
