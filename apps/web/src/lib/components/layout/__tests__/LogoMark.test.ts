// Issue #842 — the logo mark of the design prototype, mounted. Pins the geometry (one ring, two
// hand paths, all stroked with currentColor so the mark follows the theme) and the accessibility
// contract (decorative by default, an image with a name when a title is given).
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import LogoMark from "../LogoMark.svelte";

afterEach(cleanup);

describe("LogoMark", () => {
  it("renders one svg with one circle and two paths, all stroked with currentColor", () => {
    const { container } = render(LogoMark);
    const svgs = container.querySelectorAll("svg");
    expect(svgs).toHaveLength(1);
    expect(svgs[0].getAttribute("viewBox")).toBe("0 0 40 40");
    const shapes = svgs[0].querySelectorAll("circle, path");
    expect(svgs[0].querySelectorAll("circle")).toHaveLength(1);
    expect(svgs[0].querySelectorAll("path")).toHaveLength(2);
    for (const shape of shapes) {
      expect(shape.getAttribute("stroke")).toBe("currentColor");
      expect(shape.getAttribute("stroke-width")).toBe("5.5");
    }
  });

  it("is decorative by default", () => {
    const { container } = render(LogoMark);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("role")).toBeNull();
    expect(svg.querySelector("title")).toBeNull();
  });

  it("is an image with an accessible name when a title is given", () => {
    const { container, getByRole } = render(LogoMark, { props: { title: "Clokr" } });
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("aria-hidden")).toBeNull();
    expect(svg.querySelector("title")?.textContent).toBe("Clokr");
    expect(getByRole("img", { name: "Clokr" })).toBeTruthy();
  });

  it("takes its edge length from size", () => {
    const { container } = render(LogoMark, { props: { size: 40 } });
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("width")).toBe("40");
    expect(svg.getAttribute("height")).toBe("40");
  });
});
