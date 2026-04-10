<script lang="ts">
  interface Crumb {
    label: string;
    href?: string;
  }

  interface Props {
    crumbs: Crumb[];
  }

  let { crumbs }: Props = $props();
</script>

<nav class="breadcrumb" aria-label="Breadcrumb">
  <ol class="breadcrumb-list">
    {#each crumbs as crumb, i (crumb.label)}
      <li class="breadcrumb-item">
        {#if i > 0}
          <svg
            class="breadcrumb-sep"
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"><polyline points="9 18 15 12 9 6" /></svg
          >
        {/if}
        {#if crumb.href && i < crumbs.length - 1}
          <a href={crumb.href} class="breadcrumb-link">{crumb.label}</a>
        {:else}
          <span
            class="breadcrumb-current"
            aria-current={i === crumbs.length - 1 ? "page" : undefined}>{crumb.label}</span
          >
        {/if}
      </li>
    {/each}
  </ol>
</nav>

<style>
  .breadcrumb {
    margin-bottom: 1rem;
  }

  .breadcrumb-list {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    list-style: none;
    padding: 0;
    margin: 0;
    font-size: 0.8125rem;
  }

  .breadcrumb-item {
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }

  .breadcrumb-sep {
    color: var(--color-text-muted);
    opacity: 0.5;
  }

  .breadcrumb-link {
    color: var(--color-text-muted);
    text-decoration: none;
    transition: color 0.15s;
  }

  .breadcrumb-link:hover {
    color: var(--color-brand);
  }

  .breadcrumb-current {
    color: var(--color-text);
    font-weight: 500;
  }
</style>
