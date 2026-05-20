import { api } from "$api/client";

/** Server shape — matches apps/api/src/routes/me.ts merged defaults. */
export interface UiPreferences {
  skin: "editorial" | "modern";
  theme: "pflaume" | "nacht" | "wald" | "schiefer";
  mode: "light" | "dark";
  density: "comfortable" | "compact";
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
