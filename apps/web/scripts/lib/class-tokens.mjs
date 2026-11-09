/**
 * The one extractor of class tokens (Issue #843, plan 03).
 *
 * Two gates read Svelte files for classes: `lint:ui-classes` (every class a primitive emits needs a
 * recipe) and the route utility-class guard (`no-route-utilities-843.test.ts`). Both use the
 * functions below, so a change to what counts as "emitted" or "declared" happens in one place.
 * Pure string functions: no file access, no process side effects.
 */

// CSS identifier syntax: start with letter/underscore/hyphen, then letters/digits/_/-
export const CSS_IDENT_RE = /^[a-zA-Z_-][a-zA-Z0-9_-]*$/;

/**
 * Extract every class token emitted by a Svelte file.
 *
 * - `class="a b c"`   — split on whitespace, all tokens harvested
 * - `class:foo`       — `foo`
 * - `class:foo={…}`   — `foo`
 * - `class="a-{$x}-b"` — interpolated chunks are skipped (we can't statically
 *   know the runtime value), but the literal `a-` / `-b` chunks are also
 *   skipped since they are not standalone class tokens.
 *
 * Multi-line `class="…"` values are supported.
 *
 * @param {string} content the whole `.svelte` source; `<style>` blocks are ignored
 * @returns {Set<string>}
 */
export function extractEmittedClasses(content) {
  const stripped = content.replace(/<style[\s\S]*?<\/style>/g, "");
  const out = new Set();

  // Helper: tokenize a text fragment on whitespace, validating each candidate
  // against the CSS identifier regex. This drops noise like `?`, `:`, quote
  // characters, and any other Svelte template syntax that escapes the
  // interpolation extractor below.
  /** @param {string} text */
  const harvestTokens = (text) => {
    for (const tok of text.split(/\s+/)) {
      if (!tok) continue;
      if (!CSS_IDENT_RE.test(tok)) continue;
      out.add(tok);
    }
  };

  // Helper: given the body of a Svelte interpolation `{...}`, pull out every
  // string-literal's contents and tokenize them. Anything that isn't inside a
  // string literal is dynamic — we can't statically resolve it — so we skip it.
  /** @param {string} body */
  const harvestFromExpression = (body) => {
    const strRe = /(["'])((?:\\.|(?!\1)[^\\])*)\1/g;
    let s;
    while ((s = strRe.exec(body))) {
      harvestTokens(s[2]);
    }
  };

  // 1. Literal class="…" — multiline-safe. Inside the value, Svelte
  // interpolations `{...}` are valid and may contain string literals; pull
  // those out separately, and tokenize the remaining bare text on whitespace.
  const literalRe = /\bclass\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = literalRe.exec(stripped))) {
    const raw = m[1];
    // Extract any `{...}` interpolation bodies and harvest string literals
    // from them. Replace the interpolations with a sentinel non-identifier
    // character (NUL) — this kills concatenated fragments like
    // `toast-{toast.type}` (which would otherwise leave the partial token
    // `toast-`) while still letting standalone tokens through cleanly.
    const interpRe = /\{([^{}]*)\}/g;
    let interp;
    while ((interp = interpRe.exec(raw))) {
      harvestFromExpression(interp[1]);
    }
    const bareText = raw.replace(/\{[^{}]*\}/g, "\x00");
    // Split on whitespace AND on the sentinel boundary, but require that any
    // surviving token contains no sentinel character — adjacent text to a
    // `{...}` interpolation is a concatenation, not a complete class name.
    for (const tok of bareText.split(/\s+/)) {
      if (!tok) continue;
      if (tok.includes("\x00")) continue;
      if (!CSS_IDENT_RE.test(tok)) continue;
      out.add(tok);
    }
  }

  // 2. Dynamic class={expr} — extract string-literal members.
  // Matches things like  class={["card", animate ? "card-animate" : "", x].filter(...)...}
  const dynRe = /\bclass\s*=\s*\{([^}]*)\}/g;
  while ((m = dynRe.exec(stripped))) {
    harvestFromExpression(m[1]);
  }

  // 3. `class:foo` and `class:foo={…}` shorthand.
  const dirRe = /\bclass:([a-zA-Z][a-zA-Z0-9_-]*)/g;
  while ((m = dirRe.exec(stripped))) {
    out.add(m[1]);
  }

  return out;
}

/**
 * Extract every class name DECLARED inside the file's scoped `<style>` block.
 * Svelte namespaces these per-component, so they don't need a global recipe. A `:global(.x)` selector
 * is read like any other, so a file that styles a bits-ui part through it counts as declaring `x`.
 *
 * @param {string} content the whole `.svelte` source
 * @returns {Set<string>}
 */
export function extractScopedClasses(content) {
  const out = new Set();
  const styleBlocks = content.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g);
  for (const block of styleBlocks) {
    const css = block[1];
    // `.foo`, `.foo-bar`, `.foo_bar` — class-name characters per CSS spec.
    const re = /\.([a-zA-Z_-][a-zA-Z0-9_-]*)/g;
    let m;
    while ((m = re.exec(css))) {
      out.add(m[1]);
    }
  }
  return out;
}
