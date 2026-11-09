<script module lang="ts">
  // Issue #843 (D-843-04) - demo of block 11. `entries` are relative to apps/web/src/lib.
  export const block = {
    id: 11,
    name: "Dialog/Sheet",
    entries: ["components/ui/Dialog.svelte", "components/ui/DialogPanel.svelte"],
  };
</script>

<script lang="ts">
  import DialogPanel from "$components/ui/DialogPanel.svelte";
</script>

<div data-block="11">
  <DialogPanel eyebrow="Beispiel" title="Abwesenheit eintragen">
    <p>
      Wähle den Zeitraum und die Art der Abwesenheit. Danach prüft eine zweite Person den Antrag.
    </p>
    {#snippet footer()}
      <button type="button" class="btn btn-secondary">Abbrechen</button>
      <button type="button" class="btn btn-primary">Speichern</button>
    {/snippet}
  </DialogPanel>
</div>
