<script lang="ts">
  interface Props {
    total: number;
    page?: number;
    pageSize?: number;
    pageSizeOptions?: number[];
    labelSingular?: string;
    labelPlural?: string;
    showWhenSinglePage?: boolean;
    onChange?: (p: { page: number; pageSize: number }) => void;
  }

  let {
    total,
    page = $bindable(1),
    pageSize = $bindable(10),
    pageSizeOptions = [10, 25, 50],
    labelSingular = "Eintrag",
    labelPlural = "Einträge",
    showWhenSinglePage = false,
    onChange,
  }: Props = $props();

  let totalPages = $derived(Math.max(1, Math.ceil(total / pageSize)));
  let startItem = $derived(total === 0 ? 0 : (page - 1) * pageSize + 1);
  let endItem = $derived(Math.min(page * pageSize, total));
  let visible = $derived(showWhenSinglePage || total > pageSizeOptions[0]);

  $effect(() => {
    if (page > totalPages) page = totalPages;
  });

  function prevPage() {
    page = Math.max(1, page - 1);
    onChange?.({ page, pageSize });
  }

  function nextPage() {
    page = Math.min(totalPages, page + 1);
    onChange?.({ page, pageSize });
  }

  function onPageSizeChange() {
    page = 1;
    onChange?.({ page, pageSize });
  }
</script>

{#if visible}
  <nav class="pag-wrap" aria-label="Seitennavigation">
    <span class="pag-range" aria-live="polite">
      <span class="pag-num">{startItem}</span>–<span class="pag-num">{endItem}</span>
      von
      <span class="pag-num">{total}</span>
      {total === 1 ? labelSingular : labelPlural}
    </span>

    <div class="pag-controls">
      <label class="pag-size-label" for="pag-size-select">Pro Seite</label>
      <select
        id="pag-size-select"
        class="form-input pag-select"
        bind:value={pageSize}
        onchange={onPageSizeChange}
        aria-label="Zeilen pro Seite"
      >
        {#each pageSizeOptions as opt (opt)}
          <option value={opt}>{opt}</option>
        {/each}
      </select>

      <button
        class="btn btn-sm btn-ghost"
        disabled={page <= 1}
        onclick={prevPage}
        aria-label="Vorherige Seite"
      >
        ◀ Zurück
      </button>

      <span class="pag-page-indicator" aria-current="page">
        Seite <span class="pag-num">{page}</span> von <span class="pag-num">{totalPages}</span>
      </span>

      <button
        class="btn btn-sm btn-ghost"
        disabled={page >= totalPages}
        onclick={nextPage}
        aria-label="Nächste Seite"
      >
        Weiter ▶
      </button>
    </div>
  </nav>
{/if}

<style>
  .pag-wrap {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 0.75rem;
    padding: 0.875rem 1.25rem;
    border-top: 1px solid var(--color-border);
    font-size: 0.875rem;
    color: var(--color-text-muted);
  }

  .pag-range {
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }

  .pag-num {
    font-family: var(--font-mono);
    color: var(--color-text);
    font-weight: 500;
  }

  .pag-controls {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .pag-size-label {
    font-size: 0.875rem;
    color: var(--color-text-muted);
    white-space: nowrap;
  }

  .pag-select {
    width: auto;
    min-width: 4.5rem;
    padding: 0.375rem 0.625rem;
    font-size: 0.875rem;
  }

  .pag-page-indicator {
    font-size: 0.875rem;
    color: var(--color-text-muted);
    white-space: nowrap;
    padding: 0 0.25rem;
  }

  @media (max-width: 480px) {
    .pag-wrap {
      flex-direction: column;
      align-items: flex-start;
    }

    .pag-controls {
      width: 100%;
      justify-content: flex-start;
    }
  }
</style>
