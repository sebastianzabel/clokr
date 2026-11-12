// Issue #854 (D-854-03) - the pure half of Verwalten › Regeln › Arbeitszeit & Verträge: how each
// section reads its values from `GET /settings/work`, which messages its fields show and what its save
// puts on the wire. No runes and no `$app` imports on purpose; the section components
// (`lib/components/admin/arbeitszeit/`) own the form state and the request.
//
// The server stays the authority for every rule (the Zod schema of `PUT /settings/work`); the checks
// here only save a round trip and mirror the bounds the pages always showed.

/** The part of `GET /settings/work` the Arbeitszeit sections read. Every field is optional on the wire. */
export interface WorkConfig {
  autoBreakEnabled?: boolean;
  defaultBreakStart?: string | null;
  defaultBreakOver6h?: number;
  defaultBreakOver9h?: number;
  enforceBreakConfirmation?: boolean;
}

/** Messages keyed by field; an empty or missing entry means the field is fine. */
export type FieldMessages<K extends string> = Partial<Record<K, string>>;

/** The number of fields that carry a message (the SaveBar's error count). */
export function messageCount(messages: Record<string, string | undefined>): number {
  return Object.values(messages).filter((message) => message !== undefined && message !== "")
    .length;
}

// ── Pausen (ArbZG § 4) ───────────────────────────────────────────────────────────────────────────

export const BREAK_OVER_6H_MIN = 30;
export const BREAK_OVER_6H_MAX = 120;
export const BREAK_OVER_9H_MIN = 45;
export const BREAK_OVER_9H_MAX = 180;
export const DEFAULT_BREAK_START = "12:00";

// A type alias, not an interface: countChanges/pickSection take `Record<string, unknown>`, which an
// interface (no implicit index signature) does not satisfy.
export type BreaksValues = {
  autoBreakEnabled: boolean;
  /** `HH:MM`; "" while the field is cleared. */
  defaultBreakStart: string;
  /** Minutes; null while the field is empty. */
  defaultBreakOver6h: number | null;
  defaultBreakOver9h: number | null;
  enforceBreakConfirmation: boolean;
};

export type BreaksField = keyof BreaksValues;

/** The values a stored configuration shows (defaults match the ArbZG floor, Phase 64 BREAK-08). */
export function breaksFrom(config: WorkConfig): BreaksValues {
  return {
    autoBreakEnabled: config.autoBreakEnabled ?? false,
    defaultBreakStart: config.defaultBreakStart ?? DEFAULT_BREAK_START,
    defaultBreakOver6h: config.defaultBreakOver6h ?? BREAK_OVER_6H_MIN,
    defaultBreakOver9h: config.defaultBreakOver9h ?? BREAK_OVER_9H_MIN,
    enforceBreakConfirmation: config.enforceBreakConfirmation ?? false,
  };
}

function outsideRange(value: number | null, min: number, max: number): boolean {
  return value === null || !Number.isFinite(value) || value < min || value > max;
}

export function breaksMessages(values: BreaksValues): FieldMessages<BreaksField> {
  const messages: FieldMessages<BreaksField> = {};
  if (values.autoBreakEnabled && !/^\d{2}:\d{2}$/.test(values.defaultBreakStart)) {
    messages.defaultBreakStart = "Gib die Uhrzeit im Format HH:MM an.";
  }
  if (outsideRange(values.defaultBreakOver6h, BREAK_OVER_6H_MIN, BREAK_OVER_6H_MAX)) {
    messages.defaultBreakOver6h = `Die Pause ab 6 Stunden muss zwischen ${BREAK_OVER_6H_MIN} und ${BREAK_OVER_6H_MAX} Minuten liegen.`;
  }
  if (outsideRange(values.defaultBreakOver9h, BREAK_OVER_9H_MIN, BREAK_OVER_9H_MAX)) {
    messages.defaultBreakOver9h = `Die Pause ab 9 Stunden muss zwischen ${BREAK_OVER_9H_MIN} und ${BREAK_OVER_9H_MAX} Minuten liegen.`;
  }
  return messages;
}

/**
 * The body of the Pausen save, for `pickSection`. The start time is only meaningful while the automatic
 * deduction is on, so switching it off clears it (as the instant toggle always did); the minutes are
 * whole numbers. Callers validate first (`breaksMessages`).
 */
export function breaksWire(values: BreaksValues): Record<BreaksField, unknown> {
  return {
    autoBreakEnabled: values.autoBreakEnabled,
    defaultBreakStart: values.autoBreakEnabled ? values.defaultBreakStart : null,
    defaultBreakOver6h: Math.trunc(values.defaultBreakOver6h ?? BREAK_OVER_6H_MIN),
    defaultBreakOver9h: Math.trunc(values.defaultBreakOver9h ?? BREAK_OVER_9H_MIN),
    enforceBreakConfirmation: values.enforceBreakConfirmation,
  };
}
