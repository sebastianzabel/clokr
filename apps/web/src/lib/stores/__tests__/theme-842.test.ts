// Issue #842 (D-842-16, D-842-17) - the theme store knows exactly three themes, maps every legacy
// value before it reaches localStorage or <html data-theme>, and forgets skin and density.
//
// `$stores/theme` is imported for real (the `$app/environment` alias resolves `browser` to true);
// only the preference client is mocked so no request leaves the test. Modules are reset between
// cases so `readInitial()` runs again against the seeded storage.
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";

vi.mock("$api/preferences", () => ({
  savePreferences: vi.fn(() => Promise.resolve({})),
}));

// This workspace's jsdom exposes no `localStorage` (see auth-boot-hydration.test.ts).
function memoryStorage(seed: Record<string, string> = {}): Storage {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  } as Storage;
}

const THREE = ["pflaume", "salz", "petrol"];

async function bootWith(seed: Record<string, string>) {
  vi.stubGlobal("localStorage", memoryStorage(seed));
  document.documentElement.removeAttribute("data-theme");
  vi.resetModules();
  return await import("$stores/theme");
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("#842 D-842-17 - theme list", () => {
  it("lists exactly pflaume, salz and petrol with their labels and no colour", async () => {
    const { themes } = await bootWith({});
    expect(themes).toEqual([
      { id: "pflaume", label: "Pflaume" },
      { id: "salz", label: "Salz" },
      { id: "petrol", label: "Petrol" },
    ]);
  });
});

describe("#842 D-842-17 - legacy localStorage values are mapped and rewritten", () => {
  const CASES: [string, string][] = [
    ["lila", "pflaume"],
    ["hell", "pflaume"],
    ["nacht", "salz"],
    ["schiefer", "salz"],
    ["dunkel", "salz"],
    ["wald", "petrol"],
    ["not-a-theme", "pflaume"],
    ["", "pflaume"],
  ];

  for (const [legacy, expected] of CASES) {
    it(`'${legacy}' becomes '${expected}' in the store, in data-theme and in the stored key`, async () => {
      const { theme } = await bootWith(legacy ? { theme: legacy } : {});
      expect(get(theme)).toBe(expected);
      expect(document.documentElement.getAttribute("data-theme")).toBe(expected);
      expect(localStorage.getItem("theme")).toBe(expected);
      expect(THREE).toContain(document.documentElement.getAttribute("data-theme"));
    });
  }

  it("a current id is kept as it is", async () => {
    const { theme } = await bootWith({ theme: "petrol" });
    expect(get(theme)).toBe("petrol");
    expect(localStorage.getItem("theme")).toBe("petrol");
  });
});

describe("#842 D-842-17 - one-time mode seed for hell and dunkel only", () => {
  it("dunkel seeds mode dark when no mode key exists", async () => {
    await bootWith({ theme: "dunkel" });
    expect(localStorage.getItem("mode")).toBe("dark");
  });

  it("hell seeds mode light when no mode key exists", async () => {
    await bootWith({ theme: "hell" });
    expect(localStorage.getItem("mode")).toBe("light");
  });

  it("dunkel never overwrites an existing mode key", async () => {
    await bootWith({ theme: "dunkel", mode: "light" });
    expect(localStorage.getItem("mode")).toBe("light");
  });

  it("prototype property names seed no mode (IN-01)", async () => {
    for (const hostile of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      await bootWith({ theme: hostile });
      expect(localStorage.getItem("mode"), hostile).toBeNull();
      expect(localStorage.getItem("theme"), hostile).toBe("pflaume");
    }
  });

  it("control: a real legacy id still seeds (the guard did not close the path)", async () => {
    await bootWith({ theme: "dunkel" });
    expect(localStorage.getItem("mode")).toBe("dark");
  });

  it("nacht, schiefer and wald seed no mode", async () => {
    for (const legacy of ["nacht", "schiefer", "wald"]) {
      await bootWith({ theme: legacy });
      expect(localStorage.getItem("mode"), legacy).toBeNull();
    }
  });
});

describe("#842 D-842-16 - skin and density are forgotten", () => {
  it("removes the localStorage keys skin and density on load", async () => {
    await bootWith({ theme: "pflaume", skin: "modern", density: "compact" });
    expect(localStorage.getItem("skin")).toBeNull();
    expect(localStorage.getItem("density")).toBeNull();
  });

  it("control: the keys really are present before the store loads", () => {
    const storage = memoryStorage({ skin: "modern", density: "compact" });
    expect(storage.getItem("skin")).toBe("modern");
    expect(storage.getItem("density")).toBe("compact");
  });
});

describe("#842 T-842-06 - normalizeTheme is the allow-list in front of data-theme", () => {
  it("maps every known, legacy and foreign input to one of the three ids", async () => {
    const { normalizeTheme } = await bootWith({});
    const inputs: unknown[] = [
      "pflaume",
      "salz",
      "petrol",
      "lila",
      "hell",
      "nacht",
      "schiefer",
      "dunkel",
      "wald",
      "toString",
      "__proto__",
      '"><script>',
      null,
      undefined,
      42,
      {},
    ];
    for (const input of inputs) {
      expect(THREE, String(input)).toContain(normalizeTheme(input));
    }
    expect(normalizeTheme("wald")).toBe("petrol");
    expect(normalizeTheme("toString")).toBe("pflaume");
  });

  it("setting an unknown value on the store still writes only a valid id to data-theme", async () => {
    const { theme } = await bootWith({});
    theme.set("wald" as never);
    expect(document.documentElement.getAttribute("data-theme")).toBe("petrol");
    expect(localStorage.getItem("theme")).toBe("petrol");
  });
});
