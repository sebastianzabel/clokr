// Issue #93 (D-03, D-09, D-21) - the "Support-Zugriff" section of the operator's tenant page,
// mounted. The component only asks; the page owns the API calls, so it is driven with plain
// callbacks.
//
// Pinned here: the request form with its limits and the exact body, the refusal worded by its code
// with the input kept, the running access with a countdown derived from `expiresAt - now` (and the
// switch back to the form at expiry without any request), the danger confirmation of the end, the
// frozen state of a deactivated tenant, the history with its statuses and the notice codes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/svelte";
import { tick } from "svelte";

import { renderWithTheme } from "$tests/test-utils";
import { OperatorApiError } from "$lib/operator/client";
import type { OperatorSupportAccess, OperatorSupportAccessState } from "$lib/operator/types";
import SupportSection from "../SupportSection.svelte";

const NOW = new Date("2026-10-15T10:00:00.000Z").getTime();
const HOUR = 3_600_000;

function byId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.querySelector<T>(`[data-testid="${id}"]`);
}

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = byId<T>(id);
  if (!found) throw new Error(`missing test id ${id}`);
  return found;
}

async function settle() {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
    await tick();
  }
}

function access(overrides: Partial<OperatorSupportAccess> = {}): OperatorSupportAccess {
  return {
    id: "acc-1",
    tenantId: "tenant-1",
    reason: "Ticket zur Saldo-Abweichung prüfen",
    durationHours: 4,
    startedAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 4 * HOUR).toISOString(),
    endedAt: null,
    endedBy: null,
    status: "ACTIVE",
    ...overrides,
  };
}

function idle(): OperatorSupportAccessState {
  return { active: null, history: [] };
}

function running(overrides: Partial<OperatorSupportAccess> = {}): OperatorSupportAccessState {
  const current = access(overrides);
  return { active: current, history: [current] };
}

interface MountOptions {
  state?: OperatorSupportAccessState;
  tenantDeactivated?: boolean;
  notice?: string | null;
  onRequest?: ReturnType<typeof vi.fn>;
  onEnd?: ReturnType<typeof vi.fn>;
}

function mount(options: MountOptions = {}) {
  const onRequest = options.onRequest ?? vi.fn().mockResolvedValue(undefined);
  const onEnd = options.onEnd ?? vi.fn().mockResolvedValue(undefined);
  const onReload = vi.fn().mockResolvedValue(undefined);
  renderWithTheme(
    SupportSection,
    {
      tenantId: "tenant-1",
      state: options.state ?? idle(),
      tenantDeactivated: options.tenantDeactivated ?? false,
      notice: options.notice ?? null,
      onRequest,
      onEnd,
      onReload,
    },
    "nacht",
  );
  return { onRequest, onEnd, onReload };
}

async function typeReason(value: string) {
  const input = el<HTMLTextAreaElement>("op-support-reason");
  input.value = value;
  await fireEvent.input(input);
}

async function chooseDuration(label: string) {
  const radios = Array.from(
    el("op-support-duration").querySelectorAll<HTMLButtonElement>("[role=radio]"),
  );
  const radio = radios.find((r) => r.textContent?.trim() === label);
  if (!radio) throw new Error(`no duration option ${label}`);
  await fireEvent.click(radio);
}

