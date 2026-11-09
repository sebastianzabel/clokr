/**
 * Issue #852 — every raster of the brand mark comes from ONE file, static/brand/mark.svg.
 * Swapping the logo is: replace that file, run `pnpm --filter @clokr/web run brand:icons`.
 *
 * Outputs (all committed): brand/favicon.svg (the mark in the fixed logo colour), brand/favicon-32.png,
 * apple-touch-icon.png (180 px, no alpha — iOS fills transparency black), icon-192.png and icon-512.png
 * (white mark on a rounded petrol tile, purpose "any") and icon-maskable-512.png (full-bleed petrol, the
 * mark inside the 80 % safe zone).
 */
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// `sharp` is installed in the apps/api workspace, not apps/web (same reasoning as the script this
// one replaces): resolve it from there instead of adding it as a web dependency.
const here = dirname(fileURLToPath(import.meta.url));
const apiRequire = createRequire(resolve(here, "../../api/package.json"));
const sharp = apiRequire("sharp") as typeof import("sharp");

/** The logo colour (Petrol, docs: .planning/redesign design concept § 3). */
export const LOGO_COLOR = "#1f6c6f";

const staticDir = resolve(here, "../static");
const mark = readFileSync(resolve(staticDir, "brand/mark.svg"), "utf8");

/** The mark's inner SVG markup in a given colour. */
function coloured(color: string): string {
  return mark.replace(/currentColor/g, color).replace(/\saria-hidden="true"/, "");
}

/** The mark centred on a square canvas: `fill` behind it, the mark at `share` of the side. */
function tile(
  size: number,
  opts: { fill: string | null; radius: number; share: number; color: string },
) {
  const inner = coloured(opts.color)
    .replace(/<svg[^>]*>/, "")
    .replace(/<\/svg>\s*$/, "");
  const markSize = size * opts.share;
  const offset = (size - markSize) / 2;
  const scale = markSize / 32;
  const bg =
    opts.fill === null
      ? ""
      : `<rect width="${size}" height="${size}" rx="${size * opts.radius}" fill="${opts.fill}"/>`;
  const strokeAttrs =
    'fill="none" stroke-linecap="round" stroke-linejoin="round" stroke-width="4.5"';
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${bg}` +
      `<g transform="translate(${offset} ${offset}) scale(${scale})" stroke="${opts.color}" ${strokeAttrs}>${inner}</g></svg>`,
  );
}

async function png(svg: Buffer, file: string, flattenOn?: string) {
  let img = sharp(svg).png({ compressionLevel: 9 });
  if (flattenOn) img = img.flatten({ background: flattenOn });
  await img.toFile(resolve(staticDir, file));
  console.log(`generated ${file}`);
}

writeFileSync(resolve(staticDir, "brand/favicon.svg"), coloured(LOGO_COLOR));
console.log("generated brand/favicon.svg");
await png(tile(32, { fill: null, radius: 0, share: 1, color: LOGO_COLOR }), "brand/favicon-32.png");
await png(
  tile(180, { fill: LOGO_COLOR, radius: 0, share: 0.62, color: "#ffffff" }),
  "apple-touch-icon.png",
  LOGO_COLOR,
);
await png(
  tile(192, { fill: LOGO_COLOR, radius: 0.22, share: 0.6, color: "#ffffff" }),
  "icon-192.png",
);
await png(
  tile(512, { fill: LOGO_COLOR, radius: 0.22, share: 0.6, color: "#ffffff" }),
  "icon-512.png",
);
await png(
  tile(512, { fill: LOGO_COLOR, radius: 0, share: 0.5, color: "#ffffff" }),
  "icon-maskable-512.png",
);
