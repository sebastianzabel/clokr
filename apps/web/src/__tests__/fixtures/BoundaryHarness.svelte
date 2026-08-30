<script lang="ts">
  // Mounts ThrowingChild INSIDE the boundary — a throw in the harness itself would
  // sit outside it and prove nothing.
  import ErrorBoundary from "$lib/components/ui/ErrorBoundary.svelte";
  import ThrowingChild from "./ThrowingChild.svelte";

  interface Props {
    scope: "view" | "app";
    when: "render" | "mount" | "never";
  }

  let { scope, when }: Props = $props();
</script>

<ErrorBoundary {scope}>
  <ThrowingChild {when} />
</ErrorBoundary>
