import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Guard for the `query-string@7>decode-uri-component` override (GHSA-qr28-fpjm-wq7f).
 *
 * `minio` depends on `query-string@7`, which `require()`s `decode-uri-component@^0.2`. The only
 * patched release (0.5.1) is ESM-only with a default export, so under the override
 * `query-string`'s decoding functions (`parse`, `parseUrl`, `extract`, …) would throw a
 * TypeError, while `stringify` never touches the decoder. The override is safe only as long as
 * `minio` calls `stringify` and nothing else — this file proves both halves, so a `minio`
 * upgrade that starts parsing turns the run red instead of breaking object storage at runtime.
 */
const requireFromApi = createRequire(import.meta.url);
const minioEntry = requireFromApi.resolve("minio");
const requireFromMinio = createRequire(minioEntry);

function minioDistRoot(): string {
  let dir = dirname(minioEntry);
  while (!dir.endsWith(join("minio", "dist", "main")) && dir !== dirname(dir)) dir = dirname(dir);
  return dir;
}

function jsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return jsFiles(path);
    return path.endsWith(".js") ? [path] : [];
  });
}

describe("query-string override under minio", () => {
  it("keeps stringify working through minio's own resolution", () => {
    const qs = requireFromMinio("query-string") as { stringify: (o: object) => string };
    expect(qs.stringify({ a: "x y", b: 1 })).toBe("a=x%20y&b=1");
  });

  it("finds that minio uses query-string only for stringify", () => {
    const files = jsFiles(minioDistRoot()).filter((f) =>
      readFileSync(f, "utf8").includes("query-string"),
    );
    // Anti-vacuity: the walk must reach the files that import query-string today.
    expect(files.length).toBeGreaterThan(0);
    const calls = files.flatMap((f) => [
      ...readFileSync(f, "utf8").matchAll(/\b(?:qs|querystring)\.([A-Za-z]+)\(/g),
    ]);
    expect(calls.length).toBeGreaterThan(0);
    expect(new Set(calls.map((m) => m[1]))).toEqual(new Set(["stringify"]));
  });
});
