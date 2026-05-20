<script lang="ts">
  import { theme, themes, type Theme } from "$stores/theme";
  import { mode, type Mode } from "$stores/mode";
  import { skin, type Skin } from "$stores/skin";
  import PageHead from "$components/layout/PageHead.svelte";
  import Card from "$components/ui/Card.svelte";
  import CardHeader from "$components/ui/CardHeader.svelte";
  import LanguageToggle from "$components/ui/LanguageToggle.svelte";
  import DensityToggle from "$components/ui/DensityToggle.svelte";

  /** Modern preset entry: a triple of skin × mode × theme applied together. */
  interface ModernPreset {
    id: "mod_dark" | "mod_lite";
    name: string;
    skin: Skin;
    mode: Mode;
    theme: Theme;
    primary: string; // gradient mid stop
    light: string; // gradient end (top-left)
    dark: string; // gradient start (bottom-right) — used for preview surface
  }

  const modernPresets: ModernPreset[] = [
    {
      id: "mod_dark",
      name: "Modern Dark",
      skin: "modern",
      mode: "dark",
      theme: "pflaume",
      primary: "#B879F0",
      light: "#D9A5FF",
      dark: "#050507",
    },
    {
      id: "mod_lite",
      name: "Modern Bright",
      skin: "modern",
      mode: "light",
      theme: "pflaume",
      primary: "#B879F0",
      light: "#D9A5FF",
      dark: "#F7F7F8",
    },
  ];

  /** Editorial theme click: switch skin back to editorial + set theme. */
  function selectTheme(id: Theme) {
    skin.set("editorial");
    theme.set(id);
  }

  function selectMode(m: Mode) {
    mode.set(m);
  }

  /** Modern preset click: apply skin + mode + theme together. */
  function selectModern(preset: ModernPreset) {
    // Stores own the DOM attribute writes — no manual setAttribute needed,
    // each subscribe() in skin.ts / mode.ts / theme.ts already does that.
    skin.set(preset.skin);
    mode.set(preset.mode);
    theme.set(preset.theme);
  }

  // Active detection — editorial cards only match when skin is editorial.
  // Modern cards check the full triple (skin + mode + theme).
  // Helper functions are called from the template; they read $store values
  // which Svelte tracks at the call site, so re-renders fire on any change.
  function isEditorialActive(id: Theme): boolean {
    return $skin === "editorial" && $theme === id;
  }

  function isModernActive(p: ModernPreset): boolean {
    return $skin === p.skin && $mode === p.mode && $theme === p.theme;
  }
</script>

<svelte:head>
  <title>Themes & Branding – Clokr</title>
</svelte:head>

