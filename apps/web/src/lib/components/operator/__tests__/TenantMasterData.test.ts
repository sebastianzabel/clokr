// Issue #89 (D-14) - the tenant section of the operator's detail page, mounted. The component
// only asks; the page owns the API calls, so it is driven with plain callbacks.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/svelte";
import { tick } from "svelte";

import { renderWithTheme } from "$tests/test-utils";
import { OperatorApiError } from "$lib/operator/client";
import type { OperatorTenant, ResendInvitationResult } from "$lib/operator/types";
import TenantMasterData from "../TenantMasterData.svelte";

function byId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.querySelector<T>(`[data-testid="${id}"]`);
}

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = byId<T>(id);
  if (!found) throw new Error(`missing test id ${id}`);
  return found;
}

async function settle() {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
    await tick();
  }
}

const ACTIVE: OperatorTenant = {
  id: "tenant-1",
  name: "Beispiel Friseure GmbH",
  slug: "beispiel-friseure",
  federalState: "NIEDERSACHSEN",
  createdAt: "2026-03-05T12:00:00.000Z",
  deactivatedAt: null,
  deactivatedReason: null,
};

const DEACTIVATED: OperatorTenant = {
  ...ACTIVE,
  deactivatedAt: "2026-09-30T12:00:00.000Z",
  deactivatedReason: "Vertrag beendet",
};

interface Callbacks {
  onRename: ReturnType<typeof vi.fn>;
  onDeactivate: ReturnType<typeof vi.fn>;
  onReactivate: ReturnType<typeof vi.fn>;
  onResend: ReturnType<typeof vi.fn>;
}

function mount(tenant: OperatorTenant, overrides: Partial<Callbacks> = {}) {
  const callbacks: Callbacks = {
    onRename: vi.fn().mockResolvedValue(undefined),
    onDeactivate: vi.fn().mockResolvedValue(undefined),
    onReactivate: vi.fn().mockResolvedValue(undefined),
    onResend: vi
      .fn()
      .mockResolvedValue({ invitationMailSent: true } satisfies ResendInvitationResult),
    ...overrides,
  };
  renderWithTheme(TenantMasterData, { tenant, ...callbacks }, "nacht");
  return callbacks;
}

afterEach(() => {
  document.body.innerHTML = "";
});

/** Rejects like the operator client does. */
function apiError(status: number, code: string | undefined, message = "Server-Text") {
  return new OperatorApiError(status, code, message);
}

async function openDialog(testId: string, name: string): Promise<HTMLElement> {
  await fireEvent.click(el(testId));
  await settle();
  return screen.getByRole("dialog", { name });
}

describe("TenantMasterData - facts", () => {
  it("lists Name, Kurzname, Bundesland, Angelegt and Status", () => {
    mount(ACTIVE);
    const labels = [...document.querySelectorAll("dt")].map((dt) => dt.textContent?.trim());
    expect(labels).toEqual(["Name", "Kurzname", "Bundesland", "Angelegt", "Status"]);
    expect(el("op-tenant-name")).toHaveTextContent("Beispiel Friseure GmbH");
    expect(el("op-tenant-slug")).toHaveTextContent("beispiel-friseure");
    expect(el("op-tenant-federal-state")).toHaveTextContent("Niedersachsen");
    expect(document.querySelector("dl")).toHaveTextContent("05.03.2026");
  });

  it("marks an active tenant with data-state active and shows no deactivation notice", () => {
    mount(ACTIVE);
    expect(el("op-tenant-status")).toHaveAttribute("data-state", "active");
    expect(byId("op-tenant-deactivated-notice")).toBeNull();
  });

  it("marks a deactivated tenant and shows the date and the reason", () => {
    mount(DEACTIVATED);
    expect(el("op-tenant-status")).toHaveAttribute("data-state", "deactivated");
    expect(el("op-tenant-deactivated-notice")).toHaveTextContent(
      "Deaktiviert am 30.09.2026. Grund: Vertrag beendet",
    );
  });

  it("omits the reason sentence when none is stored", () => {
    mount({ ...DEACTIVATED, deactivatedReason: null });
    const text = el("op-tenant-deactivated-notice").textContent ?? "";
    expect(text).toContain("Deaktiviert am 30.09.2026.");
    expect(text).not.toContain("Grund");
  });
});

