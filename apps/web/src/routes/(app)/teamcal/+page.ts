// Issue #840 (D-840-03, AC-1) - the old team calendar is the Übersicht tab of `/team/leave` at month
// zoom. The page is gone; old bookmarks and notification links land on the timeline. `teamcalRedirect`
// is the ONE place that decides the target: a fixed path with whitelisted, re-validated parameters
// (T-840-38, open redirect).
import { redirect } from "@sveltejs/kit";
import { teamcalRedirect } from "$lib/leave/area-tabs";
import type { PageLoad } from "./$types";

export const load: PageLoad = ({ url }) => {
  redirect(307, teamcalRedirect(url.searchParams));
};
