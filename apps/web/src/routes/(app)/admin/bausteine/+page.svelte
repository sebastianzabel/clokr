<script lang="ts">
  // Issue #843 (D-843-04) - the example page of the design-system blocks. Every demo file of
  // ./demos is rendered in each of the six theme x mode frames, so a block plan adds a demo file
  // and never edits this page. The frames carry data-theme AND data-mode (both are mandatory, see
  // the tokens.css header) and nest the real token cascade of #842. The page reads no API data.
  import type { Component } from "svelte";
  import { pageLabel } from "$lib/nav/page-labels";
  import PageHead from "$components/layout/PageHead.svelte";
  import Dialog from "$components/ui/Dialog.svelte";
  import ConfirmDialog from "$components/ui/ConfirmDialog.svelte";

  interface DemoBlock {
    id: number;
    name: string;
    entries: string[];
  }
  interface DemoModule {
    default: Component;
    block: DemoBlock;
  }

  const modules = import.meta.glob<DemoModule>("./demos/*.svelte", { eager: true });
  // File names are NN-<slug>.svelte, so sorting by path is sorting by block id.
  const demos = Object.entries(modules)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, mod]) => ({ path, Demo: mod.default, block: mod.block }));

  const themes = [
    { id: "pflaume", label: "Pflaume" },
    { id: "salz", label: "Salz" },
    { id: "petrol", label: "Petrol" },
  ] as const;
  const modes = [
    { id: "light", label: "Hell" },
    { id: "dark", label: "Dunkel" },
  ] as const;
  const frames = themes.flatMap((t) =>
    modes.map((m) => ({
      theme: t.id,
      mode: m.id,
      label: `${t.label} · ${m.label}`,
    })),
  );

  let dialogOpen = $state(false);
  // The live confirmation of the page head (D-843-04, D-843-12): the e2e of the #636 finding opens
  // it at 1440 px and checks that the scrim covers the topbar and that the focus is trapped.
  let confirmOpen = $state(false);
</script>

<svelte:head>
  <title>{pageLabel("/admin/bausteine")} – Clokr</title>
  <!-- Internal tool page (#843): not for search engines. -->
  <meta name="robots" content="noindex" />
</svelte:head>

<div class="bausteine" data-testid="bausteine-page">
  <PageHead
    eyebrow="Administration"
    title={pageLabel("/admin/bausteine")}
    sub="Alle Bausteine des Designsystems in den sechs Kombinationen aus Thema und Modus."
  >
    {#snippet actions()}
      <button
        type="button"
        class="btn btn-secondary"
        data-testid="bausteine-open-confirm"
        onclick={() => (confirmOpen = true)}
      >
        Bestätigung öffnen
      </button>
      <button
        type="button"
        class="btn btn-primary"
        data-testid="bausteine-open-dialog"
        onclick={() => (dialogOpen = true)}
      >
        Dialog öffnen
      </button>
    {/snippet}
  </PageHead>

  <div class="frames">
    {#each frames as frame (frame.label)}
      <section
        class="frame"
        data-theme={frame.theme}
        data-mode={frame.mode}
        data-testid="bausteine-frame-{frame.theme}-{frame.mode}"
        aria-label={frame.label}
      >
        <h2>{frame.label}</h2>
        <div class="demos">
          {#each demos as { path, Demo } (path)}
            <Demo />
          {/each}
        </div>
      </section>
    {/each}
  </div>
</div>

<ConfirmDialog
  bind:open={confirmOpen}
  title="Eintrag löschen?"
  description="Der Eintrag ist danach nicht mehr in der Liste zu sehen."
  confirmLabel="Löschen"
  danger
  onConfirm={() => {
    // Example only: confirming just closes the dialog, nothing is deleted.
  }}
/>

<Dialog bind:open={dialogOpen} title="Beispieldialog">
  <p>Dieser Dialog liegt über der Seite und hält den Fokus in sich, bis du ihn schließt.</p>
  {#snippet footer()}
    <button type="button" class="btn btn-secondary" onclick={() => (dialogOpen = false)}>
      Abbrechen
    </button>
    <button
      type="button"
      class="btn btn-primary"
      data-autofocus
      onclick={() => (dialogOpen = false)}
    >
      Übernehmen
    </button>
  {/snippet}
</Dialog>

<style>
  /* The page is a container so the frame grid reacts to the width it is given, not to the
     viewport (D-843-03; 1100 px = CONTAINER_WIDE_PX in lib/components/ui/breakpoints.ts). */
  .bausteine {
    container-type: inline-size;
  }

  .frames {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: var(--s-4);
  }

  @container (min-width: 1100px) {
    .frames {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  .frame {
    container-type: inline-size;
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--line);
    border-radius: var(--r-card);
    padding: var(--s-5);
    min-width: 0;
  }

  .frame h2 {
    margin: 0 0 var(--s-4);
    font-size: var(--fs-h2);
    font-weight: 600;
    color: var(--text-2);
  }

  .demos {
    display: flex;
    flex-direction: column;
    gap: var(--s-6);
  }
</style>
