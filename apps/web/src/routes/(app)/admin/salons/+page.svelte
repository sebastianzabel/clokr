<script lang="ts">
  import { onMount } from "svelte";
  import { api, ApiError } from "$api/client";
  import { authStore } from "$stores/auth";
  import { salonContext, moduleBooked } from "$stores/salon-context";
  import { salonAdminRights } from "$lib/page-rights";
  import ListDetail from "$lib/components/admin/ListDetail.svelte";
  import Section from "$lib/components/admin/Section.svelte";
  import ModuleHint from "$lib/components/admin/ModuleHint.svelte";
  import { federalStateLabel } from "$lib/salons/federal-states";
  import type { SalonDto } from "$lib/salons/salon-form";

  // Presentation only: the API refuses a create without salon:manage on its own.
  const rights = $derived(salonAdminRights($authStore.user));

  let salons: SalonDto[] = $state([]);
  let loading = $state(true);
  let loadError = $state("");
  let forbidden = $state(false);

  const activeCount = $derived(salons.filter((salon) => salon.isActive).length);
  // Display only (Phase 566, D-12; fifth set-up spot, Issue #563 D-18): without the CHAIN module
  // the salon limit is reached with the first active salon. An unknown package state (null) hides
  // nothing, and the server's 409 on create and activate stays the authority.
  const chainHint = $derived(
    moduleBooked($salonContext, "CHAIN") === false &&
      activeCount >= ($salonContext.packages?.salonLimit ?? Number.POSITIVE_INFINITY),
  );

  /** "Straße, PLZ Ort" from the non-empty parts, "—" when the salon has no address at all. */
  function addressOf(salon: SalonDto): string {
    const place = [salon.postalCode, salon.city].filter((part) => part && part.trim()).join(" ");
    const parts = [salon.street, place].filter((part) => part && part.trim());
    return parts.length > 0 ? parts.join(", ") : "—";
  }

  onMount(async () => {
    try {
      const res = await api.get<{ salons: SalonDto[] }>("/salons?includeInactive=true");
      salons = res.salons;
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        forbidden = true;
      } else {
        loadError = "Die Salons konnten nicht geladen werden.";
      }
    } finally {
      loading = false;
    }
  });
</script>

<ListDetail
  eyebrow="Administration"
  title="Salons"
  sub="Standorte Ihres Unternehmens mit Adresse und Öffnungszeiten."
  animate
  view="list"
>
  {#snippet actions()}
    {#if rights.canManage}
      {#if chainHint}
        <ModuleHint module="CHAIN" subject="Weitere Salons" />
      {:else}
        <a class="btn btn-primary btn-sm" href="/admin/salons/neu">Salon anlegen</a>
      {/if}
    {/if}
  {/snippet}

  {#snippet list()}
    {#if loading}
      <Section>
        <p class="text-muted" role="status">Wird geladen…</p>
      </Section>
    {:else if forbidden}
      <Section>
        <p class="text-muted">Für die Salonübersicht fehlt Ihnen die Berechtigung.</p>
      </Section>
    {:else if loadError}
      <div class="alert alert-error">{loadError}</div>
    {:else if salons.length === 0}
      <Section>
        <p class="text-muted">Noch keine Salons angelegt.</p>
      </Section>
    {:else}
      <Section title="Alle Salons" sub="Aktive und deaktivierte Standorte">
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th class="col-state">Bundesland</th>
                <th class="col-address">Adresse</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {#each salons as salon (salon.id)}
                <tr>
                  <td><a href="/admin/salons/{salon.id}">{salon.name}</a></td>
                  <td class="col-state">{federalStateLabel(salon.federalState)}</td>
                  <td class="text-muted col-address">{addressOf(salon)}</td>
                  <td>
                    <span
                      class="badge"
                      class:badge-green={salon.isActive}
                      class:badge-gray={!salon.isActive}
                    >
                      {salon.isActive ? "Aktiv" : "Inaktiv"}
                    </span>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </Section>
    {/if}
  {/snippet}
</ListDetail>

<style>
  /* Below the phone breakpoint the address and the Bundesland give way so the name and the status
     badge always fit the card: with all four columns the status column was cut off inside the
     table's own scroll box at 390 and 360 px (measured, Issue #563). Both values stay readable on
     the salon's detail page. */
  @media (max-width: 640px) {
    .col-address,
    .col-state {
      display: none;
    }
  }
</style>
