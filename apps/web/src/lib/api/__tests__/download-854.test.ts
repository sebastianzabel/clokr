// Issue #583 (plan 854-23) - the authorised file download: the bearer token goes with the request, the
// filename comes from the server (else the fallback), an error answer throws the server's message, and
// the Blob is handed to the browser through an object URL that is revoked again.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readable } from "svelte/store";

// `$api/client` imports `$stores/auth` -> `$app/environment`; mocking the store replaces it first (the
// same reason and pattern as presence.test.ts).
vi.mock("$stores/auth", () => ({
  authStore: {
    ...readable({ accessToken: "test-token", refreshToken: null, user: null }),
    logout: vi.fn(),
    setTokens: vi.fn(),
  },
}));

import { ApiError } from "../client";
import { downloadFromApi, filenameFromDisposition } from "../download";

const fetchMock = vi.fn();
let createObjectURL: ReturnType<typeof vi.fn>;
let revokeObjectURL: ReturnType<typeof vi.fn>;
let clicked: HTMLAnchorElement[];

function fileResponse(disposition: string | null) {
  return new Response("a;b\r\n", {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      ...(disposition ? { "content-disposition": disposition } : {}),
    },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  createObjectURL = vi.fn(() => "blob:fake");
  revokeObjectURL = vi.fn();
  vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
  clicked = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicked.push(this);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("filenameFromDisposition", () => {
  it("reads a quoted and an unquoted name", () => {
    expect(filenameFromDisposition('attachment; filename="protokoll.csv"')).toBe("protokoll.csv");
    expect(filenameFromDisposition("attachment; filename=protokoll.csv")).toBe("protokoll.csv");
  });

  it("prefers the encoded name", () => {
    expect(
      filenameFromDisposition("attachment; filename=\"x.csv\"; filename*=UTF-8''pr%C3%BCfung.csv"),
    ).toBe("prüfung.csv");
  });

  it("keeps the last path segment only and refuses an empty name", () => {
    expect(filenameFromDisposition('attachment; filename="../../etc/passwd"')).toBe("passwd");
    expect(filenameFromDisposition('attachment; filename="dir/"')).toBeNull();
    expect(filenameFromDisposition("")).toBeNull();
    expect(filenameFromDisposition("attachment")).toBeNull();
  });

  it("survives a malformed percent escape", () => {
    expect(filenameFromDisposition("attachment; filename*=UTF-8''%E0%A4%A.csv")).toBeNull();
    expect(
      filenameFromDisposition("attachment; filename=\"ok.csv\"; filename*=UTF-8''%E0%A4%A.csv"),
    ).toBe("ok.csv");
  });
});

describe("downloadFromApi", () => {
  it("sends the bearer token to /api/v1 and saves under the server's name", async () => {
    fetchMock.mockResolvedValue(fileResponse('attachment; filename="protokoll-2026-03.csv"'));
    await downloadFromApi("/audit-logs/export?from=2026-03-01&to=2026-03-31", "protokoll.csv");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/v1/audit-logs/export?from=2026-03-01&to=2026-03-31");
    expect(init.headers.Authorization).toBe("Bearer test-token");
    expect(clicked).toHaveLength(1);
    expect(clicked[0].download).toBe("protokoll-2026-03.csv");
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:fake");
  });

  it("falls back to the given name without a Content-Disposition", async () => {
    fetchMock.mockResolvedValue(fileResponse(null));
    await downloadFromApi("/x", "protokoll.csv");
    expect(clicked[0].download).toBe("protokoll.csv");
  });

  it("throws an ApiError with the server's message and saves nothing on a 400", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "Validierungsfehler", message: "Zu viele Einträge" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );
    const error = await downloadFromApi("/x", "f.csv").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(400);
    expect((error as ApiError).message).toContain("Zu viele Einträge");
    expect(clicked).toHaveLength(0);
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});
