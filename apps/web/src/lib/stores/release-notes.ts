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

export const hasUnreadReleaseNotes = derived(
  [releaseNotesStore, lastSeenStore],
  ([$notes, $seen]) => $notes.length > 0 && $notes[0].version !== $seen,
);

let loaded = false;

/**
 * Single-shot loader for both endpoints. A second call is a no-op — the module-level `loaded`
 * guard is set synchronously before either request fires, exactly like `loadVersion()`.
 */
export function loadReleaseNotesData(): void {
  if (loaded) return;
  loaded = true;

  api
    .get<{ releases: ReleaseNote[] }>("/release-notes")
    .then((r) => {
      releaseNotesStore.set(r.releases);
    })
    .catch(() => {
      // Intentionally swallowed (AK-06) — an older API image or a transient network
      // failure must not surface a user-facing notice or a console entry; the store simply
      // stays empty.
    });

  api
    .get<{ lastSeenVersion: string | null }>("/me/release-notes-seen")
    .then((r) => {
      lastSeenStore.set(r.lastSeenVersion);
    })
    .catch(() => {
      // Intentionally swallowed (AK-06) — same fail-silent contract as above.
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
