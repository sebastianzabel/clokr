// Issue #854 (D-854-03) - the pure half of Verwalten › System › Phorest: how the connection form reads
// `GET /integrations/phorest/config`, which messages its fields show, what its save puts on the wire, and the
// small display rules of the status strip, the staff mapping and the sync runs. No runes and no `$app` imports
// on purpose; the panels (`lib/components/admin/phorest/`) own the form state and the requests.
//
// The server stays the authority for every rule (the Zod `configSchema` of `PUT /integrations/phorest/config`);
// the checks here only save a round trip and mirror the bounds the page always showed.

import { messageCount, type FieldMessages } from "$lib/settings/arbeitszeit";

export { messageCount };

// ── Connection and import (GET/PUT /integrations/phorest/config) ─────────────────────────────────

/** The `GET /integrations/phorest/config` answer. The password is never part of it (write-only). */
export interface PhorestConfig {
  configured: boolean;
  phorestBusinessId: string | null;
  /** The sole active salon's coupling branch (Issue #65, D-19/D-20); null when there is none or several salons. */
  branchId: string | null;
  /** True iff the tenant has exactly one active salon; the branch is coupled per salon otherwise. */
  branchIdEditable: boolean;
  phorestUsername: string | null;
  phorestBaseUrl?: string | null;
  phorestAutoSync: boolean;
  phorestSyncCron: string | null;
  phorestSyncWindowDays: number | null;
  phorestPrepMinutes: number | null;
  phorestWrapupMinutes: number | null;
}

export const DEFAULT_SYNC_CRON = "0 3 * * *";
export const DEFAULT_SYNC_WINDOW_DAYS = 7;

/** Bounds of the Zod schema of the config PUT, named once. */
export const PHOREST_BOUNDS = {
  phorestSyncWindowDays: { min: 1, max: 90, label: "Zeitfenster", unit: "Tage" },
  phorestPrepMinutes: { min: 0, max: 30, label: "Vorbereitungszeit", unit: "Minuten" },
  phorestWrapupMinutes: { min: 0, max: 30, label: "Nachbereitungszeit", unit: "Minuten" },
} as const;

export type PhorestNumberField = keyof typeof PHOREST_BOUNDS;

/** The schedules the automatic sync offers: the select label and the short form of the status strip. */
export const SYNC_CRON_OPTIONS: readonly { value: string; label: string; short: string }[] = [
  { value: "0 3 * * *", label: "Täglich um 03:00", short: "Täglich 03:00" },
  { value: "0 */6 * * *", label: "Alle 6 Stunden", short: "Alle 6 Std." },
  { value: "0 */2 * * *", label: "Alle 2 Stunden", short: "Alle 2 Std." },
  { value: "0 0 * * 1", label: "Wöchentlich (Montag 00:00)", short: "Montags 00:00" },
];

/** The short schedule label of the status strip; a stored expression the select does not offer is „Benutzerdefiniert“. */
export function cronShortLabel(cron: string): string {
  return SYNC_CRON_OPTIONS.find((option) => option.value === cron)?.short ?? "Benutzerdefiniert";
}

// A type alias, not an interface: countChanges/pickSection take `Record<string, unknown>`, which an
// interface (no implicit index signature) does not satisfy.
export type PhorestValues = {
  phorestBusinessId: string;
  /** The coupling branch of the sole active salon; sent only while the field is editable. */
  branchId: string;
  phorestUsername: string;
  /** Write-only: never hydrated from the server, "" = keep the stored password. */
  phorestPassword: string;
  phorestAutoSync: boolean;
  phorestSyncCron: string;
  /** Null while the field is empty. */
  phorestSyncWindowDays: number | null;
  phorestPrepMinutes: number | null;
  phorestWrapupMinutes: number | null;
};
export type PhorestField = keyof PhorestValues;

export function phorestFrom(config: PhorestConfig): PhorestValues {
  return {
    phorestBusinessId: config.phorestBusinessId ?? "",
    branchId: config.branchId ?? "",
    phorestUsername: config.phorestUsername ?? "",
    phorestPassword: "",
    phorestAutoSync: config.phorestAutoSync ?? false,
    phorestSyncCron: config.phorestSyncCron ?? DEFAULT_SYNC_CRON,
    phorestSyncWindowDays: config.phorestSyncWindowDays ?? DEFAULT_SYNC_WINDOW_DAYS,
    phorestPrepMinutes: config.phorestPrepMinutes ?? 0,
    phorestWrapupMinutes: config.phorestWrapupMinutes ?? 0,
  };
}

