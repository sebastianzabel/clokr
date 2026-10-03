// Issue #451 / #445 addendum (D-09) — the admin Urlaub tab's carry-over reason field.
//
// `carryOverReason`/`carryOverNote` have been accepted by `PUT /settings/vacation/:employeeId`
// since #445, but no UI set them until now. Pure, dependency-free module (no imports from
// $api, $stores, svelte, or any component) — same convention as
// apps/web/src/lib/leave/storno.ts and vacation-balance.ts — so the label/patch/hint logic is
// unit-testable without mounting admin/employees/[id]/+page.svelte.
//
// Why `carryOverReasonPatch` is change-only (#445 D-16 semantics, mirrored here): the API's PUT
// treats an OMITTED `carryOverReason`/`carryOverNote` as "keep the stored value" and an
// EXPLICIT `null` as "remove the protection" (apps/api/src/contexts/absence/api/leave-settings.ts).
// A save handler that always sent the current form value as a plain field would therefore
// silently send `null` the moment an admin merely saved an unrelated change (e.g. `totalDays`)
// on a page that never loaded a reason — exactly the "nothing sent" case this function returns
// `{}` for. `carryOverReasonPatch` compares against the LOADED value (the one last confirmed by
// the server) rather than a hardcoded default, so an unrelated save on this section never
// removes a documented, legally protected carry-over deadline (T-451-26).

export type CarryOverReasonValue = "ILLNESS" | "MATERNITY" | "PARENTAL_LEAVE" | "OTHER";

// Legacy stored value from before Issue #445 — still readable and still protects the deadline
// (apps/api/src/contexts/absence/illness-carryover-guard.ts), but is no longer offered as a
// choice for a NEW save.
const LEGACY_OPERATIONAL_REASON = "OPERATIONAL";

// Order matches the German labels an admin reads top to bottom; the mirror pin in
// __tests__/carry-over-reason.test.ts asserts these VALUES equal
// apps/api/src/contexts/absence/illness-carryover-guard.ts's CARRY_OVER_REASONS literal.
export const CARRY_OVER_REASON_OPTIONS: ReadonlyArray<{
  value: CarryOverReasonValue;
  label: string;
}> = [
  { value: "ILLNESS", label: "Krankheit" },
  { value: "MATERNITY", label: "Mutterschutz" },
  { value: "PARENTAL_LEAVE", label: "Elternzeit" },
  { value: "OTHER", label: "Sonstiges" },
];

/**
 * German display label for a stored `carryOverReason`. Includes the legacy `OPERATIONAL` value
 * (read-only "Altwert") so an existing row never renders blank or crashes the select.
 */
export function carryOverReasonLabel(value: string | null | undefined): string | null {
  if (value == null) return null;
  if (value === LEGACY_OPERATIONAL_REASON) return "Betriebliche Gründe (Altwert)";
  const found = CARRY_OVER_REASON_OPTIONS.find((option) => option.value === value);
  return found ? found.label : null;
}

/**
 * Change-only patch builder (#445 D-16 semantics — see module header). `loaded` is the pair
 * last confirmed by the server (on load, or after the previous successful save); `current` is
 * the form's live state. A key is present in the result only when its value differs from
 * `loaded` — `note` is trimmed and an empty string is treated as `null`, matching the server's
 * own `?.trim() || null` normalisation.
 */
export function carryOverReasonPatch(
  loaded: { reason: string | null; note: string | null },
  current: { reason: string | null; note: string },
): { carryOverReason?: string | null; carryOverNote?: string | null } {
  const patch: { carryOverReason?: string | null; carryOverNote?: string | null } = {};

  if (current.reason !== loaded.reason) {
    patch.carryOverReason = current.reason;
  }

  const trimmedNote = current.note.trim() === "" ? null : current.note.trim();
  if (trimmedNote !== (loaded.note ?? null)) {
    patch.carryOverNote = trimmedNote;
  }

  return patch;
}

/**
 * German hint shown below the Übertragsgrund select, mirroring the server's own validation
 * (apps/api/src/contexts/absence/api/leave-settings.ts) so the admin sees the requirement
 * BEFORE saving, not only after a rejected request:
 *   - OTHER without a note → the note is required (400 on save otherwise).
 *   - any non-ILLNESS reason without a deadline → the deadline is required (400 otherwise).
 *   - ILLNESS without a deadline → not an error; explains the server's 31.03./year+1 default.
 *   - no reason selected → no hint.
 */
export function carryOverReasonHint(
  reason: string | null,
  note: string,
  deadline: string,
): string | null {
  if (reason == null) return null;

  if (reason === "OTHER" && note.trim() === "") {
    return "Bei „Sonstiges“ ist eine Notiz zum Übertrag erforderlich.";
  }
  if (reason !== "ILLNESS" && deadline.trim() === "") {
    return "Für diesen Übertragsgrund ist ein Verfallsdatum erforderlich.";
  }
  if (reason === "ILLNESS" && deadline.trim() === "") {
    return "Ohne Datum gilt der 31.03. des Folgejahres (15 Monate, EuGH C-214/10).";
  }
  return null;
}
