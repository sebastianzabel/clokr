/**
 * auto-break-plan.ts
 *
 * Issue #511 (AK-4, D-17, D-20) — the ONE decision "which automatic break would this entry get":
 * the regime of the work day, the amount, and the tenant-zone placement. Every writer of an
 * automatic break (manual POST, regular clock-out, NFC clock-out) and the side-effect-free preview
 * of the entry form call it, so a preview can never show a finding for a break the save would have
 * placed (or hide one it would not).
 *
 * The AMOUNT is `getEffectiveBreakDuration` (employee override, tenant default) raised by
 * `autoBreakAmountFor` for a minor; the POSITION is `placeAutoBreak`. The functions it combines are
 * unchanged and keep their own tests — this module only owns the combination.
 *
 * It decides nothing about WHEN an automatic break applies at the call site except for the one rule
 * the create path and the preview share (`autoBreakAppliesOnCreate`): the other call sites (clock-out
 * with existing Break rows, NFC) keep their own, different conditions.
 */
import { isMinorAtDate } from "../absence";
import { getEffectiveBreakDuration } from "./break-effective";
import type { BreakEmployeeShape, BreakTenantConfigShape } from "./break-effective";
import { breakRegimeFor, type BreakRegime } from "./break-regime";
import {
  autoBreakAmountFor,
  placeAutoBreak,
  resolveDefaultBreakStart,
  type AutoBreakSegment,
} from "./place-auto-break";

/** The employee facts the decision reads. */
export type AutoBreakEmployee = BreakEmployeeShape & { birthDate: Date | null | undefined };

/** The tenant facts the decision reads. */
export type AutoBreakTenantConfig = BreakTenantConfigShape & {
  autoBreakEnabled: boolean;
  defaultBreakStart: string | null;
};

/** The automatic break an entry gets: its regime, its total minutes and its placed segments. */
export interface AutoBreakPlan {
  regime: BreakRegime;
  /** Total minutes of the automatic break; equals the summed length of `segments`. */
  amountMin: number;
  segments: AutoBreakSegment[];
}

/**
 * The automatic break of a closed entry, or null when none applies: the tenant has the feature off,
 * no employee is known, the amount is zero, or no conformant placement exists (in which case
 * nothing may be written either).
 */
export function planAutoBreak(input: {
  employee: AutoBreakEmployee | null | undefined;
  tenantConfig: AutoBreakTenantConfig | null | undefined;
  start: Date;
  end: Date;
  /** The work date of the entry; decides whether the employee is a minor that day. */
  entryDate: Date;
  tz: string;
}): AutoBreakPlan | null {
  const { employee, tenantConfig } = input;
  if (!tenantConfig?.autoBreakEnabled || !employee) return null;

  const presenceMin = (input.end.getTime() - input.start.getTime()) / 60000;
  const regime = breakRegimeFor(isMinorAtDate(employee.birthDate, input.entryDate));
  const amountMin = autoBreakAmountFor({
    configuredMin: getEffectiveBreakDuration(employee, tenantConfig, presenceMin),
    presenceMin,
    regime,
  });
  if (amountMin <= 0) return null;

  const segments = placeAutoBreak({
    start: input.start,
    end: input.end,
    amountMin,
    preferredStart: resolveDefaultBreakStart({
      entryStart: input.start,
      hhmm: tenantConfig.defaultBreakStart,
      tz: input.tz,
    }),
    regime,
  });
  if (segments.length === 0) return null;
  return { regime, amountMin, segments };
}

/**
 * The create-path rule shared by the manual POST and the entry-form preview: a NEW closed entry gets
 * an automatic break only when the caller supplied no break slots and no break minutes. (An edit
 * places none: the PUT route never calls `planAutoBreak`.)
 */
export function autoBreakAppliesOnCreate(input: {
  slotCount: number;
  breakMinutes: number;
}): boolean {
  return input.slotCount === 0 && input.breakMinutes === 0;
}
