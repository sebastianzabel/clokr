<script lang="ts">
  import { theme, themes, type Theme } from "$stores/theme";
  import { mode, type Mode } from "$stores/mode";
  import { applyPreferences } from "$stores/apply-preferences";
  import SectionStack from "$lib/components/admin/SectionStack.svelte";
  import Section from "$lib/components/admin/Section.svelte";
  import LanguageToggle from "$components/ui/LanguageToggle.svelte";
  import SegmentedControl from "$components/ui/SegmentedControl.svelte";

  // #842 D-842-22: three themes, each previewed in light and dark. The previews are elements that
  // carry data-theme + data-mode themselves, so the real token blocks of tokens.css resolve on
  // them; the page holds no colour of its own.
  const previewModes: { id: Mode; label: string }[] = [
    { id: "light", label: "Hell" },
    { id: "dark", label: "Dunkel" },
  ];

  const modeOptions = [
    { value: "light", label: "Hell" },
    { value: "dark", label: "Dunkel" },
  ];

  /** Theme click: one PUT through applyPreferences (Issue #392 rationale). */
  function selectTheme(id: Theme) {
    applyPreferences({ theme: id });
  }

  function selectMode(value: string) {
    mode.set(value === "dark" ? "dark" : "light");
  }
</script>

<svelte:head>
  <title>Branding & Themes – Clokr</title>
</svelte:head>

<SectionStack
  eyebrow="System"
  title="Branding & Themes"
  sub="Dein Erscheinungsbild: Es wird für dein Konto gespeichert und gilt auf all deinen Geräten."
  animate
>
  <Section title="Theme" sub="Wähle die Farbwelt, jeweils in Hell und Dunkel gezeigt.">
    <div class="theme-grid" role="group" aria-label="Theme auswählen">
      {#each themes as t (t.id)}
        {@const active = $theme === t.id}
        <button
          type="button"
          class="theme-card"
          class:active
          aria-pressed={active}
          onclick={() => selectTheme(t.id)}
        >
          <div class="theme-previews">
            {#each previewModes as m (m.id)}
              <div class="theme-preview" data-theme={t.id} data-mode={m.id}>
                <div class="tp-bar"></div>
                <div class="tp-card">
                  <span class="tp-brand"></span>
                  <span class="tp-text"></span>
                </div>
                <span class="tp-caption">{m.label}</span>
              </div>
            {/each}
          </div>
          <div class="theme-body">
            <span class="theme-label">{t.label}</span>
            {#if active}
              <span class="chip-brand">Aktiv</span>
            {/if}
          </div>
        </button>
      {/each}
    </div>
  </Section>

  <Section title="Modus" sub="Hell oder dunkel, unabhängig vom Theme.">
    <SegmentedControl
      options={modeOptions}
      value={$mode}
      name="mode"
      ariaLabel="Modus auswählen"
      onchange={selectMode}
    />
  </Section>

  <Section title="Sprache" sub="UI-Sprache (Englisch folgt in v1.6)">
    <LanguageToggle variant="segmented" />
  </Section>
</SectionStack>

<style>
  .theme-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: var(--s-4);
  }
  @media (max-width: 720px) {
    .theme-grid {
      grid-template-columns: 1fr;
    }
  }
  .theme-card {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: var(--r-card);
    padding: var(--s-3);
    cursor: pointer;
    text-align: left;
    color: var(--text);
    font-family: var(--font-ui);
    transition:
      transform 160ms var(--ease-out),
      border-color 160ms var(--ease-out);
  }
  .theme-card:hover {
    transform: translateY(-1px);
  }
  .theme-card:focus-visible {
    outline: 2px solid var(--brand);
    outline-offset: 2px;
  }
  .theme-card.active {
    border-color: var(--brand);
  }

  .theme-previews {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--s-2);
  }

  /* Each preview resolves the real token blocks through its own data-theme + data-mode. */
  .theme-preview {
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--line);
    border-radius: var(--r-control);
    padding: var(--s-2);
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
  }
  .tp-bar {
    height: 6px;
    width: 40%;
    border-radius: var(--r-pill);
    background: var(--text-3);
  }
  .tp-card {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: var(--r-control);
    padding: var(--s-2);
  }
  .tp-brand {
    flex: none;
    width: 14px;
    height: 14px;
    border-radius: var(--r-pill);
    background: var(--brand);
  }
  .tp-text {
    flex: 1;
    height: 6px;
    border-radius: var(--r-pill);
    background: var(--text-3);
  }
  .tp-caption {
    font-size: 11px;
    font-weight: 600;
    color: var(--text);
  }

  .theme-body {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--s-3) var(--s-1) var(--s-1);
  }
  .theme-label {
    font-size: 16px;
    font-weight: 600;
    color: var(--text);
  }
  .chip-brand {
    padding: 3px 9px;
    border-radius: var(--r-pill);
    background: var(--brand-soft);
    color: var(--brand);
    font-size: 11px;
    font-weight: 600;
  }
</style>
