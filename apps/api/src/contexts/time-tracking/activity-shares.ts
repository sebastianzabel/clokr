/**
 * activity-shares.ts — Issue #81 (D-05).
 *
 * The ONE place the share rules live. Callers (wired in later plans): `PUT /time-entries/:id`,
 * `POST /time-entries` (with the predicted automatic break, D-18), `POST /time-entries/:id/breaks`,
 * `PATCH /time-entries/:id/revalidate` and the retro approval with a manager correction. None of
 * them rebuilds a rule inline.
 *
 * D-05: the sum of the shares may not exceed the entry's working minutes. It is enforced on write
 * and never clamped or repaired afterwards — a violation answers 409 and the entry stays as it was.
 * The working minutes come only from `entryDurations()`; there is no second formula here. Shares
 * exist only on a closed entry: a share is an allocation of recorded working time, and an open
 * entry has none yet.
 *
 * Pure: no Prisma call. The nested-write builders return plain objects the route passes to
 * `timeEntry.create/update`, so the shares change atomically with the entry row.
 */
import type { ActivityKind } from "@clokr/db";
import type { ActivityShareInput } from "./activity-minutes";
import { entryDurations } from "./entry-durations";

// ── 400: a malformed share list ───────────────────────────────────────────────────────────────
const SHARE_UNSPECIFIED_BODY = {
  error: "Ein Tätigkeitsanteil braucht eine bestimmte Tätigkeitsart.",
} as const;
const SHARE_MINUTES_BODY = {
  error: "Ein Tätigkeitsanteil braucht ganze Minuten größer als null.",
} as const;
const SHARE_DUPLICATE_BODY = {
  error: "Jede Tätigkeitsart darf höchstens einen Anteil haben.",
} as const;
const SHARE_OWN_KIND_BODY = {
  error: "Ein Anteil darf nicht die Tätigkeitsart des Eintrags selbst haben.",
} as const;

// ── 409: the share list does not fit the entry ────────────────────────────────────────────────
const SHARE_OPEN_ENTRY_BODY = {
  error: "Tätigkeitsanteile sind nur an einem abgeschlossenen Eintrag möglich.",
} as const;
const SHARE_SUM_MESSAGE = "Die zugeordnete Tätigkeitszeit übersteigt die Arbeitszeit des Eintrags.";

/** Absorbs the float noise of `ms / 60000` so a share equal to the working minutes passes. */
const SUM_EPSILON = 1e-6;

/** The state an activity write would leave behind, as the validator judges it. */
export type ActivityState = {
  kind: ActivityKind;
  shares: readonly ActivityShareInput[];
  startTime: Date;
  endTime: Date | null;
  breakMinutes: number;
};

export type ActivityValidation =
  | { ok: true }
  | { ok: false; status: 400 | 409; body: { error: string; maxShareMinutes?: number } };

/**
 * Judges the activity state an entry would have after a write.
 *
 * - `sharesWritten`: the request itself carries a share list (also an empty one).
 * - `wasClosed`: the entry was closed before this write (false on create and for an entry that was
 *   already open).
 *
 * An open entry with shares is rejected when the shares are written now or when a closed entry is
 * being reopened. An entry that was already open may keep dormant shares (a clock re-open leaves
 * them behind): they contribute 0 and are judged again when the entry is closed.
 *
 * The sum is compared with a tiny epsilon because the working minutes are an exact float (a
 * millisecond-precision row is not a whole number of minutes); `maxShareMinutes` is the whole
 * minutes of working time, so a client can show the limit.
 */
export function validateActivityState(
  state: ActivityState,
  ctx: { sharesWritten: boolean; wasClosed: boolean },
): ActivityValidation {
  const seen = new Set<ActivityKind>();
  for (const share of state.shares) {
    if (share.kind === "UNSPECIFIED") {
      return { ok: false, status: 400, body: SHARE_UNSPECIFIED_BODY };
    }
    if (!Number.isInteger(share.minutes) || share.minutes < 1) {
      return { ok: false, status: 400, body: SHARE_MINUTES_BODY };
    }
    if (seen.has(share.kind)) {
      return { ok: false, status: 400, body: SHARE_DUPLICATE_BODY };
    }
    seen.add(share.kind);
    if (share.kind === state.kind) {
      return { ok: false, status: 400, body: SHARE_OWN_KIND_BODY };
    }
  }

  if (state.shares.length === 0) return { ok: true };

  if (state.endTime === null) {
    if (ctx.sharesWritten || ctx.wasClosed) {
      return { ok: false, status: 409, body: SHARE_OPEN_ENTRY_BODY };
    }
    return { ok: true };
  }

  const workingMinutes = entryDurations(state).workingMinutes;
  const sum = state.shares.reduce((acc, share) => acc + share.minutes, 0);
  if (sum > workingMinutes + SUM_EPSILON) {
    return {
      ok: false,
      status: 409,
      body: {
        error: SHARE_SUM_MESSAGE,
        maxShareMinutes: Math.max(0, Math.floor(workingMinutes + SUM_EPSILON)),
      },
    };
  }
  return { ok: true };
}

/**
 * Merges the activity fields of a request body with the stored state: per field the body wins,
 * an omitted field keeps the stored value. `existing` is null on create (kind UNSPECIFIED, no
 * shares). `sharesWritten` tells the validator whether the request itself carries a share list.
 */
export function mergeActivityWrite(
  body: { activityKind?: ActivityKind; activityShares?: readonly ActivityShareInput[] },
  existing: { activityKind: ActivityKind; activityShares: readonly ActivityShareInput[] } | null,
): { kind: ActivityKind; shares: readonly ActivityShareInput[]; sharesWritten: boolean } {
  return {
    kind: body.activityKind ?? existing?.activityKind ?? "UNSPECIFIED",
    shares: body.activityShares ?? existing?.activityShares ?? [],
    sharesWritten: body.activityShares !== undefined,
  };
}

