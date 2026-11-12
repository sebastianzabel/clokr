<!--
  Verwalten › Regeln › Arbeitszeit & Verträge (Issue #854, D-854-03): the working-time defaults of the
  whole company, one section per concern, each with its own SaveBar. The sections were moved here from
  the System and Urlaub pages - every setting lives exactly once (lib/settings/settings-pages.ts).

  The page loads `GET /settings/work` once and hands it to the sections; each section keeps its own
  snapshot and sends only its own fields (#878). A person sees a section only under the permission
  alternatives of the page it came from (D-854-05); the page itself opens under their union.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "$api/client";
  import { authStore } from "$stores/auth";
  import { markUnsaved } from "$stores/unsaved";
  import { pageLabel } from "$lib/nav/page-labels";
  import { mayOpenSection, settingsSection } from "$lib/settings/settings-pages";
  import type { WorkConfig } from "$lib/settings/arbeitszeit";
  import PageHead from "$lib/components/layout/PageHead.svelte";
  import Breadcrumb from "$components/ui/Breadcrumb.svelte";
  import Note from "$components/ui/Note.svelte";
  import Skeleton from "$components/ui/Skeleton.svelte";
  import BreaksSection from "$lib/components/admin/arbeitszeit/BreaksSection.svelte";
  import RetroWindowSection from "$lib/components/admin/arbeitszeit/RetroWindowSection.svelte";
  import WorkDaysSection from "$lib/components/admin/arbeitszeit/WorkDaysSection.svelte";
  import CoreHoursSection from "$lib/components/admin/arbeitszeit/CoreHoursSection.svelte";
  import VocationalSlotsSection from "$lib/components/admin/arbeitszeit/VocationalSlotsSection.svelte";

  let config = $state<WorkConfig | null>(null);
  let loadError = $state("");
  let loading = $state(true);

  // The unsaved counts of the sections, summed into ONE registration (a second registration under the
  // same id would let one section's cleanup disarm the others).
  const changes = $state({
    pausen: 0,
    rueckwirkend: 0,
    arbeitstage: 0,
    gleitzeit: 0,
    berufsschule: 0,
  });
  const totalChanges = $derived(Object.values(changes).reduce((sum, n) => sum + n, 0));

  // Gated on "the baseline has been taken": a failed load must not arm the navigation guard on a page
  // that shows nothing but an error.
  const snapshotsReady = $derived(config !== null && !loading && loadError === "");

  $effect(() => {
    markUnsaved("regeln-arbeitszeit", snapshotsReady && totalChanges > 0);
    return () => markUnsaved("regeln-arbeitszeit", false);
  });

  const user = $derived($authStore.user);
  const show = $derived({
    pausen: mayOpenSection(user, settingsSection("arbeitszeit-pausen")),
    rueckwirkend: mayOpenSection(user, settingsSection("arbeitszeit-rueckwirkend")),
    arbeitstage: mayOpenSection(user, settingsSection("arbeitszeit-arbeitstage")),
    gleitzeit: mayOpenSection(user, settingsSection("arbeitszeit-gleitzeit")),
    berufsschule: mayOpenSection(user, settingsSection("arbeitszeit-berufsschule")),
  });

  onMount(async () => {
    try {
      config = await api.get<WorkConfig>("/settings/work");
    } catch (err) {
      loadError =
        err instanceof Error ? err.message : "Die Einstellungen konnten nicht geladen werden.";
    } finally {
      loading = false;
    }
  });
</script>

<svelte:head>
  <title>{pageLabel("/verwalten/regeln/arbeitszeit")} – Clokr</title>
</svelte:head>

<Breadcrumb
  crumbs={[
    { label: pageLabel("/verwalten/regeln"), href: "/verwalten/regeln" },
    { label: pageLabel("/verwalten/regeln/arbeitszeit") },
  ]}
/>
<PageHead
  title={pageLabel("/verwalten/regeln/arbeitszeit")}
  sub="Diese Vorgaben gelten für alle im Unternehmen. Für einzelne Personen legst du sie im Vertrag der Person fest."
/>

{#if loading}
  <Skeleton shape="card" lines={4} />
{:else if loadError || config === null}
  <div role="alert"><Note tone="bad">{loadError}</Note></div>
{:else}
  {#if show.pausen}
    <BreaksSection {config} bind:changes={changes.pausen} />
  {/if}
  {#if show.rueckwirkend}
    <RetroWindowSection {config} bind:changes={changes.rueckwirkend} />
  {/if}
  {#if show.arbeitstage}
    <WorkDaysSection {config} bind:changes={changes.arbeitstage} />
  {/if}
  {#if show.gleitzeit}
    <CoreHoursSection {config} bind:changes={changes.gleitzeit} />
  {/if}
  {#if show.berufsschule}
    <VocationalSlotsSection {config} bind:changes={changes.berufsschule} />
  {/if}
{/if}
