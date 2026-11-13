/**
 * An authorised file download from the API (Issue #583, plan 854-23): the CSV of the Protokoll and, later,
 * the other exports. The request goes through the API client (bearer token, one transparent refresh on a
 * 401), the answer becomes a Blob and a click on a temporary link - the same shape as `downloadCsv()` for a
 * file the server built. A non-2xx answer throws an `ApiError` with the server's message; callers toast it.
 */
import { api } from "./client";

/** The filename a `Content-Disposition` header names, reduced to a plain file name; null when it names none. */
export function filenameFromDisposition(disposition: string): string | null {
  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(disposition);
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(disposition);
  let name: string | null = null;
  if (encoded) {
    try {
      name = decodeURIComponent(encoded[1].trim());
    } catch {
      name = null;
    }
  }
  name ??= plain ? plain[1].trim() : null;
  if (!name) return null;
  // A header must never choose a path: keep the last segment only, and refuse an empty result.
  const base = name.split(/[\\/]/).pop()?.trim() ?? "";
  return base === "" ? null : base;
}

/** Hands a Blob to the browser as a file download. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** Downloads `path` (below `/api/v1`) as a file; the name comes from the server, else `fallbackFilename`. */
export async function downloadFromApi(path: string, fallbackFilename: string): Promise<void> {
  const { blob, disposition } = await api.getBlob(path);
  saveBlob(blob, filenameFromDisposition(disposition) ?? fallbackFilename);
}
