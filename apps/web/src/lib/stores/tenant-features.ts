/**
 * Global tenant-feature flags store (Phase 47.3-02).
 *
 * Fetched once per (app)/ layout mount from GET /settings/work (no role gate on
 * the GET — any authenticated user can read it). Components (Sidebar,
 * BottomTabBar, admin pages) subscribe to react to toggles without page reload.
 *
 * Fail-open: default state pretends every feature is on so the nav doesn't
 * flash hidden→visible during initial load. The catch path on fetch failure
 * keeps the defaults and just marks `loaded: true` so dependent code can
 * stop waiting.
 */
import { writable, get } from "svelte/store";
import { api } from "$api/client";

interface TenantFeatures {
  availabilityEnabled: boolean;
  loaded: boolean;
}

interface SettingsWorkResponse {
  availabilityEnabled?: boolean;
  // other fields exist but are not consumed here
}

function createTenantFeatures() {
  const { subscribe, set, update } = writable<TenantFeatures>({
    availabilityEnabled: true,
    loaded: false,
  });

  return {
    subscribe,
    async fetch(): Promise<void> {
      try {
        const cfg = await api.get<SettingsWorkResponse>("/settings/work");
        set({
          availabilityEnabled: cfg.availabilityEnabled ?? true,
          loaded: true,
        });
      } catch {
        // fail-open: leave the optimistic defaults and just mark loaded so
        // any "waiting for feature flag" UI can move on.
        update((s) => ({ ...s, loaded: true }));
      }
    },
    /**
     * Lets the admin page push the new value after a successful PUT so
     * Sidebar/BottomTabBar update instantly without a second round-trip.
     */
    applyLocal(availabilityEnabled: boolean): void {
      set({ availabilityEnabled, loaded: true });
    },
    /**
     * Synchronous read of the current value. Intended for tests and
     * occasional non-reactive call sites.
     */
    peek(): TenantFeatures {
      return get({ subscribe });
    },
  };
}

export const tenantFeatures = createTenantFeatures();
