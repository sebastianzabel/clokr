import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchSchoolHolidays, SchoolHolidaysApiError } from "../utils/school-holidays-client";

// Mock global fetch — we never hit the real OpenHolidays API in unit tests.
const originalFetch = global.fetch;

function mockFetchOnce(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  global.fetch = vi.fn(impl) as unknown as typeof fetch;
  return global.fetch as unknown as ReturnType<typeof vi.fn>;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const samplePayload = [
  {
    id: "abc-uuid-1",
    startDate: "2026-02-16",
    endDate: "2026-02-20",
    type: "School",
    name: [
      { language: "DE", text: "Frühjahrsferien" },
      { language: "EN", text: "Spring Holidays" },
    ],
    subdivisions: [{ code: "DE-BY", shortName: "BY" }],
  },
  {
    id: "abc-uuid-2",
    startDate: "2026-07-27",
    endDate: "2026-09-07",
    type: "School",
    name: [{ language: "DE", text: "Sommerferien" }],
    subdivisions: [{ code: "DE-BY", shortName: "BY" }],
  },
];

describe("school-holidays-client", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("parses 200 OK into typed DTOs with German name preferred", async () => {
    mockFetchOnce(async () => jsonResponse(samplePayload, 200));

    const result = await fetchSchoolHolidays("DE-BY", 2026, 2027);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      externalId: "abc-uuid-1",
      startDate: new Date("2026-02-16T00:00:00Z"),
      endDate: new Date("2026-02-20T00:00:00Z"),
      name: "Frühjahrsferien",
      subdivisionCode: "DE-BY",
    });
    expect(result[1].name).toBe("Sommerferien");
  });

  it("German-name preferred over English in name[]", async () => {
    mockFetchOnce(async () =>
      jsonResponse(
        [
          {
            id: "x",
            startDate: "2026-01-01",
            endDate: "2026-01-02",
            type: "School",
            name: [
              { language: "EN", text: "Winter Break" },
              { language: "DE", text: "Winterferien" },
            ],
            subdivisions: [{ code: "DE-BY" }],
          },
        ],
        200,
      ),
    );

    const result = await fetchSchoolHolidays("DE-BY", 2026, 2026);
    expect(result[0].name).toBe("Winterferien");
  });

  it("falls back to first name[] entry when DE missing", async () => {
    mockFetchOnce(async () =>
      jsonResponse(
        [
          {
            id: "x",
            startDate: "2026-01-01",
            endDate: "2026-01-02",
            type: "School",
            name: [{ language: "EN", text: "Winter Break" }],
            subdivisions: [{ code: "DE-BY" }],
          },
        ],
        200,
      ),
    );

    const result = await fetchSchoolHolidays("DE-BY", 2026, 2026);
    expect(result[0].name).toBe("Winter Break");
  });

  it("filters out non-School entries (defense-in-depth)", async () => {
    mockFetchOnce(async () =>
      jsonResponse(
        [
          {
            id: "a",
            startDate: "2026-01-01",
            endDate: "2026-01-01",
            type: "Public",
            name: [{ language: "DE", text: "Neujahr" }],
            subdivisions: [{ code: "DE-BY" }],
          },
          {
            id: "b",
            startDate: "2026-02-16",
            endDate: "2026-02-20",
            type: "School",
            name: [{ language: "DE", text: "Frühjahrsferien" }],
            subdivisions: [{ code: "DE-BY" }],
          },
        ],
        200,
      ),
    );

    const result = await fetchSchoolHolidays("DE-BY", 2026, 2026);
    expect(result).toHaveLength(1);
    expect(result[0].externalId).toBe("b");
  });

  it("retries 5xx up to 3 times then throws SchoolHolidaysApiError", async () => {
    let calls = 0;
    const spy = mockFetchOnce(async () => {
      calls++;
      return new Response("upstream down", { status: 503 });
    });

    await expect(fetchSchoolHolidays("DE-BY", 2026, 2026)).rejects.toThrow(SchoolHolidaysApiError);

    // Confirm exactly 3 attempts were made (MAX_RETRIES).
    expect(spy).toHaveBeenCalledTimes(3);
    expect(calls).toBe(3);
  });

  it("503 retries then throws with status: 503", async () => {
    mockFetchOnce(async () => new Response("err", { status: 503 }));

    await expect(fetchSchoolHolidays("DE-BY", 2026, 2026)).rejects.toMatchObject({
      name: "SchoolHolidaysApiError",
      status: 503,
    });
  });

  it("throws immediately on 4xx (no retry)", async () => {
    const spy = mockFetchOnce(async () => new Response("bad subdivision", { status: 404 }));

    await expect(fetchSchoolHolidays("DE-XX", 2026, 2026)).rejects.toMatchObject({
      name: "SchoolHolidaysApiError",
      status: 404,
    });
    // Exactly ONE call — 4xx is not retryable.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("throws SchoolHolidaysApiError with status TIMEOUT on AbortError", async () => {
    mockFetchOnce(async () => {
      // Simulate a fetch that throws AbortError (timeout path).
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    });

    await expect(fetchSchoolHolidays("DE-BY", 2026, 2026)).rejects.toMatchObject({
      name: "SchoolHolidaysApiError",
      status: "TIMEOUT",
    });
  });

  it("throws SchoolHolidaysApiError with status NETWORK on generic fetch error", async () => {
    mockFetchOnce(async () => {
      throw new TypeError("fetch failed: ECONNREFUSED");
    });

    await expect(fetchSchoolHolidays("DE-BY", 2026, 2026)).rejects.toMatchObject({
      name: "SchoolHolidaysApiError",
      status: "NETWORK",
    });
  });

  it("passes expected query params (countryIsoCode, subdivisionCode, validFrom/To, languageIsoCode)", async () => {
    const spy = mockFetchOnce(async (url) => {
      // url is the first arg
      expect(typeof url).toBe("string");
      const parsed = new URL(url);
      expect(parsed.searchParams.get("countryIsoCode")).toBe("DE");
      expect(parsed.searchParams.get("subdivisionCode")).toBe("DE-BY");
      expect(parsed.searchParams.get("validFrom")).toBe("2026-01-01");
      expect(parsed.searchParams.get("validTo")).toBe("2027-12-31");
      expect(parsed.searchParams.get("languageIsoCode")).toBe("DE");
      return jsonResponse([], 200);
    });

    await fetchSchoolHolidays("DE-BY", 2026, 2027);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
