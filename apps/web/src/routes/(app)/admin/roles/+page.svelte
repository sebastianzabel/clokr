<!--
  /admin/roles — „Rollen & Rechte“ (Issue #83, D-01). Tabs follow the caller's permissions; the
  route itself is guarded by the admin route map, and the API decides every request anyway. The
  page owns the role draft so a tab switch never discards it (D-09).
-->
<script lang="ts">
  import SectionStack from "$lib/components/admin/SectionStack.svelte";
  import RolesTab from "$lib/components/admin/roles/RolesTab.svelte";
  import { draftDirty, type RoleDraft } from "$lib/components/admin/roles/role-draft";
  import { authStore } from "$stores/auth";
  import { markUnsaved } from "$stores/unsaved";
  import { hasPermission } from "$lib/permissions";

  let canReadRoles = $derived(hasPermission($authStore.user, "role:read:ZUGEWIESEN"));
  let canManage = $derived(hasPermission($authStore.user, "role:manage:ZUGEWIESEN"));

  let tabs = $derived(canReadRoles ? [{ id: "roles", label: "Rollen" }] : []);
  let activeTab = $state<string | undefined>(undefined);

  let draft = $state<RoleDraft | null>(null);
  let snapshotsReady = $state(false);
  const rolesDirty = $derived(draft !== null && draftDirty(draft));

  $effect(() => {
    markUnsaved("admin-roles", snapshotsReady && rolesDirty);
    return () => markUnsaved("admin-roles", false);
  });
</script>

<SectionStack
  eyebrow="System"
  title="Rollen & Rechte"
  sub="Rollen aus dem Rechte-Katalog zusammenstellen und Personen zuweisen"
  {tabs}
  bind:activeTab
  animate
>
  {#snippet tabContent(tab)}
    {#if tab === "roles"}
      <RolesTab {canManage} bind:draft onReady={() => (snapshotsReady = true)} />
    {/if}
  {/snippet}
  {#if tabs.length === 0}
    <div class="callout error" role="alert">Für diese Seite fehlen Ihnen die Berechtigungen.</div>
  {/if}
</SectionStack>
