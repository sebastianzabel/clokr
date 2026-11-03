// Issue #610 (D-11, P-610-20, AC-1/AC-2): the pairing page, mounted. One tap couples the phone, the
// consent is sent only from that tap, every failure has a calm message and the route is told to take
// the code out of the address bar once the preview has settled.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readable } from "svelte/store";
import { fireEvent, screen, waitFor } from "@testing-library/svelte";

import type { PairingPreview } from "$lib/api/presence";
import { renderWithTheme } from "$tests/test-utils";

// `pairing-view` imports `ApiError` from `$api/client`, which pulls in `$stores/auth` and with it
// `$app/environment` (not aliased by the vitest config).
vi.mock("$stores/auth", () => ({
  authStore: {
    ...readable({ accessToken: null, refreshToken: null, user: null }),
    logout: vi.fn(),
    setTokens: vi.fn(),
  },
}));

const api = vi.hoisted(() => ({
  previewPairing: vi.fn(),
  confirmPairing: vi.fn(),
}));
vi.mock("$lib/api/presence", () => api);

import { ApiError } from "$api/client";
import DevicePairing from "../DevicePairing.svelte";

const CODE = "0123456789abcdef".repeat(4);

function previewOf(overrides: Partial<PairingPreview> = {}): PairingPreview {
  return {
    deviceLabel: "Pixel-8-von-Lena",
    macTail: "ab:cd",
    replacesDevice: false,
    alreadyPaired: false,
    expiresAt: "2026-11-02T10:05:00.000Z",
    ...overrides,
  };
}

const COUPLE = "Das ist mein Handy – koppeln";

beforeEach(() => {
  vi.clearAllMocks();
  api.previewPairing.mockResolvedValue(previewOf());
  api.confirmPairing.mockResolvedValue({
    device: { id: "d1" },
    replacedDevices: 0,
    wifiPresenceEnabled: true,
    wifiOptInAt: "2026-11-02T10:00:00.000Z",
  });
});

function mount(code: string | null, onCodeHandled = vi.fn()) {
  renderWithTheme(DevicePairing, { code, onCodeHandled });
  return onCodeHandled;
}

describe("DevicePairing - no usable code", () => {
  it.each([
    ["no code", null],
    ["a malformed code", "not-a-code"],
    ["an uppercase code", CODE.toUpperCase()],
  ])("%s: says so, calls no API and hands the code back once", async (_label, code) => {
    const handled = mount(code);
    expect(
      await screen.findByText(
        "Kein gültiger Kopplungscode. Bitte scanne den QR-Code im Salon erneut.",
      ),
    ).toBeTruthy();
    expect(api.previewPairing).not.toHaveBeenCalled();
    expect(api.confirmPairing).not.toHaveBeenCalled();
    expect(screen.queryByRole("button")).toBeNull();
    expect(handled).toHaveBeenCalledTimes(1);
  });
});

describe("DevicePairing - preview", () => {
  it("previews the code once, then shows device, address tail, consent text and the one button", async () => {
    mount(CODE);
    await screen.findByRole("button", { name: COUPLE });

    expect(api.previewPairing).toHaveBeenCalledTimes(1);
    expect(api.previewPairing).toHaveBeenCalledWith(CODE);
    expect(screen.getByText("Pixel-8-von-Lena")).toBeTruthy();
    expect(screen.getByText("…:ab:cd")).toBeTruthy();
    const body = document.body.textContent ?? "";
    expect(body).toContain("Art. 6 Abs. 1 lit. a DSGVO");
    expect(body).toContain("§ 26 BDSG");
    expect(body).toContain("im Profil widerrufen");
    // The preview alone never couples anything.
    expect(api.confirmPairing).not.toHaveBeenCalled();
  });

  it("names a device without a hostname", async () => {
    api.previewPairing.mockResolvedValue(previewOf({ deviceLabel: null }));
    mount(CODE);
    await screen.findByRole("button", { name: COUPLE });
    expect(screen.getByText("Unbekanntes Gerät")).toBeTruthy();
  });

  it("renders a hostname as text, never as markup", async () => {
    api.previewPairing.mockResolvedValue(
      previewOf({ deviceLabel: "<img src=x onerror=alert(1)>" }),
    );
    mount(CODE);
    await screen.findByRole("button", { name: COUPLE });
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeTruthy();
  });

  it("tells that a bisher gekoppeltes Handy is replaced", async () => {
    api.previewPairing.mockResolvedValue(previewOf({ replacesDevice: true }));
    mount(CODE);
    expect(await screen.findByText("Dein bisher gekoppeltes Handy wird ersetzt.")).toBeTruthy();
  });

  it("tells that this phone is already coupled", async () => {
    api.previewPairing.mockResolvedValue(previewOf({ alreadyPaired: true }));
    mount(CODE);
    expect(
      await screen.findByText("Dieses Handy ist bereits mit deinem Konto gekoppelt."),
    ).toBeTruthy();
  });

  it("calls onCodeHandled exactly once, only AFTER the preview promise settled", async () => {
    let resolvePreview: (value: PairingPreview) => void = () => {};
    api.previewPairing.mockReturnValue(
      new Promise<PairingPreview>((resolve) => {
        resolvePreview = resolve;
      }),
    );
    const handled = mount(CODE);
    await waitFor(() => expect(api.previewPairing).toHaveBeenCalled());
    // Still pending: the code must stay available for a forced re-login.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(handled).not.toHaveBeenCalled();

    resolvePreview(previewOf());
    await screen.findByRole("button", { name: COUPLE });
    expect(handled).toHaveBeenCalledTimes(1);
  });

  it("calls onCodeHandled once also when the preview rejected", async () => {
    api.previewPairing.mockRejectedValue(new ApiError(404, "Der Code ist abgelaufen."));
    const handled = mount(CODE);
    await screen.findByText("Der Code ist abgelaufen.");
    expect(handled).toHaveBeenCalledTimes(1);
  });

  it("an expired or unknown code (404) shows the message and offers no button", async () => {
    api.previewPairing.mockRejectedValue(
      new ApiError(404, "Dieser Code ist abgelaufen oder bereits benutzt.", {
        code: "PAIRING_CODE_INVALID",
      }),
    );
    mount(CODE);
    expect(
      await screen.findByText("Dieser Code ist abgelaufen oder bereits benutzt."),
    ).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("a failed preview offers a retry that previews again without handing the code back twice", async () => {
    api.previewPairing.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const handled = mount(CODE);
    await screen.findByText("Das hat nicht geklappt.");
    expect(handled).toHaveBeenCalledTimes(1);

    await fireEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }));
    await screen.findByRole("button", { name: COUPLE });
    expect(api.previewPairing).toHaveBeenCalledTimes(2);
    expect(handled).toHaveBeenCalledTimes(1);
  });
});

