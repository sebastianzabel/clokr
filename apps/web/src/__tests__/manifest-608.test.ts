// Issue #608 (D-13, D-21): the manifest is installable and every declared icon size is real.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const STATIC_DIR = join(__dirname, "../../static");
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
}

const manifest = JSON.parse(readFileSync(join(STATIC_DIR, "manifest.json"), "utf8")) as {
  id: string;
  name: string;
  short_name: string;
  description: string;
  lang: string;
  scope: string;
  start_url: string;
  display: string;
  icons: ManifestIcon[];
};

/** Width and height from the PNG IHDR chunk (big-endian uint32 at byte 16 and 20). */
function pngSize(buffer: Buffer): string {
  expect(buffer.subarray(0, 8).equals(PNG_SIGNATURE), "a PNG signature").toBe(true);
  return `${buffer.readUInt32BE(16)}x${buffer.readUInt32BE(20)}`;
}

describe("manifest.json", () => {
  it("is installable", () => {
    expect(manifest.name).toBe("Clokr");
    expect(manifest.short_name).toBe("Clokr");
    expect(manifest.id).toBe("/");
    expect(manifest.scope).toBe("/");
    expect(manifest.start_url).toBe("/dashboard");
    expect(manifest.display).toBe("standalone");
    expect(manifest.lang).toBe("de");
    expect(manifest.description).toContain("Zeiterfassung");
  });

  it("declares no combined 'any maskable' icon", () => {
    expect(manifest.icons.length).toBeGreaterThanOrEqual(3);
    for (const icon of manifest.icons) {
      expect(icon.purpose ?? "any").not.toContain(" ");
    }
  });

  it("declares a 192 any, a 512 any and a 512 maskable icon", () => {
    const has = (sizes: string, purpose: string) =>
      manifest.icons.some((i) => i.sizes === sizes && (i.purpose ?? "any") === purpose);
    expect(has("192x192", "any")).toBe(true);
    expect(has("512x512", "any")).toBe(true);
    expect(has("512x512", "maskable")).toBe(true);
  });

  it.each(manifest.icons.map((i) => [i.src, i] as const))(
    "%s exists and its declared size is its real pixel size",
    (_src, icon) => {
      const file = readFileSync(join(STATIC_DIR, icon.src.replace(/^\//, "")));
      expect(icon.type).toBe("image/png");
      expect(pngSize(file)).toBe(icon.sizes);
    },
  );
});

describe("app.html", () => {
  const html = readFileSync(join(__dirname, "../app.html"), "utf8");

  it("links the manifest and the apple-touch-icon and keeps the iOS app meta", () => {
    expect(html).toContain('<link rel="manifest" href="/manifest.json" />');
    expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />');
    expect(html).toMatch(/<meta name="apple-mobile-web-app-capable" content="yes"/);
  });

  it("serves an apple-touch-icon of 180x180", () => {
    expect(pngSize(readFileSync(join(STATIC_DIR, "apple-touch-icon.png")))).toBe("180x180");
  });
});
