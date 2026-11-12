// Issue #853 (D-853-06, D-853-18, D-853-21) - the pure model of Team › Aufgaben: every open decision of
// the caller as ONE kind of row. No request, no store, no clock: the page feeds it the answers of its
// loaders (already narrowed to the caller's reach by the server) and renders what comes out. Plan 09
// feeds the leave requests and the Zeitnachträge; plan 10 adds the § 9 cases, the Pausenbefunde (the
// caller's own #85 break notices) and the open-task rows of `GET /tasks/open` (missing clock-outs and,
// feature-checked, the Zeitkorrektur of #599) as further `kind` values of the same row shape.
import { safeAppNext } from "$lib/nav/login-next";
import { legacyRedirectTarget } from "$lib/nav/routes";

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
  /** The reason the person gave (the row's context line, in quotes). */
  reason?: string | null;
  createdAt: string;
}

/** What the model reads of a § 9 case (`GET /leave/section9`). */
export interface Section9TaskSource {
  id: string;
  employeeName: string;
  status: string;
  overlapStart: string;
  overlapEnd: string;
  reason?: string | null;
  sickRequest: { startDate: string; endDate: string };
  vacationRequest: { startDate: string; endDate: string };
}

/** What the model reads of a notification (`GET /notifications`). */
export interface NoticeTaskSource {
  id: string;
  type: string;
  title: string;
  message: string;
  link?: string | null;
  createdAt: string;
  dismissedAt?: string | null;
}

/** One task of `GET /tasks/open` (853-18). */
export interface OpenTaskSource {
  type: string;
  id: string;
  employeeId?: string;
  personName: string;
  day: string;
  startTime?: string;
  label: string;
  link: string;
}

/** The answer of `GET /tasks/open`: `types` lists what the endpoint can answer at all (D-853-23). */
export interface OpenTasksAnswer {
  types: readonly string[];
  tasks: readonly OpenTaskSource[];
}

export interface TaskSources {
  leave?: readonly LeaveTaskSource[];
  retro?: readonly RetroTaskSource[];
  section9?: readonly Section9TaskSource[];
  /** The caller's own notifications; only the break notices become rows (D-853-07). */
  notices?: readonly NoticeTaskSource[];
  /** `null`/absent = not loaded or refused: a calm empty source. */
  openTasks?: OpenTasksAnswer | null;
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
  /** Display label of the kind chip when the server worded it (open tasks); else the kind's own. */
  label?: string;
  /** Same-origin app path of the row's „Klären“ / „Korrigieren“ link; `null` = the row has no link. */
  href?: string | null;
  /**
   * The row's one context line under the title (Issue #853-19, prototype „Aufgaben“): a Zeitnachtrag
   * carries the person's reason in quotes. A leave row's line (Resturlaub danach, who else is away)
   * is read per row by the page within the caller's permissions and passed to the row component; it
   * is not part of this pure model. The other kinds' subtitle already is their one line.
   */
  context?: string | null;
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
    context: r.reason?.trim() ? `„${r.reason.trim()}“` : null,
  };
}

/**
 * The target of a Pausenbefund or an open-task link (T-853-36): a stored, server-written path becomes an
 * anchor only when it is a same-origin app path (`safeAppNext`), then an old route file path is mapped to
 * its new URL (`/team/time-entries?...` -> `/team/zeiten?...`) with the query kept. Anything else -> null.
 */
