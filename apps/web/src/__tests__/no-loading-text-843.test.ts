// Issue #843, AC-6 (D-843-07, D-843-20, plan 843-31): no loading text exists outside the Skeleton,
// and a Spinner appears only inside a button. The matcher is deliberately broad - case-insensitive,
// with or without an ellipsis, in visible markup, visually hidden text, attribute values and string
// literals - so a spelling the first sweeps did not know cannot slip through. A scan that matches
// nothing reports OK forever, so this file proves the matcher can fail (positive controls), does not
// over-fire (negative controls) and that the walked set is not empty (floor).

import { describe, it, expect } from "vitest";

import { SRC_ROOT, walkFiles } from "./design-source-files";

// ── Source stripping ─────────────────────────────────────────────────────────

/** Blanks `text` but keeps its newlines, so line numbers of the remaining text stay true. */
function blank(text: string): string {
  return text.replace(/[^\n]/g, " ");
}

/**
 * Blanks JS/TS comments and keeps string literals (a loading text in a string literal is a hit).
 * A small scanner instead of a regex, because `//` inside a string ("https://…") is no comment.
 */
function stripScriptComments(code: string): string {
  let out = "";
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    const next = code[i + 1];
    if (ch === "/" && next === "/") {
      let j = i;
      while (j < code.length && code[j] !== "\n") j++;
      out += blank(code.slice(i, j));
      i = j;
    } else if (ch === "/" && next === "*") {
      const end = code.indexOf("*/", i + 2);
      const j = end === -1 ? code.length : end + 2;
      out += blank(code.slice(i, j));
      i = j;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < code.length && code[j] !== ch) {
        if (code[j] === "\\") j++;
        j++;
      }
      out += code.slice(i, j + 1);
      i = j + 1;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/**
 * The text a loading-word scan looks at: comments (JS, JSDoc, HTML) and `<style>` blocks are
 * blanked, markup text, attribute values and string literals stay. Line numbers are preserved.
 */
export function scannableText(rel: string, text: string): string {
  if (!rel.endsWith(".svelte")) return stripScriptComments(text);
  let out = text.replace(/<style[^>]*>[\s\S]*?<\/style>/g, (m) => blank(m));
  out = out.replace(/<!--[\s\S]*?-->/g, (m) => blank(m));
  out = out.replace(
    /(<script[^>]*>)([\s\S]*?)(<\/script>)/g,
    (_m, open: string, body: string, close: string) => open + stripScriptComments(body) + close,
  );
  return out;
}

// ── The matcher ──────────────────────────────────────────────────────────────

const NOT_LETTER_BEFORE = "(?<![\\p{L}\\p{N}_])";
const NOT_LETTER_AFTER = "(?![\\p{L}\\p{N}_])";

/** Loading wording (the German forms of "to load" and its progressive), any case, whole words only. */
const LOADING_WORDS = new RegExp(
  `${NOT_LETTER_BEFORE}(?:(?:wird|werden)\\s+geladen|lädt|lade|laden)${NOT_LETTER_AFTER}`,
  "giu",
);

/**
 * The non-loading phrases that contain a loading word. Each carries its reason; the matcher blanks
 * them before it looks for loading words. Anything else with a loading word is a hit.
 */
export const ALLOWED_PHRASES: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /fehler\s+beim\s+laden/giu, reason: "error message: the load failed" },
  { pattern: /erneut\s+laden/giu, reason: "action label: retry a failed load" },
  { pattern: /neu\s+laden/giu, reason: "action label: reload the page" },
  {
    pattern: /(?<![\p{L}\p{N}_])laden?\s+(?:sie\s+)?(?:die\s+)?seite\s+neu/giu,
    reason: "hint: reload the page („lade die Seite neu“, „laden Sie die Seite neu“)",
  },
  { pattern: /datei\s+laden/giu, reason: "action label: pick a file to load" },
  {
    pattern: /zu\s+laden/giu,
    reason: "infinitive of a described action („um die Geräte zu laden“)",
  },
  {
    pattern: /(?<![\p{L}\p{N}_])lade\s+[\p{L}-]+\s+ein(?![\p{L}\p{N}_])/giu,
    reason: "separable verb einladen („lade sie ein“): inviting people, not loading",
  },
];

