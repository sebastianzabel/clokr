// Issue #854 (owner review) - the record name a detail page hands to the top bar's path (the last crumb,
// e.g. „Mia Friseurin“ under Verwalten / Personen). Display only: the trail itself comes from the route
// table (`crumbTrail` in routes.ts). A page sets it while it shows a record and clears it when it leaves.
import { writable } from "svelte/store";

export const detailCrumb = writable<string | null>(null);

/**
 * Call inside an `$effect` of the detail page: shows `label` while the effect lives and clears it on
 * cleanup (a new record, leaving the page). A null or blank label shows nothing.
 */
export function showDetailCrumb(label: string | null | undefined): () => void {
  const value = label && label.trim() !== "" ? label.trim() : null;
  detailCrumb.set(value);
  return () => detailCrumb.set(null);
}
