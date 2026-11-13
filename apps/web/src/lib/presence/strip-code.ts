// Issue #610 (review WR-06): taking the one-time pairing code out of the address bar.
//
// SvelteKit's `replaceState` throws before the router is initialised (in dev it checks `started`,
// which is set only after the first hydration finished; in a build it needs the root component the
// same hydration creates). A landing without a usable code reports "handled" synchronously from
// `onMount`, i.e. DURING that first hydration, so the call must (a) not happen at all when the URL
// carries no code (nothing to remove), (b) be deferred past the hydration - one macrotask, because
// every step of the hydration is a microtask - and (c) never turn a router that is not ready into an
// uncaught error: the page keeps working, the code merely stays in the address bar.

export type StripOutcome = "skipped" | "stripped" | "failed";

export interface StripDeps {
  /** True when the current page URL carries a `code` parameter. */
  hasCode: () => boolean;
  /** The router call that rewrites the address bar. */
  strip: () => void;
  /** Wait until the router can be used; defaults to one macrotask. */
  defer?: () => Promise<void>;
}

const nextMacrotask = () => new Promise<void>((done) => setTimeout(done, 0));

export async function stripCodeFromAddress(deps: StripDeps): Promise<StripOutcome> {
  if (!deps.hasCode()) return "skipped";
  await (deps.defer ?? nextMacrotask)();
  try {
    deps.strip();
    return "stripped";
  } catch {
    return "failed";
  }
}
