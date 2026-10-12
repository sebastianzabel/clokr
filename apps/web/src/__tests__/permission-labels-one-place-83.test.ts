// Issue #83 (D-02, D-07) — the permission labels and the four-eyes rule live only on the server.
//
// Every German per-key label of `apps/api/src/contexts/platform/permission-labels.ts` must appear
// in NO web file: the web reads them from `GET /roles/permission-catalog`, a copy would drift. The
// role UI must not contain either half of the four-eyes combination key (#78 owns the rule; the UI
// reacts to the server's control code). Blind spot: a label assembled from parts is not seen —
// the guard stops copies, it does not prove absence.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function webSrcRoot(): string {
  try {
    const root = fileURLToPath(new URL("..", import.meta.url));
    if (existsSync(join(root, "app.html"))) return root;
  } catch {
    // fall through to the cwd-based root
  }
  return resolve(process.cwd(), "src");
}

const WEB_SRC = webSrcRoot();
const LABEL_MODULE = resolve(
  WEB_SRC,
  "..",
  "..",
  "api",
  "src",
  "contexts",
  "platform",
  "permission-labels.ts",
);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.(ts|svelte|js)$/.test(name) ? [path] : [];
  });
}

function perKeyLabels(): string[] {
  const source = readFileSync(LABEL_MODULE, "utf8");
  const block = source.slice(source.indexOf("export const PERMISSION_LABELS"));
  return [
    ...block.matchAll(/^\s+"[a-z0-9-]+:[a-z-]+:(?:EIGENE|ZUGEWIESEN)":\s*"([^"]+)",?$/gm),
  ].map((m) => m[1]);
}

describe("permission labels and the four-eyes rule stay on the server (Issue #83)", () => {
  it("no per-key label appears in any web file", () => {
    const labels = perKeyLabels();
    expect(labels.length).toBeGreaterThanOrEqual(80);
    const files = walk(WEB_SRC);
    expect(files.length).toBeGreaterThan(100);
    const hits = files.flatMap((file) => {
      const text = readFileSync(file, "utf8");
      return labels.filter((label) => text.includes(label)).map((label) => `${file}: ${label}`);
    });
    expect(hits).toEqual([]);
  });

  it("the role UI holds no four-eyes combination key", () => {
    const roleUi = walk(WEB_SRC).filter(
      (file) =>
        file.includes(join("lib", "components", "admin", "roles")) ||
        file.endsWith(join("lib", "api", "roles.ts")) ||
        file.includes(join("routes", "(app)", "admin", "roles")),
    );
    const sources = roleUi.filter((file) => !file.includes("__tests__"));
    expect(sources.length).toBeGreaterThanOrEqual(4);
    const keys = [
      "time-entry:create:EIGENE",
      "time-entry:update:EIGENE",
      "retro-request:approve:ZUGEWIESEN",
    ];
    const hits = sources.flatMap((file) =>
      keys
        .filter((key) => readFileSync(file, "utf8").includes(key))
        .map((key) => `${file}: ${key}`),
    );
    expect(hits).toEqual([]);
  });
});
