// Issue #612 — focusTrap prefers an element carrying `data-autofocus` for the initial focus and
// otherwise behaves as before (first focusable).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { focusTrap } from "../focus-trap";

function mount(html: string) {
  const node = document.createElement("div");
  node.innerHTML = html;
  document.body.appendChild(node);
  const action = focusTrap(node);
  return { node, destroy: () => action.destroy() };
}

describe("focusTrap — initial focus", () => {
  beforeEach(() => {
    // run the animation-frame callback synchronously so the assertion needs no timer
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("focuses the first focusable element when nothing carries data-autofocus (unchanged)", () => {
    const { node, destroy } = mount('<button id="a">A</button><button id="b">B</button>');
    expect(document.activeElement).toBe(node.querySelector("#a"));
    destroy();
  });

  it("focuses the element carrying data-autofocus", () => {
    const { node, destroy } = mount(
      '<button id="a">A</button><button id="b" data-autofocus>B</button>',
    );
    expect(document.activeElement).toBe(node.querySelector("#b"));
    destroy();
  });

  it("skips a disabled data-autofocus element in favour of the first focusable", () => {
    const { node, destroy } = mount(
      '<button id="a">A</button><button id="b" data-autofocus disabled>B</button>',
    );
    expect(document.activeElement).toBe(node.querySelector("#a"));
    destroy();
  });

  it("finds a data-autofocus select", () => {
    const { node, destroy } = mount(
      '<button id="a">A</button><select id="s" data-autofocus></select>',
    );
    expect(document.activeElement).toBe(node.querySelector("#s"));
    destroy();
  });

  it("still wraps Tab from the last to the first focusable element", () => {
    const { node, destroy } = mount(
      '<button id="a">A</button><button id="b" data-autofocus>B</button>',
    );
    const last = node.querySelector("#b") as HTMLElement;
    last.focus();
    const ev = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    node.dispatchEvent(ev);
    expect(document.activeElement).toBe(node.querySelector("#a"));
    destroy();
  });
});
