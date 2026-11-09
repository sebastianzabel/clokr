// Issue #843 (D-843-01 block 12) - the motion module: the reduced-motion store, fade, countUp,
// stagger, and the app.css reveal pinned to the TS constants.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { COUNT_MS, STAGGER_MS, STATE_MS, countUp, fade, reducedMotion, stagger } from "../index";

// A CSS file is not importable as ?raw under this vitest config (css handling returns nothing), so
// the real file is read from disk.
const rawCss = readFileSync(resolve(process.cwd(), "src/app.css"), "utf8");

/** app.css without comments, so a selector list is never prefixed by prose. */
const appCss = rawCss.replace(/\/\*[\s\S]*?\*\//g, "");

interface FakeQuery {
  matches: boolean;
  listeners: Array<(e: { matches: boolean }) => void>;
}

/** Stubs window.matchMedia; `matches` answers the reduce query. */
function stubMatchMedia(matches: boolean): FakeQuery {
  const query: FakeQuery = { matches, listeners: [] };
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      get matches() {
        return query.matches;
      },
      addEventListener: (_: string, fn: (e: { matches: boolean }) => void) =>
        query.listeners.push(fn),
      removeEventListener: (_: string, fn: (e: { matches: boolean }) => void) => {
        query.listeners = query.listeners.filter((l) => l !== fn);
      },
    })),
  );
  return query;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("constants", () => {
  it("are the values of D-843-01", () => {
    expect([STATE_MS, COUNT_MS, STAGGER_MS]).toEqual([350, 500, 35]);
  });
});

describe("reducedMotion", () => {
  it("is true where matchMedia does not exist (jsdom, SSR)", () => {
    expect(typeof window.matchMedia).not.toBe("function");
    expect(get(reducedMotion)).toBe(true);
  });

  it("is true when the reduce query matches", () => {
    stubMatchMedia(true);
    expect(get(reducedMotion)).toBe(true);
  });

  it("is false when it does not match, and follows change events", () => {
    const query = stubMatchMedia(false);
    const seen: boolean[] = [];
    const stop = reducedMotion.subscribe((v) => seen.push(v));
    expect(seen).toEqual([false]);
    query.listeners.forEach((l) => l({ matches: true }));
    expect(seen).toEqual([false, true]);
    stop();
    expect(query.listeners).toHaveLength(0);
  });
});

describe("fade", () => {
  it("lasts STATE_MS, and 0 under reduced motion", () => {
    const node = document.createElement("div");
    stubMatchMedia(false);
    expect(fade(node).duration).toBe(STATE_MS);
    vi.unstubAllGlobals();
    expect(fade(node).duration).toBe(0);
  });
});

describe("countUp", () => {
  const fmt = (n: number) => `${Math.round(n)} h`;

  it("writes the final formatted value at once under reduced motion", () => {
    const node = document.createElement("span");
    countUp(node, { value: 42, format: fmt });
    expect(node.textContent).toBe("42 h");
  });

  it("writes a non-numeric value as-is", () => {
    stubMatchMedia(false);
    const node = document.createElement("span");
    countUp(node, { value: "+12:45" });
    expect(node.textContent).toBe("+12:45");
  });

  it("animates, ends at exactly the formatted target, and animates updates from the previous value", () => {
    stubMatchMedia(false);
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) =>
      setTimeout(() => cb(performance.now()), 16),
    );
    vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
    const node = document.createElement("span");
    const action = countUp(node, { value: 100, format: fmt });
    vi.advanceTimersByTime(COUNT_MS / 2);
    const mid = Number.parseInt(node.textContent ?? "", 10);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(100);
    vi.advanceTimersByTime(COUNT_MS);
    expect(node.textContent).toBe("100 h");

    action.update({ value: 40, format: fmt });
    vi.advanceTimersByTime(COUNT_MS / 2);
    const down = Number.parseInt(node.textContent ?? "", 10);
    expect(down).toBeLessThan(100);
    expect(down).toBeGreaterThan(40);
    vi.advanceTimersByTime(COUNT_MS);
    expect(node.textContent).toBe("40 h");
  });

  it("destroy cancels the pending frame, so nothing is written afterwards", () => {
    stubMatchMedia(false);
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) =>
      setTimeout(() => cb(performance.now()), 16),
    );
    const cancel = vi.fn((id: number) => clearTimeout(id));
    vi.stubGlobal("cancelAnimationFrame", cancel);
    const node = document.createElement("span");
    const action = countUp(node, { value: 100, format: fmt });
    action.destroy();
    expect(cancel).toHaveBeenCalled();
    const before = node.textContent;
    vi.advanceTimersByTime(COUNT_MS * 2);
    expect(node.textContent).toBe(before);
  });

  it("keeps the framework's text node when there is exactly one", () => {
    const node = document.createElement("span");
    node.textContent = "0";
    const text = node.firstChild;
    countUp(node, { value: 7 });
    expect(node.firstChild).toBe(text);
    expect(node.textContent).toBe("7");
  });
});

