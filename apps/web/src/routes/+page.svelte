<script lang="ts">
  import { goto } from "$app/navigation";
  import { onMount } from "svelte";
  import { authStore } from "$stores/auth";

  onMount(() => {
    if ($authStore.accessToken) {
      goto("/dashboard");
    } else {
      goto("/login");
    }
  });
</script>
