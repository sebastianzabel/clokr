<script lang="ts">
  import { goto } from "$app/navigation";
  import { onMount } from "svelte";
  import { authStore } from "$stores/auth";
  import { firstAccessibleAdminHref } from "$lib/nav/admin-route-permissions";
  onMount(() =>
    goto(firstAccessibleAdminHref($authStore.user) ?? "/dashboard", { replaceState: true }),
  );
</script>
