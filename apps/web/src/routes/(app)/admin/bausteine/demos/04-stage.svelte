<script module lang="ts">
  // Issue #843 (D-843-04) - demo of block 4. `entries` are relative to apps/web/src/lib.
  export const block = {
    id: 4,
    name: "Bühne",
    entries: ["components/ui/Stage.svelte"],
  };
</script>

<script lang="ts">
  import Stage from "$components/ui/Stage.svelte";
  import type { StageState } from "$components/ui/Stage.svelte";

  const STATES: { state: StageState; text: string; action: string }[] = [
    { state: "ruhig", text: "Noch nicht eingestempelt", action: "Einstempeln" },
    { state: "arbeitet", text: "Arbeitet seit 08:02", action: "Pause starten" },
    { state: "pause", text: "Pause seit 12:03", action: "Pause beenden" },
    { state: "fertig", text: "Feierabend · 8:12 h", action: "Zeiten ansehen" },
  ];
</script>

<div data-block="4" class="stage-demo">
  {#each STATES as item (item.state)}
    <Stage state={item.state} ariaLabel={item.text}>
      <span>{item.text}</span>
      {#snippet actions()}
        <button type="button" class="btn">{item.action}</button>
      {/snippet}
    </Stage>
  {/each}
</div>

<style>
  .stage-demo {
    display: flex;
    flex-direction: column;
    gap: var(--s-3);
  }
</style>
