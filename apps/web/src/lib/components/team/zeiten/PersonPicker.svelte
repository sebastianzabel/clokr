<script lang="ts">
  // Issue #853 (D-853-10, S-32) - the person picker of Team › Zeiten: a FormField with the #843
  // Combobox. The leader types a name or a Personalnummer (both sit in the option label, see
  // `personOptions`) and picks with the keyboard. Template only: no `$app` import, no store, no
  // request, so it mounts in a test; the page owns the list and reacts in `onValueChange`.
  import FormField from "$components/ui/FormField.svelte";
  import Combobox from "$components/ui/Combobox.svelte";

  interface PersonItem {
    value: string;
    label: string;
  }

  interface Props {
    items: PersonItem[];
    /** Two-way bindable id of the chosen person; "" while nobody is chosen. */
    value?: string;
    label?: string;
    placeholder?: string;
    /** Called after the user picked a person. */
    onValueChange?: (value: string) => void;
  }

  let {
    items,
    value = $bindable(""),
    label = "Person",
    placeholder = "Name oder Personalnummer",
    onValueChange,
  }: Props = $props();
</script>

<FormField {label}>
  {#snippet field({ id, describedBy, invalid })}
    <Combobox {items} bind:value {id} {describedBy} {invalid} {placeholder} {onValueChange} />
  {/snippet}
</FormField>
