<!--
  HubPage — Issue #844 (D-844-08): the overview page of a Verwalten hub (Übersicht, Regeln, Daten, System). It
  lists the hub's children from the route table that the reader may open, one line each with its description,
  so the pages behind a hub can be rebuilt (#854) without touching the navigation. The content of
  Verwalten › Übersicht beyond this list is #847.
-->
<script lang="ts">
  import { authStore } from "$stores/auth";
  import { tenantFeatures } from "$stores/tenant-features";
  import PageHead from "$lib/components/layout/PageHead.svelte";
  import Icon from "$lib/components/Icon.svelte";
  import { AREA_LABELS, visibleChildren } from "$lib/nav/routes";
  import type { Snippet } from "svelte";

  interface Props {
    /** The hub's name (from pageLabel of the hub's href). */
    title: string;
    /** The hub's href in the route table. */
    hub: string;
    sub?: string;
    /** Issue #847: the hub's own content above the list (Verwalten › Übersicht). */
    intro?: Snippet;
    /** Heading of the list when an intro precedes it. */
    listTitle?: string;
  }

  let { title, hub, sub, intro, listTitle }: Props = $props();

  const children = $derived(
    visibleChildren($authStore.user, hub, {
      availabilityEnabled: $tenantFeatures.availabilityEnabled,
    }),
  );
</script>

<PageHead eyebrow={AREA_LABELS.verwalten} {title} {sub} />

{#if intro}{@render intro()}{/if}
{#if listTitle && children.length > 0}<h2 class="hub-list-title">{listTitle}</h2>{/if}

{#if children.length === 0}
  <p class="hub-empty">Hier gibt es für dich nichts zu verwalten.</p>
{:else}
  <ul class="card hub-list" data-testid="hub-list">
    {#each children as child (child.href)}
      <li>
        <a class="hub-row" href={child.href}>
          <span class="hub-icon"><Icon name={child.icon} /></span>
          <span class="hub-text">
            <span class="hub-name">{child.label}</span>
            {#if child.description}<span class="hub-desc">{child.description}</span>{/if}
          </span>
        </a>
      </li>
    {/each}
  </ul>
{/if}

<style>
  .hub-list-title {
    margin: var(--s-6) 0 var(--s-2);
    font-size: var(--fs-h2);
    font-weight: 600;
  }
  .hub-list {
    list-style: none;
    margin: 0;
    padding: var(--s-1) 0;
  }
  .hub-list li + li {
    border-top: 1px solid var(--line);
  }
  .hub-row {
    display: flex;
    align-items: center;
    gap: var(--s-3);
    min-height: 56px;
    padding: var(--s-2) var(--s-4);
    color: var(--text);
    text-decoration: none;
  }
  .hub-row:hover {
    background: var(--hover);
  }
  .hub-row:focus-visible {
    outline: 2px solid var(--brand);
    outline-offset: -2px;
  }
  .hub-icon {
    color: var(--text-2);
    display: inline-flex;
  }
  .hub-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .hub-name {
    font-weight: 600;
  }
  .hub-desc,
  .hub-empty {
    color: var(--text-2);
    font-size: var(--fs-sm);
  }
</style>
