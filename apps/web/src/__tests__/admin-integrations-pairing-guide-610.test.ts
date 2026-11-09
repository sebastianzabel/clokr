// Issue #610 (P-610-22) - source pin for the integrations page: the pairing guide sits in its own
// Section right after "Präsenz-Quellen", and the page gains no API call for it. Routes cannot be
// mounted (`apps/web/vitest.config.ts` has no `$app` alias), so the contract is read from source.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

const RELATIVE = "src/routes/(app)/admin/integrations/+page.svelte";
const path = join(__dirname, "../routes/(app)/admin/integrations/+page.svelte");

describe("integrations page - pairing guide (Issue #610)", () => {
  it("has a page source to pin", () => {
    expect(existsSync(path), `page source missing: ${RELATIVE}`).toBe(true);
  });

  const source = existsSync(path) ? readFileSync(path, "utf8") : "";

  it("imports PairingGuide and renders it once", () => {
    expect(source).toContain(
      'import PairingGuide from "$lib/components/admin/PairingGuide.svelte"',
    );
    expect(source.match(/<PairingGuide\b/g)).toHaveLength(1);
  });

  // prettier may wrap `<Section title=...>` over several lines, so the start tag is found by a
  // whitespace-tolerant pattern, never by the literal one-line spelling.
  const sectionStart = (title: string): number =>
    source.search(new RegExp(`<Section\\s+title="${title}"`));

  it("renders it inside the Section 'Handys per QR-Code koppeln' after 'Präsenz-Quellen'", () => {
    const sources = sectionStart("Präsenz-Quellen");
    const guide = sectionStart("Handys per QR-Code koppeln");
    const devices = sectionStart("WiFi-Geräteliste");
    expect(sources).toBeGreaterThan(-1);
    expect(guide).toBeGreaterThan(sources);
    expect(devices).toBeGreaterThan(guide);
    const section = source.slice(guide, devices);
    expect(section).toContain("<PairingGuide");
    expect(section).not.toContain("api.");
  });

  it("adds no API call for the guide", () => {
    const guide = sectionStart("Handys per QR-Code koppeln");
    expect(guide).toBeGreaterThan(-1);
    const section = source.slice(guide);
    const guideBlock = section.slice(0, section.indexOf("</Section>"));
    expect(guideBlock).toContain("<PairingGuide");
    expect(guideBlock).not.toMatch(/api\.|fetch\(|await /);
  });
});
