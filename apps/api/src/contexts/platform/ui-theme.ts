// Issue #842 (D-842-17, D-842-18): the one place that decides which theme ids exist and how a
// retired id maps onto the current set. The web offers three themes (Pflaume, Salz, Petrol);
// the earlier set (pflaume, nacht, wald, schiefer) is still found in stored preferences and in
// requests of stale browser tabs, so both the PUT transform and the GET merge of
// `api/me.ts` go through `normalizeUiTheme()`. No other file may spell the mapping.

export const UI_THEME_IDS = ["pflaume", "salz", "petrol"] as const;
export type UiThemeId = (typeof UI_THEME_IDS)[number];

// Stored values of the retired theme set (neutral / dark-blue and forest variants).
export const LEGACY_UI_THEME_IDS = ["nacht", "schiefer", "wald"] as const;

const LEGACY_THEME_TARGET: Record<(typeof LEGACY_UI_THEME_IDS)[number], UiThemeId> = {
  nacht: "salz",
  schiefer: "salz",
  wald: "petrol",
};

/** Map any stored or submitted value to one of the three themes; unknown values become pflaume. */
export function normalizeUiTheme(value: unknown): UiThemeId {
  if (typeof value !== "string") return "pflaume";
  if ((UI_THEME_IDS as readonly string[]).includes(value)) return value as UiThemeId;
  if (Object.prototype.hasOwnProperty.call(LEGACY_THEME_TARGET, value)) {
    return LEGACY_THEME_TARGET[value as keyof typeof LEGACY_THEME_TARGET];
  }
  return "pflaume";
}
