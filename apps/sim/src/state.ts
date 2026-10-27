/** The run state of one simulation instance: ids and credentials written by `provision`. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PopulationPlan, SimTenantKey } from "./plan";

export interface PersonState {
  employeeId: string;
  userId: string;
  /** Set once the admin bot has created the person (pending hires start without it). */
  created: boolean;
  exited: boolean;
  anonymized: boolean;
}

export interface TenantState {
  tenantId: string;
  adminEmail: string;
  adminPassword: string;
  salonIds: string[];
  /** Raw NFC terminal key (device credential, shown once by the API). */
  terminalKey: string | null;
  /** Raw presence source key for WiFi events. */
  presenceKey: string | null;
  persons: Record<string, PersonState>;
}

export interface SimState {
  plan: PopulationPlan;
  provisionedAt: string;
  tenants: Partial<Record<SimTenantKey, TenantState>>;
}

export function statePath(stateDir: string): string {
  return join(stateDir, "state.json");
}

export function loadState(stateDir: string): SimState {
  const path = statePath(stateDir);
  if (!existsSync(path)) throw new Error(`No simulation state at ${path}. Run "provision" first.`);
  return JSON.parse(readFileSync(path, "utf8")) as SimState;
}

export function saveState(stateDir: string, state: SimState): void {
  const path = statePath(stateDir);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

export function tenantState(state: SimState, key: SimTenantKey): TenantState {
  const tenant = state.tenants[key];
  if (!tenant) throw new Error(`Tenant "${key}" is not provisioned`);
  return tenant;
}
