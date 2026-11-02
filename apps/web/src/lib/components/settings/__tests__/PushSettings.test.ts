// Issue #608 (D-14, OWNER-608-VAPID): the "Push-Benachrichtigungen" section, mounted. An instance
// without VAPID keys offers nothing; with keys, one click per device enables, one disables, the
// own device list can be managed, and a test can be sent. `lint:ui-classes` does not scan this
// directory, so this mount test is the component's gate.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/svelte";

import type { PushDevice } from "$lib/api/push";
import type { ThisDeviceState } from "$lib/push/device-subscription";
import type { PushSupport } from "$lib/push/support";
import { renderWithTheme } from "$tests/test-utils";

const api = vi.hoisted(() => ({
  getPushConfig: vi.fn(),
  listPushDevices: vi.fn(),
  removePushDevice: vi.fn(),
  sendTestPush: vi.fn(),
}));
const sub = vi.hoisted(() => ({
  enableThisDevice: vi.fn(),
  disableThisDevice: vi.fn(),
  thisDeviceState: vi.fn(),
}));
const support = vi.hoisted(() => ({ pushSupport: vi.fn() }));
const toast = vi.hoisted(() => ({
  toasts: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock("$lib/api/push", () => api);
vi.mock("$lib/push/device-subscription", () => sub);
vi.mock("$lib/push/support", () => support);
vi.mock("$stores/toast", () => toast);

import PushSettings from "../PushSettings.svelte";

function device(id: string, label: string): PushDevice {
  return {
    id,
    deviceLabel: label,
    consentedAt: "2026-10-30T09:00:00.000Z",
    lastSuccessAt: null,
    endpointHash: `hash-${id}`,
  };
}

const OFF: ThisDeviceState = { state: "off", deviceId: null };

/** Server list and this-device state the next refresh will see. */
let serverDevices: PushDevice[];
let thisState: ThisDeviceState;

function setNotificationPermission(permission: NotificationPermission) {
  Object.defineProperty(globalThis, "Notification", {
    configurable: true,
    writable: true,
    value: { permission },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  serverDevices = [];
  thisState = OFF;
  setNotificationPermission("default");
  api.getPushConfig.mockResolvedValue({ enabled: true, publicKey: "PUBLIC" });
  api.listPushDevices.mockImplementation(async () => serverDevices);
  api.removePushDevice.mockResolvedValue(undefined);
  api.sendTestPush.mockResolvedValue({ devices: [] });
  sub.thisDeviceState.mockImplementation(async () => thisState);
  support.pushSupport.mockReturnValue("supported" satisfies PushSupport);
});

async function mounted() {
  const view = renderWithTheme(PushSettings, {});
  await waitFor(() => expect(api.getPushConfig).toHaveBeenCalled());
  return view;
}

describe("PushSettings", () => {
  it("renders nothing and never lists devices when the instance has no VAPID keys", async () => {
    api.getPushConfig.mockResolvedValue({ enabled: false, publicKey: null });
    const { container } = await mounted();
    // Let the mount's async work settle before asserting absence.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText("Push-Benachrichtigungen")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.querySelector("section")).toBeNull();
    expect(api.listPushDevices).not.toHaveBeenCalled();
  });

  it("offers the opt-in while off: state, hints, disabled test button, empty list", async () => {
    await mounted();
    expect(await screen.findByText("Push-Benachrichtigungen")).toBeInTheDocument();
    expect(screen.getByTestId("push-state")).toHaveTextContent("Auf diesem Gerät: aus");
    expect(screen.getByRole("button", { name: "Push aktivieren" })).toBeEnabled();
    expect(screen.getByText(/Mit dem Aktivieren erlaubst du Clokr/)).toBeInTheDocument();
    expect(
      screen.getByText(/Auf dem Sperrbildschirm erscheint nur ein neutraler Hinweis/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Test senden" })).toBeDisabled();
    expect(screen.getByText("Noch kein Gerät eingerichtet.")).toBeInTheDocument();
  });

  it("enables on click: calls enableThisDevice once, shows on, marks this device, toasts", async () => {
    await mounted();
    const button = await screen.findByRole("button", { name: "Push aktivieren" });
    const mine = device("d1", "Chrome auf Android");
    sub.enableThisDevice.mockImplementation(async () => {
      serverDevices = [mine];
      thisState = { state: "on", deviceId: "d1" };
      return { status: "enabled", device: mine };
    });
    await fireEvent.click(button);
    await waitFor(() =>
      expect(screen.getByTestId("push-state")).toHaveTextContent("Auf diesem Gerät: an"),
    );
    expect(sub.enableThisDevice).toHaveBeenCalledTimes(1);
    expect(sub.enableThisDevice).toHaveBeenCalledWith("PUBLIC");
    expect(screen.getByText("Chrome auf Android")).toBeInTheDocument();
    expect(screen.getByText("Dieses Gerät")).toBeInTheDocument();
    expect(toast.toasts.success).toHaveBeenCalledWith("Push ist auf diesem Gerät aktiviert.");
    expect(screen.getByRole("button", { name: "Push deaktivieren" })).toBeInTheDocument();
  });

  it("shows the blocked text after a denied permission and offers no button", async () => {
    await mounted();
    const button = await screen.findByRole("button", { name: "Push aktivieren" });
    sub.enableThisDevice.mockResolvedValue({ status: "denied" });
    await fireEvent.click(button);
    expect(
      await screen.findByText(
        /Benachrichtigungen sind für Clokr in den Browser-Einstellungen blockiert/,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Push aktivieren" })).toBeNull();
  });

  it("WR-03: a dismissed prompt shows a calm retry hint, keeps the button and is not 'blocked'", async () => {
    await mounted();
    const button = await screen.findByRole("button", { name: "Push aktivieren" });
    sub.enableThisDevice.mockResolvedValue({ status: "dismissed" });
    await fireEvent.click(button);
    expect(await screen.findByTestId("push-dismissed")).toHaveTextContent(
      "Benachrichtigungen wurden nicht erlaubt",
    );
    expect(screen.getByRole("button", { name: "Push aktivieren" })).toBeEnabled();
    expect(screen.queryByText(/in den Browser-Einstellungen blockiert/)).toBeNull();
    expect(toast.toasts.error).not.toHaveBeenCalled();

    // A second attempt that is granted clears the hint.
    const mine = device("d1", "Chrome auf Android");
    sub.enableThisDevice.mockImplementation(async () => {
      serverDevices = [mine];
      thisState = { state: "on", deviceId: "d1" };
      return { status: "enabled", device: mine };
    });
    await fireEvent.click(screen.getByRole("button", { name: "Push aktivieren" }));
    await waitFor(() =>
      expect(screen.getByTestId("push-state")).toHaveTextContent("Auf diesem Gerät: an"),
    );
    expect(screen.queryByTestId("push-dismissed")).toBeNull();
  });

  it("toasts the message of a failed enable and stays off", async () => {
    await mounted();
    const button = await screen.findByRole("button", { name: "Push aktivieren" });
    sub.enableThisDevice.mockResolvedValue({
      status: "error",
      message: "Du hast bereits 10 Geräte für Push eingerichtet. Entferne zuerst ein Gerät.",
    });
    await fireEvent.click(button);
    await waitFor(() =>
      expect(toast.toasts.error).toHaveBeenCalledWith(
        "Du hast bereits 10 Geräte für Push eingerichtet. Entferne zuerst ein Gerät.",
      ),
    );
    expect(screen.getByTestId("push-state")).toHaveTextContent("Auf diesem Gerät: aus");
  });

  it("disables this device: back to off with a toast", async () => {
    serverDevices = [device("d1", "Chrome auf Android")];
    thisState = { state: "on", deviceId: "d1" };
    await mounted();
    const button = await screen.findByRole("button", { name: "Push deaktivieren" });
    sub.disableThisDevice.mockImplementation(async () => {
      serverDevices = [];
      thisState = OFF;
      return { status: "disabled" };
    });
    await fireEvent.click(button);
    await waitFor(() =>
      expect(screen.getByTestId("push-state")).toHaveTextContent("Auf diesem Gerät: aus"),
    );
    expect(toast.toasts.success).toHaveBeenCalledWith("Push ist auf diesem Gerät deaktiviert.");
  });

  it("sends a test and names the number of devices", async () => {
    serverDevices = [device("d1", "Chrome auf Android"), device("d2", "Safari auf iPhone")];
    thisState = { state: "on", deviceId: "d1" };
    api.sendTestPush.mockResolvedValue({
      devices: [
        { id: "d1", deviceLabel: "Chrome auf Android", outcome: "SENT" },
        { id: "d2", deviceLabel: "Safari auf iPhone", outcome: "SENT" },
      ],
    });
    await mounted();
    await fireEvent.click(await screen.findByRole("button", { name: "Test senden" }));
    await waitFor(() =>
      expect(toast.toasts.success).toHaveBeenCalledWith("Testnachricht an 2 Geräte gesendet."),
    );
  });

  it("WR-04: reports only delivered devices as sent and the failed ones as an error", async () => {
    serverDevices = [device("d1", "Chrome auf Android"), device("d2", "Safari auf iPhone")];
    thisState = { state: "on", deviceId: "d1" };
    api.sendTestPush.mockResolvedValue({
      devices: [
        { id: "d1", deviceLabel: "Chrome auf Android", outcome: "SENT" },
        { id: "d2", deviceLabel: "Safari auf iPhone", outcome: "FAILED" },
      ],
    });
    await mounted();
    await fireEvent.click(await screen.findByRole("button", { name: "Test senden" }));
    await waitFor(() =>
      expect(toast.toasts.success).toHaveBeenCalledWith("Testnachricht an 1 Gerät gesendet."),
    );
    expect(toast.toasts.error).toHaveBeenCalledWith(
      "Die Testnachricht konnte an 1 Gerät nicht zugestellt werden. Versuche es später erneut.",
    );
  });

  it("WR-04: when every device FAILED there is no success toast at all", async () => {
    serverDevices = [device("d1", "Chrome auf Android"), device("d2", "Safari auf iPhone")];
    thisState = { state: "on", deviceId: "d1" };
    api.sendTestPush.mockResolvedValue({
      devices: [
        { id: "d1", deviceLabel: "Chrome auf Android", outcome: "FAILED" },
        { id: "d2", deviceLabel: "Safari auf iPhone", outcome: "FAILED" },
      ],
    });
    await mounted();
    await fireEvent.click(await screen.findByRole("button", { name: "Test senden" }));
    await waitFor(() =>
      expect(toast.toasts.error).toHaveBeenCalledWith(
        "Die Testnachricht konnte an 2 Geräte nicht zugestellt werden. Versuche es später erneut.",
      ),
    );
    expect(toast.toasts.success).not.toHaveBeenCalled();
  });

  it("WR-04: a REMOVED device refreshes the list and tells the person to enable push again", async () => {
    serverDevices = [device("d1", "Chrome auf Android"), device("d2", "Safari auf iPhone")];
    thisState = { state: "on", deviceId: "d1" };
    await mounted();
    expect(await screen.findByText("Safari auf iPhone")).toBeInTheDocument();
    const listCalls = api.listPushDevices.mock.calls.length;
    api.sendTestPush.mockImplementation(async () => {
      serverDevices = [device("d1", "Chrome auf Android")]; // the server deleted d2
      return {
        devices: [
          { id: "d1", deviceLabel: "Chrome auf Android", outcome: "SENT" },
          { id: "d2", deviceLabel: "Safari auf iPhone", outcome: "REMOVED" },
        ],
      };
    });
    await fireEvent.click(screen.getByRole("button", { name: "Test senden" }));
    await waitFor(() => expect(screen.queryByText("Safari auf iPhone")).toBeNull());
    expect(api.listPushDevices.mock.calls.length).toBeGreaterThan(listCalls);
    expect(toast.toasts.info).toHaveBeenCalledWith(
      "1 Gerät ist beim Push-Dienst nicht mehr bekannt und wurde entfernt. Aktiviere Push dort erneut.",
    );
    expect(toast.toasts.success).toHaveBeenCalledWith("Testnachricht an 1 Gerät gesendet.");
  });

  it("says Gerät for exactly one device", async () => {
    serverDevices = [device("d1", "Chrome auf Android")];
    thisState = { state: "on", deviceId: "d1" };
    api.sendTestPush.mockResolvedValue({
      devices: [{ id: "d1", deviceLabel: "Chrome auf Android", outcome: "SENT" }],
    });
    await mounted();
    await fireEvent.click(await screen.findByRole("button", { name: "Test senden" }));
    await waitFor(() =>
      expect(toast.toasts.success).toHaveBeenCalledWith("Testnachricht an 1 Gerät gesendet."),
    );
  });

  it("removes another device by id and reloads the list without it", async () => {
    serverDevices = [device("d1", "Chrome auf Android"), device("d2", "Safari auf iPhone")];
    thisState = { state: "on", deviceId: "d1" };
    await mounted();
    api.removePushDevice.mockImplementation(async () => {
      serverDevices = [device("d1", "Chrome auf Android")];
    });
    await fireEvent.click(
      await screen.findByRole("button", { name: "Entfernen: Safari auf iPhone" }),
    );
    await waitFor(() => expect(screen.queryByText("Safari auf iPhone")).toBeNull());
    expect(api.removePushDevice).toHaveBeenCalledWith({ id: "d2" });
    expect(sub.disableThisDevice).not.toHaveBeenCalled();
    expect(toast.toasts.success).toHaveBeenCalledWith("Gerät entfernt.");
  });

  it("removes THIS device through the browser path", async () => {
    serverDevices = [device("d1", "Chrome auf Android")];
    thisState = { state: "on", deviceId: "d1" };
    await mounted();
    sub.disableThisDevice.mockImplementation(async () => {
      serverDevices = [];
      thisState = OFF;
      return { status: "disabled" };
    });
    await fireEvent.click(
      await screen.findByRole("button", { name: "Entfernen: Chrome auf Android" }),
    );
    await waitFor(() => expect(sub.disableThisDevice).toHaveBeenCalledTimes(1));
    expect(api.removePushDevice).not.toHaveBeenCalled();
  });

  it("shows the iOS Home Screen guide instead of the button", async () => {
    support.pushSupport.mockReturnValue("ios-needs-install" satisfies PushSupport);
    await mounted();
    expect(
      await screen.findByText(/Tippe in Safari auf „Teilen“ und dann auf „Zum/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Push aktivieren" })).toBeNull();
  });

  it("explains an unsupported browser calmly", async () => {
    support.pushSupport.mockReturnValue("unsupported" satisfies PushSupport);
    await mounted();
    expect(
      await screen.findByText("Dieser Browser unterstützt keine Push-Benachrichtigungen."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Push aktivieren" })).toBeNull();
  });

  it("shows the blocked text at mount when the browser permission is already denied", async () => {
    setNotificationPermission("denied");
    await mounted();
    expect(
      await screen.findByText(
        /Benachrichtigungen sind für Clokr in den Browser-Einstellungen blockiert/,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Push aktivieren" })).toBeNull();
  });

  it("disables the buttons while an action runs (no double submit)", async () => {
    await mounted();
    const button = await screen.findByRole("button", { name: "Push aktivieren" });
    let finish: (value: unknown) => void = () => {};
    sub.enableThisDevice.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    await fireEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    await fireEvent.click(button);
    expect(sub.enableThisDevice).toHaveBeenCalledTimes(1);
    finish({ status: "denied" });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Push aktivieren" })).toBeNull(),
    );
  });
});
