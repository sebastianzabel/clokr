// Phase 109 (Issue #35, D-12 / AK-07) — registry of sections with unsaved changes.
//
// Why a store and not `setContext`: the navigation guard lives in `(app)/+layout.svelte`, which
// WRAPS the page. Context flows top-down only, so the layout cannot read a value a descendant
// `Section` sets. A module-level store is the read-back-up channel.
//
// In-memory ONLY. This registry is deliberately never written to the browser's persistent
// storage APIs (the ones that would survive a logout): residual form state from one operator's
// session must not survive into the next operator's session on a shared admin machine.
import { get, writable } from "svelte/store";

const store = writable<string[]>([]);

/** Read-only view for `$unsavedSections` in markup. */
export const unsavedSections = { subscribe: store.subscribe };

/** Register (`dirty === true`) or de-register (`dirty === false`) a section id. Idempotent. */
export function markUnsaved(id: string, dirty: boolean): void {
  store.update((ids) => {
    const has = ids.includes(id);
    if (dirty && !has) return [...ids, id];
    if (!dirty && has) return ids.filter((x) => x !== id);
    return ids;
  });
}

/** Drop every registration. Called by every logout path BEFORE it navigates (N-08). */
export function clearUnsaved(): void {
  store.set([]);
}

/** Synchronous read — `beforeNavigate`'s callback cannot await (N-07). */
export function hasUnsaved(): boolean {
  return get(store).length > 0;
}
