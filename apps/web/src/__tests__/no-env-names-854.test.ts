// Issue #854 (plan 14, finding A-15, T-854-36): no text of the web app names an environment variable. A person
// who reads „Setze PAIRING_ENABLED=true“ in the UI is told something only an operator can act on, and the name
// ties the screen to a deployment detail. The setup help builds what it needs from the page (the pairing guide
// takes an address and a port); a deployment hint belongs in the runbook, not in a shown text.
//
// What is scanned: every non-test `.svelte` and `.ts` file below `apps/web/src`, comments removed. Only TEXT is
// judged - string literals of the script, text nodes and quoted attribute values of the markup, and string
// literals inside `{…}` expressions - never an identifier (`DEFAULT_PAIRING_PORT` as a constant is fine).
// A text is a hit when it contains an UPPER_SNAKE word of at least two parts whose first or last part is one of
// the environment words below. A scan that matches nothing reports OK forever, so this file proves the matcher can
// fail (positive controls), does not over-fire (clean controls) and that the walked set is not empty (floor).

import { describe, expect, it } from "vitest";

import { SRC_ROOT, walkFiles } from "./design-source-files";

// ── Source stripping and text extraction ─────────────────────────────────────

/** Blanks `text` but keeps its newlines, so line numbers of the remaining text stay true. */
function blank(text: string): string {
  return text.replace(/[^\n]/g, " ");
}

/** Blanks JS/TS comments and keeps string literals (`//` inside "https://…" is no comment). */
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

/** A template literal's text without its `${…}` placeholders: those hold code (identifiers), not text. */
function withoutPlaceholders(body: string): string {
  let out = "";
  let i = 0;
  while (i < body.length) {
    if (body[i] === "$" && body[i + 1] === "{") {
      const end = closingBrace(body, i + 1);
      i = end === -1 ? body.length : end + 1;
    } else {
      out += body[i];
      i++;
    }
  }
  return out;
}

/** The contents of every string literal in comment-free script code. */
function stringLiterals(code: string): string[] {
  const found: string[] = [];
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < code.length && code[j] !== ch) {
        if (code[j] === "\\") j++;
        j++;
      }
      const body = code.slice(i + 1, j);
      found.push(ch === "`" ? withoutPlaceholders(body) : body);
      i = j + 1;
    } else {
      i++;
    }
  }
  return found;
}

/** Index of the `}` that closes the `{` at `open`, string literals skipped; -1 when unbalanced. */
function closingBrace(text: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) {
        if (text[j] === "\\") j++;
        j++;
      }
      i = j + 1;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i;
    i++;
  }
  return -1;
}

/**
 * The texts of a markup fragment: text nodes, quoted attribute values and the string literals inside `{…}`
 * expressions. Tags, expression code and identifiers are not texts.
 */
function markupTexts(markup: string): string[] {
  const texts: string[] = [];
  let node = "";
  const flush = () => {
    if (node.trim() !== "") texts.push(node);
    node = "";
  };
  let i = 0;
  while (i < markup.length) {
    const ch = markup[i];
    if (ch === "{") {
      flush();
      const end = closingBrace(markup, i);
      const stop = end === -1 ? markup.length : end;
      texts.push(...stringLiterals(markup.slice(i + 1, stop)));
      i = stop + 1;
    } else if (ch === "<" && /[A-Za-z/]/.test(markup[i + 1] ?? "")) {
      flush();
      // Inside a tag: collect quoted attribute values and expressions up to the closing `>`.
      i++;
      while (i < markup.length && markup[i] !== ">") {
        const c = markup[i];
        if (c === '"' || c === "'") {
          const j = markup.indexOf(c, i + 1);
          const stop = j === -1 ? markup.length : j;
          const value = markup.slice(i + 1, stop);
          // A quoted value may hold `{…}` expressions: their literals count, the rest is the text itself.
          texts.push(...markupTexts(value));
          i = stop + 1;
        } else if (c === "{") {
          const end = closingBrace(markup, i);
          const stop = end === -1 ? markup.length : end;
          texts.push(...stringLiterals(markup.slice(i + 1, stop)));
          i = stop + 1;
        } else {
          i++;
        }
      }
      i++;
    } else {
      node += ch;
      i++;
    }
  }
  flush();
  return texts;
}

