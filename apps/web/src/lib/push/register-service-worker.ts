// Issue #849 (6) — the push service worker (Issue #608) is registered here, not by SvelteKit.
//
// SvelteKit's built-in registration (`kit.serviceWorker.register`, default true) calls
// `navigator.serviceWorker.register()` without a `.catch`, so every failed registration (e.g. a
// dev origin that cannot run a module worker) became an unhandled rejection that the client
// logger shipped to the API on EVERY page load. svelte.config.js now turns that off and the root
// layout calls this function: a failure is caught and reported at most once per browser session.

export const SW_FAILURE_LOGGED_KEY = "clokr.sw.registrationFailureLogged";

export interface RegisterServiceWorkerDeps {
  nav: Pick<Navigator, "serviceWorker"> | undefined;
  storage: Pick<Storage, "getItem" | "setItem"> | undefined;
  dev: boolean;
  warn: (message: string, extra?: Record<string, unknown>) => void;
}

export async function registerServiceWorker(deps: RegisterServiceWorkerDeps): Promise<boolean> {
  const sw = deps.nav && "serviceWorker" in deps.nav ? deps.nav.serviceWorker : undefined;
  if (!sw) return false;
  try {
    // Vite serves the worker as an ES module in dev; the built worker is a classic script.
    await sw.register("/service-worker.js", { type: deps.dev ? "module" : "classic" });
    return true;
  } catch (err) {
    let alreadyLogged = false;
    try {
      alreadyLogged = deps.storage?.getItem(SW_FAILURE_LOGGED_KEY) === "1";
      deps.storage?.setItem(SW_FAILURE_LOGGED_KEY, "1");
    } catch {
      // Storage blocked (private mode): log, at worst once per page.
    }
    if (!alreadyLogged) {
      deps.warn("Service-Worker-Registrierung fehlgeschlagen", {
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return false;
  }
}