function refusal(code: string, status = 409) {
  return new OperatorApiError(status, code, "server text");
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("SupportSection request form", () => {
  it("offers Grund, Dauer preset to 1 Stunde, the protocol hint and a disabled request button", () => {
    mount();
    expect(el("op-support-section")).toHaveTextContent("Support-Zugriff");
    expect(el("op-support-reason")).toHaveAttribute("id", "op-support-reason-input");
    expect(el("op-support-reason-count")).toHaveTextContent("0 / 500");
    const labels = Array.from(el("op-support-duration").querySelectorAll("[role=radio]"));
    expect(labels.map((r) => r.textContent?.trim())).toEqual([
      "1 Stunde",
      "4 Stunden",
      "8 Stunden",
      "24 Stunden",
    ]);
    expect(el("op-support-duration")).toHaveAttribute("data-value", "1");
    expect(labels[0]).toHaveAttribute("aria-checked", "true");
    expect(el("op-support-section")).toHaveTextContent(
      "Jeder Abruf wird im Betreiber- und im Mandantenprotokoll gespeichert. Der Mandant sieht Grund und Zeitraum und kann den Zugriff jederzeit beenden.",
    );
    expect(el<HTMLButtonElement>("op-support-request").disabled).toBe(true);
    expect(el("op-support-request")).toHaveTextContent("Zugriff anfordern");
    expect(byId("op-support-active")).toBeNull();
  });

  it("enables the button only for 10 to 500 trimmed characters and counts the trimmed length", async () => {
    mount();
    const button = el<HTMLButtonElement>("op-support-request");

    await typeReason("123456789");
    expect(button.disabled).toBe(true);
    expect(el("op-support-reason-count")).toHaveTextContent("9 / 500");

    await typeReason("   123456789   ");
    expect(button.disabled).toBe(true);

    await typeReason("1234567890");
    expect(button.disabled).toBe(false);

    await typeReason("a".repeat(500));
    expect(button.disabled).toBe(false);

    await typeReason("a".repeat(501));
    expect(button.disabled).toBe(true);
    expect(el("op-support-reason-count")).toHaveTextContent("501 / 500");
    expect(el("op-support-reason-error")).toHaveTextContent("10 bis 500 Zeichen");
    expect(el("op-support-reason")).toHaveAttribute("aria-invalid", "true");
  });

  it("sends the trimmed reason with the preset duration as a number", async () => {
    const { onRequest } = mount();
    await typeReason("  Ticket 4711 prüfen  ");
    await fireEvent.click(el("op-support-request"));
    await settle();

    expect(onRequest).toHaveBeenCalledTimes(1);
    expect(onRequest.mock.calls[0]?.[0]).toStrictEqual({
      reason: "Ticket 4711 prüfen",
      durationHours: 1,
    });
  });

  it("sends the chosen duration as a number", async () => {
    const { onRequest } = mount();
    await typeReason("Ticket 4711 prüfen");
    await chooseDuration("8 Stunden");
    expect(el("op-support-duration")).toHaveAttribute("data-value", "8");
    await fireEvent.click(el("op-support-request"));
    await settle();

    expect(onRequest.mock.calls[0]?.[0]).toStrictEqual({
      reason: "Ticket 4711 prüfen",
      durationHours: 8,
    });
  });

  it("a refused request shows the sentence of its code, keeps the input and does not reload for a plain refusal", async () => {
    const { onRequest, onReload } = mount();
    onRequest.mockRejectedValue(refusal("TENANT_DEACTIVATED"));
    await typeReason("Ticket 4711 prüfen");
    await chooseDuration("4 Stunden");
    await fireEvent.click(el("op-support-request"));
    await settle();

    const error = el("op-support-error");
    expect(error).toHaveAttribute("data-code", "TENANT_DEACTIVATED");
    expect(error).toHaveTextContent("Der Mandant ist deaktiviert.");
    expect(error).not.toHaveTextContent("server text");
    expect(el<HTMLTextAreaElement>("op-support-reason").value).toBe("Ticket 4711 prüfen");
    expect(el("op-support-duration")).toHaveAttribute("data-value", "4");
    expect(onReload).not.toHaveBeenCalled();
  });

  it("SUPPORT_ACCESS_ALREADY_ACTIVE is worded by its code and reloads the stale page", async () => {
    const { onRequest, onReload } = mount();
    onRequest.mockRejectedValue(refusal("SUPPORT_ACCESS_ALREADY_ACTIVE"));
    await typeReason("Ticket 4711 prüfen");
    await fireEvent.click(el("op-support-request"));
    await settle();

    expect(el("op-support-error")).toHaveAttribute("data-code", "SUPPORT_ACCESS_ALREADY_ACTIVE");
    expect(el("op-support-error")).toHaveTextContent("Eine Verlängerung ist nicht möglich");
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it("editing after a refusal clears the message", async () => {
    const { onRequest } = mount();
    onRequest.mockRejectedValue(refusal("SUPPORT_ACCESS_ALREADY_ACTIVE"));
    await typeReason("Ticket 4711 prüfen");
    await fireEvent.click(el("op-support-request"));
    await settle();
    expect(byId("op-support-error")).not.toBeNull();

    await typeReason("Ticket 4712 prüfen");
    expect(byId("op-support-error")).toBeNull();
  });
});

describe("SupportSection running access", () => {
  it("shows the end time, the remaining time, the reason and the links instead of the form", () => {
    mount({ state: running() });
    expect(el("op-support-active")).toBeInTheDocument();
    expect(byId("op-support-request")).toBeNull();
    expect(byId("op-support-reason")).toBeNull();

    // Formatted in the browser's zone, so build the expectation the same way.
    const end = new Date(NOW + 4 * HOUR);
    const pad = (n: number) => String(n).padStart(2, "0");
    expect(el("op-support-expires")).toHaveTextContent(
      `${pad(end.getDate())}.${pad(end.getMonth() + 1)}.${end.getFullYear()}, ${pad(end.getHours())}:${pad(end.getMinutes())}`,
    );
    expect(el("op-support-remaining")).toHaveTextContent("Noch 4 Std. 0 Min.");
    expect(el("op-support-active")).toHaveTextContent("Ticket zur Saldo-Abweichung prüfen");
    expect(el("op-support-link-employees")).toHaveAttribute(
      "href",
      "/betreiber/mandanten/tenant-1/support",
    );
    expect(el("op-support-link-employees")).toHaveTextContent("Mitarbeitende ansehen");
    expect(el("op-support-link-protocol")).toHaveAttribute(
      "href",
      "/betreiber/mandanten/tenant-1/support/protokoll",
    );
    expect(el("op-support-link-protocol")).toHaveTextContent("Protokoll ansehen");
    expect(el("op-support-end")).toHaveTextContent("Zugriff beenden");
  });

  it("derives the remaining time from the expiry on the clock, not from a counter", async () => {
    mount({ state: running() });
    expect(el("op-support-remaining")).toHaveTextContent("Noch 4 Std. 0 Min.");

    // One jump of 90 minutes: a decrementing counter would have lost the skipped ticks.
    vi.advanceTimersByTime(90 * 60_000);
    await tick();
    expect(el("op-support-remaining")).toHaveTextContent("Noch 2 Std. 30 Min.");

    vi.advanceTimersByTime(2 * HOUR + 29 * 60_000 + 30_000);
    await tick();
    expect(el("op-support-remaining")).toHaveTextContent("Weniger als 1 Min.");
  });

  it("switches to the form state at expiry without any request", async () => {
    const { onRequest, onEnd, onReload } = mount({ state: running() });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    vi.advanceTimersByTime(4 * HOUR + 1000);
    await tick();

    expect(byId("op-support-active")).toBeNull();
    expect(el("op-support-reason")).toBeInTheDocument();
    expect(el<HTMLButtonElement>("op-support-request").disabled).toBe(true);
    expect(onRequest).not.toHaveBeenCalled();
    expect(onEnd).not.toHaveBeenCalled();
    expect(onReload).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("the end asks first: a danger dialog, no call before the confirmation", async () => {
    const { onEnd } = mount({ state: running() });
    await fireEvent.click(el("op-support-end"));
    await settle();

    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog).toHaveTextContent("Support-Zugriff beenden?");
    expect(dialog.querySelector(".btn-danger")).toHaveTextContent("Zugriff beenden");
    expect(onEnd).not.toHaveBeenCalled();
  });

  async function confirmEnd() {
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    const button = dialog.querySelector(".btn-danger") as HTMLElement;
    await fireEvent.click(button);
    await settle();
  }

  it("a confirmed end calls the callback with the access id and closes the dialog", async () => {
    const { onEnd } = mount({ state: running({ id: "acc-9" }) });
    await fireEvent.click(el("op-support-end"));
    await settle();
    await confirmEnd();

    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith("acc-9");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(byId("op-support-end-error")).toBeNull();
  });

  it("a refused end keeps the dialog open with the reason of its code and reloads the stale page", async () => {
    const { onEnd, onReload } = mount({ state: running() });
    onEnd.mockRejectedValue(refusal("SUPPORT_ACCESS_NOT_ACTIVE"));
    await fireEvent.click(el("op-support-end"));
    await settle();
    await confirmEnd();

    const error = el("op-support-end-error");
    expect(error).toHaveAttribute("data-code", "SUPPORT_ACCESS_NOT_ACTIVE");
    expect(error).toHaveAttribute("role", "alert");
    expect(error).toHaveTextContent("Der Support-Zugriff ist nicht mehr aktiv.");
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it("a plain refusal of the end keeps the dialog open without a reload", async () => {
    const { onEnd, onReload } = mount({ state: running() });
    onEnd.mockRejectedValue(new OperatorApiError(500, undefined, "boom"));
    await fireEvent.click(el("op-support-end"));
    await settle();
    await confirmEnd();

    expect(el("op-support-end-error")).toHaveTextContent("Der Server hat einen Fehler gemeldet.");
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(onReload).not.toHaveBeenCalled();
  });
});

describe("SupportSection deactivated tenant", () => {
  it("disables the form and names the reason", () => {
    mount({ tenantDeactivated: true });
    expect(el("op-support-frozen-hint")).toHaveTextContent("Der Mandant ist deaktiviert.");
    expect(el<HTMLTextAreaElement>("op-support-reason").disabled).toBe(true);
    expect(el<HTMLButtonElement>("op-support-request").disabled).toBe(true);
    for (const radio of el("op-support-duration").querySelectorAll<HTMLButtonElement>(
      "[role=radio]",
    )) {
      expect(radio.disabled).toBe(true);
    }
  });

  it("freezes the reads of a running access but keeps the end enabled", () => {
    mount({ state: running(), tenantDeactivated: true });
    expect(el("op-support-frozen-hint")).toBeInTheDocument();
    expect(el<HTMLButtonElement>("op-support-end").disabled).toBe(false);
    expect(el("op-support-link-employees")).toHaveAttribute("aria-disabled", "true");
    expect(el("op-support-link-employees")).not.toHaveAttribute("href");
    expect(el("op-support-link-protocol")).toHaveAttribute("aria-disabled", "true");
  });

  it("ends a running access of a deactivated tenant (ending only narrows the access)", async () => {
    const { onEnd } = mount({ state: running({ id: "acc-d" }), tenantDeactivated: true });
    await fireEvent.click(el("op-support-end"));
    await settle();
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    await fireEvent.click(dialog.querySelector(".btn-danger") as HTMLElement);
    await settle();

    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith("acc-d");
  });
});

describe("SupportSection history", () => {
  const ended = access({
    id: "acc-ended",
    status: "ENDED",
    endedBy: "TENANT",
    endedAt: new Date(NOW - 5 * HOUR).toISOString(),
    startedAt: new Date(NOW - 8 * HOUR).toISOString(),
    expiresAt: new Date(NOW - 4 * HOUR).toISOString(),
    reason: "a".repeat(300),
  });
  const endedByOperator = access({
    id: "acc-own",
    status: "ENDED",
    endedBy: "OPERATOR",
    endedAt: new Date(NOW - 26 * HOUR).toISOString(),
    startedAt: new Date(NOW - 30 * HOUR).toISOString(),
    expiresAt: new Date(NOW - 26 * HOUR).toISOString(),
  });
  const expired = access({
    id: "acc-expired",
    status: "EXPIRED",
    startedAt: new Date(NOW - 50 * HOUR).toISOString(),
    expiresAt: new Date(NOW - 49 * HOUR).toISOString(),
  });

  it("lists every access with a text status badge and who ended it", () => {
    const current = access({ id: "acc-now" });
    mount({ state: { active: current, history: [current, ended, endedByOperator, expired] } });

    expect(el("op-support-status-acc-now")).toHaveTextContent("Aktiv");
    expect(el("op-support-status-acc-now")).toHaveAttribute("data-state", "active");
    expect(el("op-support-status-acc-ended")).toHaveTextContent("Beendet");
    expect(el("op-support-status-acc-ended")).toHaveAttribute("data-state", "ended");
    expect(el("op-support-status-acc-expired")).toHaveTextContent("Abgelaufen");
    expect(el("op-support-status-acc-expired")).toHaveAttribute("data-state", "expired");
    expect(el("op-support-history-row-acc-ended")).toHaveTextContent("beendet durch Mandant");
    expect(el("op-support-history-row-acc-own")).toHaveTextContent("beendet durch Betreiber");
    expect(el("op-support-history-row-acc-expired")).not.toHaveTextContent("beendet durch");
    expect(document.querySelectorAll('[data-testid^="op-support-history-row-"]')).toHaveLength(4);
  });

  it("clamps a long reason to two lines and keeps it in the title", () => {
    mount({ state: { active: null, history: [ended] } });
    const clamp = el("op-support-history-row-acc-ended").querySelector(".clamp") as HTMLElement;
    expect(clamp).toHaveAttribute("title", "a".repeat(300));
  });

  it("reads a stored ACTIVE row whose expiry has passed on the clock as expired", async () => {
    const stale = access({ id: "acc-stale" });
    mount({ state: { active: null, history: [stale] } });
    expect(el("op-support-status-acc-stale")).toHaveAttribute("data-state", "active");

    vi.advanceTimersByTime(4 * HOUR + 2000);
    await tick();
    expect(el("op-support-status-acc-stale")).toHaveAttribute("data-state", "expired");
    expect(el("op-support-status-acc-stale")).toHaveTextContent("Abgelaufen");
  });

  it("says so when there is no earlier access", () => {
    mount();
    expect(el("op-support-history-empty")).toHaveTextContent("Noch keine Support-Zugriffe.");
    expect(byId("op-support-history-row-acc-1")).toBeNull();
  });
});

describe("SupportSection notice", () => {
  it.each([
    ["SUPPORT_ACCESS_REQUIRED", "kein aktiver Support-Zugriff"],
    ["SUPPORT_ACCESS_EXPIRED", "Der Support-Zugriff ist abgelaufen."],
  ])("renders %s with its code and its sentence", (code, text) => {
    mount({ notice: code });
    const notice = el("op-support-notice");
    expect(notice).toHaveAttribute("data-code", code);
    expect(notice).toHaveTextContent(text);
  });

  it("ignores any other code and never renders it", () => {
    mount({ notice: "<b>Ihre Daten</b>" });
    expect(byId("op-support-notice")).toBeNull();
    expect(document.body).not.toHaveTextContent("Ihre Daten");
  });

  it("renders no notice by default", () => {
    mount();
    expect(byId("op-support-notice")).toBeNull();
  });
});
