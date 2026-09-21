/**
 * The message an error response should SHOW.
 *
 * Its own module, free of `$stores`/`$app` aliases, so it is importable from a unit test —
 * client.ts is not (apps/web/vitest.config.ts registers no `$app/*` alias).
 *
 * The API's error shape is `{ error, message?, details? }` (apps/api/src/app.ts): `error` is the
 * CATEGORY ("Validierungsfehler", "Nicht gefunden"), `message` is the specific reason — for a
 * ZodError it names every failing field, e.g. "holidayRulesValidFromYear: Expected number,
 * received null". Both constructors below used to take `error` and drop `message`, so every
 * validation failure in the whole app surfaced as the bare word "Validierungsfehler" with no
 * field and no clue, while the answer sat unread in `.data`.
 *
 * That is not a cosmetic loss. It cost a real debugging session: saving the DATEV settings
 * failed with "Validierungsfehler" on a field the page does not even display
 * (`holidayRulesValidFromYear`, echoed back inside the full config the page re-sends), and the
 * screen said nothing that pointed there.
 *
 * `message` wins when present; `error` remains the fallback, so a response carrying only a
 * category is unchanged. Both are joined when they differ and neither is redundant, because the
 * category still tells the reader WHAT KIND of failure this is.
 */
export function errorMessage(data: unknown, fallback: string): string {
  const d = data as { error?: unknown; message?: unknown } | null | undefined;
  const category = typeof d?.error === "string" && d.error.trim() ? d.error.trim() : "";
  const detail = typeof d?.message === "string" && d.message.trim() ? d.message.trim() : "";
  if (detail && category && detail !== category) return `${category}: ${detail}`;
  return detail || category || fallback;
}
