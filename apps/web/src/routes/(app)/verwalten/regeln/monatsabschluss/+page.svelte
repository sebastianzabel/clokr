<!--
  Verwalten › Regeln › Monatsabschluss (Issue #854, D-854-03): the SETTINGS that decide when a month may be
  closed - closing with gaps and blocking on open break findings. The close workflow itself (status, closing,
  correcting) stays at Verwalten › Monatsabschluss; this page only configures it.

  The sections were moved here from the System page - every setting lives exactly once
  (lib/settings/settings-pages.ts). The page loads `GET /settings/work` once and hands it to the sections;
  each section keeps its own snapshot and sends only its own fields (#878). A person sees a section only
  under the permission alternatives of the page it came from (D-854-05).
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "$api/client";
  import { authStore } from "$stores/auth";
  import { markUnsaved } from "$stores/unsaved";
  import { pageLabel } from "$lib/nav/page-labels";
  import { mayOpenSection, settingsSection } from "$lib/settings/settings-pages";
  import type { ClosingConfig } from "$lib/settings/monatsabschluss";
  import PageHead from "$lib/components/layout/PageHead.svelte";
  import Breadcrumb from "$components/ui/Breadcrumb.svelte";
  import Note from "$components/ui/Note.svelte";
  import Skeleton from "$components/ui/Skeleton.svelte";
  import GapsSection from "$lib/components/admin/monatsabschluss/GapsSection.svelte";
  import BreakBlockSection from "$lib/components/admin/monatsabschluss/BreakBlockSection.svelte";

  let config = $state<ClosingConfig | null>(null);
  let loadError = $state("");
  let loading = $state(true);

  // The unsaved counts of the sections, summed into ONE registration (a second registration under the
  // same id would let one section's cleanup disarm the other).
  const changes = $state({ luecken: 0, pausen: 0 });
  const totalChanges = $derived(changes.luecken + changes.pausen);

  // Gated on "the baseline has been taken": a failed load must not arm the navigation guard on a page
  // that shows nothing but an error.
  const snapshotsReady = $derived(config !== null && !loading && loadError === "");

  $effect(() => {
    markUnsaved("regeln-monatsabschluss", snapshotsReady && totalChanges > 0);
    return () => markUnsaved("regeln-monatsabschluss", false);
  });

  const user = $derived($authStore.user);
  const show = $derived({
    luecken: mayOpenSection(user, settingsSection("monatsabschluss-luecken")),
    pausen: mayOpenSection(user, settingsSection("monatsabschluss-pausen")),
  });

  onMount(async () => {
    try {
      config = await api.get<ClosingConfig>("/settings/work");
    } catch (err) {
      loadError =
        err instanceof Error ? err.message : "Die Einstellungen konnten nicht geladen werden.";
    } finally {
      loading = false;
    }
  });
</script>

<svelte:head>
  <title>{pageLabel("/verwalten/regeln/monatsabschluss")} – Clokr</title>
</svelte:head>

<Breadcrumb
  crumbs={[
    { label: pageLabel("/verwalten/regeln"), href: "/verwalten/regeln" },
    { label: pageLabel("/verwalten/regeln/monatsabschluss") },
  ]}
/>
<PageHead
  title={pageLabel("/verwalten/regeln/monatsabschluss")}
  sub="Hier legst du fest, wann ein Monat abgeschlossen werden darf. Den Abschluss selbst machst du unter „Monatsabschluss“ in der Verwaltung."
/>

{#if loading}
  <Skeleton shape="card" lines={3} />
{:else if loadError || config === null}
  <div role="alert"><Note tone="bad">{loadError}</Note></div>
{:else}
  {#if show.luecken}
    <GapsSection {config} bind:changes={changes.luecken} />
  {/if}
  {#if show.pausen}
    <BreakBlockSection {config} bind:changes={changes.pausen} />
  {/if}
{/if}
