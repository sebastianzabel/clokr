// Issue #610 (Phase 610-06): the QR code becomes one SVG path computed from the module matrix.
import { encode } from "uqr";
import { describe, it, expect } from "vitest";

import { qrPathFor } from "../qr-svg";

const URL_A = "http://192.168.178.20:8766/koppeln";
const URL_B = "http://10.0.0.5:8080/koppeln";

describe("qrPathFor", () => {
  it("draws one square per dark module of the encoded matrix", () => {
    const { size, d } = qrPathFor(URL_A);
    const reference = encode(URL_A, { ecc: "M", border: 4 });
    const dark = reference.data.flat().filter(Boolean).length;
    expect(size).toBe(reference.size);
    expect(size).toBeGreaterThan(0);
    expect(d.startsWith("M")).toBe(true);
    expect(d.split("h1v1h-1z").length - 1).toBe(dark);
    expect(dark).toBeGreaterThan(0);
  });

  it("keeps a quiet zone of four modules", () => {
    const { d, size } = qrPathFor(URL_A);
    const coords = [...d.matchAll(/M(\d+) (\d+)h1v1h-1z/g)].map((m) => [+m[1], +m[2]]);
    const min = Math.min(...coords.flat());
    const max = Math.max(...coords.flat());
    expect(min).toBeGreaterThanOrEqual(4);
    expect(max).toBeLessThanOrEqual(size - 5);
  });

  it("is deterministic and depends on the input", () => {
    expect(qrPathFor(URL_A)).toEqual(qrPathFor(URL_A));
    expect(qrPathFor(URL_A).d).not.toBe(qrPathFor(URL_B).d);
  });

  it("contains only path commands and digits, never markup", () => {
    expect(qrPathFor(URL_A).d).toMatch(/^[Mhvz0-9 -]+$/);
  });
});