describe("TenantMasterData - action sets", () => {
  it("offers rename, resend and deactivate for an active tenant", () => {
    mount(ACTIVE);
    expect(byId("op-tenant-rename")).not.toBeNull();
    expect(byId("op-tenant-resend")).not.toBeNull();
    expect(byId("op-tenant-deactivate")).not.toBeNull();
    expect(byId("op-tenant-reactivate")).toBeNull();
  });

  it("offers rename and reactivate for a deactivated tenant, without resend and deactivate", () => {
    mount(DEACTIVATED);
    expect(byId("op-tenant-rename")).not.toBeNull();
    expect(byId("op-tenant-reactivate")).not.toBeNull();
    expect(byId("op-tenant-resend")).toBeNull();
    expect(byId("op-tenant-deactivate")).toBeNull();
  });

  it("keeps the three actions in one row outside any header slot", () => {
    mount(ACTIVE);
    const row = el("op-tenant-actions");
    expect(row.closest("header")).toBeNull();
    expect(row.querySelectorAll("button").length).toBeGreaterThanOrEqual(3);
  });
});

describe("TenantMasterData - rename", () => {
  it("opens the rename dialog from the current name and passes the trimmed name on", async () => {
    const { onRename } = mount(ACTIVE);
    expect(byId("op-tenant-rename-dialog")).toBeNull();
    await fireEvent.click(el("op-tenant-rename"));
    await settle();

    const input = el<HTMLInputElement>("op-tenant-rename-input");
    expect(input.value).toBe("Beispiel Friseure GmbH");
    input.value = "  Umbenannt  ";
    await fireEvent.input(input);
    await fireEvent.click(el("op-tenant-rename-submit"));
    await settle();

    expect(onRename).toHaveBeenCalledWith("Umbenannt");
    expect(byId("op-tenant-rename-dialog")).toBeNull();
  });
});

