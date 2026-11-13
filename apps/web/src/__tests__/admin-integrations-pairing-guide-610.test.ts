// Issue #610 (P-610-22) - source pin for the pairing guide on System > Integrationen: the guide sits in its own
// group right after "Präsenz-Quellen", and the group gains no API call for it. Since plan 854-14 the groups live in
// the panel of the WLAN-Anwesenheit tab (`PresenceSourcesPanel.svelte`); routes cannot be mounted
// (`apps/web/vitest.config.ts` has no `$app` alias), so the contract is read from source, and the panel itself is
// mounted by `presence-sources-panel-854.test.ts`.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

const RELATIVE = "src/lib/components/admin/integrationen/PresenceSourcesPanel.svelte";
const path = join(__dirname, "../lib/components/admin/integrationen/PresenceSourcesPanel.svelte");
const pagePath = join(__dirname, "../routes/(app)/admin/integrations/+page.svelte");

describe("integrations WLAN tab - pairing guide (Issue #610)", () => {
  it("has a panel source to pin", () => {
    expect(existsSync(path), `panel source missing: ${RELATIVE}`).toBe(true);
  });

  const source = existsSync(path) ? readFileSync(path, "utf8") : "";

  it("imports PairingGuide and renders it once", () => {
    expect(source).toContain(
      'import PairingGuide from "$lib/components/admin/PairingGuide.svelte"',
    );
    expect(source.match(/<PairingGuide\b/g)).toHaveLength(1);
  });

  it("the page mounts the panel in its WLAN tab", () => {
    const page = readFileSync(pagePath, "utf8");
    expect(page).toContain("<PresenceSourcesPanel");
    expect(page).not.toContain("<PairingGuide");
  });

  // prettier may wrap the heading over several lines, so a group start is found by a whitespace-tolerant
  // pattern on its title, never by the literal one-line spelling.
  const groupStart = (title: string): number =>
    source.search(new RegExp(`<h2[^>]*>\\s*${title}\\s*</h2>`));

  it("renders it inside the group 'Handys per QR-Code koppeln' after 'Präsenz-Quellen'", () => {
    const sources = groupStart("Präsenz-Quellen");
    const guide = groupStart("Handys per QR-Code koppeln");
    const devices = groupStart("WLAN-Geräteliste");
    expect(sources).toBeGreaterThan(-1);
    expect(guide).toBeGreaterThan(sources);
    expect(devices).toBeGreaterThan(guide);
    const group = source.slice(guide, devices);
    expect(group).toContain("<PairingGuide");
    expect(group).not.toContain("api.");
  });

  it("adds no API call for the guide", () => {
    const guide = groupStart("Handys per QR-Code koppeln");
    expect(guide).toBeGreaterThan(-1);
    const group = source.slice(guide, source.indexOf("</section>", guide));
    expect(group).toContain("<PairingGuide");
    expect(group).not.toMatch(/api\.|fetch\(|await /);
  });
});
