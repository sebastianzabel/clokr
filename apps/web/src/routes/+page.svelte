<script lang="ts">
  // Issue #844 (Z-02, D-844-10): "/" opens the person's start page — decided from permissions only (a session
  // cached before Phase 378 loads its permission list first) — or the sign-in page.
  import { goto } from "$app/navigation";
  import { onMount } from "svelte";
  import { get } from "svelte/store";
  import { authStore } from "$stores/auth";
  import { loadPermissionsIfMissing } from "$api/client";
  import { homeHref } from "$lib/nav/routes";

  onMount(async () => {
    if (!get(authStore).accessToken) {
      goto("/login");
      return;
    }
    await loadPermissionsIfMissing();
    goto(homeHref(get(authStore).user), { replaceState: true });
  });
</script>