/** Nested-write fragment for `timeEntry.create`: the shares are created with the entry. */
export function activitySharesCreate(shares: readonly ActivityShareInput[]): {
  create: ActivityShareInput[];
} {
  return { create: shares.map(({ kind, minutes }) => ({ kind, minutes })) };
}

/** Nested-write fragment for `timeEntry.update`: the stored rows are replaced by the new list. */
export function activitySharesReplace(shares: readonly ActivityShareInput[]): {
  deleteMany: Record<string, never>;
  create: ActivityShareInput[];
} {
  return { deleteMany: {}, create: shares.map(({ kind, minutes }) => ({ kind, minutes })) };
}

/** The part of the PUT body the D-20 predicate looks at (mirrors the route's schema output). */
export type ActivityPutBody = {
  activityKind?: ActivityKind;
  activityShares?: readonly ActivityShareInput[];
  date?: string;
  startTime?: string;
  endTime?: string | null;
  breakMinutes?: number;
  breaks?: readonly unknown[];
  grantId?: string;
  note?: string | null;
  type?: string;
  salonId?: string;
};

/** The stored entry fields the predicate compares the body against. */
export type ActivityPutExisting = {
  date: Date;
  startTime: Date;
  endTime: Date | null;
  note: string | null;
  type: string;
  salonId: string;
};

/**
 * D-20: true when a PUT changes nothing but the activity classification.
 *
 * A classification is not a correction of recorded time, so such a PUT is neither flagged
 * `source: CORRECTION` nor does it need the manager's correction Begründung; it is still audited,
 * still refused on a locked entry and still bound by the retro window. The predicate only
 * classifies the body — it never decides permissions, the retro window or the lock.
 *
 * Decided per field:
 * - `breakMinutes`, `breaks` and `grantId` present => never activity-only (they confirm the
 *   break or consume a retro grant, even when the value equals the stored one);
 * - `date`, `startTime`, `endTime`, `note`, `type` and `salonId` count only when their value
 *   differs from the stored one, so a form that re-sends the unchanged values stays
 *   activity-only. `"endTime" in body` / `"note" in body` decide presence exactly like the route.
 */
export function isActivityOnlyPut(body: ActivityPutBody, existing: ActivityPutExisting): boolean {
  if (body.activityKind === undefined && body.activityShares === undefined) return false;

  if (body.breakMinutes !== undefined || body.breaks !== undefined || body.grantId !== undefined) {
    return false;
  }

  if (body.date !== undefined && body.date !== existing.date.toISOString().slice(0, 10)) {
    return false;
  }
  if (
    body.startTime !== undefined &&
    new Date(body.startTime).getTime() !== existing.startTime.getTime()
  ) {
    return false;
  }
  if ("endTime" in body) {
    const bodyEnd = body.endTime ? new Date(body.endTime).getTime() : null;
    const storedEnd = existing.endTime ? existing.endTime.getTime() : null;
    if (bodyEnd !== storedEnd) return false;
  }
  if ("note" in body && (body.note ?? null) !== existing.note) return false;
  if (body.type !== undefined && body.type !== existing.type) return false;
  if (body.salonId !== undefined && body.salonId !== existing.salonId) return false;

  return true;
}

/**
 * Issue #81 (D-07) — turns an entry's classified remainder into an explicit share before the clock
 * extends the entry with time nobody classified.
 *
 * Under the remainder model (D-01) all unallocated working time of an entry counts as its kind. A
 * clock re-open or a consolidation adds working time AFTER a classification was recorded; letting
 * that time inherit the kind would fabricate a classification nobody made. This function keeps the
 * recorded statement exactly (never lose) and leaves the added time unspecified (never fabricate):
 * the remainder measured on the closed entry BEFORE the extension (whole minutes, floor) becomes a
 * share of the entry's kind, and the entry kind becomes UNSPECIFIED. A remainder below one minute
 * is dropped, and the kind still becomes UNSPECIFIED.
 *
 * Callers: the clock re-open (`services/clock/resolver.ts`) and the consolidation target
 * (`services/clock/consolidate.ts`). A user edit (PUT) that extends an entry is a deliberate act on
 * the classified entry and is not materialised. The clock paths never write a classification of
 * their own.
 *
 * Returns null when there is nothing to keep: the entry is UNSPECIFIED or still open.
 *
 * Known limit: when a stored `breakMinutes` is lower than the sum of the entry's Break rows (only a
 * legacy row or a revalidation that set a break sum without rows), the clock re-open recomputes the
 * break from the rows and the working time after the next clock-out can fall below the shares. The
 * clock never rejects a punch, so `activityMinutes()` reports the negative remainder as-is (never
 * clamped, D-05); the next PUT that touches times or shares must resolve it.
 */
export function materializeRemainder(
  state: ActivityState,
): { kind: "UNSPECIFIED"; shares: ActivityShareInput[] } | null {
  if (state.kind === "UNSPECIFIED" || state.endTime === null) return null;
  const allocated = state.shares.reduce((acc, share) => acc + share.minutes, 0);
  const whole = Math.floor(entryDurations(state).workingMinutes - allocated + SUM_EPSILON);
  const shares = state.shares.map((share) => ({ kind: share.kind, minutes: share.minutes }));
  if (whole >= 1) shares.push({ kind: state.kind, minutes: whole });
  return { kind: "UNSPECIFIED", shares };
}
