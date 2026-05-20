<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    title: string;
    sub?: string;
    actions?: Snippet;
  }

  let { title, sub, actions }: Props = $props();
</script>

<header class="card-hd">
  <div class="card-title">{title}</div>
  {#if sub}<div class="card-sub">{sub}</div>{/if}
  {#if actions}
    <div class="card-hd-actions">{@render actions()}</div>
  {/if}
</header>
