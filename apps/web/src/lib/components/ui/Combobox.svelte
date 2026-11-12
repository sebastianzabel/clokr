<script lang="ts">
  // Issue #843 (D-843-01 block 7) - single-select combobox on bits-ui. The input filters through
  // the one search normaliser (`$lib/table/search`); the first ArrowDown or any typed text opens the list, further
  // arrows move the highlight, Enter selects. The list is portaled, so its parts render through
  // the bits-ui `child` snippets and the scoped CSS of this file applies to them.
  import { Combobox } from "bits-ui";
  import { matchesSearch } from "$lib/table/search";

  interface ComboboxItem {
    value: string;
    label: string;
  }

  interface Props {
    items: ComboboxItem[];
    /** Two-way bindable selected value; "" while nothing is selected. */
    value?: string;
    /** Accessible name when the combobox is not inside a FormField. */
    label?: string;
    placeholder?: string;
    disabled?: boolean;
    /** FormField attrs: the id the label points at, the describedby list and the invalid flag. */
    id?: string;
    describedBy?: string;
    invalid?: boolean;
    /** Called after the user picked an item. */
    onValueChange?: (value: string) => void;
  }

  let {
    items,
    value = $bindable(""),
    label,
    placeholder,
    disabled = false,
    id,
    describedBy,
    invalid = false,
    onValueChange,
  }: Props = $props();

  const selectedLabel = $derived(items.find((i) => i.value === value)?.label ?? "");

  // What the input shows, and the part of it that filters. After a pick the input shows the label
  // but the list shows everything again, so `search` is tracked apart from the input text.
  let search = $state("");
  // Writable derived: follows the bound value when the caller changes it, and the user's typing
  // overrides it until the next change.
  let inputText = $derived(selectedLabel);
  // The list is as wide as the field; measured when it opens (no ResizeObserver needed).
  let fieldEl: HTMLElement | null = $state(null);
  let fieldWidth = $state(0);

  const filtered = $derived(items.filter((i) => matchesSearch(i.label, search)));

  // bits-ui opens the list on keydown only. Text that arrives without a key press (paste, IME
  // composition, autofill) would filter a list nobody sees, so typed text opens it too (#853).
  let open = $state(false);

  function onInput(e: Event) {
    const text = (e.currentTarget as HTMLInputElement).value;
    inputText = text;
    search = text;
    if (text !== "" && !open && !disabled) {
      if (fieldEl) fieldWidth = fieldEl.getBoundingClientRect().width;
      open = true;
    }
  }

  function onOpenChange(next: boolean) {
    if (next && fieldEl) fieldWidth = fieldEl.getBoundingClientRect().width;
    if (!next) {
      // Closing without a pick drops the query and shows the selected label again.
      search = "";
      inputText = selectedLabel;
    }
  }

  function onPick(next: string) {
    search = "";
    onValueChange?.(next);
  }
</script>

<div class="combobox">
  <Combobox.Root
    type="single"
    bind:value
    {items}
    {disabled}
    inputValue={inputText}
    bind:open
    loop
    {onOpenChange}
    onValueChange={onPick}
  >
    <div class="cb-field" class:cb-invalid={invalid} bind:this={fieldEl}>
      <Combobox.Input
        {id}
        class="cb-input"
        aria-label={label}
        aria-describedby={describedBy}
        aria-invalid={invalid ? "true" : undefined}
        {placeholder}
        oninput={onInput}
      />
      <Combobox.Trigger class="cb-trigger" aria-label="Optionen anzeigen">
        <svg
          aria-hidden="true"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </Combobox.Trigger>
    </div>
    <Combobox.Portal>
      <Combobox.Content sideOffset={4} collisionPadding={8}>
        {#snippet child({ props, wrapperProps, open: isOpen })}
          {#if isOpen}
            <div {...wrapperProps} class="cb-wrapper">
              <div {...props} class="cb-content" style:min-width="{fieldWidth}px">
                <Combobox.Viewport>
                  {#each filtered as item (item.value)}
                    <Combobox.Item value={item.value} label={item.label}>
                      {#snippet child({ props: itemProps, selected, highlighted })}
                        <div
                          {...itemProps}
                          class="cb-item"
                          class:cb-item--on={highlighted}
                          class:cb-item--selected={selected}
                        >
                          <span class="cb-item-label">{item.label}</span>
                          {#if selected}
                            <svg
                              class="cb-check"
                              aria-hidden="true"
                              width="14"
                              height="14"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              stroke-width="2.5"
                              stroke-linecap="round"
                              stroke-linejoin="round"
                            >
                              <path d="M20 6 9 17l-5-5" />
                            </svg>
                          {/if}
                        </div>
                      {/snippet}
                    </Combobox.Item>
                  {:else}
                    <p class="cb-empty">Keine Treffer</p>
                  {/each}
                </Combobox.Viewport>
              </div>
            </div>
          {/if}
        {/snippet}
      </Combobox.Content>
    </Combobox.Portal>
  </Combobox.Root>
</div>

<style>
  .combobox {
    min-width: 0;
  }

  .cb-field {
    position: relative;
    display: flex;
    align-items: center;
    min-height: var(--h-control);
    border: 1px solid var(--line-2);
    border-radius: var(--r-control);
    background: var(--card);
    color: var(--text);
  }

  .cb-field:focus-within {
    border-color: var(--brand);
  }

  .cb-field.cb-invalid {
    border-color: var(--bad);
  }

  .cb-field :global(.cb-input) {
    flex: 1;
    min-width: 0;
    min-height: calc(var(--h-control) - 2px);
    padding: 0 var(--s-2) 0 var(--s-3);
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: var(--fs-base);
    outline: none;
  }

  .cb-field :global(.cb-input::placeholder) {
    color: var(--text-3);
  }

  .cb-field :global(.cb-trigger) {
    display: inline-grid;
    place-items: center;
    width: var(--h-control-sm);
    height: var(--h-control-sm);
    margin-right: 2px;
    border: 0;
    border-radius: var(--r-control);
    background: transparent;
    color: var(--text-2);
    cursor: pointer;
  }

  .cb-field :global(.cb-trigger:hover) {
    background: var(--hover);
  }

  .cb-field:has(:global(.cb-input:disabled)) {
    opacity: 0.6;
  }

  .cb-wrapper {
    z-index: 1600;
  }

  /* bits-ui copies the COMPUTED z-index of the content onto the floating wrapper (inline style,
     which beats the class above), so the stacking value has to sit on the content itself or the
     list renders under a Dialog (1500/1501) it was opened from (Issue #853, „Für wen?“). */
  .cb-content {
    z-index: 1600;
    max-height: min(280px, 50vh);
    overflow-y: auto;
    padding: var(--s-1);
    border: 1px solid var(--line);
    border-radius: var(--r-control);
    background: var(--card);
    color: var(--text);
    box-shadow: var(--shadow-pop);
  }

  .cb-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-2);
    min-height: var(--h-row);
    padding: 0 var(--s-3);
    border-radius: var(--r-control);
    font-size: var(--fs-base);
    cursor: pointer;
  }

  .cb-item-label {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .cb-item--on {
    background: var(--hover);
  }

  .cb-item--selected {
    font-weight: 600;
  }

  .cb-check {
    flex-shrink: 0;
    color: var(--brand);
  }

  .cb-empty {
    margin: 0;
    padding: var(--s-3);
    color: var(--text-2);
    font-size: var(--fs-sm);
  }
</style>
