import { writable } from "svelte/store";

/**
 * Monotonic cache-bust counter for the current user's avatar.
 *
 * Bumped after a successful avatar upload (or delete) so every subscriber
 * — settings page, topbar button, etc. — re-fetches the image and bypasses
 * the 1-hour `Cache-Control: private, max-age=3600` set by the API.
 */
export const avatarVersion = writable(0);

export function bumpAvatarVersion() {
  avatarVersion.update((n) => n + 1);
}
