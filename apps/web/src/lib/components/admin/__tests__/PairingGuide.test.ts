// Issue #610 (D-13 revised, AC-6, P-610-22): the admin's pairing guide, mounted. `lint:ui-classes`
// does not scan lib/components/admin, so this mount test is the component's gate. The address is
// browser state only: the component imports no API client and makes no request.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/svelte";

import { renderWithTheme } from "$tests/test-utils";
import PairingGuide from "../PairingGuide.svelte";

const SOURCE = readFileSync(join(__dirname, "..", "PairingGuide.svelte"), "utf8");

async function typeInto(label: string | RegExp, value: string) {
  await fireEvent.input(screen.getByLabelText(label), { target: { value } });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PairingGuide", () => {
  it("starts with the two fields, the port prefilled, and neither a QR nor an error", () => {
    const { container } = renderWithTheme(PairingGuide, {});
    const address = screen.getByLabelText("Adresse des Adapters im Salon-WLAN") as HTMLInputElement;
    expect(address.placeholder).toBe("z. B. 192.168.178.20");
    expect(address.value).toBe("");
    expect((screen.getByLabelText("Port") as HTMLInputElement).value).toBe("8766");
    expect(container.querySelector("svg[role='img']")).toBeNull();
    expect(container.querySelector(".form-error")).toBeNull();
  });

  it("shows one QR path, the URL as text and prints on demand for a private address", async () => {
    const print = vi.spyOn(window, "print").mockImplementation(() => {});
    const { container } = renderWithTheme(PairingGuide, {});
    await typeInto("Adresse des Adapters im Salon-WLAN", "192.168.178.20");

    const svg = container.querySelector("svg[role='img']");
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute("aria-label")).toContain("http://192.168.178.20:8766/koppeln");
    expect(svg!.querySelectorAll("path")).toHaveLength(1);
    expect(svg!.querySelector("path")!.getAttribute("d")).toMatch(/^M\d+ \d+h1v1h-1z/);
    expect(screen.getByText("http://192.168.178.20:8766/koppeln")).toBeTruthy();

    await fireEvent.click(screen.getByRole("button", { name: "QR-Code drucken" }));
    expect(print).toHaveBeenCalledTimes(1);
  });

  it("follows the port", async () => {
    const { container } = renderWithTheme(PairingGuide, {});
    await typeInto("Adresse des Adapters im Salon-WLAN", "10.0.0.5");
    await typeInto("Port", "8080");
    expect(container.querySelector("svg")!.getAttribute("aria-label")).toContain(
      "http://10.0.0.5:8080/koppeln",
    );
  });

  it("refuses a public address with the German message and draws no QR", async () => {
    const { container } = renderWithTheme(PairingGuide, {});
    await typeInto("Adresse des Adapters im Salon-WLAN", "8.8.8.8");
    expect(container.querySelector("svg[role='img']")).toBeNull();
    expect(
      screen.getByText(
        "Bitte gib die Adresse des Adapters im Salon-WLAN ein (z. B. 192.168.178.20).",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "QR-Code drucken" })).toBeNull();
  });

  it("refuses a malformed address and an invalid port", async () => {
    const { container } = renderWithTheme(PairingGuide, {});
    await typeInto("Adresse des Adapters im Salon-WLAN", "adapter.local");
    expect(container.querySelector("svg[role='img']")).toBeNull();
    expect(screen.getByText(/keine gültige IP-Adresse/)).toBeTruthy();

    await typeInto("Adresse des Adapters im Salon-WLAN", "192.168.178.20");
    await typeInto("Port", "70000");
    expect(container.querySelector("svg[role='img']")).toBeNull();
    expect(screen.getByText(/Der Port muss eine Zahl/)).toBeTruthy();
  });

  it("always lists the network preconditions, the guest WLAN with client isolation included", () => {
    const { container } = renderWithTheme(PairingGuide, {});
    const text = container.textContent ?? "";
    expect(text).toContain("WPA2");
    expect(text).toContain("WPA3");
    expect(text).toContain("Gast-WLAN");
    expect(text).toContain("Geräteisolation");
    // Issue #574 (D-574-08): plain instructions that point to the operator guide, no variable names
    expect(text).toContain("Kopplung eingeschaltet");
    expect(text).toMatch(/https-Adresse\s+deiner\s+Clokr-Installation/);
    expect(text).toMatch(/LAN-Adresse\s+im\s+Salon-WLAN/);
    expect(text).toMatch(/WLAN-Kopplung\s+per\s+QR-Code/);
    expect(text).not.toMatch(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/);
    expect(text).toContain("mit dem Salon-WLAN verbunden");
    expect(text).toMatch(/nicht gespeichert/);
    const guest = [...container.querySelectorAll("li")].find((li) =>
      li.textContent?.includes("Geräteisolation"),
    );
    expect(guest?.textContent).toMatch(/funktioniert nicht/);
  });

  it("makes no network request and imports no API client or router", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    renderWithTheme(PairingGuide, {});
    await typeInto("Adresse des Adapters im Salon-WLAN", "192.168.178.20");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(SOURCE).not.toMatch(/from "[$](app|api)\//);
    expect(SOURCE).not.toContain("@html");
  });
});
