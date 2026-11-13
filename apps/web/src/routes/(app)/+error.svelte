<script lang="ts">
  // Issue #855 (D-855-06): a failed load inside the app shell keeps the navigation around the page.
  import { page } from "$app/state";
  import ErrorPage from "$lib/components/feedback/ErrorPage.svelte";
</script>

<ErrorPage status={page.status} />
