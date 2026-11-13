// Issue #598 (Phase 851): the own Stundennachweis of a month as a PDF - GET /reports/monthly/pdf for
// oneself (report:export:EIGENE, docs/permissions.md). One helper for Ich › Konto and Ich › Zeiten.
import { get } from "svelte/store";
import { ApiError } from "$api/client";
import { authStore } from "$stores/auth";

export function stundennachweisFilename(year: number, month: number): string {
  return `Stundennachweis_${year}_${String(month).padStart(2, "0")}.pdf`;
}

export async function downloadStundennachweis(
  employeeId: string,
  year: number,
  month: number,
): Promise<void> {
  const auth = get(authStore);
  const res = await fetch(
    `/api/v1/reports/monthly/pdf?employeeId=${encodeURIComponent(employeeId)}&year=${year}&month=${month}`,
    { headers: auth.accessToken ? { Authorization: `Bearer ${auth.accessToken}` } : {} },
  );
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, data.error ?? "Der Stundennachweis ließ sich nicht erstellen.");
  }
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = stundennachweisFilename(year, month);
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(objectUrl), 100);
}
