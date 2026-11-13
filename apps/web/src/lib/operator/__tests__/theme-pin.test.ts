import { afterEach, describe, expect, it, vi } from "vitest";

import { pinOperatorLook } from "../theme-pin";

afterEach(() => {
  vi.unstubAllGlobals();
});

// #842 D-842-21: the console pins only the graphite theme (salz); the colour mode follows the
// device and the retired skin and density attributes no longer exist.
describe("pinOperatorLook (D-842-21)", () => {
  it("pins data-theme salz and leaves data-mode untouched", () => {
    const html = document.createElement("html");
    html.setAttribute("data-theme", "pflaume");
    html.setAttribute("data-mode", "dark");

    pinOperatorLook(html);

    expect(html.getAttribute("data-theme")).toBe("salz");
    // The mode follows the device and is never touched.
    expect(html.getAttribute("data-mode")).toBe("dark");
  });

  it("pins nothing but the theme attribute", () => {
    const html = document.createElement("html");

    pinOperatorLook(html);

    expect(html.getAttributeNames()).toEqual(["data-theme"]);
  });

  it("restores the previous theme exactly", () => {
    const html = document.createElement("html");
    html.setAttribute("data-theme", "petrol");

    const restore = pinOperatorLook(html);
    expect(html.getAttribute("data-theme")).toBe("salz");
    restore();

    expect(html.getAttribute("data-theme")).toBe("petrol");
  });

  it("restores an absent attribute as absent", () => {
    const html = document.createElement("html");

    const restore = pinOperatorLook(html);
    expect(html.getAttribute("data-theme")).toBe("salz");
    restore();

    expect(html.hasAttribute("data-theme")).toBe(false);
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
