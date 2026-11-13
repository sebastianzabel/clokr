<script module lang="ts">
  // Issue #843 (D-843-04) - demo of block 9. `entries` are relative to apps/web/src/lib.
  export const block = {
    id: 9,
    name: "Rückmeldung",
    entries: ["components/ui/Toast.svelte", "components/ui/ToastItem.svelte"],
  };
</script>

<script lang="ts">
  import ToastItem from "$components/ui/ToastItem.svelte";
</script>

<!-- Static items only: the live regions of Toast.svelte exist once per page, not six times. -->
<div data-block="9" class="feedback-demo">
  <ToastItem type="success" message="Eingestempelt 10:02 · Salon Nord" />
  <ToastItem
    type="error"
    message="Speichern hat nicht geklappt. Prüfe die Verbindung und versuche es noch einmal."
    onClose={() => {}}
  />
</div>

<style>
  .feedback-demo {
    display: flex;
    flex-direction: column;
    gap: var(--s-3);
    max-width: 480px;
  }
</style>