describe("DevicePairing - the one tap", () => {
  it("couples with the exact code on the tap and shows the success state", async () => {
    mount(CODE);
    await fireEvent.click(await screen.findByRole("button", { name: COUPLE }));

    expect(await screen.findByText("Fertig! Dein Handy ist gekoppelt.")).toBeTruthy();
    expect(api.confirmPairing).toHaveBeenCalledTimes(1);
    expect(api.confirmPairing).toHaveBeenCalledWith(CODE);
    expect(screen.queryByRole("button", { name: COUPLE })).toBeNull();
    const link = screen.getByRole("link", { name: "Zu meinem Profil" });
    expect(link.getAttribute("href")).toBe("/settings");
  });

  it("a second click while the request is pending does nothing", async () => {
    let resolveConfirm: (value: unknown) => void = () => {};
    api.confirmPairing.mockReturnValue(
      new Promise((resolve) => {
        resolveConfirm = resolve;
      }),
    );
    mount(CODE);
    const button = await screen.findByRole("button", { name: COUPLE });
    await fireEvent.click(button);
    await fireEvent.click(button);
    expect(api.confirmPairing).toHaveBeenCalledTimes(1);
    resolveConfirm({});
    await screen.findByText("Fertig! Dein Handy ist gekoppelt.");
    expect(api.confirmPairing).toHaveBeenCalledTimes(1);
  });

  it("never confirms without a tap (consent only from the button)", async () => {
    mount(CODE);
    await screen.findByRole("button", { name: COUPLE });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.confirmPairing).not.toHaveBeenCalled();
  });

  it("a taken device (409) shows the server's message and offers no retry", async () => {
    api.confirmPairing.mockRejectedValue(
      new ApiError(
        409,
        "Dieses Gerät ist bereits einer anderen Person zugeordnet. Bitte wende dich an deine Leitung.",
        { code: "PRESENCE_DEVICE_TAKEN" },
      ),
    );
    mount(CODE);
    await fireEvent.click(await screen.findByRole("button", { name: COUPLE }));

    expect(
      await screen.findByText(
        "Dieses Gerät ist bereits einer anderen Person zugeordnet. Bitte wende dich an deine Leitung.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("a code that turned invalid between preview and tap (404) asks to scan again", async () => {
    api.confirmPairing.mockRejectedValue(new ApiError(404, "Der Code ist abgelaufen."));
    mount(CODE);
    await fireEvent.click(await screen.findByRole("button", { name: COUPLE }));
    expect(await screen.findByText("Der Code ist abgelaufen.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("a network error shows a calm message and a retry that confirms again", async () => {
    api.confirmPairing.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    mount(CODE);
    await fireEvent.click(await screen.findByRole("button", { name: COUPLE }));

    expect(await screen.findByText("Das hat nicht geklappt.")).toBeTruthy();
    // The consent text stays next to the button that sends it.
    expect(document.body.textContent).toContain("Art. 6 Abs. 1 lit. a DSGVO");
    await fireEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }));

    expect(await screen.findByText("Fertig! Dein Handy ist gekoppelt.")).toBeTruthy();
    expect(api.confirmPairing).toHaveBeenCalledTimes(2);
    expect(api.confirmPairing).toHaveBeenLastCalledWith(CODE);
    expect(api.previewPairing).toHaveBeenCalledTimes(1);
  });
});
