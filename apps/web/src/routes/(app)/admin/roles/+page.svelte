<!--
  /admin/roles — „Rollen & Rechte“ (Issue #83, D-01). Tabs follow the caller's permissions; the
  route itself is guarded by the admin route map, and the API decides every request anyway. The
  page owns the role draft so a tab switch never discards it (D-09).
-->
<script lang="ts">
  import { pageLabel } from "$lib/nav/page-labels";
  import SectionStack from "$lib/components/admin/SectionStack.svelte";
  import RolesTab from "$lib/components/admin/roles/RolesTab.svelte";
  import AssignmentsTab from "$lib/components/admin/roles/AssignmentsTab.svelte";
  import { salonContext, moduleBooked } from "$stores/salon-context";
  import ModuleHint from "$lib/components/admin/ModuleHint.svelte";
  import { draftDirty, type RoleDraft } from "$lib/components/admin/roles/role-draft";
  import { authStore } from "$stores/auth";
  import { markUnsaved } from "$stores/unsaved";
  import { hasPermission } from "$lib/permissions";

  let canReadRoles = $derived(hasPermission($authStore.user, "role:read:ZUGEWIESEN"));
  let canManage = $derived(hasPermission($authStore.user, "role:manage:ZUGEWIESEN"));
  let canAssign = $derived(hasPermission($authStore.user, "role-assignment:manage:ZUGEWIESEN"));

  // Display only (Phase 566, D-12; sixth set-up spot, Issue #624): a new own role needs the
  // Ketten-Paket. An unknown package state (null) hides nothing; the server's 409 stays the authority.
  const chainHint = $derived(moduleBooked($salonContext, "CHAIN") === false);

  let tabs = $derived([
    ...(canReadRoles ? [{ id: "roles", label: "Rollen" }] : []),
    ...(canAssign ? [{ id: "zuweisungen", label: "Zuweisungen" }] : []),
  ]);
  let activeTab = $state<string | undefined>(undefined);

  let draft = $state<RoleDraft | null>(null);
  let snapshotsReady = $state(false);
  const rolesDirty = $derived(draft !== null && draftDirty(draft));

  $effect(() => {
    markUnsaved("admin-roles", snapshotsReady && rolesDirty);
    return () => markUnsaved("admin-roles", false);
  });
</script>

{#snippet chainHintSnippet()}
  <ModuleHint module="CHAIN" subject="Eigene Rollen" />
{/snippet}

<SectionStack
  eyebrow="System"
  title={pageLabel("/admin/roles")}
  sub="Rollen aus dem Rechte-Katalog zusammenstellen und Personen zuweisen"
  {tabs}
  bind:activeTab
  animate
>
  {#snippet tabContent(tab)}
    {#if tab === "roles"}
      <RolesTab
        {canManage}
        bind:draft
        onReady={() => (snapshotsReady = true)}
        createHint={chainHint ? chainHintSnippet : undefined}
      />
    {:else if tab === "zuweisungen"}
      <AssignmentsTab
        {canReadRoles}
        salons={$salonContext.salons}
        salonsLoaded={$salonContext.loaded}
      />
    {/if}
  {/snippet}
  {#if tabs.length === 0}
    <div class="callout error" role="alert">Für diese Seite fehlen Ihnen die Berechtigungen.</div>
  {/if}
</SectionStack>