/** Every loading-text hit of one file as `file:line: text`. */
export function findLoadingTexts(rel: string, text: string): string[] {
  let scan = scannableText(rel, text);
  for (const { pattern } of ALLOWED_PHRASES) {
    scan = scan.replace(pattern, (m) => blank(m));
  }
  const lines = scan.split("\n");
  const original = text.split("\n");
  const hits: string[] = [];
  lines.forEach((line, idx) => {
    LOADING_WORDS.lastIndex = 0;
    if (LOADING_WORDS.test(line)) hits.push(`${rel}:${idx + 1}: ${original[idx].trim()}`);
  });
  return hits;
}

/**
 * Spinner sites of a Svelte file that do not sit lexically inside a `<button>…</button>` element
 * (D-843-20: a Spinner is the in-progress sign of an action, never a section loading state).
 */
export function spinnersOutsideButtons(rel: string, text: string): string[] {
  const markup = scannableText(rel, text);
  const events: Array<{ pos: number; kind: "open" | "close" | "spinner" }> = [];
  for (const m of markup.matchAll(/<button(?![\p{L}\p{N}_-])/gu))
    events.push({ pos: m.index ?? 0, kind: "open" });
  for (const m of markup.matchAll(/<\/button\s*>/g))
    events.push({ pos: m.index ?? 0, kind: "close" });
  for (const m of markup.matchAll(/<Spinner(?![\p{L}\p{N}_])/gu))
    events.push({ pos: m.index ?? 0, kind: "spinner" });
  events.sort((a, b) => a.pos - b.pos);
  let depth = 0;
  const hits: string[] = [];
  for (const e of events) {
    if (e.kind === "open") depth++;
    else if (e.kind === "close") depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      const line = markup.slice(0, e.pos).split("\n").length;
      hits.push(`${rel}:${line}: <Spinner outside a <button>`);
    }
  }
  return hits;
}

// ── Controls ─────────────────────────────────────────────────────────────────

const hitsOf = (markup: string, rel = "fixture.svelte") => findLoadingTexts(rel, markup);

describe("loading-text matcher - positive controls", () => {
  const flagged: Array<[string, string]> = [
    ["bare ellipsis character", "<p>Laden…</p>"],
    ["verb with three dots", "<p>Lade Woche...</p>"],
    ["visually hidden text", '<span class="sr-only">Bericht wird geladen…</span>'],
    ["aria-label attribute", '<div aria-label="Salons werden geladen"></div>'],
    ["string literal in an expression", '<button>{busy ? "Lädt" : "OK"}</button>'],
    ["leading space and ellipsis", "<span> laden…</span>"],
    ["lower-case wording", "<p>wird geladen</p>"],
    ["upper-case wording", "<p>WIRD GELADEN</p>"],
    ["title attribute", '<i title="Lädt"></i>'],
  ];
  for (const [label, markup] of flagged) {
    it(`control: flags ${label}`, () => {
      expect(hitsOf(markup)).toHaveLength(1);
    });
  }

  it("control: flags a string literal of a .ts file and carries the true line", () => {
    const hits = findLoadingTexts("x.ts", 'const a = 1;\n\nexport const label = "Lade Daten";\n');
    expect(hits).toEqual(['x.ts:3: export const label = "Lade Daten";']);
  });

  it("control: flags a loading text next to an allowed phrase on the same line", () => {
    expect(hitsOf("<p>Fehler beim Laden. Lade …</p>")).toHaveLength(1);
  });

  it("control: flags a loading text in the script block of a Svelte file", () => {
    expect(hitsOf('<script lang="ts">\n  const t = "Wird geladen";\n</script>')).toHaveLength(1);
  });
});

describe("loading-text matcher - negative controls", () => {
  const passed: string[] = [
    "<p>Fehler beim Laden der Daten</p>",
    "<button>Erneut laden</button>",
    "<p>Seite neu laden</p>",
    "<p>Lade die Seite neu.</p>",
    "<p>Bitte laden Sie die Seite neu.</p>",
    "<button>Datei laden</button>",
    "<p>um die Geräte zu laden</p>",
    "<p>Lege Personen an, lade sie ein und verwalte ihre Daten.</p>",
    '<Skeleton shape="row" />',
    "<button><Spinner /> Speichern</button>",
    "<p>Herunterladen und Hochladen</p>",
    "<p>Ladenöffnungszeiten</p>",
    "<p>Ladeanzeige</p>",
  ];
  for (const markup of passed) {
    it(`control: passes ${markup}`, () => {
      expect(hitsOf(markup)).toEqual([]);
    });
  }

  it("control: ignores comments of every kind and style blocks", () => {
    const svelte = [
      "<!-- Lade Daten -->",
      '<script lang="ts">',
      "  // Wird geladen",
      "  /* Lädt */",
      '  const url = "https://example.test";',
      "</script>",
      "<style>.x::after { content: 'Laden'; }</style>",
    ].join("\n");
    expect(hitsOf(svelte)).toEqual([]);
    expect(findLoadingTexts("x.ts", "/** Lade Daten */\n// Laden\nconst a = 1;")).toEqual([]);
  });

  it("control: a // inside a string does not hide the rest of the line", () => {
    expect(findLoadingTexts("x.ts", 'const a = "https://x.test"; const b = "Lädt";')).toHaveLength(
      1,
    );
  });

  it("control: every allowed phrase names a reason", () => {
    expect(ALLOWED_PHRASES.length).toBeGreaterThanOrEqual(7);
    for (const { reason } of ALLOWED_PHRASES) expect(reason.length).toBeGreaterThan(10);
  });
});

