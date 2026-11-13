// Test helper (not a `*.test.ts`) — the source walkers of the #842 design guards. It only lists
// files; every guard that uses it states its own non-empty floor and carries a positive control.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function webRoot(): string {
  try {
    return resolve(fileURLToPath(new URL("../..", import.meta.url)));
  } catch {
    // jsdom gives `import.meta.url` a non-file scheme; vitest runs from the package directory.
    return resolve(process.cwd());
  }
}

export const WEB_ROOT = webRoot();
export const SRC_ROOT = join(WEB_ROOT, "src");
export const E2E_ROOT = resolve(WEB_ROOT, "..", "e2e");

export interface SourceFile {
  /** Path relative to the walked root, POSIX separators. */
  rel: string;
  abs: string;
  text: string;
}

const SKIP_DIRS = new Set(["node_modules", "playwright-report", "test-results", ".svelte-kit"]);

/**
 * Walks `root` for files with one of `extensions`. `includeTests: false` skips `__tests__`
 * directories and `*.test.ts` files (the production sources); `true` keeps them.
 */
export function walkFiles(
  root: string,
  extensions: string[],
  { includeTests }: { includeTests: boolean },
): SourceFile[] {
  const out: SourceFile[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        if (!includeTests && name === "__tests__") continue;
        walk(full);
      } else if (extensions.some((ext) => name.endsWith(ext))) {
        if (!includeTests && name.endsWith(".test.ts")) continue;
        out.push({
          rel: relative(root, full).split("\\").join("/"),
          abs: full,
          text: readFileSync(full, "utf8"),
        });
      }
    }
  };
  walk(root);
  return out;
}

/** The text of every `<style>` block of a Svelte file. */
export function svelteStyleBlocks(text: string): string[] {
  return [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
}
