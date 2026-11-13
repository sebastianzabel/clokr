// Issue #850 — the "Hinweise zur Schichtplanung" page shows ONE list instead of three cards.
//
// GET /shifts/conflicts answers three buckets (shifts removed automatically, shifts marked
// because they overlap leave or Berufsschule, weeks with more shift days than the contract
// allows). This module turns them into notices with a date, a person, a reason and one action,
// sorted by date. It only re-shapes; which shift belongs in which bucket stays the API's rule.

import { planningWeekLabel, shortGermanDay } from "./planning-week";

export interface ConflictShift {
  id: string;
  date: string;
  startTime: string;
  endTime: string;
  label: string | null;
  employee: { firstName: string; lastName: string };
  deletedAt: string | null;
  deletedReason: string | null;
  conflictsWithLeave: boolean;
}

export interface WeekOverbookedEntry {
  employeeId: string;
  employeeName: string;
  weekStart: string;
  weekEnd: string;
  contractDays: number;
  leaveDays: number;
  otherAbsenceDays: number;
  scheduledDays: number;
  overbookedBy: number;
}

export interface ConflictsResponse {
  softDeleted: ConflictShift[];
  flagged: ConflictShift[];
  weekOverbooked: WeekOverbookedEntry[];
}

export type NoticeKind = "removed" | "marked" | "week-overbooked";

export type NoticeAction =
  | { type: "restore"; shiftId: string; label: string; doneToast: string }
  | { type: "link"; href: string; label: string };

export interface ShiftNotice {
  key: string;
  kind: NoticeKind;
  /** Calendar day the notice sorts by (YYYY-MM-DD). */
  day: string;
  dateLabel: string;
  person: string;
  /** The shift's time and label, when the notice is about one shift. */
  detail: string | null;
  reason: string;
  action: NoticeAction;
}

/** The kind's short name and the explanation behind (i). */
export const NOTICE_KINDS: Record<NoticeKind, { badge: string; explanation: string }> = {
  removed: {
    badge: "Entfernt",
    explanation:
      "Beim Anlegen eines neuen Berufsschultags werden Schichten an diesem Tag automatisch " +
      "entfernt. Mit „Wiederherstellen“ holst du die Schicht zurück; das wird protokolliert.",
  },
  marked: {
    badge: "Prüfen",
    explanation:
      "Die Schicht überschneidet sich mit genehmigtem Urlaub oder einem Berufsschultag. Prüf, ob " +
      "sie so bleiben soll. „Schicht behalten“ nimmt den Hinweis weg; das wird protokolliert.",
  },
  "week-overbooked": {
    badge: "Woche voll",
    explanation:
      "In dieser Woche sind mehr Schichttage geplant, als der Vertrag nach Urlaub und sonstigen " +
      "Abwesenheiten zulässt. Hier gibt es nichts wiederherzustellen; die Übersicht je Person " +
      "steht im Planungsbedarf.",
  },
};

const WEEKDAYS = ["So.", "Mo.", "Di.", "Mi.", "Do.", "Fr.", "Sa."];

/** "Mo., 9. Nov." for a calendar day. */
export function noticeDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}, ${shortGermanDay(iso)}`;
}

function days(n: number): string {
  return n === 1 ? "1 Tag" : `${n} Tage`;
}

function shiftNotice(s: ConflictShift, kind: "removed" | "marked"): ShiftNotice {
  const day = s.date.slice(0, 10);
  return {
    key: `${kind}:${s.id}`,
    kind,
    day,
    dateLabel: noticeDay(day),
    person: `${s.employee.firstName} ${s.employee.lastName}`,
    detail: `${s.startTime}–${s.endTime}${s.label ? ` · ${s.label}` : ""}`,
    reason:
      kind === "removed"
        ? "Wegen eines neuen Berufsschultags automatisch entfernt."
        : "Überschneidet sich mit Urlaub oder Berufsschule.",
    action:
      kind === "removed"
        ? {
            type: "restore",
            shiftId: s.id,
            label: "Wiederherstellen",
            doneToast: "Schicht wiederhergestellt",
          }
        : {
            type: "restore",
            shiftId: s.id,
            label: "Schicht behalten",
            doneToast: "Hinweis erledigt",
          },
  };
}

function weekNotice(w: WeekOverbookedEntry): ShiftNotice {
  const allowed = Math.max(0, w.contractDays - w.leaveDays - w.otherAbsenceDays);
  return {
    key: `week:${w.employeeId}:${w.weekStart}`,
    kind: "week-overbooked",
    day: w.weekStart,
    dateLabel: planningWeekLabel(w.weekStart, w.weekEnd),
    person: w.employeeName,
    detail: null,
    reason: `${days(w.scheduledDays)} geplant, laut Vertrag ${days(allowed)} möglich – ${days(w.overbookedBy)} zu viel.`,
    action: { type: "link", href: "/shifts/planning", label: "Zum Planungsbedarf" },
  };
}

/** All notices of a response in one list, by day; on the same day removed, marked, then weeks. */
export function buildShiftNotices(res: ConflictsResponse): ShiftNotice[] {
  const order: Record<NoticeKind, number> = { removed: 0, marked: 1, "week-overbooked": 2 };
  return [
    ...res.softDeleted.map((s) => shiftNotice(s, "removed")),
    ...res.flagged.map((s) => shiftNotice(s, "marked")),
    ...res.weekOverbooked.map(weekNotice),
  ].sort(
    (a, b) =>
      a.day.localeCompare(b.day) ||
      order[a.kind] - order[b.kind] ||
      a.person.localeCompare(b.person, "de"),
  );
}
