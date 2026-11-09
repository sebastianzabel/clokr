import { api } from "$api/client";
import type { Theme } from "$stores/theme";

/** Server shape — matches apps/api/src/contexts/platform/api/me.ts merged defaults. */
export interface UiPreferences {
  theme: Theme;
  mode: "light" | "dark";
  language: "de" | "en";
}

export type UiPreferencesPartial = Partial<UiPreferences>;

/** Fetch the authenticated user's preferences (merged with server-side defaults). */
export function fetchPreferences(): Promise<UiPreferences> {
  return api.get<UiPreferences>("/me/preferences");
}

/** Partial-update the authenticated user's preferences. Returns the new merged state. */
export function savePreferences(partial: UiPreferencesPartial): Promise<UiPreferences> {
  return api.put<UiPreferences>("/me/preferences", partial);
}
