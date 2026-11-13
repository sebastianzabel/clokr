// Issue #840 (D-840-03/31, AC-1) - the legacy links of /team/leave keep working. The old tabs are
// gone (`?view=approvals|calendar|list`), the § 9 cases live in the inbox (`?section9=`), and a bare
// `?request=` names the request in the Anträge tab. `teamLeaveRedirect` is the ONE place that decides
// the target: always a fixed path (`/team/leave` or `/inbox`) with whitelisted, re-validated
// parameters (T-840-31, open redirect), and `null` for a URL that needs no redirect - which is also
// the loop guard. Every other parameter (`create`, `employeeId`, `date`, ...) passes through the
// mapping untouched; the page reads the create link itself, on whatever tab is active.
import { redirect } from "@sveltejs/kit";
import { teamLeaveRedirect } from "$lib/leave/area-tabs";
import type { PageLoad } from "./$types";

export const load: PageLoad = ({ url }) => {
  const target = teamLeaveRedirect(url.searchParams);
  if (target) redirect(307, target);
};
