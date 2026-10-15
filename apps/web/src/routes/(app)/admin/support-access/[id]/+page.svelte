<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/stores";
  import { api } from "$api/client";
  import { authStore } from "$stores/auth";
  import { toasts } from "$stores/toast";
  import ListDetail from "$lib/components/admin/ListDetail.svelte";
  import SupportAccessDetail from "$lib/components/admin/SupportAccessDetail.svelte";
  import { formatInZone, type SupportAccessDetailResponse } from "$lib/support-access/labels";

  let detail = $state<SupportAccessDetailResponse | null>(null);
  // Starts TRUE for the same reason as the list: the request fires after mount.
  let loading = $state(true);
  let loadError = $state("");
  let notFound = $state(false);

  const accessId = $derived($page.params.id);

  const crumbs = $derived([
    { label: "Support-Zugriffe", href: "/admin/support-access" },
    {
      label: detail ? formatInZone(detail.access.startedAt, detail.timezone) : "Support-Zugriff",
    },
  ]);

  onMount(() => {
    void load();
  });

  /** `showSpinner` is false for the reload after an end, so the page does not flash empty. */
  async function load(showSpinner = true) {
    if (showSpinner) loading = true;
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
  <title>Support-Zugriff – Clokr</title>
</svelte:head>

<ListDetail
  view="detail"
  eyebrow="Compliance"
  title="Support-Zugriff"
  sub="Begründung, Zeitraum und alle Abrufe"
  {crumbs}
>
  {#snippet tabContent(_)}
    {#if loading}
      <div
        class="skeleton sa-detail-skeleton"
        role="status"
        aria-label="Support-Zugriff wird geladen"
      ></div>
    {:else if notFound}
      <div class="alert alert-error" role="alert">
        <span>⚠</span>
        <span>Support-Zugriff nicht gefunden.</span>
        <a class="btn btn-outline sm sa-back" href="/admin/support-access">Zurück zur Übersicht</a>
      </div>
    {:else if loadError || !detail}
      <div class="alert alert-error" role="alert">
        <span>⚠</span>
        <span>{loadError || "Der Support-Zugriff konnte nicht geladen werden."}</span>
        <button class="btn btn-outline sm sa-back" type="button" onclick={() => void load()}>
          Erneut laden
        </button>
      </div>
    {:else}
      <SupportAccessDetail {detail} user={$authStore.user} onEnd={endAccess} />
    {/if}
  {/snippet}
</ListDetail>

<style>
  .sa-detail-skeleton {
    height: 160px;
    border-radius: var(--r-lg);
  }

  .sa-back {
    margin-left: auto;
  }
</style>
