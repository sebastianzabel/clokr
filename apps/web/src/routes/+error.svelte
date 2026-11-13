<script lang="ts">
  // Issue #855 (D-855-06): an unknown address or a failed load outside the app shell.
  import { page } from "$app/state";
  import ErrorPage from "$lib/components/feedback/ErrorPage.svelte";
</script>

<ErrorPage status={page.status} framed />
