// Issue #610 (Phase 610-06, D-13 revised): the ONLY importer of `uqr`. It turns a text into the
// module matrix and then into ONE SVG path string of unit squares. The component renders that
// string as the `d` attribute of its own <path>; no markup string is ever built or injected.
import { encode } from "uqr";

/** Quiet zone in modules (the QR specification asks for four). */
const QUIET_ZONE = 4;

export interface QrPath {
  /** Width and height of the matrix in modules, quiet zone included (the SVG viewBox edge). */
  size: number;
  /** One `M{x} {y}h1v1h-1z` per dark module, rows top to bottom. */
  d: string;
}

export function qrPathFor(text: string): QrPath {
  const { size, data } = encode(text, { ecc: "M", border: QUIET_ZONE });
  const squares: string[] = [];
  for (let y = 0; y < data.length; y++) {
    const row = data[y];
    for (let x = 0; x < row.length; x++) {
      if (row[x]) squares.push(`M${x} ${y}h1v1h-1z`);
    }
  }
  return { size, d: squares.join("") };
}
