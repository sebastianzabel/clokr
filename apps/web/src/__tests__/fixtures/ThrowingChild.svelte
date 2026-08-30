<script lang="ts">
  // Test fixture: throws on demand so the boundary has something to catch.
  // Two throw sites because #115 threw from onMount, not from the template.
  import { onMount } from "svelte";

  interface Props {
    when: "render" | "mount" | "never";
  }

  let { when }: Props = $props();

  if (when === "render") throw new Error("BOOM-127-render");

  onMount(() => {
    if (when === "mount") throw new Error("BOOM-127-mount");
  });
</script>

<p data-testid="throwing-child">Kind gerendert</p>