describe("TenantMasterData - deactivate", () => {
  const TITLE = "Mandant deaktivieren?";

  async function submitReason(dialog: HTMLElement, reason: string) {
    const field = within(dialog).getByLabelText(/Begründung/) as HTMLTextAreaElement;
    field.value = reason;
    await fireEvent.input(field);
    await fireEvent.click(within(dialog).getByRole("button", { name: "Mandant deaktivieren" }));
    await settle();
  }

  it("asks with the consequence text and a danger confirm button", async () => {
    mount(ACTIVE);
    const dialog = await openDialog("op-tenant-deactivate", TITLE);
    expect(dialog).toHaveTextContent(
      "„Beispiel Friseure GmbH“ wird deaktiviert. Mitarbeitende können sich nicht mehr anmelden, bestehende Sitzungen enden, geplante Abläufe wie der Monatsabschluss pausieren. Alle Daten bleiben erhalten; der Mandant lässt sich reaktivieren.",
    );
    expect(within(dialog).getByRole("button", { name: "Mandant deaktivieren" })).toHaveClass(
      "btn-danger",
    );
  });

  it("rejects a two-character reason inside the dialog without calling onDeactivate", async () => {
    const { onDeactivate } = mount(ACTIVE);
    const dialog = await openDialog("op-tenant-deactivate", TITLE);
    await submitReason(dialog, "ab");

    expect(onDeactivate).not.toHaveBeenCalled();
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "Die Begründung muss 3 bis 500 Zeichen lang sein.",
    );
    expect(screen.queryByRole("dialog", { name: TITLE })).not.toBeNull();
  });

  it("measures the trimmed reason: spaces around two characters do not pass", async () => {
    const { onDeactivate } = mount(ACTIVE);
    const dialog = await openDialog("op-tenant-deactivate", TITLE);
    await submitReason(dialog, "   ab   ");
    expect(onDeactivate).not.toHaveBeenCalled();
  });

  it("rejects a reason of 501 characters and accepts 500", async () => {
    const { onDeactivate } = mount(ACTIVE);
    const dialog = await openDialog("op-tenant-deactivate", TITLE);
    await submitReason(dialog, "x".repeat(501));
    expect(onDeactivate).not.toHaveBeenCalled();

    await submitReason(dialog, "x".repeat(500));
    expect(onDeactivate).toHaveBeenCalledWith(ACTIVE.id, "x".repeat(500));
  });

  it("accepts exactly three characters and passes id and trimmed reason on", async () => {
    const { onDeactivate } = mount(ACTIVE);
    const dialog = await openDialog("op-tenant-deactivate", TITLE);
    await submitReason(dialog, "  abc  ");

    expect(onDeactivate).toHaveBeenCalledTimes(1);
    expect(onDeactivate).toHaveBeenCalledWith(ACTIVE.id, "abc");
    expect(screen.queryByRole("dialog", { name: TITLE })).toBeNull();
  });

  it("words an API failure by its code inside the open dialog", async () => {
    const onDeactivate = vi.fn().mockRejectedValue(apiError(409, "ALREADY_DEACTIVATED"));
    mount(ACTIVE, { onDeactivate });
    const dialog = await openDialog("op-tenant-deactivate", TITLE);
    await submitReason(dialog, "Vertrag beendet");

    expect(onDeactivate).toHaveBeenCalledTimes(1);
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "Der Mandant ist bereits deaktiviert.",
    );
    expect(within(dialog).getByRole("alert")).not.toHaveTextContent("Server-Text");
    expect(screen.queryByRole("dialog", { name: TITLE })).not.toBeNull();
  });
});

describe("TenantMasterData - reactivate", () => {
  const TITLE = "Mandant reaktivieren?";

  it("asks for confirmation, calls onReactivate and closes on success", async () => {
    const { onReactivate } = mount(DEACTIVATED);
    const dialog = await openDialog("op-tenant-reactivate", TITLE);
    expect(dialog).toHaveTextContent(
      "„Beispiel Friseure GmbH“ ist danach wieder nutzbar. Anmeldungen sind wieder möglich.",
    );
    expect(onReactivate).not.toHaveBeenCalled();

    await fireEvent.click(within(dialog).getByRole("button", { name: "Mandant reaktivieren" }));
    await settle();

    expect(onReactivate).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog", { name: TITLE })).toBeNull();
  });

  it("shows the code's sentence in the dialog body and keeps it open on a 409", async () => {
    const onReactivate = vi.fn().mockRejectedValue(apiError(409, "NOT_DEACTIVATED"));
    mount(DEACTIVATED, { onReactivate });
    const dialog = await openDialog("op-tenant-reactivate", TITLE);
    await fireEvent.click(within(dialog).getByRole("button", { name: "Mandant reaktivieren" }));
    await settle();

    const notice = within(dialog).getByTestId("op-tenant-notice");
    expect(notice).toHaveAttribute("data-code", "NOT_DEACTIVATED");
    expect(notice).toHaveTextContent("Der Mandant ist nicht deaktiviert.");
    expect(screen.queryByRole("dialog", { name: TITLE })).not.toBeNull();
  });
});