function outsideBounds(value: number | null, min: number, max: number): boolean {
  return typeof value !== "number" || !Number.isInteger(value) || value < min || value > max;
}

export interface PhorestMessageOptions {
  /** True while the Branch-ID can be edited at all (one active salon, coupling not blocked by the package). */
  branchEditable: boolean;
}

export function phorestMessages(
  values: PhorestValues,
  { branchEditable }: PhorestMessageOptions,
): FieldMessages<PhorestField> {
  const messages: FieldMessages<PhorestField> = {};
  if (values.phorestBusinessId.trim() === "") {
    messages.phorestBusinessId = "Gib die Business-ID ein.";
  }
  if (branchEditable && values.branchId.trim() === "") {
    messages.branchId = "Gib die Branch-ID ein.";
  }
  if (values.phorestUsername.trim() === "") {
    messages.phorestUsername = "Gib den API-Benutzernamen ein.";
  }
  for (const field of Object.keys(PHOREST_BOUNDS) as PhorestNumberField[]) {
    const { min, max, label } = PHOREST_BOUNDS[field];
    if (outsideBounds(values[field], min, max)) {
      messages[field] = `${label}: Gib eine ganze Zahl zwischen ${min} und ${max} ein.`;
    }
  }
  return messages;
}

export interface PhorestWireOptions {
  /** True when the Branch-ID is editable; the branch is sent only then (Issue #65, D-20). */
  branchEditable: boolean;
}

/**
 * What the save puts on the wire. The password goes along only when one was typed (the API keeps the stored
 * one otherwise), and the branch only while exactly one salon is active: with several the API decides per salon.
 * The caller narrows the result to the registry section with `pickSection`.
 */
export function phorestWire(
  values: PhorestValues,
  { branchEditable }: PhorestWireOptions,
): Partial<Record<PhorestField, unknown>> {
  return {
    phorestBusinessId: values.phorestBusinessId.trim(),
    phorestUsername: values.phorestUsername.trim(),
    ...(values.phorestPassword !== "" ? { phorestPassword: values.phorestPassword } : {}),
    phorestAutoSync: values.phorestAutoSync,
    phorestSyncCron: values.phorestSyncCron,
    phorestSyncWindowDays: values.phorestSyncWindowDays,
    phorestPrepMinutes: values.phorestPrepMinutes,
    phorestWrapupMinutes: values.phorestWrapupMinutes,
    ...(branchEditable ? { branchId: values.branchId.trim() } : {}),
  };
}

// ── Sync runs ────────────────────────────────────────────────────────────────────────────────────

/** One row of `GET /integrations/phorest/sync-runs`. A type alias so DataTable accepts it as a row. */
export type PhorestSyncRun = {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  /** RUNNING | SUCCESS | ERROR | SUSPECT */
  status: string;
  created: number;
  updated: number;
  cancelled: number;
  unmapped: number;
  error: string | null;
  /** Shifts skipped for Berufsschule and shifts replaced by the Phorest master (Phase 85.1-03, D-08). */
  skippedVocationalSchool: number;
  replaced: number;
};

export type RunTone = "ok" | "warn" | "bad" | "neutral";

export function runStatusLabel(status: string): string {
  if (status === "SUCCESS") return "Erfolg";
  if (status === "RUNNING") return "Läuft";
  if (status === "SUSPECT") return "Verdächtig";
  return "Fehler";
}

/** SUCCESS good, SUSPECT warn, RUNNING neutral; ERROR and every unknown status read as an error. */
export function runStatusTone(status: string): RunTone {
  if (status === "SUCCESS") return "ok";
  if (status === "SUSPECT") return "warn";
  if (status === "RUNNING") return "neutral";
  return "bad";
}

/** The window of a manual sync: the explicit Von/Bis when both are set, else today up to today plus the window. */
export function syncRange(
  start: string,
  end: string,
  windowDays: number,
  today: Date = new Date(),
): { startDate: string; endDate: string } {
  if (start !== "" && end !== "") return { startDate: start, endDate: end };
  const last = new Date(today);
  last.setDate(last.getDate() + windowDays);
  return {
    startDate: today.toISOString().split("T")[0],
    endDate: last.toISOString().split("T")[0],
  };
}

// ── Staff mapping ────────────────────────────────────────────────────────────────────────────────

/** One entry of `GET /integrations/phorest/staff`. */
export interface PhorestStaffItem {
  phorestStaffId: string;
  name: string;
  email: string | null;
  savedEmployeeId: string | null;
  suggestedEmployeeId: string | null;
}