export function breakFindingHref(link: string | null | undefined): string | null {
  const safe = safeAppNext(link);
  if (safe === null) return null;
  const cut = safe.search(/[?#]/);
  const path = cut === -1 ? safe : safe.slice(0, cut);
  const tail = cut === -1 ? "" : safe.slice(cut);
  return (legacyRedirectTarget(path) ?? path) + tail;
}

/** The notification types that are Pausenbefunde (#85): the caller's own, reach-worded break notices. */
export const BREAK_NOTICE_TYPES: readonly string[] = [
  "BREAK_CROSS_SALON_VIOLATION",
  "BREAK_PLACEMENT_VIOLATION",
];

/** The § 9 cases that wait for a decision: AU pending, or rejected (can be reopened). */
const OPEN_SECTION9_STATUSES: readonly string[] = ["AU_PENDING", "REJECTED"];

function section9Row(c: Section9TaskSource): TaskRowModel | null {
  if (!OPEN_SECTION9_STATUSES.includes(c.status)) return null;
  const reason = c.status === "REJECTED" && c.reason ? ` · „${c.reason}“` : "";
  return {
    key: `paragraf9:${c.id}`,
    kind: "paragraf9",
    sourceId: c.id,
    personName: c.employeeName,
    title: c.employeeName,
    subtitle:
      `Urlaub ${fmtTaskDate(c.vacationRequest.startDate)}–${fmtTaskDate(c.vacationRequest.endDate)}` +
      ` · Krank ${fmtTaskDate(c.sickRequest.startDate)}–${fmtTaskDate(c.sickRequest.endDate)}${reason}`,
    // The case has no creation time; the start of the overlap is what makes it wait (the sort key).
    createdAt: c.overlapStart,
    status: c.status === "REJECTED" ? "AU_REJECTED" : "AU_PENDING",
    decided: false,
    typeCode: null,
  };
}

function noticeRow(n: NoticeTaskSource): TaskRowModel | null {
  if (!BREAK_NOTICE_TYPES.includes(n.type) || n.dismissedAt) return null;
  return {
    key: `pausenbefund:${n.id}`,
    kind: "pausenbefund",
    sourceId: n.id,
    // The notice is worded by the server for this reader's reach: its title and message are shown as
    // text, nothing is derived from them.
    personName: n.title,
    title: n.title,
    subtitle: n.message,
    createdAt: n.createdAt,
    status: "OPEN",
    decided: false,
    typeCode: null,
    href: breakFindingHref(n.link),
  };
}

function openTaskRow(t: OpenTaskSource, types: readonly string[]): TaskRowModel | null {
  // Only a type the answer lists is a kind of this list (the D-853-23 feature check).
  if (!types.includes(t.type)) return null;
  if (t.type !== "ausstempeln" && t.type !== "zeitkorrektur") return null;
  const start = t.startTime ? ` · seit ${t.startTime}` : "";
  return {
    key: `${t.type}:${t.id}`,
    kind: t.type,
    sourceId: t.id,
    personName: t.personName,
    title: t.personName,
    subtitle: `${fmtTaskDate(t.day)}${start}`,
    createdAt: `${t.day}T${t.startTime ?? "00:00"}`,
    status: "OPEN",
    decided: false,
    typeCode: null,
    label: t.label,
    href: breakFindingHref(t.link),
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
  for (const c of sources.section9 ?? []) {
    const row = section9Row(c);
    if (row) rows.push(row);
  }
  for (const n of sources.notices ?? []) {
    const row = noticeRow(n);
    if (row) rows.push(row);
  }
  const open = sources.openTasks;
  for (const t of open?.tasks ?? []) {
    const row = openTaskRow(t, open?.types ?? []);
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

/** What decides which kinds the caller is offered (segment and KPI band). */
export interface AvailableKindsInput {
  /** The held-key hints (the API decides): leave approve, retro approve, § 9 read/decide. */
  leave: boolean;
  retro: boolean;
  section9: boolean;
  /** The caller's own break notices: the kind appears only when there are some. */
  breakNoticeCount: number;
  /** `types` of the `GET /tasks/open` answer; empty when it was not loaded or refused. */
  openTaskTypes: readonly string[];
}

/** The kinds the caller sees, in display order. Zeitkorrektur only when the open-task answer lists it. */
export function availableTaskKinds(input: AvailableKindsInput): TaskKind[] {
  const kinds: TaskKind[] = [];
  if (input.leave) kinds.push("urlaub");
  if (input.retro) kinds.push("nachtrag");
  if (input.section9) kinds.push("paragraf9");
  if (input.breakNoticeCount > 0) kinds.push("pausenbefund");
  if (input.openTaskTypes.includes("ausstempeln")) kinds.push("ausstempeln");
  if (input.openTaskTypes.includes("zeitkorrektur")) kinds.push("zeitkorrektur");
  return kinds;
}
