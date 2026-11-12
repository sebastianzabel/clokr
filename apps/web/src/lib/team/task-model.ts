// Issue #853 (D-853-06, D-853-18, D-853-21) - the pure model of Team › Aufgaben: every open decision of
// the caller as ONE kind of row. No request, no store, no clock: the page feeds it the answers of its
// loaders (already narrowed to the caller's reach by the server) and renders what comes out. Plan 09
// feeds the leave requests and the Zeitnachträge; § 9 cases, break findings and the open-task rows of
// `GET /tasks/open` join in plan 10 as further `kind` values of the same row shape.

/** A kind of task the list can carry. The value is a control value (URL, `data-kind`), never shown. */
export type TaskKind =
  "urlaub" | "nachtrag" | "paragraf9" | "pausenbefund" | "ausstempeln" | "zeitkorrektur";

export interface TaskKindInfo {
  kind: TaskKind;
  /** The German label of the kind (type filter, KPI band). */
  label: string;
}

/**
 * All kinds in display order. „Urlaub“ covers every leave type and a cancellation request; the label
 * of a row's own type comes from the leave type rule, not from the kind. `zeitkorrektur` is the
 * D-853-23 slot: it is shown only when the open-tasks answer lists that type.
 */
export const TASK_KINDS: readonly TaskKindInfo[] = [
  { kind: "urlaub", label: "Urlaub" },
  { kind: "nachtrag", label: "Nachtrag" },
  { kind: "paragraf9", label: "§ 9" },
  { kind: "pausenbefund", label: "Pausenbefund" },
  { kind: "ausstempeln", label: "Ausstempeln fehlt" },
  { kind: "zeitkorrektur", label: "Zeitkorrektur" },
];

/** The kind values of {@link TASK_KINDS}, for the `oneOf` allow-list of the URL state. */
export const TASK_KIND_VALUES: readonly TaskKind[] = TASK_KINDS.map((k) => k.kind);

/** The German label of a kind. */
export function taskKindLabel(kind: TaskKind): string {
  return TASK_KINDS.find((k) => k.kind === kind)?.label ?? kind;
}

// ── Sources ──────────────────────────────────────────────────────────────────

/** What the model reads of a leave request (`GET /leave/requests`). */
export interface LeaveTaskSource {
  id: string;
  typeCode: string;
  status: string;
  employee: { firstName: string; lastName: string };
  startDate: string;
  endDate: string;
  days: number;
  halfDay: boolean;
  createdAt: string;
}

/** What the model reads of a Zeitnachtrag (`GET /retro-entry-requests`). */
export interface RetroTaskSource {
  id: string;
  status: string;
  employee: { firstName: string; lastName: string };
  targetDate: string;
  startTime: string | null;
  endTime: string | null;
  entryAgeInDays?: number;
  createdAt: string;
}

export interface TaskSources {
  leave?: readonly LeaveTaskSource[];
  retro?: readonly RetroTaskSource[];
}

/** The caller of the model supplies the one piece the model must not own. */
export interface TaskOptions {
  /** The day figure of a leave row, e.g. „3 Arbeitstage“: always the shared `leaveDaysLabel`. */
  leaveDays: (request: LeaveTaskSource) => string;
}

/** One row of the list. `title` is the person, so the avatar initials are the person's. */
export interface TaskRowModel {
  /** `<kind>:<sourceId>` - unique over the list. */
  key: string;
  kind: TaskKind;
  sourceId: string;
  personName: string;
  title: string;
  subtitle: string;
  /** ISO timestamp of the request (the sort key). */
  createdAt: string;
  /** The status of the source (`PENDING`, `CANCELLATION_REQUESTED`, `APPROVED`, ...). */
  status: string;
  /** True when the entry is already decided (the „Entschieden“ view). */
  decided: boolean;
  /** Leave type code for the type chip; null for every other kind. */
  typeCode: string | null;
}

// ── Mapping ──────────────────────────────────────────────────────────────────

