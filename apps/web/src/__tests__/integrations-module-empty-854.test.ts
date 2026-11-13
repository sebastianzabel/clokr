// Issue #854 (owner review): without the booked add-on module a Verwalten › Integrationen panel shows only
// its ModuleHint, never also the empty state that invites to set up the first item. Existing items stay
// listed and manageable (#566, never retroactive), so only the empty state is guarded.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const PANELS = [
  { file: "PresenceSourcesPanel", flag: "hardwareBooked", list: "sources" },
  { file: "TerminalsPanel", flag: "hardwareBooked", list: "keys" },
  { file: "ApiKeysPanel", flag: "integrationsBooked", list: "keys" },
] as const;

describe("integration panels without the module show only the hint (#854)", () => {
  for (const panel of PANELS) {
    it(`${panel.file}: the empty state waits for the module`, () => {
      const source = readFileSync(
        resolve(process.cwd(), `src/lib/components/admin/integrationen/${panel.file}.svelte`),
        "utf8",
      );
      expect(source.length).toBeGreaterThan(2_000);
      expect(source).toContain(`{#if ${panel.flag} === false}`);
      const empty = source.indexOf(`{:else if ${panel.list}.length === 0}`);
      expect(empty, "no empty branch").toBeGreaterThan(-1);
      const branch = source.slice(empty, source.indexOf("{:else}", empty));
      expect(branch).toMatch(new RegExp(`\\{#if ${panel.flag} !== false\\}\\s*<EmptyState`));
    });
  }
});
