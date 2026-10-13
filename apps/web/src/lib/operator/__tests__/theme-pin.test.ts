import { afterEach, describe, expect, it, vi } from "vitest";

import { pinOperatorLook } from "../theme-pin";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pinOperatorLook (UI-SPEC skin decision)", () => {
  it("pins theme nacht and density comfortable and removes the skin", () => {
    const html = document.createElement("html");
    html.setAttribute("data-theme", "pflaume");
    html.setAttribute("data-density", "compact");
    html.setAttribute("data-skin", "modern");
    html.setAttribute("data-mode", "dark");

    pinOperatorLook(html);

    expect(html.getAttribute("data-theme")).toBe("nacht");
    expect(html.getAttribute("data-density")).toBe("comfortable");
    expect(html.hasAttribute("data-skin")).toBe(false);
    // The mode follows the device and is never touched.
    expect(html.getAttribute("data-mode")).toBe("dark");
  });

  it("restores exactly the previous values", () => {
    const html = document.createElement("html");
    html.setAttribute("data-theme", "wald");
    html.setAttribute("data-density", "compact");
    html.setAttribute("data-skin", "modern");

    const restore = pinOperatorLook(html);
    restore();

    expect(html.getAttribute("data-theme")).toBe("wald");
    expect(html.getAttribute("data-density")).toBe("compact");
    expect(html.getAttribute("data-skin")).toBe("modern");
  });

  it("restores an absent attribute as absent", () => {
    const html = document.createElement("html");

    const restore = pinOperatorLook(html);
    expect(html.getAttribute("data-theme")).toBe("nacht");
    restore();

    expect(html.hasAttribute("data-theme")).toBe(false);
    expect(html.hasAttribute("data-density")).toBe(false);
    expect(html.hasAttribute("data-skin")).toBe(false);
  });

  it("never touches localStorage", () => {
    const touched: string[] = [];
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => (touched.push(`get:${k}`), null),
      setItem: (k: string) => touched.push(`set:${k}`),
      removeItem: (k: string) => touched.push(`remove:${k}`),
    });
    const html = document.createElement("html");

    pinOperatorLook(html)();

    expect(touched).toEqual([]);
  });
});
