// Issue #610 (D-12, D-08, AC-5, P-610-21): the profile's WLAN card, mounted. It shows how each device
// was coupled and when it was last recognised, and withdrawing the consent is a confirmed step that
// removes every device. `lint:ui-classes` does not scan this directory, so this mount test is the
// component's gate.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/svelte";

import type { MyWifiDevice } from "$lib/api/presence";
import { renderWithTheme } from "$tests/test-utils";

const api = vi.hoisted(() => ({
  getMyWifi: vi.fn(),
  updateMyWifi: vi.fn(),
  addMyDevice: vi.fn(),
  removeMyDevice: vi.fn(),
}));
const toast = vi.hoisted(() => ({
  toasts: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock("$lib/api/presence", () => api);
vi.mock("$stores/toast", () => toast);

import WifiPresenceSettings from "../WifiPresenceSettings.svelte";

const QR_DEVICE: MyWifiDevice = {
  id: "d-qr",
  mac: "aa:bb:cc:dd:ee:01",
  label: "Pixel-8",
  pairedVia: "QR",
  addedAt: "2026-11-01T08:00:00.000Z",
  lastSeenAt: "2026-11-02T07:30:00.000Z",
};
const MANUAL_DEVICE: MyWifiDevice = {
  id: "d-manual",
  mac: "aa:bb:cc:dd:ee:02",
  label: null,
  pairedVia: "MANUAL",
  addedAt: "2026-10-01T08:00:00.000Z",
  lastSeenAt: null,
};

function serve(devices: MyWifiDevice[], enabled = true) {
  api.getMyWifi.mockResolvedValue({ wifiPresenceEnabled: enabled, devices });
}

beforeEach(() => {
  vi.clearAllMocks();
  serve([QR_DEVICE, MANUAL_DEVICE]);
  api.updateMyWifi.mockImplementation(async (value: boolean) => ({
    wifiPresenceEnabled: value,
    devicesRemoved: value ? undefined : 2,
  }));
  api.addMyDevice.mockResolvedValue({ ...MANUAL_DEVICE, id: "d-new", mac: "aa:bb:cc:dd:ee:03" });
  api.removeMyDevice.mockResolvedValue(undefined);
});

async function mounted() {
  const view = renderWithTheme(WifiPresenceSettings, {});
  await waitFor(() => expect(api.getMyWifi).toHaveBeenCalled());
  await waitFor(() => expect(screen.queryByText("Laden…")).toBeNull());
  return view;
}

function optIn(): HTMLInputElement {
  return screen.getByRole("switch", { name: "WLAN-Anwesenheitserkennung" }) as HTMLInputElement;
}

describe("WifiPresenceSettings - device list", () => {
  it("shows both devices with how they were coupled and when they were last recognised", async () => {
    await mounted();
    expect(screen.getByText("aa:bb:cc:dd:ee:01")).toBeTruthy();
    expect(screen.getByText("aa:bb:cc:dd:ee:02")).toBeTruthy();
    expect(screen.getByText("über QR-Code gekoppelt")).toBeTruthy();
    expect(screen.getByText("manuell eingetragen")).toBeTruthy();
    expect(screen.getByText(/^zuletzt erkannt am \d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}$/)).toBeTruthy();
    expect(screen.getByText("noch nicht erkannt")).toBeTruthy();
    expect(screen.getByText("Pixel-8")).toBeTruthy();
    // The QR code in the salon is named as the easy way.
    expect(document.body.textContent).toContain("QR-Code im Salon");
  });

  it("shows an empty state that points to the QR code", async () => {
    serve([], false);
    await mounted();
    expect(
      screen.getByText("Noch kein Gerät gekoppelt. Scanne dazu den QR-Code im Salon."),
    ).toBeTruthy();
  });

  it("speaks to the person in du-form", async () => {
    await mounted();
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/\b(Sie|Ihre|Ihr|Ihnen)\b/);
    expect(text).toContain("Deine Geräteadresse");
  });

  it("a load failure shows the callout and disables the switch", async () => {
    api.getMyWifi.mockRejectedValue(new Error("boom"));
    renderWithTheme(WifiPresenceSettings, {});
    expect(
      await screen.findByText(/Die WLAN-Einstellungen konnten nicht geladen werden/),
    ).toBeTruthy();
    expect(optIn().disabled).toBe(true);
    expect(document.body.textContent).toContain("bitte lade die Seite neu");
  });
});

describe("WifiPresenceSettings - withdrawing the consent", () => {
  it("asks first and calls nothing while the dialog is open", async () => {
    await mounted();
    await fireEvent.click(optIn());

    const dialog = await screen.findByRole("dialog", { name: "Einwilligung widerrufen?" });
    expect(within(dialog).getByText(/Alle deine Geräte werden entfernt/)).toBeTruthy();
    expect(api.updateMyWifi).not.toHaveBeenCalled();
    // The switch still shows the consent until the withdrawal is confirmed.
    expect(optIn().checked).toBe(true);
  });

  it("confirming withdraws once, empties the list and toasts", async () => {
    await mounted();
    await fireEvent.click(optIn());
    const dialog = await screen.findByRole("dialog", { name: "Einwilligung widerrufen?" });
    await fireEvent.click(within(dialog).getByRole("button", { name: "Widerrufen" }));

    await waitFor(() => expect(api.updateMyWifi).toHaveBeenCalledTimes(1));
    expect(api.updateMyWifi).toHaveBeenCalledWith(false);
    await waitFor(() => expect(screen.queryByText("aa:bb:cc:dd:ee:01")).toBeNull());
    expect(screen.queryByText("aa:bb:cc:dd:ee:02")).toBeNull();
    expect(screen.getByText(/Noch kein Gerät gekoppelt/)).toBeTruthy();
    expect(optIn().checked).toBe(false);
    expect(toast.toasts.success).toHaveBeenCalledWith(
      "Einwilligung widerrufen. Deine Geräte wurden entfernt.",
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("cancelling calls nothing, keeps the devices and leaves the switch on", async () => {
    await mounted();
    await fireEvent.click(optIn());
    const dialog = await screen.findByRole("dialog", { name: "Einwilligung widerrufen?" });
    await fireEvent.click(within(dialog).getByRole("button", { name: "Abbrechen" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.updateMyWifi).not.toHaveBeenCalled();
    expect(optIn().checked).toBe(true);
    expect(screen.getByText("aa:bb:cc:dd:ee:01")).toBeTruthy();
  });

  it("a failed withdrawal keeps the switch on and the devices, with an error toast", async () => {
    api.updateMyWifi.mockRejectedValue(new Error("down"));
    await mounted();
    await fireEvent.click(optIn());
    const dialog = await screen.findByRole("dialog", { name: "Einwilligung widerrufen?" });
    await fireEvent.click(within(dialog).getByRole("button", { name: "Widerrufen" }));

    await waitFor(() => expect(toast.toasts.error).toHaveBeenCalled());
    expect(optIn().checked).toBe(true);
    expect(screen.getByText("aa:bb:cc:dd:ee:01")).toBeTruthy();
    expect(toast.toasts.success).not.toHaveBeenCalled();
  });

  it("switching off without devices withdraws directly, without a dialog", async () => {
    serve([], true);
    await mounted();
    await fireEvent.click(optIn());

    await waitFor(() => expect(api.updateMyWifi).toHaveBeenCalledWith(false));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(optIn().checked).toBe(false));
  });

  it("switching on gives the consent directly", async () => {
    serve([], false);
    await mounted();
    await fireEvent.click(optIn());

    await waitFor(() => expect(api.updateMyWifi).toHaveBeenCalledWith(true));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(optIn().checked).toBe(true);
  });

  it("a failed switch-on reverts the switch and shows an error toast", async () => {
    serve([], false);
    api.updateMyWifi.mockRejectedValue(new Error("down"));
    await mounted();
    await fireEvent.click(optIn());

    await waitFor(() => expect(toast.toasts.error).toHaveBeenCalledWith("Fehler beim Speichern."));
    await waitFor(() => expect(optIn().checked).toBe(false));
  });
});

describe("WifiPresenceSettings - manual entry and removal", () => {
  async function openManualEntry() {
    await mounted();
    const summary = screen.getByText("MAC-Adresse manuell eintragen");
    await fireEvent.click(summary);
  }

  it("keeps the manual entry inside a details element", async () => {
    await mounted();
    const summary = screen.getByText("MAC-Adresse manuell eintragen");
    expect(summary.closest("details")).not.toBeNull();
  });

  it("adds a device by MAC address and label", async () => {
    await openManualEntry();
    await fireEvent.input(screen.getByLabelText("MAC-Adresse"), {
      target: { value: "AA:BB:CC:DD:EE:03" },
    });
    await fireEvent.input(screen.getByLabelText("Bezeichnung (optional)"), {
      target: { value: "Tablet" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Gerät hinzufügen" }));

    await waitFor(() =>
      expect(api.addMyDevice).toHaveBeenCalledWith("aa:bb:cc:dd:ee:03", "Tablet"),
    );
    expect(await screen.findByText("aa:bb:cc:dd:ee:03")).toBeTruthy();
  });

  it("shows the format hint for an invalid MAC and keeps the add button disabled", async () => {
    await openManualEntry();
    const input = screen.getByLabelText("MAC-Adresse");
    await fireEvent.input(input, { target: { value: "nicht gültig" } });
    await fireEvent.blur(input);

    expect(
      await screen.findByText("Ungültige MAC-Adresse. Format: aa:bb:cc:dd:ee:ff"),
    ).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Gerät hinzufügen" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(api.addMyDevice).not.toHaveBeenCalled();
  });

  it("removes a device and drops its row", async () => {
    await mounted();
    const row = screen.getByText("aa:bb:cc:dd:ee:02").closest(".mac-row") as HTMLElement;
    await fireEvent.click(within(row).getByRole("button", { name: "Gerät entfernen" }));

    await waitFor(() => expect(api.removeMyDevice).toHaveBeenCalledWith("d-manual"));
    await waitFor(() => expect(screen.queryByText("aa:bb:cc:dd:ee:02")).toBeNull());
    expect(screen.getByText("aa:bb:cc:dd:ee:01")).toBeTruthy();
  });
});

describe("settings page wiring (source pin)", () => {
  const page = readFileSync(
    join(__dirname, "../../../../routes/(app)/settings/+page.svelte"),
    "utf8",
  );

  it("renders the component where the card was and holds no WLAN state any more", () => {
    expect(page).toContain("<WifiPresenceSettings");
    expect(page).not.toMatch(/getMyWifi|updateMyWifi|addMyDevice|removeMyDevice/);
    expect(page).not.toMatch(/wifiEnabled|wifiDevices|\.wifi-card|\.mac-row/);
  });
});
