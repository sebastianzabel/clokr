/**
 * Issue #844 (D-844-04) — an old URL (the pre-#844 address of a page, e.g. `/inbox` or `/admin/employees/1`)
 * redirects to its new URL with the query string kept (before a `#fragment` of the target, #854). With SSR
 * this `load` answers a document request on the server (bookmarks, e-mail and push links of earlier releases: a 308, the browser keeps the fragment) and an
 * in-app navigation in the browser. The mapping lives only in `$lib/nav/routes`.
 */
import { redirect } from "@sveltejs/kit";
import { legacyRedirectTarget, redirectLocation } from "$lib/nav/routes";
import type { LayoutLoad } from "./$types";

export const load: LayoutLoad = ({ url }) => {
  const target = legacyRedirectTarget(url.pathname);
  if (target !== null) redirect(308, redirectLocation(target, url.search));
};
