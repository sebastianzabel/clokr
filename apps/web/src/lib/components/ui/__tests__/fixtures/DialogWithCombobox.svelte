<script lang="ts">
  // Test fixture: a Combobox inside an open Dialog, the shape of the leave form's "Für wen?" field.
  import Dialog from "../../Dialog.svelte";
  import Combobox from "../../Combobox.svelte";

  let { onValueChange }: { onValueChange?: (value: string) => void } = $props();
  let open = $state(true);
  const items = [
    { value: "a", label: "Zeile, Formular" },
    { value: "b", label: "Muster, Max" },
  ];
</script>

<Dialog bind:open title="Abwesenheit">
  <Combobox {items} label="Für wen?" {onValueChange} />
</Dialog>