/** Every shown or constructed text of one source file, comments removed. */
export function textsOf(rel: string, source: string): string[] {
  if (!rel.endsWith(".svelte")) return stringLiterals(stripScriptComments(source));
  const scripts: string[] = [];
  const markup = source
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/<style[^>]*>[\s\S]*?<\/style>/g, blank)
    .replace(/<script[^>]*>([\s\S]*?)<\/script>/g, (whole, body: string) => {
      scripts.push(body);
      return blank(whole);
    });
  return [
    ...scripts.flatMap((body) => stringLiterals(stripScriptComments(body))),
    ...markupTexts(markup),
  ];
}

// ── The matcher ──────────────────────────────────────────────────────────────

/** The first or last part of an environment variable's name (the shapes of config.ts and the compose files). */
export const ENV_WORDS: readonly string[] = [
  "KEY",
  "SECRET",
  "URL",
  "HOST",
  "PORT",
  "ENABLED",
  "BIND",
  "TOKEN",
  "PASSWORD",
  "VAPID",
  "PAIRING",
  "SMTP",
  "JWT",
  "MINIO",
  "DATABASE",
];

const UPPER_SNAKE = /(?<![A-Za-z0-9_])[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+(?![A-Za-z0-9_])/g;

/**
 * Words in a text that look like an environment variable. Control values that are not environment variables are
 * allowed only through `ALLOWED_WORDS`, each with its reason.
 */
export function envLikeWords(text: string): string[] {
  const hits: string[] = [];
  for (const word of text.match(UPPER_SNAKE) ?? []) {
    const parts = word.split("_");
    if (!ENV_WORDS.includes(parts[0]) && !ENV_WORDS.includes(parts[parts.length - 1])) continue;
    if (word in ALLOWED_WORDS) continue;
    hits.push(word);
  }
  return hits;
}

/** UPPER_SNAKE control values of the shape that are no environment variable, each with its reason. */
export const ALLOWED_WORDS: Record<string, string> = {
  INVALID_PORT:
    "refusal code of the pairing address check (lib/presence/pairing-url.ts): a control value the guide branches on, not an environment variable",
};

/** Every hit of one file as `file: WORD`. */
export function findEnvNames(rel: string, source: string): string[] {
  return textsOf(rel, source).flatMap((text) =>
    envLikeWords(text).map((word) => `${rel}: ${word}`),
  );
}

// ── The walk ─────────────────────────────────────────────────────────────────

const files = [
  ...walkFiles(SRC_ROOT, [".svelte"], { includeTests: false }),
  ...walkFiles(SRC_ROOT, [".ts"], { includeTests: false }),
];

describe("no environment variable name in a web text (#854, finding A-15)", () => {
  it("walks at least 300 source files, Svelte and TypeScript, none of them a test", () => {
    expect(files.length).toBeGreaterThanOrEqual(300);
    expect(files.some((file) => file.rel.endsWith(".svelte"))).toBe(true);
    expect(files.some((file) => file.rel.endsWith(".ts"))).toBe(true);
    expect(
      files.some((file) => file.rel.endsWith(".test.ts") || file.rel.includes("__tests__")),
    ).toBe(false);
    // The setup pages the finding was about are in the walk.
    expect(files.some((file) => file.rel.endsWith("components/admin/PairingGuide.svelte"))).toBe(
      true,
    );
    expect(
      files.some((file) =>
        file.rel.endsWith("components/admin/integrationen/PresenceSourcesPanel.svelte"),
      ),
    ).toBe(true);
  });

  it("no text names an environment variable", () => {
    const hits = files.flatMap((file) => findEnvNames(file.rel, file.text));
    expect(hits).toEqual([]);
  });

  it("every allowed word carries a reason and still occurs in a scanned text (no stale entry)", () => {
    const allTexts = files.flatMap((file) => textsOf(file.rel, file.text)).join("\n");
    for (const [word, reason] of Object.entries(ALLOWED_WORDS)) {
      expect(reason.trim().length, word).toBeGreaterThan(10);
      expect(allTexts.includes(word), `${word} is allowed but occurs nowhere`).toBe(true);
    }
  });
});

// ── Matcher controls: it can fail, and it does not over-fire ─────────────────

describe("the matcher can fail (positive controls)", () => {
  it("flags the text of the finding in a TypeScript string literal", () => {
    expect(findEnvNames("x.ts", 'export const hint = "Setze PAIRING_ENABLED=true";')).toEqual([
      "x.ts: PAIRING_ENABLED",
    ]);
  });

  it("flags a template literal and the other shapes (prefix, suffix, key names)", () => {
    for (const word of [
      "CLOKR_APP_URL",
      "PAIRING_HOST_BIND",
      "VAPID_PUBLIC_KEY",
      "DATABASE_URL",
      "JWT_SECRET",
    ]) {
      expect(findEnvNames("x.ts", `const t = \`Trag ${"$"}{x} in ${word} ein\`;`), word).toEqual([
        `x.ts: ${word}`,
      ]);
    }
  });

  it("flags a text node, a quoted attribute value and a literal inside an expression of a Svelte file", () => {
    expect(findEnvNames("x.svelte", "<p>Setze CLOKR_APP_URL auf deine Adresse.</p>")).toEqual([
      "x.svelte: CLOKR_APP_URL",
    ]);
    expect(findEnvNames("x.svelte", '<input placeholder="VAPID_PUBLIC_KEY" />')).toEqual([
      "x.svelte: VAPID_PUBLIC_KEY",
    ]);
    expect(findEnvNames("x.svelte", "<p>{ok ? 'JWT_SECRET' : ''}</p>")).toEqual([
      "x.svelte: JWT_SECRET",
    ]);
    expect(
      findEnvNames("x.svelte", '<script lang="ts">\n  const t = "PAIRING_PORT";\n</script>'),
    ).toEqual(["x.svelte: PAIRING_PORT"]);
  });
});

describe("the matcher does not over-fire (clean controls)", () => {
  it("ignores identifiers, comments and styles", () => {
    expect(
      findEnvNames(
        "x.ts",
        "export const DEFAULT_PAIRING_PORT = 8766;\nfoo(PUSH_SERVICE_HOST_SUFFIXES);",
      ),
    ).toEqual([]);
    expect(
      findEnvNames("x.ts", "// Set PAIRING_ENABLED=true\n/* VAPID_PUBLIC_KEY */\nconst a = 1;"),
    ).toEqual([]);
    expect(
      findEnvNames(
        "x.svelte",
        "<!-- JWT_SECRET -->\n<style>\n  .a { --ENV_KEY: 1; }\n</style>\n<p>{DEFAULT_PAIRING_PORT}</p>",
      ),
    ).toEqual([]);
  });

  it("ignores the placeholders of a template literal (they hold code, not text)", () => {
    expect(findEnvNames("x.ts", "const url = `${BASE_URL}/auth/refresh`;")).toEqual([]);
  });

  it("ignores ordinary German text, single words and UPPER_SNAKE words of other shapes", () => {
    expect(findEnvNames("x.svelte", "<p>Der Schlüssel wird nicht erneut angezeigt.</p>")).toEqual(
      [],
    );
    expect(
      findEnvNames(
        "x.ts",
        'const a = "URL"; const b = "NO_ROLE_ASSIGNED"; const c = "TENANT_REQUIRED";',
      ),
    ).toEqual([]);
  });

  it("an allowed word is skipped (and a stale allow-list entry would be visible in the table)", () => {
    ALLOWED_WORDS.SOME_SAMPLE_KEY = "control value of a test, no environment variable";
    try {
      expect(findEnvNames("x.ts", 'const a = "SOME_SAMPLE_KEY";')).toEqual([]);
    } finally {
      delete ALLOWED_WORDS.SOME_SAMPLE_KEY;
    }
  });
});
