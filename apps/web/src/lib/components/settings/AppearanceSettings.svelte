<script lang="ts">
  // Issue #851 (D-851-02): the personal appearance in the profile - Farbwelt and Modus. The same stores and
  // the same single PUT /me/preferences as the Branding page (Issue #392 rationale in apply-preferences.ts);
  // a personal preference every person may set, so no permission is involved.
  import Section from "$lib/components/admin/Section.svelte";
  import SegmentedControl from "$components/ui/SegmentedControl.svelte";
  import { theme, themes, type Theme } from "$stores/theme";
  import { mode } from "$stores/mode";
  import { applyPreferences } from "$stores/apply-preferences";

  const themeOptions = themes.map((t) => ({ value: t.id, label: t.label }));
  const modeOptions = [
    { value: "light", label: "Hell" },
    { value: "dark", label: "Dunkel" },
  ];

  function selectTheme(value: string) {
    const next = themes.find((t) => t.id === value)?.id as Theme | undefined;
    if (next) applyPreferences({ theme: next });
  }

  function selectMode(value: string) {
    applyPreferences({ mode: value === "dark" ? "dark" : "light" });
  }
</script>

<Section title="Darstellung" sub="Gilt für dein Konto auf all deinen Geräten.">
  <div class="appearance-rows">
    <div class="appearance-row">
      <span class="appearance-label" id="appearance-theme">Farbwelt</span>
      <SegmentedControl
        options={themeOptions}
        value={$theme}
        name="profile-theme"
        ariaLabel="Farbwelt auswählen"
        size="sm"
        onchange={selectTheme}
      />
    </div>
    <div class="appearance-row">
      <span class="appearance-label" id="appearance-mode">Modus</span>
      <SegmentedControl
        options={modeOptions}
        value={$mode}
        name="profile-mode"
        ariaLabel="Modus auswählen"
        size="sm"
        onchange={selectMode}
      />
    </div>
  </div>
</Section>

<style>
  .appearance-rows {
    display: flex;
    flex-direction: column;
    gap: var(--s-3);
  }

  .appearance-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-3);
    flex-wrap: wrap;
  }

  .appearance-label {
    font-weight: 500;
    color: var(--text);
  }
</style>
