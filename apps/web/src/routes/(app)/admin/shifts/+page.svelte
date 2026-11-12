<script lang="ts">
  import { pageLabel } from "$lib/nav/page-labels";
  import { onMount } from "svelte";
  import { page } from "$app/stores";
  import { api } from "$api/client";
  import { toasts } from "$stores/toast";
  import { markUnsaved } from "$stores/unsaved";
  import {
    shiftBasedEmployees,
    type CoverageRule,
    type PatternEmployee,
    type PatternRow,
    type ShiftTemplate,
  } from "$lib/shifts/dienstplan-config";
  import { tabFromHash, writeTabHash } from "$lib/nav/tab-hash";
  import PageHead from "$lib/components/layout/PageHead.svelte";
  import CoverageRulesPanel from "$lib/components/admin/dienstplan/CoverageRulesPanel.svelte";
  import ShiftTemplatesPanel from "$lib/components/admin/dienstplan/ShiftTemplatesPanel.svelte";
  import WeekPatternsPanel from "$lib/components/admin/dienstplan/WeekPatternsPanel.svelte";
  import ErrorState from "$components/ui/ErrorState.svelte";
  import PageTabs from "$components/ui/PageTabs.svelte";
  import Skeleton from "$components/ui/Skeleton.svelte";

  // The panels of the page, in the order of the tab strip; the URL hash names one (D-854-03).
  const TABS = [
    { value: "vorlagen", label: "Schichtvorlagen" },
    { value: "bedarf", label: "Bedarfsregeln" },
    { value: "muster", label: "Wochenmuster" },
  ] as const;
  const TAB_IDS = TABS.map((tab) => tab.value);
  let activeTab = $state<string>(TAB_IDS[0]);

  function selectTab(next: string) {
    activeTab = next;
    writeTabHash(next);
  }

  // Issue #83 (D-13): access is decided by the admin layout guard (admin-route-permissions.ts);
  // the API answers 403 regardless.
  onMount(() => {
    activeTab = tabFromHash($page.url.hash, TAB_IDS);
    void loadAll();
  });

  // ── State ───────────────────────────────────────────────────
  let templates: ShiftTemplate[] = $state([]);
  let coverageRules: CoverageRule[] = $state([]);
  let shiftEmployees: PatternEmployee[] = $state([]);
  let patterns: PatternRow[] = $state([]);
  let loading = $state(true);
  let error = $state("");

  // Number of persons with unsaved pattern edits, reported by the Wochenmuster panel.
  let patternChanges = $state(0);

  // Gate the registration on "the panels have their baseline" (WR-01): loadAll can fail (its catch
  // sets `error`) or never run at all, and an unregistered page must not be able to arm the
  // navigation guard. Template and rule editors are Dialogs with an instant save and their own
  // Abbrechen: a dialog draft is out of the page registry on purpose.
  let snapshotsReady = $state(false);

  $effect(() => {
    markUnsaved("admin-shifts", snapshotsReady && patternChanges > 0);
    return () => markUnsaved("admin-shifts", false);
  });

  // ── Load all config ─────────────────────────────────────────
  async function loadAll() {
    loading = true;
    error = "";
    try {
      const todayIso = new Date().toISOString().slice(0, 10);
      const [tpls, rules, week, tenantPatterns] = await Promise.all([
        api.get<ShiftTemplate[]>("/shifts/templates"),
        api.get<CoverageRule[]>("/shifts/coverage-rules"),
        api.get<{ employees: PatternEmployee[] }>(`/shifts/week?date=${todayIso}`),
        api.get<PatternRow[]>("/shift-patterns/tenant"),
      ]);
      templates = tpls;
      coverageRules = rules;
      shiftEmployees = shiftBasedEmployees(week.employees ?? []);
      patterns = tenantPatterns;
      snapshotsReady = true;
    } catch (e) {
      console.error(e);
      error = "Die Konfiguration konnte nicht geladen werden.";
    } finally {
      loading = false;
    }
  }

  // Reloads the two lists a template or rule write can change; the pattern matrix and its unsaved
  // edits are left alone.
  async function reloadLists() {
    try {
      [templates, coverageRules] = await Promise.all([
        api.get<ShiftTemplate[]>("/shifts/templates"),
        api.get<CoverageRule[]>("/shifts/coverage-rules"),
      ]);
    } catch (e) {
      console.error(e);
      toasts.error("Die Listen konnten nicht neu geladen werden.");
    }
  }
</script>

<svelte:head>
  <title>{pageLabel("/admin/shifts")} – Clokr</title>
</svelte:head>

<PageHead
  title={pageLabel("/admin/shifts")}
  sub="Schichtvorlagen, Bedarfsregeln und Wochenmuster deines Unternehmens."
/>

{#if error}
  <ErrorState message={error} onRetry={loadAll} retrying={loading} />
{:else if loading}
  <Skeleton shape="card" count={2} lines={3} />
{:else}
  <PageTabs
    tabs={[...TABS]}
    tab={activeTab}
    onTabChange={selectTab}
    tabsLabel="Bereiche des Dienstplans"
  >
    {#snippet panel(value)}
      {#if value === "vorlagen"}
        <ShiftTemplatesPanel {templates} onChanged={reloadLists} />
      {:else if value === "bedarf"}
        <CoverageRulesPanel rules={coverageRules} {templates} onChanged={reloadLists} />
      {:else if value === "muster"}
        <WeekPatternsPanel
          employees={shiftEmployees}
          {patterns}
          {templates}
          bind:changes={patternChanges}
        />
      {/if}
    {/snippet}
  </PageTabs>
{/if}
