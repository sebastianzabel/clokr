// Issue #854 (D-854-03, D-854-25) - the pure half of Verwalten › Regeln › Monatsabschluss: how the two
// closing sections read their values from `GET /settings/work` and what their save puts on the wire. No
// runes and no `$app` imports on purpose; the section components (`lib/components/admin/monatsabschluss/`)
// own the form state and the request.
//
// These are the SETTINGS that decide when a month may be closed. The close workflow itself (status,
// closing, correcting) stays at Verwalten › Monatsabschluss.

/** The part of `GET /settings/work` the closing sections read. Every field is optional on the wire. */
export interface ClosingConfig {
  closeMonthWithGapsAllowed?: boolean;
  blockMonthCloseOnUnconfirmedBreak?: boolean;
  /** Read only: it is saved on Regeln › Arbeitszeit & Verträge and decides whether blocking can take effect. */
  enforceBreakConfirmation?: boolean;
}

// Type aliases, not interfaces: countChanges/pickSection take `Record<string, unknown>`, which an
// interface (no implicit index signature) does not satisfy.
export type GapsValues = { closeMonthWithGapsAllowed: boolean };
export type GapsField = keyof GapsValues;

/** Closing a month with missing days is allowed unless the company switched it off (stored default: on). */
export function gapsFrom(config: ClosingConfig): GapsValues {
  return { closeMonthWithGapsAllowed: config.closeMonthWithGapsAllowed ?? true };
}

export function gapsWire(values: GapsValues): Record<GapsField, unknown> {
  return { closeMonthWithGapsAllowed: values.closeMonthWithGapsAllowed };
}

export type BreakBlockValues = { blockMonthCloseOnUnconfirmedBreak: boolean };
export type BreakBlockField = keyof BreakBlockValues;

export function breakBlockFrom(config: ClosingConfig): BreakBlockValues {
  return { blockMonthCloseOnUnconfirmedBreak: config.blockMonthCloseOnUnconfirmedBreak ?? false };
}

export function breakBlockWire(values: BreakBlockValues): Record<BreakBlockField, unknown> {
  return { blockMonthCloseOnUnconfirmedBreak: values.blockMonthCloseOnUnconfirmedBreak };
}

/** Whether the Pausen-Bestätigung is on (the precondition for blocking the close, D-854-25). */
export function breakConfirmationOn(config: ClosingConfig): boolean {
  return config.enforceBreakConfirmation ?? false;
}
