<!--
  Verwalten › Daten › Support-Zugriffe › one access (Issue #93, #854): the grant (operator display name,
  reason, window, status), every read made under it, and „Zugriff beenden“ behind a ConfirmDialog (only with
  tenant-settings:update; the API's 403 stays the authority). Never an operator e-mail or IP (T-854-64).
-->
<script lang="ts">
  import { pageLabel } from "$lib/nav/page-labels";
  import { onMount } from "svelte";
  import { page } from "$app/stores";
  import { api } from "$api/client";
  import { authStore } from "$stores/auth";
  import { toasts } from "$stores/toast";
  import PageHead from "$lib/components/layout/PageHead.svelte";
  import SupportAccessDetail from "$lib/components/admin/SupportAccessDetail.svelte";
  import Note from "$components/ui/Note.svelte";
  import Skeleton from "$components/ui/Skeleton.svelte";
  import { formatInZone, type SupportAccessDetailResponse } from "$lib/support-access/labels";

  let detail = $state<SupportAccessDetailResponse | null>(null);
  // Starts TRUE for the same reason as the list: the request fires after mount.
  let loading = $state(true);
  let loadError = $state("");
  let notFound = $state(false);

  const accessId = $derived($page.params.id);

  const windowText = $derived.by(() => {
    if (!detail) return "";
    const { access, timezone } = detail;
    return `${formatInZone(access.startedAt, timezone)} – ${formatInZone(access.endedAt ?? access.expiresAt, timezone)}`;
  });

  onMount(() => {
    void load();
  });

  /** `showSkeleton` is false for the reload after an end, so the page does not flash empty. */
  async function load(showSkeleton = true) {
    if (showSkeleton) loading = true;
    loadError = "";
    notFound = false;
    try {
      detail = await api.get<SupportAccessDetailResponse>(`/support-accesses/${accessId}`);
    } catch (e: unknown) {
      if ((e as { status?: number })?.status === 404) {
        notFound = true;
      } else {
        loadError = "Der Support-Zugriff konnte nicht geladen werden.";
      }
    } finally {
      loading = false;
    }
  }

  /** A refusal (for example 409 because the access already ended) rejects and stays in the dialog. */
  async function endAccess() {
    await api.post(`/support-accesses/${accessId}/end`, {});
    toasts.success("Support-Zugriff beendet.");
    await load(false);
  }
</script>

<svelte:head>
  <title>Support-Zugriff – {pageLabel("/admin/support-access")} – Clokr</title>
</svelte:head>

<div data-testid="admin-support-access-detail-page" style="display: contents;">
  {#if loading}
    <Skeleton shape="card" lines={3} />
  {:else if notFound}
    <div role="alert"><Note tone="bad">Support-Zugriff nicht gefunden.</Note></div>
    <a class="btn btn-secondary" href="/admin/support-access">Zurück zur Übersicht</a>
  {:else if loadError || !detail}
    <div role="alert">
      <Note tone="bad">{loadError || "Der Support-Zugriff konnte nicht geladen werden."}</Note>
    </div>
    <button class="btn btn-secondary" type="button" onclick={() => void load()}>
      Erneut laden
    </button>
  {:else}
    <PageHead title={`Support-Zugriff von ${detail.access.operatorName}`} sub={windowText} />
    <SupportAccessDetail {detail} user={$authStore.user} onEnd={endAccess} />
  {/if}
</div>
