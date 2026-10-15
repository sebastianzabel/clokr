/**
 * Tenant and salon context of the web app (Issue #82, D-07..D-10).
 *
 * Holds the caller's tenant, the ACTIVE salons the caller can reach (computed by the server,
 * `GET /api/v1/me/context`) and the active salon selection — a salon id or "all reachable salons".
 * Later views (#84–#87) read `selectedSalonId()` and pass it as a `salonId` parameter.
 *
 * Presentation only, never an access decision: the server decides every request on its own
 * (DSGVO Art. 32), a manipulated selection yields no foreign data (proven API-side by
 * `salon-context-manipulation-82.test.ts`). Nothing here hides data as a security measure.
 *
 * Persistence (D-09): per device and per person in localStorage, never on the server — a device
 * usually stands in one salon, and a server preference would add a write path for no functional or
 * legal gain (Art. 25 DSGVO, data protection by default). The stored value is never trusted: every
 * load validates it against the freshly fetched list (`resolveSelection`).
 *
 * Loading (D-10): the (app) layout loads once on mount (forced) and again after in-app navigation
 * (throttled: skipped while a load is in flight or within 30 s of the last success). The tenant-side
 * salon admin screen `/admin/salons` calls `load({ force: true })` after every successful create,
 * edit, deactivate and activate (Issue #563), so the options appear or vanish without a reload. A failure
 * without a previous good answer, and a 401, fail closed for presentation (no options, no
 * selection); a transient failure (5xx, network) keeps the last good answer instead of widening the
 * selection silently.
 */
import { writable, get } from "svelte/store";
import { api, ApiError } from "$api/client";
import { clientLogger } from "$lib/utils/logger";
import { TENANT_MODULES, type TenantModule } from "$lib/packages/tenant-modules";

export interface ContextSalon {
  id: string;
  name: string;
}

export interface MeContextResponse {
  tenant: { id: string; name: string };
  isMultiSalon: boolean;
  homeSalonId: string | null;
  salons: ContextSalon[];
  /** Optional on the wire so a mixed deploy cannot crash (Phase 566). */
  packages?: { bookedModules: string[]; salonLimit: number };
  /** Names of the caller's own roles (Issue #538); optional on the wire for a mixed deploy. */
  roles?: string[];
}

/** The booked packages of the tenant, display only (Phase 566, D-12). */
export interface ContextPackages {
  bookedModules: TenantModule[];
  salonLimit: number;
}

export interface SalonContextState {
  loaded: boolean;
  tenant: { id: string; name: string } | null;
  salons: ContextSalon[];
  isMultiSalon: boolean;
  homeSalonId: string | null;
  /** A listed salon id, `ALL_SALONS`, or null when no choice exists. */
  selection: string | null;
  /**
   * Booked packages (Phase 566, D-12). Null until loaded and after a fail-closed load. Display
   * only: never an input of `showSalonOptions`, `resolveSelection` or any salon id.
   */
  packages: ContextPackages | null;
  /**
   * Names of the roles assigned to the caller (Issue #538), shown as the role label in Topbar,
   * Sidebar and profile. Empty until loaded and after a fail-closed load. Display only: decides
   * nothing, every decision reads the permission list.
   */
  roles: string[];
}

/** The selection value for "every reachable salon" (D-08: the default with several salons). */
export const ALL_SALONS = "ALL";
export const SALON_CONTEXT_STORAGE_PREFIX = "clokr.salonContext.";
/** A navigation-triggered reload within this window after a success is skipped. */
export const SALON_CONTEXT_REFRESH_MS = 30_000;

const INITIAL: SalonContextState = {
  loaded: false,
  tenant: null,
  salons: [],
  isMultiSalon: false,
  homeSalonId: null,
  selection: null,
  packages: null,
  roles: [],
};

export function salonContextStorageKey(tenantId: string, userId: string): string {
  return `${SALON_CONTEXT_STORAGE_PREFIX}${tenantId}.${userId}`;
}

/**
 * The ONE place of the #64 owner rule in the web: salon options (choice, filters, columns) appear
 * only when the tenant has more than one active salon AND the caller reaches more than one.
 */
export function showSalonOptions(state: Pick<SalonContextState, "isMultiSalon" | "salons">) {
  return state.isMultiSalon && state.salons.length > 1;
}

/**
 * Whether the tenant booked a module: true/false, or null while the packages are unknown. A teaser
 * shows only on `=== false`; unknown never hides a create control — the server answers 409 for an
 * unbooked module anyway (Phase 566, D-12). Display only, never an access boundary.
 */
export function moduleBooked(
  state: Pick<SalonContextState, "packages">,
  module: TenantModule,
): boolean | null {
  if (state.packages === null) return null;
  return state.packages.bookedModules.includes(module);
}

/** The role label for the shell: the assigned role names, joined; empty while unknown. */
export function roleNamesLabel(state: Pick<SalonContextState, "roles">): string {
  return state.roles.join(", ");
}

/** Copies the wire role names; anything that is not a non-empty string is dropped. */
function readRoles(wire: MeContextResponse["roles"]): string[] {
  if (!Array.isArray(wire)) return [];
  return wire.filter((name): name is string => typeof name === "string" && name.length > 0);
}

