<!--
  /admin/roles — „Rollen & Rechte“ (Issue #83, D-01; rebuilt on the blocks of #843 in Issue #854). Tabs follow
  the caller's permissions; the route itself is guarded by the admin route map, and the API decides every
  request anyway. The page owns the role draft so a tab switch never discards it (D-09).
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/stores";
  import { pageLabel } from "$lib/nav/page-labels";
  import { tabFromHash, writeTabHash } from "$lib/nav/tab-hash";
  import PageHead from "$lib/components/layout/PageHead.svelte";
  import RolesTab from "$lib/components/admin/roles/RolesTab.svelte";
  import AssignmentsTab from "$lib/components/admin/roles/AssignmentsTab.svelte";
  import { salonContext, moduleBooked } from "$stores/salon-context";
  import ModuleHint from "$lib/components/admin/ModuleHint.svelte";
  import { draftDirty, type RoleDraft } from "$lib/components/admin/roles/role-draft";
  import EmptyState from "$components/ui/EmptyState.svelte";
  import PageTabs from "$components/ui/PageTabs.svelte";
  import { authStore } from "$stores/auth";
  import { markUnsaved } from "$stores/unsaved";
  import { hasPermission } from "$lib/permissions";

  let canReadRoles = $derived(hasPermission($authStore.user, "role:read:ZUGEWIESEN"));
  let canManage = $derived(hasPermission($authStore.user, "role:manage:ZUGEWIESEN"));
  let canAssign = $derived(hasPermission($authStore.user, "role-assignment:manage:ZUGEWIESEN"));

  // Display only (Phase 566, D-12; sixth set-up spot, Issue #624): a new own role needs the
  // Ketten-Paket. An unknown package state (null) hides nothing; the server's 409 stays the authority.
  const chainHint = $derived(moduleBooked($salonContext, "CHAIN") === false);

  // ── Tabs (D-854-26: lowercase German ids; `roles` is the id of the former page) ──
  const TAB_ALIASES = { roles: "rollen" };
  let tabs = $derived([
    ...(canReadRoles ? [{ value: "rollen", label: "Rollen" }] : []),
    ...(canAssign ? [{ value: "zuweisungen", label: "Zuweisungen" }] : []),
  ]);
  // The tab the URL hash or a click asked for; a tab this person does not see falls back to the first.
  let requestedTab = $state<string | undefined>(undefined);
  let activeTab = $derived(
    tabs.some((tab) => tab.value === requestedTab)
      ? (requestedTab as string)
      : (tabs[0]?.value ?? ""),
  );

  function selectTab(next: string) {
    requestedTab = next;
    writeTabHash(next);
  }

  onMount(() => {
    const ids = tabs.map((tab) => tab.value);
    if (ids.length > 0) requestedTab = tabFromHash($page.url.hash, ids, TAB_ALIASES);
  });

  let draft = $state<RoleDraft | null>(null);
  let snapshotsReady = $state(false);
  const rolesDirty = $derived(draft !== null && draftDirty(draft));

  $effect(() => {
    markUnsaved("admin-roles", snapshotsReady && rolesDirty);
    return () => markUnsaved("admin-roles", false);
  });
</script>

<svelte:head><title>{pageLabel("/admin/roles")} – Clokr</title></svelte:head>

{#snippet chainHintSnippet()}
  <ModuleHint module="CHAIN" subject="Eigene Rollen" />
{/snippet}

<PageHead
  title={pageLabel("/admin/roles")}
  sub="Rollen aus dem Rechte-Katalog zusammenstellen und Personen zuweisen."
/>

{#if tabs.length === 0}
  <div role="alert">
    <EmptyState title="Kein Zugriff" description="Für diese Seite fehlen dir die Berechtigungen." />
  </div>
{:else}
  <PageTabs {tabs} tab={activeTab} onTabChange={selectTab} tabsLabel="Bereiche von Rollen & Rechte">
    {#snippet panel(value)}
      {#if value === "rollen" && activeTab === "rollen"}
        <RolesTab
          {canManage}
          bind:draft
          onReady={() => (snapshotsReady = true)}
          createHint={chainHint ? chainHintSnippet : undefined}
        />
      {:else if value === "zuweisungen" && activeTab === "zuweisungen"}
        <AssignmentsTab
          {canReadRoles}
          salons={$salonContext.salons}
          salonsLoaded={$salonContext.loaded}
        />
      {/if}
    {/snippet}
  </PageTabs>
{/if}
