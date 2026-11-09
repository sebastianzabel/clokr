// Issue #576 (D-576-04/05) — the What's-New panel opens only on the reader's click. (a) No code
// path outside the store and the panel opens it; (b) mounted: the Mehr sheet's version entry shows
// the „Neu“ badge while something visible is unread, a click opens the panel, sends one seen PUT
// and the badge disappears.
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/svelte";
import { get } from "svelte/store";

const apiGet = vi.fn();
const apiPut = vi.fn();
vi.mock("$api/client", () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
    put: (...args: unknown[]) => apiPut(...args),
  },
}));
vi.mock("$stores/auth", async () => {
  const { writable } = await import("svelte/store");
  return { authStore: writable({ user: { permissions: [] } }) };
});

import { renderWithTheme } from "$tests/test-utils";
import { versionStore } from "$stores/version";
import {
  lastSeenStore,
  loadReleaseNotesData,
  releaseNotesStore,
  whatsNewOpen,
} from "$stores/release-notes";
import MobileMoreSheet from "$lib/components/layout/MobileMoreSheet.svelte";

function webSrc(): string {
  try {
    const root = fileURLToPath(new URL("..", import.meta.url));
    if (existsSync(join(root, "app.html"))) return root;
  } catch {
    // fall through to the cwd-based root
  }
  return resolve(process.cwd(), "src");
}

const SRC = webSrc();
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" ? [] : walk(path);
    return /\.(ts|svelte)$/.test(name) && !name.endsWith(".test.ts") ? [path] : [];
  });
}
const FILES = walk(SRC);
/** Source without whole-line comments. */
const code = (path: string) =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");

describe("Issue #576 — no automatic opening", () => {
  it("walks the web source (non-vacuity)", () => {
    expect(FILES.length).toBeGreaterThan(300);
  });

  it("only the store and the panel touch the open state; only the store opens it", () => {
    const touching = FILES.filter((f) => code(f).includes("whatsNewOpen")).map((f) =>
      relative(SRC, f).split("\\").join("/"),
    );
    expect(touching.sort()).toEqual(
      ["lib/components/layout/WhatsNewPanel.svelte", "lib/stores/release-notes.ts"].sort(),
    );
    const opening = FILES.filter((f) => code(f).includes("whatsNewOpen.set(true)")).map((f) =>
      relative(SRC, f).split("\\").join("/"),
    );
    expect(opening).toEqual(["lib/stores/release-notes.ts"]);
  });

  it("the (app) layout has no effect that opens the panel", () => {
    const layout = code(join(SRC, "routes", "(app)", "+layout.svelte"));
    expect(layout).not.toMatch(/hasUnreadReleaseNotes|autoOpened|openWhatsNew/);
  });
});

describe("Issue #576 — badge and click (mounted Mehr sheet)", () => {
  it("shows „Neu“ while unread, opens on click, marks seen once, then hides the badge", async () => {
    apiGet.mockImplementation((path: string) => {
      if (path === "/release-notes")
        return Promise.resolve({
          releases: [
            {
              version: "1.99.0",
              title: "Probe",
              intro: [],
              footnote: null,
              sections: [{ heading: "Neue Funktionen", audience: "all", bullets: [] }],
            },
          ],
        });
      if (path === "/me/release-notes-seen") return Promise.resolve({ lastSeenVersion: "1.98.0" });
      if (path === "/version") return Promise.resolve({ version: "1.99.0" });
      return Promise.resolve({});
    });
    apiPut.mockResolvedValue(undefined);
    versionStore.set("1.99.0");
    loadReleaseNotesData();
    renderWithTheme(MobileMoreSheet, { open: true, sections: [], currentPath: "/dashboard" });
    const entry = await screen.findByRole("button", {
      name: "Was ist neu in Version 1.99.0 (ungelesen)",
    });
    expect(screen.getByText("Neu")).toBeInTheDocument();
    expect(get(whatsNewOpen)).toBe(false);
    await fireEvent.click(entry);
    expect(get(whatsNewOpen)).toBe(true);
    expect(apiPut).toHaveBeenCalledTimes(1);
    expect(apiPut).toHaveBeenCalledWith("/me/release-notes-seen", { version: "1.99.0" });
    await waitFor(() => expect(screen.queryByText("Neu")).toBeNull());
    expect(get(lastSeenStore)).toBe("1.99.0");
    releaseNotesStore.set([]);
  });
});
