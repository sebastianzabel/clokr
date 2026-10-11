/**
 * activity-kind.ts — Issue #81 (D-02).
 *
 * The one home of the activity-kind vocabulary: the display labels and the Zod shapes of the write
 * fields. The German labels are DISPLAY text only and never a control value (CLAUDE.md): code
 * branches on the enum value, never on a label. No Prisma call lives here.
 */
import { z } from "zod";
import { ActivityKind } from "@clokr/db";

/** The one display map of the three kinds (D-02). */
export const ACTIVITY_KIND_LABEL: Readonly<Record<ActivityKind, string>> = {
  UNSPECIFIED: "nicht angegeben",
  PRODUCTIVE: "Produktive Zeit am Kunden",
  SETUP_CLEANING: "Rüst-, Reinigungs- und Vorbereitungszeit",
};

/**
 * The kinds that can carry a share: every generated enum value except UNSPECIFIED. Derived from
 * the enum object, so a later additive enum value needs no edit here.
 */
export const ACTIVITY_SHARE_KINDS: readonly ActivityKind[] = Object.values(ActivityKind).filter(
  (kind) => kind !== ActivityKind.UNSPECIFIED,
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
