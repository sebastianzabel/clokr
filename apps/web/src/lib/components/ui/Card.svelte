<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    animate?: boolean;
    class?: string;
    style?: string | null;
    children: Snippet;
  }

  let { animate = false, class: extraClass = "", style = null, children }: Props = $props();

  const classes = $derived(
    ["card", animate ? "card-animate" : "", extraClass].filter(Boolean).join(" ")
  );
</script>

<section class={classes} style={style ?? undefined}>
  {@render children()}
</section>
