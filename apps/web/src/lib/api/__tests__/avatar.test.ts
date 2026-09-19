import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchAvatarObjectUrl } from "$api/avatar";

// Hand-rolled response double, not `new Response(...)` — a real Response
// disagrees with jsdom about zero-byte bodies, which would make the
// zero-byte case untestable. The helper only touches `ok`, `status`, and
// `blob()`, so this double is faithful, not weakened.
function fakeResponse(status: number, blobSize: number) {
  return {
    ok: status >= 200 && status < 300,
    status,
    blob: async () => ({ size: blobSize }) as unknown as Blob,
  };
}

let createObjectURL: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  createObjectURL = vi.fn(() => "blob:fake-url");
  vi.stubGlobal("URL", { ...URL, createObjectURL });
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe("fetchAvatarObjectUrl", () => {
  it("resolves to the object URL for a 200 with a non-empty body", async () => {
    fetchMock.mockResolvedValue(fakeResponse(200, 42));
    const url = await fetchAvatarObjectUrl("emp-1", "tok", 3);
    expect(url).toBe("blob:fake-url");
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  it("resolves to null for a 204 and never calls createObjectURL", async () => {
    // Non-zero blobSize is deliberate: it isolates the `res.status === 204` guard
    // from the separate zero-byte guard below. A real 204 has an empty body, but if
    // this test used blobSize 0 too, removing the status check would still pass via
    // the zero-byte guard — masking the exact regression this test exists to catch
    // (`res.ok` is true for 204, so a naive `!res.ok` check lets it through).
    fetchMock.mockResolvedValue(fakeResponse(204, 42));
    const url = await fetchAvatarObjectUrl("emp-1", "tok", 3);
    expect(url).toBeNull();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("resolves to null for a 200 with a zero-byte blob (proxy rewrite defence)", async () => {
    fetchMock.mockResolvedValue(fakeResponse(200, 0));
    const url = await fetchAvatarObjectUrl("emp-1", "tok", 3);
    expect(url).toBeNull();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("resolves to null for a 404 and never calls createObjectURL", async () => {
    fetchMock.mockResolvedValue(fakeResponse(404, 0));
    const url = await fetchAvatarObjectUrl("emp-1", "tok", 3);
    expect(url).toBeNull();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("resolves to null (does not throw) when fetch rejects", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    await expect(fetchAvatarObjectUrl("emp-1", "tok", 3)).resolves.toBeNull();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("requests the expected URL with the expected headers", async () => {
    fetchMock.mockResolvedValue(fakeResponse(200, 1));
    await fetchAvatarObjectUrl("emp-1", "tok", 3);
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/avatars/emp-1?v=3", {
      headers: { Authorization: "Bearer tok" },
      cache: "no-cache",
    });
  });
});
