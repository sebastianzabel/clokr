// Issue #849 (6) — a failing service-worker registration is caught and reported once per session.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { registerServiceWorker, SW_FAILURE_LOGGED_KEY } from "../register-service-worker";

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

describe("service-worker registration (Issue #849)", () => {
  it("a rejected registration never escapes and is logged only once per session", async () => {
    const register = vi.fn().mockRejectedValue(new Error("Failed to register a ServiceWorker"));
    const nav = { serviceWorker: { register } } as unknown as Navigator;
    const storage = memoryStorage();
    const warn = vi.fn();
    for (let i = 0; i < 5; i++) {
      await expect(registerServiceWorker({ nav, storage, dev: true, warn })).resolves.toBe(false);
    }
    expect(register).toHaveBeenCalledTimes(5);
    expect(register).toHaveBeenCalledWith("/service-worker.js", { type: "module" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(storage.getItem(SW_FAILURE_LOGGED_KEY)).toBe("1");
  });

  it("registers the classic worker in production and skips browsers without support", async () => {
    const register = vi.fn().mockResolvedValue({});
    const warn = vi.fn();
    const nav = { serviceWorker: { register } } as unknown as Navigator;
    await expect(
      registerServiceWorker({ nav, storage: memoryStorage(), dev: false, warn }),
    ).resolves.toBe(true);
    expect(register).toHaveBeenCalledWith("/service-worker.js", { type: "classic" });
    await expect(
      registerServiceWorker({ nav: {} as Navigator, storage: undefined, dev: false, warn }),
    ).resolves.toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("SvelteKit's uncaught auto-registration is off; the root layout registers instead", () => {
    const config = readFileSync(resolve(process.cwd(), "svelte.config.js"), "utf8");
    expect(config).toMatch(/serviceWorker:\s*\{\s*register:\s*false/);
    const layout = readFileSync(resolve(process.cwd(), "src/routes/+layout.svelte"), "utf8");
    expect(layout).toContain("registerServiceWorker(");
  });
});