/** One row of the mapping table. A type alias so DataTable accepts it as a row. */
export type PhorestMappingRow = {
  phorestStaffId: string;
  name: string;
  email: string | null;
  /** The employee chosen in the select; "" = none. Pre-filled with the server's suggestion. */
  selectedEmployeeId: string;
  /** The selection as loaded (or last saved): the baseline of the unsaved count, NOT the saved mapping. */
  baselineEmployeeId: string;
  /** The stored mapping, authoritative. */
  savedEmployeeId: string | null;
  saving: boolean;
};

export function mappingRowFrom(item: PhorestStaffItem): PhorestMappingRow {
  const selected = item.savedEmployeeId ?? item.suggestedEmployeeId ?? "";
  return {
    phorestStaffId: item.phorestStaffId,
    name: item.name,
    email: item.email,
    selectedEmployeeId: selected,
    baselineEmployeeId: selected,
    savedEmployeeId: item.savedEmployeeId ?? null,
    saving: false,
  };
}

export type MappingStatus = "saved" | "suggested" | "none";

export function mappingStatus(row: PhorestMappingRow): MappingStatus {
  if (row.selectedEmployeeId && row.selectedEmployeeId === row.savedEmployeeId) return "saved";
  if (row.selectedEmployeeId) return "suggested";
  return "none";
}

/**
 * The number of rows whose selection differs from the loaded one. A suggestion the server pre-filled is the
 * baseline, so a freshly loaded table is not "unsaved" before anyone touched it.
 */
export function unsavedMappingCount(rows: readonly PhorestMappingRow[]): number {
  return rows.filter((row) => row.selectedEmployeeId !== row.baselineEmployeeId).length;
}

// ── Status strip ─────────────────────────────────────────────────────────────────────────────────

/** What the status strip of the page shows; both panels write to it. */
export interface PhorestStatus {
  configured: boolean;
  /** Result of the last connection test of this visit; null = not tested yet. */
  testOk: boolean | null;
  autoSync: boolean;
  syncCron: string;
  syncWindowDays: number;
  mappedCount: number;
  staffTotal: number;
  latestRun: PhorestSyncRun | null;
}

export function emptyPhorestStatus(): PhorestStatus {
  return {
    configured: false,
    testOk: null,
    autoSync: false,
    syncCron: DEFAULT_SYNC_CRON,
    syncWindowDays: DEFAULT_SYNC_WINDOW_DAYS,
    mappedCount: 0,
    staffTotal: 0,
    latestRun: null,
  };
}

type StripTone = "good" | "bad" | "warn" | "neutral";

export interface StatusItem {
  label: string;
  value: string;
  unit?: string;
  delta?: string;
  deltaTone?: StripTone;
  progress?: { value: number; max: number; label: string };
}

function runTone(status: string): StripTone {
  const tone = runStatusTone(status);
  return tone === "ok" ? "good" : tone;
}

/** The four figures of the status strip, in strip order. */
export function statusItems(status: PhorestStatus): StatusItem[] {
  const unmapped = status.staffTotal - status.mappedCount;
  const run = status.latestRun;
  return [
    {
      label: "Verbindung",
      value: status.configured ? "Konfiguriert" : "Offen",
      delta:
        status.testOk === true
          ? "Zuletzt erfolgreich getestet"
          : status.testOk === false
            ? "Letzter Test fehlgeschlagen"
            : "Noch nicht getestet",
      deltaTone: status.testOk === true ? "good" : status.testOk === false ? "bad" : "neutral",
    },
    {
      label: "Zuordnung",
      value: `${status.mappedCount}/${status.staffTotal}`,
      unit: "Personen",
      progress: {
        value: status.mappedCount,
        max: status.staffTotal || 1,
        label: unmapped > 0 ? `${unmapped} offen` : "vollständig",
      },
    },
    {
      label: "Automatischer Abgleich",
      value: status.autoSync ? "An" : "Aus",
      delta: status.autoSync
        ? cronShortLabel(status.syncCron)
        : `Fenster ${status.syncWindowDays} Tage`,
      deltaTone: status.autoSync ? "good" : "neutral",
    },
    {
      label: "Letzter Lauf",
      value: run ? runStatusLabel(run.status) : "—",
      delta: run ? new Date(run.startedAt).toLocaleString("de-DE") : "Noch kein Lauf",
      deltaTone: run ? runTone(run.status) : "neutral",
    },
  ];
}
