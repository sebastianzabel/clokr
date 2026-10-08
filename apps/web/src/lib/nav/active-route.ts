/**
 * The ONE place the rule "which navigation item is the current one" lives (#515).
 *
 * Every navigation variant (desktop Sidebar, mobile BottomTabBar, MobileMoreSheet) and the (app)
 * layout's page-label lookup decide "current" through this module and nowhere else. WCAG 1.3.1,
 * 2.4.8 and 4.1.2 require the current location to be identifiable and exposed programmatically,
 * and that only holds if every variant marks the SAME item — four independent copies of the rule
 * had drifted apart. `active-route-one-place.test.ts` fails on a consumer that matches routes
 * itself.
 *
 * There is deliberately no `/dashboard` special case: no route exists below `/dashboard`, so the
 * former exact-match rule for it was dead and the general rule gives identical results.
 */

/** True when `path` is the page `href` or a page below it (`/leave` matches `/leave/123`). */
export function matchesRoute(href: string, path: string): boolean {
  return path === href || path.startsWith(href + "/");
}

/**
 * The single current href out of `hrefs` for `path`: the longest href that matches, so a nested
 * item wins over its parent and at most one item per navigation is current. `null` when none
 * matches.
 */
export function activeNavHref(hrefs: readonly string[], path: string): string | null {
  let best: string | null = null;
  for (const href of hrefs) {
    if (matchesRoute(href, path) && (best === null || href.length > best.length)) {
      best = href;
    }
  }
  return best;
}
