/**
 * activity-kind.ts — Issue #81 (D-02).
 *
 * The one home of the activity-kind vocabulary (four values: UNSPECIFIED, PRODUCTIVE, SETUP_CLEANING
 * and, since Issue #92, TRAVEL): the display labels and the Zod shapes of the write fields. The German labels are DISPLAY text only and never a control value (CLAUDE.md): code
 * branches on the enum value, never on a label. No Prisma call lives here.
 */
import { z } from "zod";
import { ActivityKind } from "@clokr/db";

/** The one display map of the kinds (D-02; TRAVEL added by Issue #92, D-05). */
export const ACTIVITY_KIND_LABEL: Readonly<Record<ActivityKind, string>> = {
  UNSPECIFIED: "nicht angegeben",
  PRODUCTIVE: "Produktive Zeit am Kunden",
  SETUP_CLEANING: "Rüst-, Reinigungs- und Vorbereitungszeit",
  TRAVEL: "Fahrzeit zwischen Salons",
};

/**
 * The kinds that can carry a share: every generated enum value except UNSPECIFIED and TRAVEL.
 * TRAVEL (Issue #92, D-05) is the kind of a WHOLE travel entry between two salons — it is derived
 * by the API from `travelToSalonId` and is never a share, so the share schema's `.max()` stays at
 * two kinds. Derived from the enum object, so a later additive enum value needs no edit here
 * unless it must be excluded like these two.
 */
export const ACTIVITY_SHARE_KINDS: readonly ActivityKind[] = Object.values(ActivityKind).filter(
  (kind) => kind !== ActivityKind.UNSPECIFIED && kind !== ActivityKind.TRAVEL,
);

/** The entry's own (remainder) kind as sent by a client. */
export const activityKindSchema = z.nativeEnum(ActivityKind);

/**
 * The share list as sent by a client: omitted = unchanged, [] = clear, a list = full replacement.
 * `null` is deliberately not accepted (same convention as `salonId`). The kind rules — no
 * UNSPECIFIED, no duplicate, not the entry's own kind — live in `validateActivityState`, so stored
 * and submitted values are judged by one function.
 */
export const activitySharesSchema = z
  .array(z.object({ kind: z.nativeEnum(ActivityKind), minutes: z.number().int().min(1).max(1440) }))
  .max(ACTIVITY_SHARE_KINDS.length);
