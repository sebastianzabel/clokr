// Phase 566 (D-03) — the web's display mirror of the bookable modules must never silently drift
// from the API. The test reads the Prisma schema and the API's package module as TEXT (the web
// tree cannot import API code — `apps/web/Dockerfile`'s `test ! -e /app/packages/db` gate), so a
// change to the enum order, a new module or a renamed label that is not mirrored fails the build.
// Source-read pattern: lib/leave/__tests__/effective-leave-statuses.test.ts.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { TENANT_MODULES, TENANT_MODULE_LABELS } from "../tenant-modules";

function readRepoFile(relativeFromHere: string, relativeFromCwd: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(relativeFromHere, import.meta.url)), "utf8");
  } catch {
    return readFileSync(resolve(process.cwd(), relativeFromCwd), "utf8");
  }
}

const SCHEMA = readRepoFile(
  "../../../../../../packages/db/prisma/schema.prisma",
  "../../packages/db/prisma/schema.prisma",
);
const API_SOURCE = readRepoFile(
  "../../../../../api/src/contexts/platform/tenant-packages.ts",
  "../api/src/contexts/platform/tenant-packages.ts",
);

function enumValues(): string[] {
  const match = SCHEMA.match(/enum TenantModule\s*\{([\s\S]*?)\}/);
  expect(match).not.toBeNull();
  return match![1]
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "").trim())
    .filter((line) => line.length > 0);
}

function apiLabels(): [string, string][] {
  const match = API_SOURCE.match(/TENANT_MODULE_LABEL_DE[^=]*=\s*\{([\s\S]*?)\};/);
  expect(match).not.toBeNull();
  return [...match![1].matchAll(/^\s*([A-Z_]+):\s*"([^"]+)",?\s*$/gm)].map((m) => [m[1], m[2]]);
}

describe("TENANT_MODULES and TENANT_MODULE_LABELS mirror the API (Phase 566, D-03)", () => {
  it("[vacuity gate] both sources are loaded and declare what is compared", () => {
    expect(SCHEMA.length).toBeGreaterThan(0);
    expect(API_SOURCE.length).toBeGreaterThan(0);
    expect(SCHEMA).toContain("enum TenantModule");
    expect(API_SOURCE).toContain("TENANT_MODULE_LABEL_DE");
    expect(enumValues().length).toBeGreaterThan(0);
    expect(apiLabels().length).toBeGreaterThan(0);
  });

  it("the web module list equals the Prisma enum, in declaration order", () => {
    expect([...TENANT_MODULES]).toEqual(enumValues());
  });

  it("the web labels equal the API's German names, pair by pair", () => {
    const labels = apiLabels();
    expect(labels.map(([key]) => key)).toEqual(enumValues());
    expect(Object.entries(TENANT_MODULE_LABELS)).toEqual(labels);
  });
});
