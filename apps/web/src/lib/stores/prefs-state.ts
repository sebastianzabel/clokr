import { writable } from "svelte/store";

/**
 * Gates whether theme/mode/density store subscribers should sync writes back to the API.
 *
 * Lifecycle:
 *  - Starts as `false` (initial store subscription fires once during page load — we don't
 *    want that to PUT the localStorage-loaded value back to the server).
 *  - Flipped to `true` after `fetchPreferences()` resolves on login, so subsequent user
 *    toggles propagate to the server.
 *  - Reset to `false` on logout to stop background writes for the previous user.
 */
export const prefsHydrated = writable<boolean>(false);