/** „2026-11-12“ -> „12.11.2026“; anything else is returned as it came. */
export function fmtTaskDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return y && m && d ? `${d}.${m}.${y}` : iso;
}

const OPEN_LEAVE_STATUSES: readonly string[] = ["PENDING", "CANCELLATION_REQUESTED"];
const DECIDED_LEAVE_STATUSES: readonly string[] = ["APPROVED", "REJECTED"];
const DECIDED_RETRO_STATUSES: readonly string[] = ["APPROVED", "REJECTED", "USED"];

function personName(e: { firstName: string; lastName: string }): string {
  return `${e.firstName} ${e.lastName}`;
}

function leaveRow(r: LeaveTaskSource, options: TaskOptions): TaskRowModel | null {
  const open = OPEN_LEAVE_STATUSES.includes(r.status);
  if (!open && !DECIDED_LEAVE_STATUSES.includes(r.status)) return null;
  const name = personName(r.employee);
  return {
    key: `urlaub:${r.id}`,
    kind: "urlaub",
    sourceId: r.id,
    personName: name,
    title: name,
    subtitle: `${fmtTaskDate(r.startDate)} – ${fmtTaskDate(r.endDate)} · ${options.leaveDays(r)}`,
    createdAt: r.createdAt,
    status: r.status,
    decided: !open,
    typeCode: r.typeCode,
  };
}

function retroRow(r: RetroTaskSource): TaskRowModel | null {
  const open = r.status === "PENDING";
  if (!open && !DECIDED_RETRO_STATUSES.includes(r.status)) return null;
  const name = personName(r.employee);
  const times = r.startTime && r.endTime ? ` · ${r.startTime}–${r.endTime}` : "";
  return {
    key: `nachtrag:${r.id}`,
    kind: "nachtrag",
    sourceId: r.id,
    personName: name,
    title: name,
    subtitle: `Eintrag vom ${fmtTaskDate(r.targetDate)}${times} · Alter: ${r.entryAgeInDays ?? "?"} Tage`,
    createdAt: r.createdAt,
    status: r.status,
    decided: !open,
    typeCode: null,
  };
}

/**
 * Oldest first (`createdAt`, then key) - what waits longest is decided first. The decided view lists
 * the newest first, so the latest decisions are on top. Returns a new array.
 */
export function sortTasks(
  rows: readonly TaskRowModel[],
  order: "oldest" | "newest" = "oldest",
): TaskRowModel[] {
  const sign = order === "oldest" ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -sign : sign;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
}

/**
 * Maps the loaded sources to rows. Open and decided entries are both returned (`decided` tells them
 * apart); the page picks the view. An unknown status maps to no row. Sorted oldest first.
 */
export function taskRowsFrom(sources: TaskSources, options: TaskOptions): TaskRowModel[] {
  const rows: TaskRowModel[] = [];
  for (const r of sources.leave ?? []) {
    const row = leaveRow(r, options);
    if (row) rows.push(row);
  }
  for (const r of sources.retro ?? []) {
    const row = retroRow(r);
    if (row) rows.push(row);
  }
  return sortTasks(rows);
}

/** How many rows per kind (every kind is present, 0 when none). */
export function taskCounts(rows: readonly TaskRowModel[]): Record<TaskKind, number> {
  const counts = Object.fromEntries(TASK_KIND_VALUES.map((k) => [k, 0])) as Record<
    TaskKind,
    number
  >;
  for (const row of rows) counts[row.kind] += 1;
  return counts;
}

/** The open or the decided rows, newest first when decided. */
export function rowsForView(
  rows: readonly TaskRowModel[],
  view: "offen" | "entschieden",
): TaskRowModel[] {
  return sortTasks(
    rows.filter((r) => r.decided === (view === "entschieden")),
    view === "offen" ? "oldest" : "newest",
  );
}

/** One kind or all (`"alle"`). */
export function filterByKind(
  rows: readonly TaskRowModel[],
  typ: TaskKind | "alle",
): TaskRowModel[] {
  return typ === "alle" ? [...rows] : rows.filter((r) => r.kind === typ);
}
