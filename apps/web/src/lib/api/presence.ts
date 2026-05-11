import { api } from "$api/client";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PresenceSource {
  id: string;
  name: string;
  keyPrefix: string;
  adapterUrl: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface FritzDevice {
  mac: string;
  hostname: string;
  lastSeen: string | null;
  online: boolean;
  assignedEmployeeId: string | null;
  assignedEmployeeName: string | null;
}

export interface OptedInEmployee {
  id: string;
  firstName: string;
  lastName: string;
  wifiPresenceEnabled: boolean;
  wifiOptInAt: string | null;
  wifiMacs: string[];
}

// ── API helpers ───────────────────────────────────────────────────────────────

export async function listSources(): Promise<PresenceSource[]> {
  const res = await api.get<{ sources: PresenceSource[] }>("/admin/presence-sources");
  return res.sources;
}

export async function createSource(
  name: string,
  adapterUrl?: string,
): Promise<{ rawKey: string; source: PresenceSource }> {
  return api.post<{ rawKey: string; source: PresenceSource }>("/admin/presence-sources", {
    name,
    adapterUrl: adapterUrl || undefined,
  });
}

export async function revokeSource(id: string): Promise<void> {
  await api.delete(`/admin/presence-sources/${id}`);
}

export async function listDevices(sourceId: string): Promise<FritzDevice[]> {
  const res = await api.get<{ devices: FritzDevice[] }>(
    `/admin/presence-sources/${sourceId}/devices`,
  );
  return res.devices;
}

export async function mapDevice(sourceId: string, mac: string, employeeId: string): Promise<void> {
  await api.post(`/admin/presence-sources/${sourceId}/devices/${encodeURIComponent(mac)}/assign`, {
    employeeId,
  });
}

export async function listOptedInEmployees(): Promise<OptedInEmployee[]> {
  const res = await api.get<{ employees: OptedInEmployee[] }>("/admin/presence-sources/opted-in");
  return res.employees;
}
