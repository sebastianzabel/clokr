<script lang="ts">
  // Phase 109 / WR-02 fixture — the exact shape the eight instant toggles now use:
  // `bind:checked` plus an `onchange` handler that derives the pre-flip value from the state.
  //
  // The whole rollback fix rests on ONE assumption: that bind:checked has already written the
  // new value into the state by the time onchange runs, so `!state` is the previous value.
  // This fixture exists to pin that assumption instead of trusting it.
  interface Props {
    enabled: boolean;
    shouldFail: boolean;
    onresult: (r: { previous: boolean; atHandler: boolean }) => void;
  }
  let { enabled = $bindable(), shouldFail, onresult }: Props = $props();

  async function save() {
    const previous = !enabled;
    const atHandler = enabled;
    onresult({ previous, atHandler });
    try {
      await new Promise((resolve, reject) =>
        shouldFail ? reject(new Error("API nicht erreichbar")) : resolve(null),
      );
    } catch {
      enabled = previous;
    }
  }
</script>

<input type="checkbox" aria-label="Testschalter" bind:checked={enabled} onchange={save} />