describe("stagger", () => {
  let node: HTMLElement;
  beforeEach(() => {
    node = document.createElement("li");
  });

  it("sets --card-idx to the index", () => {
    stubMatchMedia(false);
    const action = stagger(node, { index: 3 });
    expect(node.style.getPropertyValue("--card-idx")).toBe("3");
    action.update({ index: 5 });
    expect(node.style.getPropertyValue("--card-idx")).toBe("5");
    action.destroy();
    expect(node.style.getPropertyValue("--card-idx")).toBe("");
  });

  it("sets nothing under reduced motion", () => {
    stagger(node, { index: 3 });
    expect(node.style.getPropertyValue("--card-idx")).toBe("");
  });
});

describe(".card-animate in app.css follows the constants", () => {
  /** Every rule block whose selector list names .card-animate. */
  const rules = [...appCss.matchAll(/([^{}]*\.card-animate[^{}]*)\{([^{}]*)\}/g)].map((m) => ({
    selector: m[1].trim(),
    body: m[2],
  }));

  it("finds a non-empty rule set", () => {
    expect(rules.length).toBeGreaterThanOrEqual(12);
    expect(rules.filter((r) => /nth-child/.test(r.selector)).length).toBeGreaterThanOrEqual(12);
  });

  it("steps every literal delay by a multiple of STAGGER_MS, one position at a time", () => {
    const stepped = rules.filter((r) => /nth-child\((\d)\)/.test(r.selector));
    for (const rule of stepped) {
      const pos = Number(/nth-child\((\d)\)/.exec(rule.selector)![1]);
      const delay = Number(/animation-delay:\s*(\d+)ms/.exec(rule.body)![1]);
      expect(delay % STAGGER_MS).toBe(0);
      expect(delay).toBe((pos - 1) * STAGGER_MS);
    }
    expect(stepped).toHaveLength(12);
  });

  it("derives the --card-idx delay from STAGGER_MS", () => {
    const idx = rules.find((r) => r.selector.includes("--card-idx"));
    expect(idx).toBeDefined();
    expect(idx!.body).toContain(`* ${STAGGER_MS}ms`);
  });

  it("keeps the backwards fill (never both/forwards, #570)", () => {
    const shorthands = rules
      .filter((r) => r.selector === ".card-animate")
      .map((r) => /animation:\s*([^;]+);/.exec(r.body)?.[1])
      .filter(Boolean) as string[];
    expect(shorthands.length).toBeGreaterThanOrEqual(2);
    for (const value of shorthands) {
      expect(value).toMatch(/\bbackwards\b/);
      expect(value).not.toMatch(/\b(both|forwards)\b/);
    }
  });

  it("is off in the reduced-motion block", () => {
    // The block closes at the first line that is exactly "}" (nested rules are indented).
    const start = appCss.indexOf("@media (prefers-reduced-motion: reduce) {");
    expect(start).toBeGreaterThanOrEqual(0);
    const body = appCss.slice(start, appCss.indexOf("\n}\n", start));
    expect(body).toMatch(/\.card-animate[\s\S]*animation:\s*none/);
  });
});
