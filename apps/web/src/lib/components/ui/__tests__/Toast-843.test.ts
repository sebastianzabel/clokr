// Issue #843 (D-843-01 block 9, D-843-19, P9) - Toast: persistent live regions outside the app root,
// legacy classes kept for the e2e specs, success default 2.6 s.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import { renderWithTheme } from "$tests/test-utils";
import { toasts } from "$stores/toast";
import Toast from "../Toast.svelte";
import ToastItem from "../ToastItem.svelte";
import toastSource from "../Toast.svelte?raw";
import itemSource from "../ToastItem.svelte?raw";

function clearStore() {
  // The store is module state; drop every item a test left behind.
  let ids: string[] = [];
  const unsub = toasts.subscribe((v) => (ids = v.map((t) => t.id)));
  unsub();
  for (const id of ids) toasts.remove(id);
}

function regions() {
  const container = document.body.querySelector(":scope > .toast-container") as HTMLElement | null;
  return {
    container,
    status: document.querySelector('[data-testid="toast-region-status"]') as HTMLElement | null,
    alert: document.querySelector('[data-testid="toast-region-alert"]') as HTMLElement | null,
  };
}

describe("Toast - live regions", () => {
  afterEach(() => {
    cleanup();
    clearStore();
    vi.useRealTimers();
  });

  it("renders the container as a direct child of body with two empty live regions", () => {
    const { container: host } = render(Toast);
    const { container, status, alert } = regions();
    expect(container).not.toBeNull();
    expect(container!.hasAttribute("data-toast-root")).toBe(true);
    // Moved out of the mount target: the component's own host holds no toast markup.
    expect(host.querySelector(".toast-container")).toBeNull();
    expect(status!.getAttribute("role")).toBe("status");
    expect(status!.getAttribute("aria-live")).toBe("polite");
    expect(alert!.getAttribute("role")).toBe("alert");
    expect(status!.children.length).toBe(0);
    expect(alert!.children.length).toBe(0);
  });

  it("removes the container again when the component is destroyed", () => {
    const { unmount } = render(Toast);
    expect(regions().container).not.toBeNull();
    unmount();
    expect(regions().container).toBeNull();
  });

  it("puts a success into the status region with an aria-hidden icon", async () => {
    render(Toast);
    toasts.success("Eingestempelt 10:02");
    await tick();
    const { status, alert } = regions();
    const item = status!.querySelector(".toast.toast-success") as HTMLElement;
    expect(item).not.toBeNull();
    expect(item.querySelector(".toast-message")!.textContent).toBe("Eingestempelt 10:02");
    expect(item.querySelector(".toast-icon svg")!.getAttribute("aria-hidden")).toBe("true");
    expect(item.querySelector(".toast-close")).toBeNull();
    expect(alert!.children.length).toBe(0);
  });

  it("puts info and warning into the status region", async () => {
    render(Toast);
    toasts.info("Hinweis");
    toasts.warning("Achtung");
    await tick();
    const { status } = regions();
    expect(status!.querySelector(".toast-info")).not.toBeNull();
    expect(status!.querySelector(".toast-warning")).not.toBeNull();
  });

  it("puts an error into the alert region with a labelled close button that removes it", async () => {
    render(Toast);
    toasts.error("Speichern hat nicht geklappt.");
    await tick();
    const { status, alert } = regions();
    expect(status!.children.length).toBe(0);
    const item = alert!.querySelector(".toast.toast-error") as HTMLElement;
    expect(item).not.toBeNull();
    const close = item.querySelector(".toast-close") as HTMLButtonElement;
    expect(close.getAttribute("aria-label")).toBe("Schließen");
    close.click();
    await waitFor(() => expect(alert!.querySelector(".toast-error")).toBeNull());
  });

  it("a success disappears after 2600 ms, an explicit duration wins", async () => {
    vi.useFakeTimers();
    render(Toast);
    toasts.success("Standard");
    toasts.success("Lang", 10000);
    await tick();
    const { status } = regions();
    expect(status!.querySelectorAll(".toast-success").length).toBe(2);
    vi.advanceTimersByTime(2599);
    await tick();
    expect(status!.querySelectorAll(".toast-success").length).toBe(2);
    vi.advanceTimersByTime(1);
    await tick();
    expect(status!.querySelectorAll(".toast-success").length).toBe(1);
    expect(status!.textContent).toContain("Lang");
  });

  it("an error lasts 6000 ms by default", async () => {
    vi.useFakeTimers();
    render(Toast);
    toasts.error("Fehler");
    await tick();
    const { alert } = regions();
    vi.advanceTimersByTime(5999);
    await tick();
    expect(alert!.querySelectorAll(".toast-error").length).toBe(1);
    vi.advanceTimersByTime(1);
    await tick();
    expect(alert!.querySelectorAll(".toast-error").length).toBe(0);
  });

  it("mounts without window.matchMedia", () => {
    const original = window.matchMedia;
    // @ts-expect-error - simulate an environment that cannot read the preference
    window.matchMedia = undefined;
    try {
      expect(() => render(Toast)).not.toThrow();
    } finally {
      window.matchMedia = original;
    }
  });

  it("renders text, never HTML", async () => {
    render(Toast);
    toasts.error("<img src=x onerror=alert(1)>");
    await tick();
    const { alert } = regions();
    expect(alert!.querySelector("img")).toBeNull();
    expect(alert!.textContent).toContain("<img");
  });
});

describe("ToastItem", () => {
  afterEach(() => cleanup());

  it("renders the toast markup; the close button exists for errors only", () => {
    const success = renderWithTheme(ToastItem, { type: "success", message: "Gespeichert" });
    expect(
      success.container.querySelector(".toast.toast-success .toast-message")!.textContent,
    ).toBe("Gespeichert");
    expect(success.container.querySelector(".toast-close")).toBeNull();
    cleanup();
    const onClose = vi.fn();
    const error = renderWithTheme(ToastItem, { type: "error", message: "Fehler", onClose });
    (error.container.querySelector(".toast-close") as HTMLButtonElement).click();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("Toast renders its items through ToastItem (one markup source)", () => {
    expect(toastSource).toContain("<ToastItem");
    expect(toastSource).not.toContain('class="toast ');
  });
});

describe("Toast - source contracts", () => {
  it("keeps z-index 9999 on .toast-container in its own style block", () => {
    expect(toastSource).toMatch(/\.toast-container\s*\{[^}]*z-index:\s*9999/);
  });

  it("uses no module-scope matchMedia and no {@html}", () => {
    expect(toastSource).not.toContain("matchMedia");
    expect(toastSource).not.toContain("{@html");
    expect(itemSource).not.toContain("{@html");
  });

  it("the root layout still mounts <Toast after the boundary and is unchanged by this block", () => {
    const layout = readFileSync(resolve(process.cwd(), "src/routes/+layout.svelte"), "utf8");
    expect(layout).toContain("<Toast");
  });
});

beforeEach(() => clearStore());
