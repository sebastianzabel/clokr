<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { authStore } from "$stores/auth";

  interface Props {
    children?: import("svelte").Snippet;
  }

  let { children }: Props = $props();

  onMount(() => {
    const role = $authStore.user?.role ?? "";
    if (!["ADMIN", "MANAGER"].includes(role)) {
      goto("/dashboard");
    }
  });
</script>

{@render children?.()}
