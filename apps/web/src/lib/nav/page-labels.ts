/**
 * Issue #574 (D-574-09..11) — the ONE place a page's name is read; since #844 the names live in the route table
 * (`routes.ts`) and this module is its name view.
 *
 * The desktop Sidebar and the mobile "Mehr" sheet (through `app-nav.ts`), the Topbar crumb (`labelForPath`), the
 * quick search (CommandPalette) and the H1 of every nav page all read it, so a page can no longer carry four
 * different names. The names follow `docs/glossar.md`. `page-labels-one-source-574.test.ts` fails on a surface
 * that spells a name itself.
 *
 * A page names itself by its new URL OR by its route file (the pre-#844 URL, e.g. `pageLabel("/inbox")` in
 * `routes/(app)/inbox/+page.svelte`): both resolve to the same table entry, so the H1 always equals the menu name.
 */
import { APP_ROUTES, routeByKey, routeFor } from "$lib/nav/routes";

/** href or route file → page name, for every table entry. */
export const PAGE_LABELS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    APP_ROUTES.flatMap((route) =>
      route.file === undefined
        ? [[route.href, route.label]]
        : [
            [route.href, route.label],
            [route.file, route.label],
          ],
    ),
  ),
);

/** A key of the page-name table: a new href or a route file. */
export type PageHref = string;

/** The name of the page `href` (new URL or route file). Throws for an href outside the table — a nav entry
 *  without a name must break the unit tests, never render an empty label (fail closed). */
export function pageLabel(href: PageHref): string {
  const route = routeByKey(href);
  if (route === null) {
    throw new Error(
      `page-labels: no page name for "${href}" — add it to the route table (routes.ts)`,
    );
  }
  return route.label;
}

/** The name of the page `path` belongs to — the longest matching href wins (shared rule, `active-route.ts`),
 *  so `/verwalten/personen/123` is "Personen". "" when no page matches. */
export function labelForPath(path: string): string {
  return routeFor(path)?.label ?? "";
}