/** Copies the two display fields of the wire value; unknown module names are dropped. */
function readPackages(wire: MeContextResponse["packages"]): ContextPackages | null {
  if (!wire || !Array.isArray(wire.bookedModules) || typeof wire.salonLimit !== "number") {
    return null;
  }
  return {
    bookedModules: TENANT_MODULES.filter((module) => wire.bookedModules.includes(module)),
    salonLimit: wire.salonLimit,
  };
}

/**
 * D-07/D-08: exactly one reachable salon → that salon (no choice offered); no options otherwise →
 * null; with options a stored `ALL_SALONS` or currently listed id wins, anything else (stale,
 * deactivated, removed scope, manipulated) → `ALL_SALONS`.
 */
export function resolveSelection(
  stored: string | null,
  state: Pick<SalonContextState, "isMultiSalon" | "salons">,
): string | null {
  if (state.salons.length === 1) return state.salons[0].id;
  if (!showSalonOptions(state)) return null;
  if (stored === ALL_SALONS) return ALL_SALONS;
  if (stored !== null && state.salons.some((salon) => salon.id === stored)) return stored;
  return ALL_SALONS;
}

/** The `salonId` a view passes on: a listed id, or null for "every reachable salon". */
export function selectedSalonId(state: Pick<SalonContextState, "salons" | "selection">) {
  const selection = state.selection;
  if (selection === null || selection === ALL_SALONS) return null;
  return state.salons.some((salon) => salon.id === selection) ? selection : null;
}

function storage(): Storage | null {
  try {
    return typeof globalThis.localStorage === "undefined" ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}

function readStored(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    storage()?.setItem(key, value);
  } catch {
    // Private mode or a full quota: the selection still holds in memory for this page.
  }
}

function removeAllStored(): void {
  try {
    const store = storage();
    if (!store) return;
    const keys: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key !== null && key.startsWith(SALON_CONTEXT_STORAGE_PREFIX)) keys.push(key);
    }
    for (const key of keys) store.removeItem(key);
  } catch {
    // Nothing to forget when storage is unavailable.
  }
}

function createSalonContext() {
  const { subscribe, set, update } = writable<SalonContextState>(INITIAL);
  let generation = 0;
  let inFlightGeneration: number | null = null;
  let lastSuccessAt: number | null = null;
  let hasGoodState = false;
  let currentKey: string | null = null;

  function failClosed() {
    currentKey = null;
    lastSuccessAt = null;
    hasGoodState = false;
    set({ ...INITIAL, loaded: true });
  }

  return {
    subscribe,

    async load(userId: string | null, options: { force?: boolean } = {}): Promise<void> {
      if (!options.force) {
        if (inFlightGeneration !== null) return;
        if (lastSuccessAt !== null && Date.now() - lastSuccessAt < SALON_CONTEXT_REFRESH_MS) {
          return;
        }
      }
      const myGeneration = ++generation;
      inFlightGeneration = myGeneration;
      let response: MeContextResponse;
      try {
        response = await api.get<MeContextResponse>("/me/context");
      } catch (err) {
        if (myGeneration !== generation) return;
        inFlightGeneration = null;
        const reportable = err instanceof ApiError && err.status !== 401;
        if (reportable) {
          clientLogger.warn("Salon-Kontext konnte nicht geladen werden", { status: err.status });
        }
        const transient = reportable || err instanceof TypeError;
        if (transient && hasGoodState) return;
        failClosed();
        return;
      }
      if (myGeneration !== generation) return;
      inFlightGeneration = null;

      const base = {
        tenant: { id: response.tenant.id, name: response.tenant.name },
        salons: response.salons.map((salon) => ({ id: salon.id, name: salon.name })),
        isMultiSalon: response.isMultiSalon === true,
        homeSalonId: response.homeSalonId ?? null,
      };
      currentKey = userId === null ? null : salonContextStorageKey(base.tenant.id, userId);
      const stored = currentKey === null ? null : readStored(currentKey);
      const selection = resolveSelection(stored, base);
      if (currentKey !== null && showSalonOptions(base) && selection !== null) {
        if (selection !== stored) writeStored(currentKey, selection);
      }
      lastSuccessAt = Date.now();
      hasGoodState = true;
      // Packages sit next to `base`, not in it: selection logic never sees them (D-12).
      set({
        ...base,
        loaded: true,
        selection,
        packages: readPackages(response.packages),
        roles: readRoles(response.roles),
      });
    },

    /** Accepts only `ALL_SALONS` or a listed id, and only while options are shown. */
    setSelection(value: string): void {
      const state = get({ subscribe });
      if (!showSalonOptions(state)) return;
      if (value !== ALL_SALONS && !state.salons.some((salon) => salon.id === value)) return;
      update((s) => ({ ...s, selection: value }));
      if (currentKey !== null) writeStored(currentKey, value);
    },

    /**
     * Logout (D-09): forget the in-memory context and every stored selection on this device, so a
     * shared salon device keeps no residue of any person; a load still in flight is ignored.
     */
    reset(): void {
      generation++;
      inFlightGeneration = null;
      lastSuccessAt = null;
      hasGoodState = false;
      currentKey = null;
      removeAllStored();
      set(INITIAL);
    },

    peek(): SalonContextState {
      return get({ subscribe });
    },
  };
}

export const salonContext = createSalonContext();
