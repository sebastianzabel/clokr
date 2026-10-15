<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/stores";
  import { api, ApiError } from "$api/client";
  import { authStore } from "$stores/auth";
  import { salonContext } from "$stores/salon-context";
  import { toasts } from "$stores/toast";
  import { markUnsaved } from "$stores/unsaved";
  import { salonAdminRights } from "$lib/page-rights";
  import ListDetail from "$lib/components/admin/ListDetail.svelte";
  import Section from "$lib/components/admin/Section.svelte";
  import OpeningHoursEditor from "$lib/components/admin/OpeningHoursEditor.svelte";
  import {
    prefillOpeningHours,
    validateOpeningHours,
    type OpeningHoursDay,
  } from "$lib/salons/opening-hours";

  interface SalonDetail {
    id: string;
    name: string;
    isActive: boolean;
    openingHours: unknown;
  }

  const salonId = $derived($page.params.id);
  // Presentation only: the API refuses a write without salon:manage on its own.
  const rights = $derived(salonAdminRights($authStore.user));

  let salon = $state<SalonDetail | null>(null);
  let loading = $state(true);
  let loadError = $state("");
  let forbidden = $state(false);

  let hoursForm: OpeningHoursDay[] = $state([]);
  let hoursErrors: Record<number, string> = $state({});
  let saving = $state(false);

  // ── Unsaved-section tracking (Phase 109, D-11/D-12) ───────────────────────────────────────
  function snap(...values: unknown[]): string {
    return JSON.stringify(values);
  }

  let hoursSnapshot = $state("");
  let hoursDirty = $derived(snap(hoursForm) !== hoursSnapshot);

  // The registration is gated on "the baseline has been taken": a failed or not-found load must
  // not arm the navigation guard on a page that shows nothing but an error.
  let snapshotsReady = $state(false);

  $effect(() => {
    markUnsaved("admin-salon-detail", snapshotsReady && hoursDirty);
    return () => markUnsaved("admin-salon-detail", false);
  });

  function applySalon(loaded: SalonDetail) {
    salon = loaded;
    hoursForm = prefillOpeningHours(loaded.openingHours);
    hoursErrors = {};
    hoursSnapshot = snap(hoursForm);
  }

  /** Reloads the header salon context after every successful salon write (Issue #82, D-10). */
  async function refreshSalonContext() {
    await salonContext.load($authStore.user?.id ?? null, { force: true }).catch(() => undefined);
  }

  onMount(async () => {
    try {
      applySalon(await api.get<SalonDetail>(`/salons/${salonId}`));
      snapshotsReady = true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        forbidden = true;
      } else if (err instanceof ApiError && err.status === 404) {
        loadError = "Salon nicht gefunden.";
      } else {
        loadError = "Der Salon konnte nicht geladen werden.";
      }
    } finally {
      loading = false;
    }
  });

  async function saveHours() {
    hoursErrors = validateOpeningHours(hoursForm);
    if (Object.keys(hoursErrors).length > 0) {
      toasts.error("Bitte prüfen Sie die markierten Tage.");
      return;
    }
    saving = true;
    try {
      const updated: SalonDetail = await api.patch(`/salons/${salonId}`, {
        openingHours: hoursForm,
      });
      applySalon(updated);
      toasts.success("Öffnungszeiten gespeichert.");
      await refreshSalonContext();
    } catch (err) {
      toasts.error(err instanceof Error ? err.message : "Speichern fehlgeschlagen.");
    } finally {
      saving = false;
    }
  }
</script>

{#if loading}
  <div class="page-loading" role="status">Laden…</div>
{:else if forbidden}
  <div class="page-loading">Für die Salonübersicht fehlt Ihnen die Berechtigung.</div>
{:else if loadError || !salon}
  <div class="page-error">{loadError || "Salon nicht gefunden."}</div>
{:else}
  <ListDetail
    eyebrow="Administration"
    title={salon.name}
    sub="Öffnungszeiten dieses Salons"
    view="detail"
    crumbs={[{ label: "Salons", href: "/admin/salons" }, { label: salon.name }]}
    animate
  >
    {#snippet tabContent(_tab)}
      {#snippet saveFooter()}
        <button type="button" class="btn btn-primary btn-sm" onclick={saveHours} disabled={saving}>
          {saving ? "Speichern …" : "Öffnungszeiten speichern"}
        </button>
      {/snippet}
      <Section
        title="Öffnungszeiten"
        sub="Wochentägliche Öffnungs- und Schließzeiten dieses Salons. Die Schichtplanung prüft Schichten gegen diese Zeiten."
        dirty={hoursDirty}
        footer={rights.canManage ? saveFooter : undefined}
      >
        {#snippet actions()}
          <span class="badge" class:badge-green={salon.isActive} class:badge-gray={!salon.isActive}>
            {salon.isActive ? "Aktiv" : "Inaktiv"}
          </span>
        {/snippet}

        <OpeningHoursEditor
          bind:days={hoursForm}
          errors={hoursErrors}
          idPrefix="salon-hours"
          disabled={!rights.canManage}
        />
      </Section>
    {/snippet}
  </ListDetail>
{/if}

<style>
  .page-loading,
  .page-error {
    padding: var(--s-6);
    color: var(--text-muted);
    font-size: 14px;
  }

  .page-error {
    color: var(--bad);
  }
</style>
