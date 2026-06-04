import { writable } from "svelte/store";
import { api } from "$api/client";

/**
 * Phase 69 (DEVOPS-V8-02): runtime version store.
 *
 * Holds the running API version (read from `apps/api/package.json` at module
 * init on the server) and is hydrated by a single `GET /api/v1/version` call
 * the first time `loadVersion()` runs. Subsequent callers (Sidebar +
 * MobileMoreSheet) reuse the cached value — no duplicate network calls.
 *
 * Fail-silent per D-08: if the endpoint is unreachable (e.g. running against
 * an older API image) the store stays empty and consumers simply do not
 * render the version line. No toast, no console.error.
 */
export const versionStore = writable<string>("");

let loaded = false;

export function loadVersion(): void {
  if (loaded) return;
  loaded = true;
  // api.client.ts BASE_URL is "/api/v1", so the path here is "/version".
  api
    .get<{ version: string }>("/version")
    .then((r) => {
      versionStore.set(r.version);
    })
    .catch(() => {
      // Intentionally swallowed (D-08).
    });
}
