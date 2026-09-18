/**
 * Fetches an employee's avatar and returns an object URL, or null when there is no
 * avatar to show.
 *
 * Why this is not a two-line inline fetch: `res.ok` is true for 204 No Content, and
 * `res.blob()` on a 204 resolves to a truthy zero-byte Blob. Handing that to
 * URL.createObjectURL produces a broken <img src>. The API answers 204 for the normal
 * "no avatar stored" state (phase 258, D-01), so every caller needs this guard — which
 * is why there is exactly one caller-facing function instead of one copy per component.
 *
 * Returning null (never throwing) keeps the callers' shape: null means "show initials".
 */
export async function fetchAvatarObjectUrl(
  employeeId: string,
  token: string,
  cacheBust: number | string,
): Promise<string | null> {
  try {
    const res = await fetch(`/api/v1/avatars/${employeeId}?v=${cacheBust}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-cache",
    });
    if (res.status === 204 || !res.ok) return null;
    const blob = await res.blob();
    if (blob.size === 0) return null;
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}
