import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// `sharp` is installed in the apps/api workspace, not apps/web. Resolve it from
// there via createRequire so this script can live colocated with its output
// asset without adding sharp as an apps/web dependency. See PLAN.md D-07.
const __dirname = dirname(fileURLToPath(import.meta.url));
const apiRequire = createRequire(resolve(__dirname, "../../api/package.json"));
const sharp = apiRequire("sharp") as typeof import("sharp");

const input = resolve(__dirname, "../static/clokr-icon.png");
const output = resolve(__dirname, "../static/apple-touch-icon.png");

await sharp(input)
  .resize(180, 180, { fit: "cover" })
  .flatten({ background: "#0F4E96" })
  .png({ compressionLevel: 9 })
  .toFile(output);

console.log("Generated apple-touch-icon.png (180x180, no alpha)");
