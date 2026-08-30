<script lang="ts">
  // Phase 110 (N-07/D-12): non-modal What's-New drawer.
  //
  // Why this is not `Modal.svelte`: `Modal.svelte:42-53` marks every sibling `<body>` child
  // as non-interactive and locks body scroll while open (`Modal.svelte:38-40`). `/dashboard`
  // is the post-login landing route and carries the "Einstempeln" button, so an auto-opening
  // modal would make the time clock unreachable at exactly the moment it matters most. This
  // panel is therefore a non-modal drawer — `role="complementary"`, no dialog-trapping
  // attribute, no keyboard focus trap, no scroll lock, and no full-viewport click-catching
  // overlay (a viewport-covering surface would swallow pointer events on the page beneath even
  // without marking siblings non-interactive, reintroducing the same problem). It is also the
  // presentation the owner explicitly named as the model — a side drawer, not a forced dialog.
  // `Modal.svelte` remains correct for genuinely blocking flows and is not modified by this plan.
  import { releaseNotesStore, whatsNewOpen, markReleaseNotesSeen } from "$stores/release-notes";

  let view: "latest" | "history" = $state("latest");

  let notes = $derived($releaseNotesStore);
  let latest = $derived(notes[0] ?? null);
  let shown = $derived(view === "history" ? notes : latest ? [latest] : []);

  function close() {
    markReleaseNotesSeen();
    whatsNewOpen.set(false);
    view = "latest";
  }

  function toggleHistory() {
    view = view === "history" ? "latest" : "history";
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape" && $whatsNewOpen) close();
  }
</script>

<svelte:window onkeydown={onKeyDown} />

{#if $whatsNewOpen && latest}
  <aside class="whats-new" aria-label="Was ist neu">
    <header class="whats-new-hd">
      <div>
        <div class="whats-new-eyebrow">Was ist neu</div>
        <h2>{view === "history" ? "Änderungshistorie" : latest.title}</h2>
      </div>
      <button type="button" class="whats-new-close" aria-label="Schließen" onclick={close}>
        &times;
      </button>
    </header>

    <div class="whats-new-toolbar">
      <button type="button" class="link-btn" onclick={toggleHistory}>
        {view === "history" ? "Nur neueste Version" : "Alle Versionen"}
      </button>
    </div>

    <div class="whats-new-body">
      {#each shown as release, ri (release.version)}
        <article class="whats-new-release">
          <div class="whats-new-release-hd">
            <span class="badge">Version {release.version}</span>
            {#if view === "history"}
              <h3>{release.title}</h3>
            {/if}
          </div>

          {#each release.intro as paragraph, pi (pi)}
            <p class="whats-new-intro">{paragraph}</p>
          {/each}

          {#each release.sections as section, si (si)}
            <section class="whats-new-section">
              <h4>{section.heading}</h4>
              <ul>
                {#each section.bullets as bullet, bi (bi)}
                  <li>
                    {#each bullet.spans as span, sp (sp)}
                      {#if span.bold}<strong>{span.text}</strong>{:else}{span.text}{/if}
                    {/each}
                  </li>
                {/each}
              </ul>
            </section>
          {/each}

          {#if release.footnote}
            <p class="whats-new-footnote">{release.footnote}</p>
          {/if}

          {#if view === "history" && ri < shown.length - 1}
            <hr class="whats-new-divider" />
          {/if}
        </article>
      {/each}
    </div>
  </aside>
{/if}

<style>
  .whats-new {
    position: fixed;
    top: 0;
    bottom: 0;
    right: 0;
    width: min(400px, 92vw);
    /* Phase 110-07 checkpoint fix: this drawer is chrome that must sit above ALL persistent app
       chrome (Sidebar, Topbar, BottomTabBar, the mobile "Mehr" sheet) since it can open on any
       authenticated route -- Topbar.svelte's own comment puts the highest of those at 1000. It
       previously sat at 150, below that chrome, so its close button was covered by the Topbar
       avatar and unclickable (measured: elementFromPoint on the close button's centre hit
       .topbar-actions, not the button). 2000 is deliberately in the gap between the app-chrome
       band (<=1000) and the global-overlay band (CommandPalette 9000/9001, Toast 9999,
       skip-to-content 10000): it must win over chrome, but Toast must still win over an open
       drawer (an error toast has to stay visible while it's open) and the CommandPalette --
       invoked from anywhere via keyboard shortcut -- keeps its own precedence too. Pinned by
       whats-new-stacking.test.ts. */
    z-index: 2000;
    background: var(--bg-card);
    border-left: 1px solid var(--border);
    box-shadow: var(--shadow-lg);
    display: flex;
    flex-direction: column;
    animation: fadeUp 200ms var(--ease-out);
  }

  .whats-new-hd {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 14px;
    padding: 22px 26px;
    border-bottom: 1px solid var(--border);
  }

  .whats-new-eyebrow {
    font-family: var(--font-serif);
    font-style: italic;
    color: var(--brand-light, var(--brand));
    font-size: 13px;
    line-height: 1;
    margin-bottom: 4px;
  }

  .whats-new-hd h2 {
    font-family: var(--font-serif);
    font-weight: 400;
    font-size: 22px;
    line-height: 1.2;
    margin: 4px 0 0;
    color: var(--text);
  }

  .whats-new-close {
    width: 32px;
    height: 32px;
    border-radius: var(--r-sm);
    background: transparent;
    border: 1px solid transparent;
    color: var(--text-muted);
    cursor: pointer;
    display: grid;
    place-items: center;
    flex-shrink: 0;
    font-size: 20px;
    line-height: 1;
  }

  .whats-new-close:hover {
    background: var(--bg-subtle);
    color: var(--text);
  }

  .whats-new-toolbar {
    padding: 12px 26px 0;
    display: flex;
    justify-content: flex-end;
  }

  .link-btn {
    background: none;
    border: none;
    color: var(--brand);
    font-size: 13px;
    cursor: pointer;
    padding: 0;
  }

  .link-btn:hover {
    text-decoration: underline;
  }

  .whats-new-body {
    padding: 14px 26px 26px;
    overflow-y: auto;
    flex: 1;
    font-size: 13.5px;
    line-height: 1.55;
    color: var(--text);
  }

  .whats-new-release {
    display: block;
  }

  .whats-new-release-hd {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 8px;
  }

  .whats-new-release-hd h3 {
    font-family: var(--font-serif);
    font-weight: 400;
    font-size: 17px;
    margin: 0;
    color: var(--text);
  }

  .whats-new-intro {
    margin: 0 0 10px;
  }

  .whats-new-section {
    margin-bottom: 14px;
  }

  .whats-new-section h4 {
    font-size: 12.5px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
    margin: 0 0 6px;
  }

  .whats-new-section ul {
    margin: 0;
    padding-left: 18px;
  }

  .whats-new-section li {
    margin-bottom: 4px;
  }

  .whats-new-footnote {
    font-size: 12px;
    font-style: italic;
    color: var(--text-faint);
    margin-top: 10px;
  }

  .whats-new-divider {
    border: none;
    border-top: 1px solid var(--border);
    margin: 18px 0;
  }
</style>
