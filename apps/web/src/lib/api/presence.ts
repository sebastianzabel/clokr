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

export async function mapDevice(
  sourceId: string,
  mac: string,
  employeeId: string,
): Promise<{ employeeId: string; mac: string; optInAutoEnabled: boolean }> {
  return await api.post<{ employeeId: string; mac: string; optInAutoEnabled: boolean }>(
    `/admin/presence-sources/${sourceId}/devices/${encodeURIComponent(mac)}/assign`,
    { employeeId },
  );
}

export async function unmapDevice(
  sourceId: string,
  mac: string,
): Promise<{ success: boolean; optInAutoDisabled: boolean }> {
  return await api.delete<{ success: boolean; optInAutoDisabled: boolean }>(
    `/admin/presence-sources/${sourceId}/devices/${encodeURIComponent(mac)}`,
  );
}

export async function listOptedInEmployees(): Promise<OptedInEmployee[]> {
  const res = await api.get<{ employees: OptedInEmployee[] }>("/admin/presence-sources/opted-in");
  return res.employees;
}

// ── Employee self-service: /me/wifi ────────────────────────────────────────

export interface MyWifiDevice {
  id: string;
  mac: string;
  label: string | null;
}

export interface MyWifiData {
  wifiPresenceEnabled: boolean;
  devices: MyWifiDevice[];
}

export async function getMyWifi(): Promise<MyWifiData> {
  return api.get<MyWifiData>("/me/wifi");
}

export async function updateMyWifi(
  wifiPresenceEnabled: boolean,
): Promise<{ wifiPresenceEnabled: boolean }> {
  return api.patch<{ wifiPresenceEnabled: boolean }>("/me/wifi", { wifiPresenceEnabled });
}

export async function addMyDevice(mac: string, label?: string): Promise<MyWifiDevice> {
  return api.post<MyWifiDevice>("/me/wifi/devices", { mac, label: label ?? null });
}

export async function removeMyDevice(id: string): Promise<void> {
  await api.delete(`/me/wifi/devices/${id}`);
}
