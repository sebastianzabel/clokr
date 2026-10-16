/**
 * travel-entry-form.ts
 *
 * Issue #92 (Phase 92b-05, D-06/D-08) — the presentation of a trip between two salons
 * („Fahrzeit zwischen Salons“) on the time-entry pages and on the dashboard: which form the page
 * shows, the request body it sends, and the label a list row carries.
 *
 * Presentation only. The server decides whether a trip is recordable (anchoring between two salon
 * entries, the salons themselves, recorded day breaks, overlap, month lock) and answers a refusal
 * in German text that the page shows verbatim. The entry kind is DERIVED server-side from
 * `travelToSalonId` and immutable; the web never sends it, which is why `travelPayload` has no
 * kind, break or share key (T-92b-24). The control values are the salon ids; the names are served
 * display values and never decide anything.
 *
 * Pure module: no Svelte, no API call, so it is unit-testable without a mounted page.
 */

/**
 * The fields of a `GET /time-entries` row a trip adds. The pages' own row types extend this, so a
 * page never has to name the kind field itself — every kind read goes through `isTravelRow`.
 */
export interface TravelRowFields {
  /** The served entry kind; a trip carries `TRAVEL`. Read only through `isTravelRow`. */
  activityKind?: string | null;
  /** Control value: the ARRIVAL salon of a trip (`salonId` is the departure salon); `null` elsewhere. */
  travelToSalonId?: string | null;
  /** Display name of `travelToSalonId` (also when that salon was deactivated). */
  travelToSalonName?: string | null;
  /** Display name of the entry's own salon — the departure salon of a trip. */
  salonName?: string | null;
}

/** The German texts of the travel form, shared by both time-entry pages. */
export const TRAVEL_TEXTS = {
  switchLabel: "Fahrzeit zwischen Salons",
  from: "Von Salon",
  to: "Nach Salon",
  placeholder: "Bitte wählen",
  hint: "Erfassen Sie die Fahrt ab dem Verlassen des ersten Salons. Der Weg von oder nach Hause ist keine Arbeitszeit.",
  editTitle: "Fahrzeit bearbeiten",
  badge: "Fahrzeit",
  salonsRequired: "Bitte wählen Sie „Von Salon“ und „Nach Salon“.",
  outsideWindow:
    "Eine Fahrzeit außerhalb des Bearbeitungsfensters kann nicht nachträglich beantragt werden.",
} as const;

/** The name shown for a side of the route whose name the server did not serve. */
const ABSENT_SALON_NAME = "anderer Salon";

/** Whether a served row is a trip between two salons. */
export function isTravelRow(
  row: Pick<TravelRowFields, "activityKind"> | null | undefined,
): boolean {
  return row?.activityKind === "TRAVEL";
}

/** „{Von} → {Nach}“ from the served display names. */
export function travelRouteLabel(
  row: Pick<TravelRowFields, "salonName" | "travelToSalonName">,
): string {
  return `${row.salonName || ABSENT_SALON_NAME} → ${row.travelToSalonName || ABSENT_SALON_NAME}`;
}

/** One salon of a select. */
export interface TravelSalonOption {
  id: string;
  name: string;
}

/**
 * The options of the „Nach Salon“ select: the salons offered for „Von Salon“ plus - when a trip
 * is edited - its own arrival salon by the served name if the reach no longer lists it (a
 * deactivated salon), so the form can still show and re-select it. Sorted like the departure list.
 */
export function travelArrivalOptions(
  options: readonly TravelSalonOption[],
  row: Pick<TravelRowFields, "travelToSalonId" | "travelToSalonName"> | null | undefined,
): TravelSalonOption[] {
  const out = options.map((salon) => ({ id: salon.id, name: salon.name }));
  if (
    row?.travelToSalonId &&
    row.travelToSalonName &&
    !out.some((s) => s.id === row.travelToSalonId)
  ) {
    out.push({ id: row.travelToSalonId, name: row.travelToSalonName });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, "de") || a.id.localeCompare(b.id));
}

export interface TravelPayloadInput {
  /** Calendar day, `YYYY-MM-DD`. */
  date: string;
  /** Start as an ISO instant (the page's own conversion of the typed time). */
  start: string;
  /** End as an ISO instant; a trip always has one. */
  end: string;
  /** Von: the departure salon id (sent as `salonId`). */
  fromSalonId: string;
  /** Nach: the arrival salon id (sent as `travelToSalonId`). */
  toSalonId: string;
  /** Sent when given; `null` clears the note on an edit. */
  note?: string | null;
}

/**
 * The body of a POST / PUT of a trip. Exactly date, startTime, endTime, salonId, travelToSalonId
 * and — when given — note. Never a kind, a break, a break total or an activity share: the server
 * derives the kind and refuses a trip with breaks or shares.
 */
export function travelPayload(input: TravelPayloadInput): {
  date: string;
  startTime: string;
  endTime: string;
  salonId: string;
  travelToSalonId: string;
  note?: string | null;
} {
  const body = {
    date: input.date,
    startTime: input.start,
    endTime: input.end,
    salonId: input.fromSalonId,
    travelToSalonId: input.toSalonId,
  };
  return input.note === undefined ? body : { ...body, note: input.note };
}

export type TravelFormMode =
  /** A new entry where the switch „Fahrzeit zwischen Salons“ is offered. */
  | "offer"
  /** An existing trip is edited: the travel form, no switch. */
  | "travel"
  /** The form of any other entry, or no salon options: byte-identical to the ordinary form. */
  | "none";

/**
 * Which form the page shows. `multiEntryUi` is the #64 rule (more than one active salon, more than
 * one reachable) — a single-salon tenant sees no change. `editingRow` is `null` for a new entry.
 * The kind of an existing entry is immutable, so an ordinary row never gets the switch.
 */
export function travelFormMode(
  multiEntryUi: boolean,
  editingRow: Pick<TravelRowFields, "activityKind"> | null | undefined,
): TravelFormMode {
  if (!multiEntryUi) return "none";
  if (!editingRow) return "offer";
  return isTravelRow(editingRow) ? "travel" : "none";
}