describe("spinner rule - controls", () => {
  it("control: flags a section spinner outside a button", () => {
    expect(spinnersOutsideButtons("x.svelte", "<div><Spinner /></div>")).toHaveLength(1);
  });

  it("control: flags a spinner after a closed button", () => {
    const markup = "<button>OK</button>\n<Spinner size={20} />";
    expect(spinnersOutsideButtons("x.svelte", markup)).toEqual([
      "x.svelte:2: <Spinner outside a <button>",
    ]);
  });

  it("control: passes a spinner inside a button, also with attributes and nesting", () => {
    expect(spinnersOutsideButtons("x.svelte", "<button><Spinner /> Speichern</button>")).toEqual(
      [],
    );
    expect(
      spinnersOutsideButtons(
        "x.svelte",
        '<button type="submit" class="btn">{#if busy}<Spinner size="sm" />{/if} <span>Ok</span></button>',
      ),
    ).toEqual([]);
  });

  it("control: a commented-out spinner is no hit", () => {
    expect(spinnersOutsideButtons("x.svelte", "<!-- <Spinner /> -->")).toEqual([]);
  });
});

// ── The real tree ────────────────────────────────────────────────────────────

const EXEMPT_LOADING = new Set([
  "lib/components/ui/Skeleton.svelte", // the one source of the wording
  "lib/components/ui/Spinner.svelte", // its default `label` only
]);

const files = [
  ...walkFiles(`${SRC_ROOT}/routes`, [".svelte", ".ts"], { includeTests: false }).map((f) => ({
    ...f,
    rel: `routes/${f.rel}`,
  })),
  ...walkFiles(`${SRC_ROOT}/lib`, [".svelte", ".ts"], { includeTests: false }).map((f) => ({
    ...f,
    rel: `lib/${f.rel}`,
  })),
];

describe("no loading text outside the Skeleton (AC-6, D-843-07, D-843-20)", () => {
  it("walks a real source set (anti-vacuity floor)", () => {
    // 400 files at planning time; the floor only has to prove the walk found a real tree
    expect(files.length).toBeGreaterThan(300);
    expect(files.some((f) => f.rel === "lib/components/ui/Skeleton.svelte")).toBe(true);
    expect(files.some((f) => f.rel.startsWith("routes/") && f.rel.endsWith("+page.svelte"))).toBe(
      true,
    );
  });

  it("the exempt files exist and Skeleton really holds the wording", () => {
    for (const rel of EXEMPT_LOADING) expect(files.some((f) => f.rel === rel)).toBe(true);
    const skeleton = files.find((f) => f.rel === "lib/components/ui/Skeleton.svelte");
    expect(findLoadingTexts(skeleton!.rel, skeleton!.text).length).toBeGreaterThan(0);
  });

  it("finds no loading text in routes or lib", () => {
    const hits = files
      .filter((f) => !EXEMPT_LOADING.has(f.rel))
      .flatMap((f) => findLoadingTexts(f.rel, f.text));
    expect(hits).toEqual([]);
  });

  it("every Spinner outside lib/components/ui sits inside a button", () => {
    const svelte = files.filter(
      (f) => f.rel.endsWith(".svelte") && !f.rel.startsWith("lib/components/ui/"),
    );
    expect(svelte.some((f) => /<Spinner(?![\p{L}\p{N}_])/u.test(f.text))).toBe(true);
    const hits = svelte.flatMap((f) => spinnersOutsideButtons(f.rel, f.text));
    expect(hits).toEqual([]);
  });
});
