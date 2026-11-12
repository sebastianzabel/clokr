/**
 * Issue #844 (D-844-03) — universal hooks. `reroute` renders a new URL of the route table with the route file
 * it names (`/team/aufgaben` → `routes/(app)/inbox`), so the pages keep their files while the URLs follow the
 * three areas. The URL in the address bar stays the new one. The mapping lives only in `$lib/nav/routes`.
 */
import type { Reroute } from "@sveltejs/kit";
import { rerouteTarget } from "$lib/nav/routes";

export const reroute: Reroute = ({ url }) => rerouteTarget(url.pathname) ?? undefined;