describe("TenantMasterData - resend invitation", () => {
  const TITLE = "Einladung erneut senden?";

  async function confirmResend(dialog: HTMLElement) {
    await fireEvent.click(within(dialog).getByRole("button", { name: "Einladung senden" }));
    await settle();
  }

  it("asks first, then resends and closes without a warning when the mail went out", async () => {
    const { onResend } = mount(ACTIVE);
    const dialog = await openDialog("op-tenant-resend", TITLE);
    expect(dialog).toHaveTextContent(
      "Die erste Administration erhält eine neue Einladung per E-Mail.",
    );
    expect(onResend).not.toHaveBeenCalled();

    await confirmResend(dialog);

    expect(onResend).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog", { name: TITLE })).toBeNull();
    expect(byId("op-tenant-mail-warning")).toBeNull();
  });

  it("closes the dialog and shows the page warning when the mail was not sent", async () => {
    const onResend = vi.fn().mockResolvedValue({ invitationMailSent: false });
    mount(ACTIVE, { onResend });
    const dialog = await openDialog("op-tenant-resend", TITLE);
    await confirmResend(dialog);

    expect(screen.queryByRole("dialog", { name: TITLE })).toBeNull();
    const warning = el("op-tenant-mail-warning");
    expect(warning).toHaveClass("alert-warning");
    expect(warning).toHaveTextContent("Die Einladung konnte nicht gesendet werden.");
  });

  it("clears the warning when the next resend succeeds", async () => {
    const onResend = vi
      .fn()
      .mockResolvedValueOnce({ invitationMailSent: false })
      .mockResolvedValueOnce({ invitationMailSent: true });
    mount(ACTIVE, { onResend });
    await confirmResend(await openDialog("op-tenant-resend", TITLE));
    expect(byId("op-tenant-mail-warning")).not.toBeNull();

    await confirmResend(await openDialog("op-tenant-resend", TITLE));
    expect(byId("op-tenant-mail-warning")).toBeNull();
  });

  const REASONS: Array<[string, string]> = [
    ["TENANT_DEACTIVATED", "Der Mandant ist deaktiviert."],
    ["TENANT_IN_USE", "Der Mandant ist bereits in Benutzung. Eine neue Einladung ist nicht nötig."],
    ["NO_PENDING_INVITATION", "Es gibt keine offene Einladung."],
  ];

  for (const [code, text] of REASONS) {
    it(`words ${code} by its code in the dialog body and keeps the dialog open`, async () => {
      const onResend = vi.fn().mockRejectedValue(apiError(409, code, `Text zu ${code}`));
      mount(ACTIVE, { onResend });
      const dialog = await openDialog("op-tenant-resend", TITLE);
      await confirmResend(dialog);

      const notice = within(dialog).getByTestId("op-tenant-notice");
      expect(notice).toHaveAttribute("data-code", code);
      expect(notice.textContent?.trim()).toBe(text);
      expect(screen.queryByRole("dialog", { name: TITLE })).not.toBeNull();
      expect(byId("op-tenant-mail-warning")).toBeNull();
    });
  }

  it("renders the server string for a code the console does not know", async () => {
    const onResend = vi.fn().mockRejectedValue(apiError(409, "SOMETHING_NEW", "Server sagt X"));
    mount(ACTIVE, { onResend });
    const dialog = await openDialog("op-tenant-resend", TITLE);
    await confirmResend(dialog);

    const notice = within(dialog).getByTestId("op-tenant-notice");
    expect(notice).toHaveAttribute("data-code", "SOMETHING_NEW");
    expect(notice).toHaveTextContent("Server sagt X");
  });

  it("forgets the notice when the dialog is opened again", async () => {
    const onResend = vi
      .fn()
      .mockRejectedValueOnce(apiError(409, "NO_PENDING_INVITATION"))
      .mockResolvedValueOnce({ invitationMailSent: true });
    mount(ACTIVE, { onResend });
    let dialog = await openDialog("op-tenant-resend", TITLE);
    await confirmResend(dialog);
    expect(within(dialog).queryByTestId("op-tenant-notice")).not.toBeNull();

    await fireEvent.click(within(dialog).getByRole("button", { name: "Abbrechen" }));
    await settle();
    dialog = await openDialog("op-tenant-resend", TITLE);
    expect(within(dialog).queryByTestId("op-tenant-notice")).toBeNull();
  });
});
