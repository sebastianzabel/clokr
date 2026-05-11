import { describe, it, expect } from "vitest";
import { normalizeMac } from "../utils/normalize-mac";

describe("normalizeMac", () => {
  // happy path
  it("colon-separated uppercase → lowercase colon-separated", () => {
    expect(normalizeMac("AA:BB:CC:DD:EE:FF")).toBe("aa:bb:cc:dd:ee:ff");
  });
  it("dash-separated → colon-separated", () => {
    expect(normalizeMac("aa-bb-cc-dd-ee-ff")).toBe("aa:bb:cc:dd:ee:ff");
  });
  it("no separator (12 hex chars) → colon-separated", () => {
    expect(normalizeMac("AABBCCDDEEFF")).toBe("aa:bb:cc:dd:ee:ff");
  });
  it("mixed case → lowercase", () => {
    expect(normalizeMac("Aa:Bb:Cc:Dd:Ee:Ff")).toBe("aa:bb:cc:dd:ee:ff");
  });
  it("FritzBox-style uppercase colon → canonical", () => {
    expect(normalizeMac("DC:A6:32:AB:CD:EF")).toBe("dc:a6:32:ab:cd:ef");
  });

  // error cases
  it("throws on 5-byte input", () => {
    expect(() => normalizeMac("AA:BB:CC:DD:EE")).toThrow("Ungültige MAC-Adresse");
  });
  it("throws on 7-byte input", () => {
    expect(() => normalizeMac("AA:BB:CC:DD:EE:FF:00")).toThrow("Ungültige MAC-Adresse");
  });
  it("throws on non-hex chars", () => {
    expect(() => normalizeMac("GG:HH:II:JJ:KK:LL")).toThrow("Ungültige MAC-Adresse");
  });
  it("throws on empty string", () => {
    expect(() => normalizeMac("")).toThrow("Ungültige MAC-Adresse");
  });
});