<section class="page">
  <PageHead
    eyebrow="Administration"
    title="Themes & Branding"
    accent="Branding"
    sub="Wähle Theme, Modus und Dichte. Spracheinstellung folgt in v1.6."
  />

  <!-- Theme picker (editorial) -->
  <Card>
    <CardHeader title="Theme" sub="Markenfarbe und Charakter" />
    <div class="theme-grid grid grid-3" role="group" aria-label="Theme auswählen">
      {#each themes as t (t.id)}
        <button
          type="button"
          class="theme-card theme-pick-{t.id}"
          class:active={isEditorialActive(t.id)}
          aria-pressed={isEditorialActive(t.id)}
          onclick={() => selectTheme(t.id)}
        >
          <div class="theme-hero">
            {#if isEditorialActive(t.id)}
              <span class="chip-brand">Aktiv</span>
            {/if}
          </div>
          <div class="theme-body">
            <div class="theme-eyebrow">Theme</div>
            <div class="theme-label">{t.label}</div>
            <div class="swatch-row">
              <span class="swatch swatch-dark" title="Dark"></span>
              <span class="swatch swatch-brand" title="Brand"></span>
              <span class="swatch swatch-light" title="Light"></span>
            </div>
          </div>
        </button>
      {/each}
    </div>
  </Card>

  <!-- Modern presets — skin × mode × theme combos -->
  <Card>
    <CardHeader
      title="Modern Skin"
      sub="Glasmorphismus mit Inter Tight und Neon-Akzenten — überschreibt Theme + Modus."
    />
    <div class="theme-grid grid grid-3" role="group" aria-label="Modern Preset auswählen">
      {#each modernPresets as p (p.id)}
        <button
          type="button"
          class="theme-card theme-pick-{p.id}"
          class:active={isModernActive(p)}
          aria-pressed={isModernActive(p)}
          onclick={() => selectModern(p)}
        >
          <div
            class="theme-hero modern-hero"
            style:background="linear-gradient(135deg, {p.light}, {p.primary} 55%, {p.dark})"
          >
            {#if isModernActive(p)}
              <span class="chip-brand">Aktiv</span>
            {/if}
          </div>
          <div class="theme-body">
            <div class="theme-eyebrow">Modern · {p.mode === "dark" ? "Dunkel" : "Hell"}</div>
            <div class="theme-label">{p.name}</div>
            <div class="swatch-row">
              <span class="swatch" style:background={p.dark} title="Surface"></span>
              <span class="swatch" style:background={p.primary} title="Brand"></span>
              <span class="swatch" style:background={p.light} title="Accent"></span>
            </div>
          </div>
        </button>
      {/each}
    </div>
  </Card>

  <!-- Mode picker -->
  <Card>
    <CardHeader title="Modus" sub="Hell oder dunkel — unabhängig vom Theme" />
    <div class="seg" role="group" aria-label="Modus auswählen">
      <button
        type="button"
        class="seg-btn"
        class:active={$mode === "light"}
        aria-pressed={$mode === "light"}
        onclick={() => selectMode("light")}
      >
        Hell
      </button>
      <button
        type="button"
        class="seg-btn"
        class:active={$mode === "dark"}
        aria-pressed={$mode === "dark"}
        onclick={() => selectMode("dark")}
      >
        Dunkel
      </button>
    </div>
  </Card>

  <!-- Density picker -->
  <Card>
    <CardHeader title="Dichte" sub="Padding und Zeilenhöhe" />
    <DensityToggle />
  </Card>

  <!-- Language picker (stub) -->
  <Card>
    <CardHeader title="Sprache" sub="UI-Sprache (Englisch folgt in v1.6)" />
    <LanguageToggle variant="segmented" />
  </Card>
</section>

<style>
  /* .page wrapper is global (app.css) — no per-page padding/max-width. */

  /* Theme picker */
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
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    padding: 0;
    overflow: hidden;
    cursor: pointer;
    text-align: left;
    transition:
      transform 160ms var(--ease-out),
      border-color 160ms var(--ease-out);
  }
  .theme-card:hover {
    transform: translateY(-1px);
  }
  .theme-card:focus-visible {
    outline: 2px solid var(--brand-light);
    outline-offset: 2px;
  }
  .theme-card.active {
    border-color: var(--brand-light);
  }
  .theme-hero {
    height: 88px;
    position: relative;
  }

  /* Theme-specific gradients (hero strip) and swatches.
     Hex values mirror $stores/theme.ts; encoded as classes so the page
     contains zero inline color/background styles. */
  .theme-pick-pflaume .theme-hero {
    background: linear-gradient(135deg, #5c2858, #a85ca3);
  }
  .theme-pick-pflaume .swatch-dark {
    background: #5c2858;
  }
  .theme-pick-pflaume .swatch-brand {
    background: #80377b;
  }
  .theme-pick-pflaume .swatch-light {
    background: #a85ca3;
  }

  .theme-pick-nacht .theme-hero {
    background: linear-gradient(135deg, #232e78, #6b7bd8);
  }
  .theme-pick-nacht .swatch-dark {
    background: #232e78;
  }
  .theme-pick-nacht .swatch-brand {
    background: #3d4dad;
  }
  .theme-pick-nacht .swatch-light {
    background: #6b7bd8;
  }

  .theme-pick-wald .theme-hero {
    background: linear-gradient(135deg, #1b4332, #52b788);
  }
  .theme-pick-wald .swatch-dark {
    background: #1b4332;
  }
  .theme-pick-wald .swatch-brand {
    background: #2d6a4f;
  }
  .theme-pick-wald .swatch-light {
    background: #52b788;
  }

  .chip-brand {
    position: absolute;
    top: 10px;
    right: 10px;
    padding: 3px 9px;
    border-radius: var(--r-pill);
    background: var(--bg-card);
    color: var(--brand);
    font-family: var(--font-sans);
    font-size: 11px;
    font-weight: 600;
  }
  .theme-body {
    padding: var(--s-4);
  }
  .theme-eyebrow {
    font-family: var(--font-serif);
    font-style: italic;
    font-size: 12px;
    color: var(--brand-light);
  }
  .theme-label {
    font-family: var(--font-serif);
    font-size: 24px;
    font-weight: 400;
    color: var(--text);
    margin: 2px 0 var(--s-3);
  }
  .swatch-row {
    display: flex;
    gap: 6px;
  }
  .swatch {
    width: 14px;
    height: 14px;
    border-radius: var(--r-pill);
    border: 1px solid var(--border);
  }

  /* Segmented control (mode / density / language) */
  .seg {
    display: inline-flex;
    padding: 2px;
    gap: 2px;
    background: var(--bg-subtle);
    border-radius: var(--r-pill);
  }
  .seg-btn {
    padding: 6px 14px;
    border: 0;
    background: transparent;
    color: var(--text-muted);
    border-radius: var(--r-pill);
    font-family: var(--font-sans);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition:
      background 120ms var(--ease-out),
      color 120ms var(--ease-out);
  }
  .seg-btn:hover {
    color: var(--text);
  }
  .seg-btn:focus-visible {
    outline: 2px solid var(--brand-light);
    outline-offset: 2px;
  }
  .seg-btn.active {
    background: var(--bg-card);
    color: var(--text);
    box-shadow: var(--shadow-sm);
  }
</style>
