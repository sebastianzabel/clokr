// German display labels of the tenant's support-access page (Issue #93, AC-93-7, AC-93-9). Display
// only: every map is keyed by the control value the API sends and no code decides anything from these
// strings. An unknown value (a control value a newer API sends) is shown raw, never hidden. Instants
// are shown in the tenant's time zone that the API returns, never in the browser's.

/** `SupportAccessStatus` as `GET /support-accesses` sends it. */
export type SupportAccessStatus = "ACTIVE" | "EXPIRED" | "ENDED";

export interface SupportAccessItem {
  id: string;
  operatorName: string;
  reason: string;
  startedAt: string;
  expiresAt: string;
  endedAt: string | null;
  endedBy: "OPERATOR" | "TENANT" | null;
  status: SupportAccessStatus;
  readCount: number;
}

export interface SupportAccessRead {
  at: string;
  category: string;
  /** `name` is null for an anonymised person and for an id that no longer resolves. */
  employee: { id: string; name: string | null; anonymized: boolean } | null;
  month: string | null;
  filters: Record<string, unknown> | null;
}

export interface SupportAccessListResponse {
  items: SupportAccessItem[];
  total: number;
  page: number;
  limit: number;
  timezone: string;
}

export interface SupportAccessDetailResponse {
  access: SupportAccessItem;
  reads: SupportAccessRead[];
  timezone: string;
}

export const STATUS_LABELS = {
  ACTIVE: "Aktiv",
  EXPIRED: "Abgelaufen",
  ENDED: "Beendet",
} as const;

export const CATEGORY_LABELS = {
  EMPLOYEES: "Mitarbeitende",
  EMPLOYEE_MONTH: "Monatsansicht",
  CONTRACTS: "Verträge",
  AUDIT_LOG: "Änderungsprotokoll",
} as const;

export const ENDED_BY_LABELS = {
  OPERATOR: "durch den Betreiber",
  TENANT: "durch Ihre Verwaltung",
} as const;

/** The badge recipe (app.css) of a status; an unknown status gets the neutral one. */
const STATUS_BADGE = {
  ACTIVE: "badge badge-yellow",
  EXPIRED: "badge badge-gray",
  ENDED: "badge badge-purple",
} as const;

function labelFor(map: Readonly<Record<string, string>>, value: string): string {
  return Object.hasOwn(map, value) ? map[value] : value;
}

export function statusLabel(status: string): string {
  return labelFor(STATUS_LABELS, status);
}

export function categoryLabel(category: string): string {
  return labelFor(CATEGORY_LABELS, category);
}

/** Who ended the access, empty when nobody did (it ran out or is still running). */
export function endedByLabel(endedBy: string | null): string {
  return endedBy === null ? "" : labelFor(ENDED_BY_LABELS, endedBy);
}

export function statusBadgeClass(status: string): string {
  return Object.hasOwn(STATUS_BADGE, status)
    ? STATUS_BADGE[status as keyof typeof STATUS_BADGE]
    : "badge badge-gray";
}

/**
 * `dd.MM.yyyy, HH:mm` of the instant in the given IANA zone. An unparseable instant or an unknown zone
 * returns the raw value; a missing instant is an em dash.
 */
export function formatInZone(iso: string | null, timezone: string): string {
  if (iso === null) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat("de-DE", {
      timeZone: timezone,
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(date);
  } catch {
    return iso;
  }
}

const MONTH_NAMES = [
  "Januar",
  "Februar",
  "März",
  "April",
  "Mai",
  "Juni",
  "Juli",
  "August",
  "September",
  "Oktober",
  "November",
  "Dezember",
] as const;

/** `2026-09` as „September 2026“; empty for no month, the raw value when it is no month. */
export function formatMonth(month: string | null): string {
  if (month === null) return "";
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!match) return month;
  return `${MONTH_NAMES[Number(match[2]) - 1]} ${match[1]}`;
}

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A stored `YYYY-MM-DD` as `dd.MM.yyyy`; anything else (a tampered or foreign value) is null. */
function dayOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = DAY_PATTERN.exec(value);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : null;
}

/** The window of an audit-log read („01.09.2026 – 30.09.2026“); empty when no day was stored. */
export function formatReadWindow(filters: Record<string, unknown> | null): string {
  if (filters === null) return "";
  const from = dayOf(filters.from);
  const to = dayOf(filters.to);
  if (from && to) return `${from} – ${to}`;
  if (from) return `ab ${from}`;
  if (to) return `bis ${to}`;
  return "";
}
