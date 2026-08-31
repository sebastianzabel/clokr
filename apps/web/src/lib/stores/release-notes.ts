import { derived, writable, get } from "svelte/store";
import { api } from "$api/client";

/**
 * Phase 110 (D-05/D-07/D-08/D-10/N-07/N-08): What's-New store.
 *
 * Mirrors `apps/web/src/lib/stores/version.ts` (Phase 69, D-08) as the house fail-silent
 * pattern: a single one-shot `GET`, no error banner, no logging to the browser console.
 * Extends it in two ways specific to this feature:
 *
 * - The "seen" marker lives entirely server-side per user (D-10/AK-10), never in browser
 *   web storage — a client-side marker would reappear on every second device the same
 *   employee logs in from, defeating the point of the marker.
 * - The release-notes payload is structured data (`ReleaseNoteSpan[]` with a `bold` flag), never
 *   markup (N-08/AK-13). This module holds no HTML-rendering concern at all; it only fetches and
 *   caches the structured shape produced by `apps/api/src/utils/release-notes.ts` (Plan 03).
 *
 * An older API image simply has no `/release-notes` route yet and 404s; the correct outcome is
 * that no unread marker and no panel entry point appear — never an error surfaced to the user.
 */

export interface ReleaseNoteSpan {
  text: string;
  bold: boolean;
}

export interface ReleaseNoteBullet {
  spans: ReleaseNoteSpan[];
}

export interface ReleaseNoteSection {
  heading: string;
  bullets: ReleaseNoteBullet[];
}

export interface ReleaseNote {
  version: string;
  title: string;
  intro: string[];
  sections: ReleaseNoteSection[];
  footnote: string | null;
}

export const releaseNotesStore = writable<ReleaseNote[]>([]);
export const lastSeenStore = writable<string | null>(null);
export const whatsNewOpen = writable(false);

/**
 * Readiness gate (fix for the auto-open race found live during the 110-07 checkpoint).
 *
 * `loadReleaseNotesData()` fires `GET /release-notes` and `GET /me/release-notes-seen`
 * independently. Whichever settles first updates its own store immediately — that is correct
 * for each store in isolation, but `hasUnreadReleaseNotes` reads BOTH stores together, and for
 * the instant between the two settling, `lastSeenStore` still held its initial `null` while
 * `releaseNotesStore` already held the real payload. `"1.9.18" !== null` made the derived store
 * flip true for one tick, which was enough to latch the auto-open `$effect` in
 * `(app)/+layout.svelte` — reproduced live, drawer re-opened on every login regardless of the
 * server-side seen marker.
 *
 * Mirrors the `snapshotsReady` readiness-gate idiom from Phase 109 (WR-01: never act on state
 * before its baseline has loaded), adapted for two independently-racing sources instead of one:
 * two flags, reset to `false` at the start of a load cycle and each raised only once its own
 * fetch has settled. `hasUnreadReleaseNotes` is false while either flag is down.
 *
 * They default to `true` (not `false`, unlike the single-flag WR-01 shape) so that a test — or
 * any other caller — that sets `releaseNotesStore`/`lastSeenStore` directly without ever calling
 * `loadReleaseNotesData()` sees the derived value computed immediately from those values, exactly
 * as before this fix. In the running app `loadReleaseNotesData()` is always called once at app
 * init (`(app)/+layout.svelte`'s `onMount`) before anything reads `hasUnreadReleaseNotes`, so the
 * `true` default is never actually observed there — it only preserves the "set both stores
 * directly" shape used by other unit tests in this file.
 *
 * A FAILED seen-fetch never raises `seenReady` — the flag is only set on success. We cannot tell
 * an unseen release apart from a network hiccup by looking at `lastSeenStore` alone (a legitimate
 * "never seen anything" `null` from a successful fetch looks identical to a `null` left over from
 * a failed one), so the fail-silent contract resolves that ambiguity by favouring silence: rather
 * than risk an unwanted auto-open built on a guess, this load cycle's `hasUnreadReleaseNotes`
 * simply stays `false` — same fail-open direction as an older API image's 404 (AK-06), no error
 * surfaced, no console entry, nothing latched. The trade-off (a genuinely new release goes
 * unannounced for this one degraded session) is the same one `markReleaseNotesSeen()`'s own
 * comment accepts for a failed PUT, just facing the opposite direction.
 */
const notesReady = writable(true);
const seenReady = writable(true);

export const hasUnreadReleaseNotes = derived(
  [releaseNotesStore, lastSeenStore, notesReady, seenReady],
  ([$notes, $seen, $notesReady, $seenReady]) =>
    $notesReady && $seenReady && $notes.length > 0 && $notes[0].version !== $seen,
);

let loaded = false;

/**
 * Single-shot loader for both endpoints. A second call is a no-op — the module-level `loaded`
 * guard is set synchronously before either request fires, exactly like `loadVersion()`.
 */
export function loadReleaseNotesData(): void {
  if (loaded) return;
  loaded = true;

  notesReady.set(false);
  seenReady.set(false);

  api
    .get<{ releases: ReleaseNote[] }>("/release-notes")
    .then((r) => {
      releaseNotesStore.set(r.releases);
    })
    .catch(() => {
      // Intentionally swallowed (AK-06) — an older API image or a transient network
      // failure must not surface a user-facing notice or a console entry; the store simply
      // stays empty.
    })
    .finally(() => {
      notesReady.set(true);
    });

  api
    .get<{ lastSeenVersion: string | null }>("/me/release-notes-seen")
    .then((r) => {
      lastSeenStore.set(r.lastSeenVersion);
      seenReady.set(true);
    })
    .catch(() => {
      // Intentionally swallowed (AK-06) — same fail-silent contract as above. `seenReady` is
      // deliberately NOT raised here — see the readiness-gate comment above for why a failed
      // seen-fetch must not be treated as "unread" either.
    });
}

/**
 * Marks the newest known release as seen. Optimistic on purpose: dismissing the panel must
 * feel instant, and the worst case of a failed PUT is that the panel auto-opens once more on
 * the next login — a re-shown notice, never a lost one. No-op when there is nothing to
 * acknowledge (an empty corpus, e.g. against an older API image).
 */
export function markReleaseNotesSeen(): void {
  const notes = get(releaseNotesStore);
  if (notes.length === 0) return;

  const version = notes[0].version;
  lastSeenStore.set(version);

  api.put("/me/release-notes-seen", { version }).catch(() => {
    // Intentionally swallowed (AK-06) — see loadReleaseNotesData() above.
  });
}

export function openWhatsNew(): void {
  whatsNewOpen.set(true);
}
